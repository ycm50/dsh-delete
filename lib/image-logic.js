/**
 * dsh-delete 的「图片管理」纯逻辑层 —— 零依赖（只用 node: 内置模块），可离线测试。
 *
 * 本层回答三件事，全部以 home（DSH 主目录）为入参、不读全局可变状态：
 *
 *   1. **盘点**：一个会话在**当前模型表面**上有哪些图片出现位置（occurrence），
 *      每处多大、什么尺寸、来自哪个事件、是否已被摘除。数据源是会话日志本身，
 *      所以「宿主内存里活着的会话」与「磁盘上冷掉的会话」用同一条代码路径。
 *
 *   2. **摘除计划**：把用户勾选的出现位置，换算成 DSH 官方 `image/offload` 事件的
 *      `targets`（`{ seq, imageIndexes }`，seq 是**事件真实序号**，不是表面位置）。
 *
 *   3. **磁盘删除计划**：把「源文件」「附件对象」两条通路各自过一道独立的安全闸，
 *      逐项给出「删 / 跳过 / 拒绝」与原因，绝不猜、绝不做通配删除。
 *
 * ## 为什么摘除用官方事件而不是重写日志
 *
 * DSH 本体已有一套「把图片从请求里摘掉」的持久机制：路由发现保留图片超预算时以
 * `IMAGE_OFFLOAD_REQUIRED` 失败 → `@deepseek-ai/dsh-compaction-image-offload`
 * 追加一条 `image/offload` 事件（按事件 seq + 消息内深度优先图片序号选点）→
 * 该投影把这些出现位置换成占位文本后重试。于是我们只需要**追加同一种事件**：
 * 日志不变、附件不丢、可回读（占位文本带只读路径）、重放/fork 语义天然一致。
 *
 * 它的投影要求（我们写的事件必须过这一关，所以这里逐条对齐）：
 *   - `targets` 非空；每项恰好 `{ seq, imageIndexes }`；
 *   - `seq` 必须是**当前表面节点**，且事件类型是 `user/message` 或 `tool/result`；
 *   - `imageIndexes` 非空、严格递增、都是非负安全整数；
 *   - 被选中的位置**不能已经摘除**（已摘除的索引会让投影抛错）。
 *
 * ## 磁盘契约（实测于 DSH 0.2.0-rc.2，不是猜的）
 *
 *   <home>/attachments/v1/objects/<64hex 前2位>/<64hex>   ← 规范化图片/文件对象
 *   <home>/cache/attachments/request-images/<hash>        ← 路由专用变体缓存（本插件不碰）
 *
 * 对象名 = 内容的 sha256，因此「同名即同内容」，删除前可以再做一次内容校验。
 * 附件是**内容寻址、可能被多个会话共享**的，所以删之前必须全库核引用（见 scanReferences）。
 *
 * ## 安全边界（本文件是插件里第二处真正危险的地方）
 *
 * 源文件删除只认「同一个 tool/result 事件里，与 image 块同排出现的 data.meta.path」——
 * 不认任何其它来源，也不做通配。路径先规范化（resolve + 小写折叠）再比对，
 * 因此 `C:\Windows\..\Windows\System32` 这类花招在比较前就被拉平。
 * 系统区（Windows / Program Files* / ProgramData / DSH 自身）**连子路径一起挡**。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, resolve, sep } from 'node:path'
import * as zlib from 'node:zlib'

// ---------------------------------------------------------------- 常量

/** 附件 id 的合法形状：sha256:<64 位小写十六进制>。 */
export const ATTACHMENT_ID_RE = /^sha256:[0-9a-f]{64}$/

/** 单个日志文件解压后的读取上限（防御性：真实日志是几十 MB 级）。 */
export const MAX_LOG_TEXT_BYTES = 512 * 1024 * 1024

/** 引用扫描的默认并发（不放大：既是 IO，也是 CPU 解压）。 */
export const DEFAULT_SCAN_CONCURRENCY = 4

/** 走 image 块的内容块类型名。 */
const IMAGE_BLOCK = 'image'

/** 深度优先数图片时的顶层块容器字段（与本体一致：只看 content 里的 image 块）。 */
const CONTENT_KEYS = ['content']

/** 产生消息、且可能带图片的事件类型（与本体 offloadOldestImages 同一口径）。 */
const IMAGE_EVENT_TYPES = new Set(['user/message', 'tool/result'])

/**
 * 全部「产生消息」的事件类型（表面节点就是这些类型）。
 * 只用于**缺省回退**：真实表面应由宿主给出（`session.surface.nodes` /
 * `sessionQuery.readSurface().surface`），这里只是没有宿主时的保守近似。
 */
const MESSAGE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'tool/result'])

/** fsutil 探测超时（毫秒），失败即放弃这一项增强信息，不影响主流程。 */
const REPARSE_PROBE_TIMEOUT_MS = 3000

// ---------------------------------------------------------------- 主目录

/**
 * 定位 DSH 主目录：优先显式 override，其次 $DSH_HOME，再次 ~/.dsh；
 * 候选里第一个「真的像主目录」（含 sessions 或 storages 或 attachments）的胜出。
 * 与 index.js 的 resolveHome 同口径，但这里不 import 它，避免逻辑层依赖宿主半。
 */
export function resolveImageHome(override, env = process.env, homeDir = '') {
  const list = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') list.push(resolve(value.trim()))
  }
  push(override)
  push(env?.DSH_HOME)
  if (homeDir !== '') push(join(homeDir, '.dsh'))
  for (const candidate of list) {
    if (
      existsSync(join(candidate, 'sessions')) ||
      existsSync(join(candidate, 'storages')) ||
      existsSync(join(candidate, 'attachments'))
    ) {
      return candidate
    }
  }
  return list[0] ?? ''
}

/** 附件库根（图片、通用文件对象都在它下面）。 */
export function attachmentsRoot(home) {
  return join(home, 'attachments', 'v1')
}

/** 内容寻址对象根。 */
export function attachmentObjectsRoot(home) {
  return join(attachmentsRoot(home), 'objects')
}

/** 路由变体缓存根（本插件**不删**它，只在报告里说明有多少派生文件被保留）。 */
export function attachmentVariantRoot(home) {
  return join(home, 'cache', 'attachments', 'request-images')
}

/** 会话日志根。与 lib/logic.js 的 sessionsRoot 同口径（encodeSegment 产物在磁盘名里）。 */
export function sessionLogsRoot(home) {
  return join(home, 'sessions')
}

// ---------------------------------------------------------------- 路径规范化

/**
 * 折叠路径用于**比较**：resolve 拉平 `..`、统一分隔符、去掉尾部多余分隔符，
 * 再整体小写（Windows 路径大小写不敏感）。返回空串表示入参不是可用路径。
 *
 * 所有「这个路径是否落在禁区」的判断都必须先过这一步，绝不直接拿原文比。
 */
export function foldPath(target) {
  if (typeof target !== 'string') return ''
  const raw = target.trim()
  if (raw === '') return ''
  let folded = resolve(raw)
  // 去掉尾部多余分隔符，但**保留**盘根形态（`C:\`、`\`）——盘根是合法比较对象。
  while (folded.length > 3 && folded.endsWith(sep)) folded = folded.slice(0, -1)
  if (/^[a-z]:$/i.test(folded)) folded += sep
  return folded.toLowerCase()
}

/** target 是否落在 dir 之内（含 dir 自身）。两侧都先折叠。 */
export function insideFolded(dir, target) {
  const d = foldPath(dir)
  const t = foldPath(target)
  if (d === '' || t === '') return false
  if (t === d) return true
  return t.startsWith(d.endsWith(sep) ? d : d + sep)
}

/** 该路径是否网络位置：UNC 共享或已挂载的网络盘。 */
export function isNetworkPath(target) {
  if (typeof target === 'string' && (target.startsWith('\\\\') || target.startsWith('//'))) return true
  try {
    const info = statfsSync(target)
    return info?.type === 'network'
  } catch {
    return false
  }
}

/** 该路径是否是「盘根 / 卷根」（永远不许删）。 */
export function isDriveRoot(target) {
  const folded = foldPath(target)
  if (folded === '') return false
  return /^[a-z]:\\?$/.test(folded) || folded === sep
}
/** 该路径是否是目录（删除只针对普通文件）。 */
export function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** 该路径是否符号链接/联接（重解析点）。 */
export function isLink(target) {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 权威重解析点探测（Windows）：lstat 在 Windows 上认不出 junction，
 * 于是额外问一次 fsutil（带超时）。任何失败都只返回 false，不阻断主流程。
 * @returns { boolean } 是否带 reparse point 属性。
 */
export function hasReparsePoint(target) {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('fsutil', ['reparsepoint', 'query', String(target)], {
      encoding: 'utf8',
      timeout: REPARSE_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return typeof out === 'string' && !/not a reparse point/i.test(out)
  } catch {
    return false
  }
}

/** 普通文件？（目录、链接、缺失一律 false） */
export function isPlainFile(target) {
  try {
    const info = lstatSync(target)
    return info.isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 禁区名单

/**
 * 构建「禁止删除」的目录集合。
 *
 * 名单只包含**系统区与 DSH 自身**，且**连子路径一起挡**（用户明确要求：
 * “C 下面的 windows 下面，还有其它重要目录，不仅挡目录本身，还要挡子路径”）。
 *
 * 例外：`%SystemRoot%\Temp` 是用户可写的临时区，放行它自己及其子路径。
 */
export function forbiddenRoots(options = {}) {
  const env = options.env ?? process.env
  const home = typeof options.home === 'string' ? options.home : ''
  const dshInstall = options.dshInstall
  const entries = []
  const add = (label, value) => {
    if (typeof value === 'string' && value.trim() !== '') entries.push({ label, path: value.trim() })
  }

  add('windows', env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows')
  add('program-files', env.ProgramFiles ?? 'C:\\Program Files')
  add('program-files-x86', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)')
  add('programdata', env.ProgramData ?? 'C:\\ProgramData')
  add('system-volume-metadata', join(env.SystemDrive ?? 'C:', '$Recycle.Bin'))
  add('system-volume-metadata', join(env.SystemDrive ?? 'C:', 'Recovery'))
  add('system-volume-metadata', join(env.SystemDrive ?? 'C:', 'System Volume Information'))
  add('system-volume-metadata', join(env.SystemDrive ?? 'C:', 'EFI'))
  if (home !== '') add('dsh-home', home)
  if (typeof dshInstall === 'string' && dshInstall.trim() !== '') add('dsh-install', dshInstall.trim())

  const roots = entries.map((entry) => ({ label: entry.label, folded: foldPath(entry.path) })).filter((r) => r.folded !== '')

  const allow = []
  const systemTemp = env.SystemRoot ?? env.WINDIR
  if (typeof systemTemp === 'string' && systemTemp.trim() !== '') {
    allow.push(foldPath(join(systemTemp, 'Temp')))
  }
  const userProfile = typeof env.USERPROFILE === 'string' ? env.USERPROFILE.trim() : ''
  if (userProfile !== '') {
    // 用户可写的临时区整棵树放行。
    allow.push(foldPath(join(userProfile, 'AppData', 'Local', 'Temp')))
    // **其它**用户的主目录不许删（本机只有一个用户，但这条不变量该有）。
    // 当前用户的主目录整体放行 —— 用户明确要求「用户主目录的部分可以删除」。
    const usersDir = join(env.SystemDrive ?? 'C:', 'Users')
    const current = foldPath(userProfile)
    let names = []
    try {
      names = readdirSync(usersDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      names = []
    }
    for (const name of names) {
      const candidate = foldPath(join(usersDir, name))
      if (candidate === '' || candidate === current) continue
      roots.push({ label: 'other-user-profile', folded: candidate })
    }
  }
  return { roots, allow }
}

/**
 * 判断一个源文件路径能不能删。
 *
 * @param target 事件里带出来的原始路径
 * @param opts   { env?, home?, dshInstall?, workspaceRoot? }
 * @returns { ok, reason?, scope?, exists?, bytes?, link?, directory?, network? }
 */
export function classifySourceFile(target, opts = {}) {
  const raw = typeof target === 'string' ? target.trim() : ''
  if (raw === '') return { ok: false, reason: 'EMPTY_PATH' }
  if (!isAbsolute(raw)) return { ok: false, reason: 'NOT_ABSOLUTE' }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return { ok: false, reason: 'UNC_PATH' }
  if (isDriveRoot(raw)) return { ok: false, reason: 'DRIVE_ROOT' }
  const folded = foldPath(raw)
  if (folded === '') return { ok: false, reason: 'BAD_SHAPE' }
  // 规范化后必须与原文一致（拉平 .. 之后不该产生新路径）。
  if (folded !== resolve(raw).toLowerCase()) return { ok: false, reason: 'BAD_SHAPE' }
  if (isNetworkPath(raw)) return { ok: false, reason: 'NETWORK_PATH' }

  const { roots, allow } = forbiddenRoots(opts)
  const allowed = allow.some((prefix) => prefix !== '' && (folded === prefix || folded.startsWith(prefix + sep)))
  if (!allowed) {
    for (const root of roots) {
      if (folded === root.folded || folded.startsWith(root.folded + sep)) {
        return { ok: false, reason: 'FORBIDDEN_ROOT:' + root.label }
      }
    }
  }

  // 系统区之外的形态检查：先看是否可 stat，再判类型。
  let info
  try {
    info = lstatSync(raw)
  } catch {
    return { ok: false, reason: 'MISSING', exists: false }
  }
  if (info.isDirectory()) return { ok: false, reason: 'IS_DIRECTORY', exists: true, directory: true }
  if (!info.isFile()) {
    return { ok: false, reason: info.isSymbolicLink() ? 'IS_LINK' : 'NOT_REGULAR_FILE', exists: true, link: info.isSymbolicLink() }
  }
  if (hasReparsePoint(raw)) return { ok: false, reason: 'REPARSE_POINT', exists: true }

  const workspace = opts.workspaceRoot
  const inWorkspace = typeof workspace === 'string' && workspace.trim() !== '' && insideFolded(workspace, raw)
  const inProfile = typeof opts.env?.USERPROFILE === 'string' && insideFolded(opts.env.USERPROFILE, raw)
  const inProgramData = typeof opts.env?.ProgramData === 'string' && insideFolded(opts.env.ProgramData, raw)
  const scope = inWorkspace
    ? 'in-workspace'
    : inProgramData
      ? 'programdata'
      : inProfile
        ? 'in-profile'
        : 'outside-workspace'
  const risk = scope === 'in-workspace' ? 'low' : scope === 'programdata' ? 'high' : 'medium'
  return { ok: true, scope, risk, exists: true, bytes: info.size }
}

// ---------------------------------------------------------------- 附件对象

/** 把附件 id 解析成磁盘对象路径；形状不对返回空串（绝不拼路径）。 */
export function attachmentObjectPath(home, attachmentId) {
  const id = typeof attachmentId === 'string' ? attachmentId.trim().toLowerCase() : ''
  if (!ATTACHMENT_ID_RE.test(id)) return ''
  const digest = id.slice('sha256:'.length)
  const candidate = join(attachmentObjectsRoot(home), digest.slice(0, 2), digest)
  // 双保险：拼出来的路径必须仍在对象根之内。
  if (!insideFolded(attachmentObjectsRoot(home), candidate)) return ''
  return candidate
}

/** 计算文件内容的 sha256（hex）。读不到返回空串。 */
export function fileDigest(file) {
  try {
    const data = readFileSync(file)
    return createHash('sha256').update(data).digest('hex')
  } catch {
    return ''
  }
}

/**
 * 判断一个附件对象能不能删。
 * @returns { ok, reason?, path?, exists?, bytes?, digestMatches? }
 */
export function classifyAttachmentObject(home, attachmentId, opts = {}) {
  const path = attachmentObjectPath(home, attachmentId)
  if (path === '') return { ok: false, reason: 'BAD_ATTACHMENT_ID' }
  const digest = String(attachmentId).trim().toLowerCase().slice('sha256:'.length)
  let info
  try {
    info = lstatSync(path)
  } catch {
    return { ok: false, reason: 'MISSING', path, exists: false }
  }
  if (!info.isFile()) return { ok: false, reason: 'NOT_REGULAR_FILE', path, exists: true }
  if (isLink(path)) return { ok: false, reason: 'IS_LINK', path, exists: true }
  if (hasReparsePoint(path)) return { ok: false, reason: 'REPARSE_POINT', path, exists: true }
  const actual = fileDigest(path)
  if (actual === '') return { ok: false, reason: 'UNREADABLE', path, exists: true }
  if (actual !== digest) return { ok: false, reason: 'DIGEST_MISMATCH', path, exists: true, bytes: info.size }
  return { ok: true, path, exists: true, bytes: info.size, digestMatches: true }
}

/** 统计变体缓存里有多少派生文件（只报告，不删）。 */
export function countVariantFiles(home) {
  const root = attachmentVariantRoot(home)
  let count = 0
  let bytes = 0
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        count += 1
        bytes += fileSizeOf(full)
      }
    }
  }
  walk(root)
  return { count, bytes }
}

/** 文件字节数（读不到记 0）。 */
function fileSizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------- 日志读取

/** zstd 帧魔数（小端）。 */
const ZSTD_MAGIC = 4247762216

/**
 * 读一个会话日志，返回逐行事件（JSON 解析失败的碎行保留为 null）。
 *
 * 兼容两种落盘形态：zstd 拼接帧（现版）与明文 .jsonl（老版）。
 * 解压按帧推进、总长封顶 MAX_LOG_TEXT_BYTES，坏帧跳过而不是整体失败。
 */
export function readSessionEvents(file) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return []
  }
  const text = looksZstd(buffer) ? decompressFrames(buffer) : buffer.toString('utf8')
  return parseEventLines(text)
}

/** 该缓冲区是否是 zstd 帧（看魔数）。 */
function looksZstd(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC
}

/**
 * 解压 zstd 拼接帧：按帧魔数切边界，逐帧解压后拼接。
 * 没有 zstd 能力（老 Node）时返回空串，调用方降级为「读不到」。
 */
function decompressFrames(buffer) {
  const decompress = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null
  if (decompress === null) return ''
  const starts = []
  let cursor = 0
  for (;;) {
    const at = buffer.indexOf(ZSTD_FRAME_MAGIC_BUFFER, cursor)
    if (at < 0) break
    starts.push(at)
    cursor = at + 4
  }
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      text += decompress(buffer.subarray(starts[i], end)).toString('utf8')
    } catch {
      /* 坏帧：跳过，别让整份日志读不出来 */
    }
    if (text.length > MAX_LOG_TEXT_BYTES) return text.slice(0, MAX_LOG_TEXT_BYTES)
  }
  return text
}

/** zstd 帧魔数的 Buffer 形态（用于 indexOf 切帧）。 */
const ZSTD_FRAME_MAGIC_BUFFER = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * **异步**读一个会话日志（读盘 + 逐帧解压都不阻塞事件循环）。
 *
 * 宿主半必须用它：同步版一次要占 400 ms 左右（10 MB 日志 → 31 MB 文本），
 * 在宿主上就是卡住整个进程 400 ms；面板一刷新就重现一次。
 */
export async function readSessionEventsAsync(file) {
  const { readFile } = await import('node:fs/promises')
  const zstd = typeof zlib.zstdDecompress === 'function' ? zlib.zstdDecompress : null
  let buffer
  try {
    buffer = await readFile(file)
  } catch {
    return []
  }
  if (!looksZstd(buffer) || zstd === null) return parseEventLines(buffer.toString('utf8'))
  const starts = []
  let cursor = 0
  for (;;) {
    const at = buffer.indexOf(ZSTD_FRAME_MAGIC_BUFFER, cursor)
    if (at < 0) break
    starts.push(at)
    cursor = at + 4
  }
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    const frame = buffer.subarray(starts[i], end)
    try {
      const chunk = await new Promise((resolveFrame, rejectFrame) => {
        zstd(frame, (error, out) => (error ? rejectFrame(error) : resolveFrame(out)))
      })
      text += chunk.toString('utf8')
    } catch {
      /* 坏帧跳过 */
    }
    if (text.length > MAX_LOG_TEXT_BYTES) {
      text = text.slice(0, MAX_LOG_TEXT_BYTES)
      break
    }
  }
  return parseEventLines(text)
}

/** 把日志文本切成事件对象数组（坏行 → null，保持行序与 seq 对齐）。 */
export function parseEventLines(text) {
  const out = []
  if (typeof text !== 'string' || text === '') return out
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      out.push(null)
    }
  }
  return out
}

/** 事件里承载消息的那个字段（user/message 在 data、tool/result 在 data.message）。 */
function messageOf(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.type === 'user/message') {
    const message = event.data?.message ?? event.data
    return message !== null && typeof message === 'object' ? message : null
  }
  if (event.type === 'tool/result') {
    const message = event.data?.message
    return message !== null && typeof message === 'object' ? message : null
  }
  return null
}

/** 该事件的真实序号（事件体自带 seq；缺失时回退到日志行号）。 */
function seqOf(event, fallback) {
  const seq = event?.seq
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : fallback
}

/**
 * 逐个取出一个消息里的图片出现位置（深度优先，与本体口径一致）。
 * @returns [{ imageIndex, block }]
 */
export function imageBlocksOf(message) {
  const out = []
  if (message === null || typeof message !== 'object') return out
  let imageIndex = 0
  for (const key of CONTENT_KEYS) {
    const blocks = message[key]
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.type !== IMAGE_BLOCK) continue
      out.push({ imageIndex, block })
      imageIndex += 1
    }
  }
  return out
}

// ---------------------------------------------------------------- 会话模型

/**
 * 从解析后的事件数组构建「会话模型」。
 *
 * **为什么必须显式建映射**：真机实测（9379 行日志）里，**位置 ≠ seq** 是常态
 * ——第一条事件的 `seq` 是 0，却落在数组位置 1；日志开头还有一行 header。
 * 所以「读事件」要按**位置**，「写 image/offload 的 targets」要按**真实 seq**，
 * 两者绝不可互相代替。这个模型把两件事分开：
 *
 *   - `seqToIndex`：真实 seq → 数组位置（读事件用）
 *   - `surfaceSeqs`：当前表面节点的真实 seq 列表（模型请求顺序）
 *
 * @param events  parseEventLines 的结果（含坏行 null）
 * @param surfaceSeqs 可选：宿主给出的表面 seq 列表
 * @returns { events, seqToIndex, surfaceSeqs, anomalies }
 */
export function buildSessionModel(events, surfaceSeqs) {
  const list = Array.isArray(events) ? events : []
  const seqToIndex = new Map()
  const anomalies = { header: 0, missingSeq: 0, duplicateSeq: [] }
  for (let position = 0; position < list.length; position += 1) {
    const event = list[position]
    if (event === null || typeof event !== 'object') continue
    // header 行（type: 'session'）不参与事件序号空间：它自带的 seq 会与第一条事件撞号
    // （真机实测：header 的 seq 是 0，第一条 permission/preset 事件的 seq 也是 0）。
    if (event.type === 'session') {
      anomalies.header += 1
      continue
    }
    const seq = event.seq
    if (!Number.isSafeInteger(seq) || seq < 0) {
      anomalies.missingSeq += 1
      continue
    }
    if (seqToIndex.has(seq)) {
      anomalies.duplicateSeq.push(seq)
      continue
    }
    seqToIndex.set(seq, position)
  }

  let surface = Array.isArray(surfaceSeqs) ? surfaceSeqs.filter((seq) => Number.isSafeInteger(seq) && seq >= 0) : []
  if (surface.length === 0) surface = defaultSurfaceSeqs(list)

  return { events: list, seqToIndex, surfaceSeqs: surface, anomalies }
}

/** 按真实 seq 取事件（读事件一律走这里，绝不拿 seq 当数组下标）。 */
export function eventAtSeq(model, seq) {
  const position = model?.seqToIndex?.get(seq)
  if (position === undefined) return null
  return model.events[position] ?? null
}

/** 缺省表面：按 `surfaceOp` 标记回退（消息事件自带 `surfaceOp: 'append'`）。 */
function defaultSurfaceSeqs(events) {
  const nodes = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (!MESSAGE_EVENT_TYPES.has(event.type)) continue
    if (event.surfaceOp === undefined || event.surfaceOp === 'append') {
      if (Number.isSafeInteger(event.seq) && event.seq >= 0) nodes.push(event.seq)
    }
  }
  return nodes
}

// ---------------------------------------------------------------- 盘点

/**
 * 从**活会话对象**直接建模型 —— 零磁盘 I/O，且表面必然与本体一致。
 *
 * 为什么必须优先走这条路（实测踩出来的）：
 *   1. **一致性**：本体追加 `image/offload` 时用 `session.surface.nodes` 校验
 *      「目标 seq 是不是当前表面节点」。磁盘日志里的表面可能已经不同（压缩 `replace`
 *      会把旧节点移出表面，而日志里那些事件还在），于是从磁盘算出的选点会被本体拒绝。
 *   2. **开销**：读一次 10 MB 日志要解压 232 ms + 逐行 parse 163 ms，全是**同步**
 *      阻塞宿主事件循环；活会话的 `log` 本来就在内存里。
 *
 * @param session 宿主内存里的活会话（`ctx.sessions.get(id)`）
 * @returns 与 buildSessionModel 同形的模型；拿不到可用字段时返回 null（调用方退回读盘）
 */
export function buildSessionModelFromSession(session) {
  if (session === null || typeof session !== 'object') return null
  const events = session.log
  if (!Array.isArray(events) || events.length === 0) return null
  const nodes = session.surface?.nodes
  const surfaceSeqs = Array.isArray(nodes) ? [...nodes] : []
  return buildSessionModel(events, surfaceSeqs.length > 0 ? surfaceSeqs : undefined)
}

/** 该会话对象是否带可用的内存日志（决定走活会话还是读盘）。 */
export function canModelFromSession(session) {
  return Array.isArray(session?.log) && session.log.length > 0
}

/**
 * 列出「当前表面上的全部图片出现位置」与摘除记录。
 *
 * @param model buildSessionModel 的产物
 * @returns { occurrences[], offloadEvents[], totals }
 */
export function inventoryOccurrences(model) {
  const nodeSeqs = model?.surfaceSeqs ?? []
  const occurrences = []
  const offloadEvents = []

  // 先收集摘除记录，才能给每个出现位置打上 offloaded 标记。
  const offloaded = new Set()
  for (const event of model?.events ?? []) {
    if (event === null || event?.type !== 'image/offload') continue
    const targets = event.data?.targets
    if (!Array.isArray(targets)) continue
    const cleaned = []
    for (const target of targets) {
      const seq = target?.seq
      const indexes = target?.imageIndexes
      if (!Number.isSafeInteger(seq) || !Array.isArray(indexes)) continue
      const list = indexes.filter((n) => Number.isSafeInteger(n) && n >= 0)
      if (list.length === 0) continue
      cleaned.push({ seq, imageIndexes: list })
      for (const index of list) offloaded.add(seq + ':' + index)
    }
    if (cleaned.length > 0) {
      offloadEvents.push({
        seq: Number.isSafeInteger(event.seq) ? event.seq : null,
        time: event.time ?? null,
        targets: cleaned,
      })
    }
  }

  for (const seq of nodeSeqs) {
    const event = eventAtSeq(model, seq)
    if (event === null) continue
    if (!IMAGE_EVENT_TYPES.has(event.type)) continue
    const message = messageOf(event)
    if (message === null) continue
    const captured = typeof event.data?.meta?.path === 'string' ? event.data.meta.path : ''
    for (const { imageIndex, block } of imageBlocksOf(message)) {
      const attachment = block.attachment ?? block.ref ?? null
      const attachmentId = typeof attachment?.attachmentId === 'string' ? attachment.attachmentId : ''
      const marked = block.offloaded === true
      const recorded = offloaded.has(seq + ':' + imageIndex)
      occurrences.push({
        seq,
        imageIndex,
        attachmentId,
        bytes: Number.isSafeInteger(attachment?.bytes) ? attachment.bytes : 0,
        width: Number.isSafeInteger(attachment?.width) ? attachment.width : 0,
        height: Number.isSafeInteger(attachment?.height) ? attachment.height : 0,
        name: typeof attachment?.name === 'string' ? attachment.name : '',
        mediaType: typeof attachment?.mediaType === 'string' ? attachment.mediaType : '',
        time: event.time ?? null,
        origin: event.type,
        turn: Number.isSafeInteger(event.data?.turn) ? event.data.turn : null,
        heldPath: captured,
        offloaded: marked || recorded,
        offloadSource: marked && recorded ? 'both' : marked ? 'projection' : recorded ? 'event' : '',
      })
    }
  }

  occurrences.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.seq - b.seq || a.imageIndex - b.imageIndex)

  const retained = occurrences.filter((o) => !o.offloaded)
  const totals = {
    occurrences: occurrences.length,
    retained: retained.length,
    offloaded: occurrences.length - retained.length,
    bytes: sum(occurrences.map((o) => o.bytes)),
    retainedBytes: sum(retained.map((o) => o.bytes)),
    distinctAttachments: new Set(occurrences.map((o) => o.attachmentId).filter((id) => id !== '')).size,
    distinctRetainedAttachments: new Set(retained.map((o) => o.attachmentId).filter((id) => id !== '')).size,
  }
  return { occurrences, offloadEvents, totals }
}

/** 求和（数字安全）。 */
function sum(values) {
  let total = 0
  for (const value of values) if (Number.isSafeInteger(value)) total += value
  return total
}

// ---------------------------------------------------------------- 摘除计划

/**
 * 把勾选的出现位置换算成一条 `image/offload` 的数据体。
 *
 * 校验（全部通过才返回 ok）：
 *   - 每个 seq 都在当前表面内，且按 seq→位置 映射能取到 `user/message` 或 `tool/result`；
 *   - 每个 imageIndex 在该消息里真实存在（按深度优先重算）；
 *   - 该位置尚未被摘除（无论投影标记还是既有记录）——否则投影会抛错；
 *   - 同一次计划里同 seq 的索引严格递增、不重复。
 *
 * @param model buildSessionModel 的产物
 * @returns { ok, reason?, targets?, items?, count }
 */
export function planOffload(model, items) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return { ok: false, reason: 'NO_ITEMS', count: 0 }

  const nodeSet = new Set(model?.surfaceSeqs ?? [])
  const { occurrences } = inventoryOccurrences(model)
  const byKey = new Map(occurrences.map((o) => [o.seq + ':' + o.imageIndex, o]))

  const grouped = new Map()
  const planned = []
  for (const item of list) {
    const seq = item?.seq
    const imageIndex = item?.imageIndex
    if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(imageIndex) || imageIndex < 0) {
      return { ok: false, reason: 'BAD_ITEM', count: 0 }
    }
    if (!model?.seqToIndex?.has(seq)) return { ok: false, reason: 'SEQ_OUT_OF_RANGE', count: 0, seq }
    if (!nodeSet.has(seq)) return { ok: false, reason: 'SEQ_NOT_ON_SURFACE', count: 0, seq }
    const event = eventAtSeq(model, seq)
    if (event === null || !IMAGE_EVENT_TYPES.has(event?.type)) {
      return { ok: false, reason: 'SEQ_NOT_MESSAGE', count: 0, seq }
    }
    const occurrence = byKey.get(seq + ':' + imageIndex)
    if (occurrence === undefined) return { ok: false, reason: 'IMAGE_INDEX_MISSING', count: 0, seq, imageIndex }
    if (occurrence.offloaded) return { ok: false, reason: 'ALREADY_OFFLOADED', count: 0, seq, imageIndex }
    const bucket = grouped.get(seq) ?? new Set()
    if (bucket.has(imageIndex)) continue // 幂等：同一条计划里重复勾选只算一次
    bucket.add(imageIndex)
    grouped.set(seq, bucket)
    planned.push({ seq, imageIndex, attachmentId: occurrence.attachmentId, bytes: occurrence.bytes, heldPath: occurrence.heldPath })
  }

  const targets = []
  for (const seq of [...grouped.keys()].sort((a, b) => a - b)) {
    targets.push({ seq, imageIndexes: [...grouped.get(seq)].sort((a, b) => a - b) })
  }
  if (targets.length === 0) return { ok: false, reason: 'NO_ITEMS', count: 0 }
  return { ok: true, targets, items: planned, count: planned.length }
}

/** 构造 DSH 官方的 image/offload 事件数据体。 */
export function buildOffloadEvent(targets) {
  return { targets: targets.map((t) => ({ seq: t.seq, imageIndexes: [...t.imageIndexes] })) }
}

// ---------------------------------------------------------------- 缓存代价预估

/**
 * 收集「用量锚点」：每次请求的总输入 token = `inputTokens + cacheReadTokens`。
 *
 * 为什么能用它估算缓存代价：前缀缓存是**逐 token 精确前缀匹配**，于是
 *   - 断点之前的内容仍能命中 → 可复用前缀 ≈ 断点前最后一次请求的体量；
 *   - 断点之后的内容要重算 → 重算量 ≈ 当前请求体量 − 可复用前缀。
 *
 * 实测校准（本机真实会话，摘除 seq 1799 那次）：估算 376,888 / 74,870，
 * 真值 377,472 / 73,967 —— 前缀误差 0.15%，重算误差 1.2%，命中率 83.4% vs 83.6%。
 */
export function usageAnchors(model) {
  const anchors = []
  for (const event of model?.events ?? []) {
    if (event === null || event?.type !== 'assistant/message') continue
    const usage = event.data?.usage ?? event.data?.message?.usage
    if (usage === null || typeof usage !== 'object') continue
    if (!Number.isSafeInteger(event.seq)) continue
    const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
    const hit = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
    const total = input + hit
    if (total <= 0) continue
    anchors.push({ seq: event.seq, total, input, hit })
  }
  const last = anchors.length > 0 ? anchors[anchors.length - 1] : null
  // 「平时命中率」取最近几次的**中位数**：单次冷启动/刚被打断的那一次不该当基线。
  const recent = anchors.slice(-5).map((anchor) => (anchor.total > 0 ? anchor.hit / anchor.total : 0))
  const median = (values) => {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }
  const medianRate = median(recent)
  return {
    source: last === null ? 'none' : 'usage',
    total: last === null ? null : last.total,
    totalSeq: last === null ? null : last.seq,
    /** 平时命中率（最近 5 次的中位数）；这个会话本来就没缓存时它会接近 0。 */
    baselineHitRatePct: medianRate === null ? null : medianRate * 100,
    /** 最近一次请求的命中率（用于对照）。 */
    lastHitRatePct: last === null || last.total <= 0 ? null : (last.hit / last.total) * 100,
    anchors,
  }
}

/** 断点之前还能命中的前缀体量：最后一个 `seq < breakSeq` 的锚点（没有则 0）。 */
function prefixTokensBefore(anchors, breakSeq) {
  let best = 0
  for (const anchor of anchors) {
    if (anchor.seq >= breakSeq) break // 锚点按日志顺序递增
    best = anchor.total
  }
  return best
}

/**
 * 估算「在 `breakSeq` 这条消息处打断前缀缓存」的一次性代价。
 *
 * @param usage usageAnchors 的产物
 * @param breakSeq 最早被修改的那条消息的 seq
 * @returns { ok, seq, total, cached, reprocess, hitRatePct, baselineHitRatePct, approximate }
 */
export function estimateBreakCost(usage, breakSeq) {
  if (usage?.source !== 'usage' || !Number.isSafeInteger(usage.total)) {
    return { ok: false, reason: 'NO_USAGE', seq: breakSeq ?? null }
  }
  if (!Number.isSafeInteger(breakSeq)) return { ok: false, reason: 'BAD_SEQ', seq: null }
  const total = usage.total
  const cached = prefixTokensBefore(usage.anchors, breakSeq)
  const reprocess = Math.max(0, total - cached)
  return {
    ok: true,
    seq: breakSeq,
    total,
    cached,
    reprocess,
    hitRatePct: total > 0 ? (cached / total) * 100 : null,
    baselineHitRatePct: usage.baselineHitRatePct ?? null,
    /**
     * ⚠️ 估算口径：按**摘除前**的请求体量算。图片换成占位文本后实际请求会略小
     * （图片 token 越贵，高估越多）；前缀那一侧是实测锚点，几乎精确。
     */
    approximate: true,
  }
}

/** 给每个「带图片的 seq」预先算好「若在此处打断缓存」的代价（面板据此即时显示，无需额外请求）。 */
export function costBySeq(model, occurrences) {
  const usage = usageAnchors(model)
  const seqs = [...new Set((occurrences ?? []).map((o) => o.seq).filter((seq) => Number.isSafeInteger(seq)))].sort(
    (a, b) => a - b,
  )
  return {
    source: usage.source,
    total: usage.total,
    totalSeq: usage.totalSeq,
    baselineHitRatePct: usage.baselineHitRatePct,
    anchors: usage.anchors.length,
    bySeq: seqs.map((seq) => estimateBreakCost(usage, seq)),
  }
}

// ---------------------------------------------------------------- 引用扫描

/**
 * 扫全部会话日志，统计每条「源文件路径」与每个「附件 id」被哪些会话引用。
 *
 * 为什么必须全库扫：附件是内容寻址的，同一张图可能被多个会话（含 fork）共享；
 * 源文件也可能被多个会话的历史引用。删掉被别处引用的对象，会让那些会话的历史读取
 * 直接失败（本体读取时会校验引用），所以这是删盘前的硬前提。
 *
 * 只认「同一个 tool/result 事件内、与 image 块同排出现的 data.meta.path」——
 * 普通代码文件也会带 meta.path，绝不能把 `.cpp` 之类当成图片源文件。
 *
 * @param home  DSH 主目录
 * @param opts  { concurrency?, isCurrent?(sessionId), onProgress?, signal? }
 * @returns { sessions, files, attachments: Map, sources: Map, elapsedMs }
 */
export async function scanReferences(home, opts = {}) {
  const started = Date.now()
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_SCAN_CONCURRENCY)
  const files = listSessionLogs(home)
  const isCurrent = typeof opts.isCurrent === 'function' ? opts.isCurrent : () => false
  const signal = opts.signal
  let cursor = 0
  let done = 0
  const attachments = new Map()
  const sources = new Map()

  const bump = (map, key, sessionId, weight) => {
    if (key === '') return
    const entry = map.get(key) ?? { sessions: new Set(), weight: 0 }
    entry.sessions.add(sessionId)
    entry.weight += weight
    map.set(key, entry)
  }

  const work = async () => {
    for (;;) {
      if (signal?.aborted === true) return
      const index = cursor
      cursor += 1
      if (index >= files.length) return
      const file = files[index]
      const sessionId = sessionIdOfLogPath(home, file.path)
      // ⚠️ 必须用异步读：同步版一次 400 ms，扫全库时会把宿主事件循环堵好几秒。
      const events = await readSessionEventsAsync(file.path)
      let attachmentRefs = 0
      let sourceRefs = 0
      for (const event of events) {
        if (event === null) continue
        if (event.type === 'image/offload') continue
        const message = messageOf(event)
        if (message === null) continue
        const captured = typeof event.data?.meta?.path === 'string' ? event.data.meta.path.trim() : ''
        for (const { block } of imageBlocksOf(message)) {
          const attachmentId = typeof block?.attachment?.attachmentId === 'string' ? block.attachment.attachmentId.toLowerCase() : ''
          if (attachmentId !== '') {
            bump(attachments, attachmentId, sessionId, 1)
            attachmentRefs += 1
          }
          // 源文件：只在这个事件确实带 image 块时，才把 meta.path 当作图片来源。
          if (captured !== '') {
            bump(sources, foldSourceKey(captured), sessionId, 1)
            sourceRefs += 1
          }
        }
      }
      files[index] = { ...file, sessionId, attachmentRefs, sourceRefs }
      done += 1
      if (typeof opts.onProgress === 'function') opts.onProgress({ done, total: files.length })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, work))

  // 当前会话的引用单独标出来：删自己会话里的图不算「别处引用」。
  for (const map of [attachments, sources]) {
    for (const entry of map.values()) {
      entry.elsewhere = [...entry.sessions].filter((id) => id !== '' && !isCurrent(id))
      entry.currentOnly = entry.elsewhere.length === 0
    }
  }

  return {
    sessions: files.length,
    files,
    attachments,
    sources,
    elapsedMs: Date.now() - started,
  }
}

/** 源文件在引用索引里的键：折叠路径（大小写/分隔符/尾分隔符无关）。 */
export function foldSourceKey(target) {
  return foldPath(target)
}

/**
 * 全部会话日志的「指纹」：`路径|字节|mtime`。
 *
 * 宿主用它给引用索引做缓存键 —— 只要没有日志变化（大小与修改时间都不变），
 * 就不必重扫全库（一次扫描要读十几 MB、解压上百 MB，几秒级）。
 */
export function logsFingerprint(home) {
  const parts = []
  for (const entry of listSessionLogs(home)) {
    let size = 0
    let mtime = 0
    try {
      const info = statSync(entry.path)
      size = info.size
      mtime = Math.floor(info.mtimeMs)
    } catch {
      /* 读不到就按 0 记，指纹自然会变化 */
    }
    parts.push(entry.path + '|' + String(size) + '|' + String(mtime))
  }
  parts.sort()
  return parts.join('\n')
}

/** 列出全部会话日志文件（目录枚举 + 优先取版本号最高的主体）。 */
export function listSessionLogs(home) {
  const root = sessionLogsRoot(home)
  const out = []
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const wsDir = join(root, workspace.name)
    let entries
    try {
      entries = readdirSync(wsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(wsDir, entry.name)
      if (entry.isDirectory()) {
        const log = pickSessionLog(full)
        if (log !== '') out.push({ path: log, session: entry.name })
      } else if (/\.jsonl(\.zstd)?$/i.test(entry.name)) {
        // 老版单文件布局。
        out.push({ path: full, session: entry.name.replace(/\.jsonl(\.zstd)?$/i, '') })
      }
    }
  }
  return out
}

/** 在一个会话目录里挑主体文件：版本号最大者优先。 */
function pickSessionLog(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return ''
  }
  let best = ''
  let bestVersion = -1
  for (const name of names) {
    const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/i.exec(name)
    if (match === null) {
      if (/\.jsonl(\.zstd)?$/i.test(name) && best === '') best = join(dir, name)
      continue
    }
    const version = Number(match[1])
    if (version > bestVersion) {
      bestVersion = version
      best = join(dir, name)
    }
  }
  return best
}

/** 从日志路径反解会话 id（磁盘目录名就是 id，两种写法都可能在）。 */
export function sessionIdOfLogPath(home, file) {
  const root = resolve(sessionLogsRoot(home))
  const target = resolve(file)
  if (!insideFolded(root, target)) return ''
  const relative = target.slice(root.length).split(sep).filter((part) => part !== '')
  return relative.length >= 2 ? relative[1] : relative[0] ?? ''
}

// ---------------------------------------------------------------- 报告与删除

/**
 * 逐项判定「这个源文件能不能删」，并把引用情况合并进来。
 *
 * @param home
 * @param items   [{ attachmentId, heldPath }]
 * @param refs    scanReferences 的结果（可为 null：没有引用数据时一律按「不删」处理）
 * @param opts    { env?, dshInstall?, workspaceRoot?, isCurrent?(sessionId), allowReferenced? }
 * @returns [{ kind, path, attachmentId, ok, action, reason, scope, risk, bytes, referencedBy }]
 */
export function planDiskDeletion(home, items, refs, opts = {}) {
  const list = Array.isArray(items) ? items : []
  const allowReferenced = opts.allowReferenced === true
  const isCurrent = typeof opts.isCurrent === 'function' ? opts.isCurrent : () => false
  const forCurrent = (entry) =>
    entry === undefined ? [] : [...entry.sessions].filter((id) => id !== '' && isCurrent(id))

  const results = []
  const plannedAttachments = new Set()
  const plannedPaths = new Set()

  for (const item of list) {
    // ① 源文件
    const source = typeof item?.heldPath === 'string' ? item.heldPath.trim() : ''
    if (source !== '') {
      const reported = []
      const verdict = classifySourceFile(source, opts)
      const key = foldSourceKey(source)
      const ref = refs?.sources?.get(key)
      const elsewhere = ref?.elsewhere ?? []
      const mine = forCurrent(ref)
      if (plannedPaths.has(key)) {
        reported.push({ kind: 'source', path: source, action: 'ALREADY_PLANNED', ok: false, reason: 'DUPLICATE_IN_BATCH' })
      } else if (!verdict.ok) {
        reported.push({
          kind: 'source',
          path: source,
          action: 'SKIPPED',
          ok: false,
          reason: verdict.reason,
          scope: verdict.scope ?? null,
          risk: verdict.risk ?? null,
          referencedBy: elsewhere,
        })
      } else if (elsewhere.length > 0 && !allowReferenced) {
        reported.push({
          kind: 'source',
          path: source,
          action: 'SKIPPED',
          ok: false,
          reason: 'SHARED_WITH_OTHER_SESSION',
          scope: verdict.scope,
          risk: verdict.risk,
          bytes: verdict.bytes,
          referencedBy: elsewhere,
          forceable: true,
        })
      } else {
        plannedPaths.add(key)
        reported.push({
          kind: 'source',
          path: source,
          action: 'DELETE',
          ok: true,
          scope: verdict.scope,
          risk: verdict.risk,
          bytes: verdict.bytes,
          referencedBy: elsewhere,
          referencedByCurrent: mine.length,
          forced: elsewhere.length > 0,
        })
      }
      for (const entry of reported) results.push(entry)
    }

    // ② 附件对象
    const attachmentId = typeof item?.attachmentId === 'string' ? item.attachmentId.trim().toLowerCase() : ''
    if (attachmentId === '') continue
    if (plannedAttachments.has(attachmentId)) {
      results.push({ kind: 'attachment', attachmentId, action: 'ALREADY_PLANNED', ok: false, reason: 'DUPLICATE_IN_BATCH' })
      continue
    }
    const verdict = classifyAttachmentObject(home, attachmentId, opts)
    const ref = refs?.attachments?.get(attachmentId)
    const elsewhere = ref?.elsewhere ?? []
    const mine = forCurrent(ref)
    if (!verdict.ok) {
      results.push({
        kind: 'attachment',
        attachmentId,
        path: verdict.path ?? attachmentObjectPath(home, attachmentId),
        action: 'SKIPPED',
        ok: false,
        reason: verdict.reason,
        referencedBy: elsewhere,
      })
      continue
    }
    if (elsewhere.length > 0 && !allowReferenced) {
      results.push({
        kind: 'attachment',
        attachmentId,
        path: verdict.path,
        action: 'SKIPPED',
        ok: false,
        reason: 'SHARED_WITH_OTHER_SESSION',
        bytes: verdict.bytes,
        referencedBy: elsewhere,
        forceable: true,
      })
      continue
    }
    plannedAttachments.add(attachmentId)
    results.push({
      kind: 'attachment',
      attachmentId,
      path: verdict.path,
      action: 'DELETE',
      ok: true,
      bytes: verdict.bytes,
      referencedBy: elsewhere,
      referencedByCurrent: mine.length,
      forced: elsewhere.length > 0,
    })
  }

  return results
}

/**
 * 执行磁盘删除（**破坏性、不可恢复、不进回收站**）。
 *
 * 只删 planDiskDeletion 里 action === 'DELETE' 的项；每一项在删除前**再复核一次**
 * 「它仍然落在允许范围内」，不做通配、不递归删目录。
 *
 * @param opts 与判定同一套（env/home/workspaceRoot）；`opts.ops` 可注入替代操作
 *             （离线测试用来记录「本来会删什么」而不真的删）。
 * @returns { deleted[], skipped[], failed[], reclaimedBytes }
 */
export function executeDiskDeletion(home, plan, opts = {}) {
  const ops = opts.ops ?? {}
  const remove = typeof ops.remove === 'function' ? ops.remove : rmSync
  const sizeOf = typeof ops.sizeOf === 'function' ? ops.sizeOf : (file) => statSync(file).size
  const entries = Array.isArray(plan) ? plan : []
  const deleted = []
  const skipped = []
  const failed = []
  const seenSkipped = new Set()
  let reclaimedBytes = 0

  /** 记录跳过项（按路径去重：同一路径的源文件与附件两条目只需报一次）。 */
  const noteSkipped = (kind, path, reason) => {
    const key = String(path)
    if (path !== '' && seenSkipped.has(key)) return
    if (path !== '') seenSkipped.add(key)
    skipped.push({ kind: kind ?? '', path: path ?? '', reason: reason ?? 'NOT_PLANNED' })
  }

  for (const entry of entries) {
    if (entry?.action !== 'DELETE') {
      noteSkipped(entry?.kind, entry?.path, entry?.reason ?? 'NOT_PLANNED')
      continue
    }
    const target = entry.path
    // 删除前复核：源文件必须仍被判定为可删；附件对象必须仍在对象根内且摘要相符。
    if (entry.kind === 'source') {
      const recheck = classifySourceFile(target, opts)
      if (!recheck.ok) {
        noteSkipped('source', target, 'RECHECK_FAILED:' + recheck.reason)
        continue
      }
    } else if (entry.kind === 'attachment') {
      const recheck = classifyAttachmentObject(home, entry.attachmentId, opts)
      if (!recheck.ok || recheck.path !== target) {
        noteSkipped('attachment', target, 'RECHECK_FAILED:' + (recheck.reason ?? 'PATH_MISMATCH'))
        continue
      }
    } else {
      noteSkipped(entry.kind, target, 'UNKNOWN_KIND')
      continue
    }
    let bytes = 0
    try {
      bytes = sizeOf(target)
    } catch {
      bytes = 0
    }
    try {
      remove(target, { force: false })
      deleted.push({ kind: entry.kind, path: target, attachmentId: entry.attachmentId ?? '', bytes })
      reclaimedBytes += bytes
    } catch (error) {
      failed.push({ kind: entry.kind, path: target, error: String(error?.message ?? error) })
    }
  }

  return { deleted, skipped, failed, reclaimedBytes }
}

// ---------------------------------------------------------------- 导出（测试用）

/** 供离线测试使用；不属于插件契约。 */
export const internals = {
  ZSTD_FRAME_MAGIC_BUFFER,
  messageOf,
  seqOf,
  defaultSurfaceSeqs,
  sum,
  pickSessionLog,
  fileSizeOf,
  IMAGE_EVENT_TYPES,
}
