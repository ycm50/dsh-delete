/**
 * dsh-delete 的纯逻辑层 —— 零依赖（只用 node: 内置模块），因此能脱离 DSH 直接离线测试。
 *
 * 这一层只做两件事，全部以 home（DSH 主目录）为入参、不读全局状态：
 *
 *   1. **盘点**：扫磁盘，列出「每个会话在磁盘上占用了哪些路径、多大、叫什么名字、
 *      是根会话还是子 agent」。数据源是会话目录本身，而不是内存里的会话列表 ——
 *      删除工具必须能看见「内存里已经不显示、但文件还在」的残留会话。
 *
 *   2. **删除**：给定会话 id，解析出该删的路径并删除。
 *
 * ## 磁盘契约（对齐 DSH 0.2.0-rc.x 的真实布局，别再凭想象假设了）
 *
 *   - **会话目录名 = encodeSegment(会话 id)**，不是写死的 session-<uuid>。
 *     根会话的 id 形如 session-<uuid>（带前缀），**子 agent 会话的 id 是裸
 *     <uuid>**；两者都直接拿去当目录名。于是磁盘上两种名字同时存在：
 *
 *       sessions/<projectKey>/session-<uuid>/session.v4.jsonl.zstd   ← 根会话
 *       sessions/<projectKey>/<uuid>/session.v4.jsonl.zstd           ← 子 agent 会话
 *
 *     老版本还可能把主体存成单个文件 session-<uuid>.jsonl.zstd。所以任何
 *     「把磁盘名改写成另一种 id 形态」的做法都会立刻错位：轻则同一会话在面板里
 *     出现两行（一行只有体积、一行只有标题），重则子 agent 会话根本扫不到、
 *     永远删不掉。
 *
 *   - **会话主体第一行就是 header**（zstd 拼接帧的第一帧）：
 *       { type:'session', version, id, createdAt, cwd, parentSession?, origin?, delegationDepth, agentPreset? }
 *     header.id 是权威 id；header.origin === 'subagent' / header.parentSession
 *     是权威的「子 agent」判据。header 比任何缓存都新、都准 ——
 *     「这条会话到底是什么」只认它。
 *
 *   - **标题是日志里的 session/title 事件**，投影缓存
 *     storages/session_projcache/sessions/<id>.json 里存着它的缓存副本
 *     （record.rows.title.val）。缓存不一定有（子 agent 会话常常没有），
 *     所以标题要么读缓存、要么回退到日志本身。
 *
 * 安全边界（这是本插件唯一真正危险的地方，所以规则写在最前面）：
 *   - 会话 id 必须是合法形状（裸 UUID 或 session-<UUID>，大小写不敏感），
 *     否则一律拒绝 —— 这样 ../.. 之类不可能构造出来，路径穿越在入口就被堵死。
 *   - 每一条待删路径都要通过 insideRoot() 复核，必须真的落在 sessions 根
 *     或 projcache 根之内；复核不通过就丢弃。
 *   - 只删「名字能反解出该会话 id」的条目（会话目录 / 主体文件 / 投影文档），
 *     绝不按目录名模糊匹配。
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import * as zlib from 'node:zlib'

// ------------------------------------------------------------------ 会话 id

/** 会话 id 的核心形状：8-4-4-4-12 的十六进制 UUID。 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 根会话 id 的前缀。子 agent 会话的 id 不带它。 */
export const SESSION_PREFIX = 'session-'

/** 老版（无前缀）会话 id 形状。 */
export const SESSION_ID_RE = UUID_RE

/** 现版根会话 id 形状：session-<UUID>。 */
export const PREFIXED_SESSION_ID_RE =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 磁盘条目名 → 会话 id 的**形状**判据（两种前缀形态都认，允许尾巴上的扩展名，
 * 用于老版「主体即单个文件」的布局）。
 */
export const NAME_TO_ID_RE =
  /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[^/\\]*)?$/i

/** 该字符串是否是一个合法的会话 id（裸 UUID 或 session-<UUID>）。 */
export function isSessionId(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  return UUID_RE.test(s) || PREFIXED_SESSION_ID_RE.test(s)
}

/**
 * 会话 id 的规范化名字：剥掉可选的 session- 前缀。
 * 非字符串/空串原样返回（调用方自己判断合法性）。
 */
export function uuidOf(id) {
  const s = typeof id === 'string' ? id.trim() : ''
  if (!s.toLowerCase().startsWith(SESSION_PREFIX)) return s
  return s.slice(SESSION_PREFIX.length)
}

/**
 * 同一会话在磁盘/快照两个世界里可能出现的全部 id 写法（全部小写）。
 *
 * DSH 的两种写法（session-<uuid> 与 <uuid>）指向同一批文件，面板合并行、
 * 删除匹配都必须按「别名集合是否相交」来判断，而不是字符串相等。
 * 非 UUID 形状的 id 没有别名可言，返回空数组。
 */
export function aliasesOf(id) {
  const u = uuidOf(id).toLowerCase()
  if (!UUID_RE.test(u)) return []
  return [u, SESSION_PREFIX + u]
}

/**
 * 反解 DSH 的路径段编码（见 dsh-session-persistence-jsonl 的 encodeSegment）：
 * 安全字符原样保留，其余（含 ~ 自己）编码成 ~XXXX（UTF-16 码元的大写十六进制）。
 */
export function decodeSegment(segment) {
  const raw = typeof segment === 'string' ? segment : ''
  if (raw.indexOf('~') < 0) return raw
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '~') {
      out += raw[i]
      continue
    }
    const hex = raw.slice(i + 1, i + 5)
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16))
      i += 4
    } else {
      out += '~' // 不是编码产物：原样保留
    }
  }
  return out
}

/** encodeSegment 的正向实现（与 DSH 逐字符对齐，便于测试与自查）。 */
export function encodeSegment(raw) {
  const s = typeof raw === 'string' ? raw : ''
  if (s === '') throw new Error('cannot encode an empty path segment')
  if (s === '.') return '~002E'
  if (s === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 磁盘条目名 → 会话 id。
 * 兼容三种布局：
 *   - 目录 session-<uuid> / <uuid>（现版；名字就是 id）
 *   - 文件 session-<uuid>.jsonl.zstd / <uuid>.jsonl.zstd（老版单文件）
 *   - 任意 encodeSegment 产物（id 里出现非安全字符时才会出现）
 * 认不出来一律返回空串，绝不猜。
 */
export function entryNameToId(name) {
  const raw = typeof name === 'string' ? name : ''
  if (raw === '' || raw.length > 400) return ''
  const m = NAME_TO_ID_RE.exec(raw)
  if (m !== null) return m[0].replace(/\.[^/\\]*$/, '')
  const decoded = decodeSegment(raw)
  if (decoded !== raw && isSessionId(decoded)) return decoded
  return ''
}

/**
 * 投影缓存文档名 → 会话 id。
 * 现版是 <id>.json（domain 的 per-record 布局：文件名就是记录键）；
 * 记录校验失败时 domain 会把它挪成 <id>.json.bak.<stamp>，那也属于这个会话。
 */
export function docNameToId(name) {
  const raw = typeof name === 'string' ? name : ''
  if (raw === '' || raw.length > 400) return ''
  const cut = raw.indexOf('.json')
  if (cut <= 0) return ''
  const stem = raw.slice(0, cut)
  if (isSessionId(stem)) return stem
  const decoded = decodeSegment(stem)
  return isSessionId(decoded) ? decoded : ''
}

/** target 是否落在 root 之内（含 root 自身）。删除前对每条路径复核用它。 */
export function insideRoot(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r) return true
  return t.startsWith(r.endsWith(sep) ? r : r + sep)
}

// ------------------------------------------------------------------ 基础工具

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function fileSize(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/** 目录总字节数（递归；读不到的条目计 0，不抛）。 */
export function dirBytes(dir) {
  let total = 0
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry)
    if (isDir(full)) total += dirBytes(full)
    else total += fileSize(full)
  }
  return total
}

/** 只读文件开头若干字节 —— 大日志只取头部，别把上百 MB 拖进内存。 */
function readHeadBytes(file, max) {
  if (!Number.isFinite(max) || max <= 0) return null
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.allocUnsafe(max)
    const read = readSync(fd, buffer, 0, max, 0)
    return read > 0 ? buffer.subarray(0, read) : Buffer.alloc(0)
  } catch {
    return null
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* 关不掉也不该影响结果 */
      }
    }
  }
}

// ------------------------------------------------------------------ 日志读取

/** zstd 帧魔数（小端读出的值）。 */
const ZSTD_MAGIC = 4247762216

/** 读取头部时最多看多少字节：header 行总是很小的。 */
const HEADER_READ_BYTES = 256 * 1024

/** 找标题时的压缩字节预算与帧数上限（标题总在开头几帧里）。 */
const TITLE_SCAN_BYTES = 4 * 1024 * 1024
const TITLE_SCAN_FRAMES = 256

/** 运行时没有 zstd（老 Node）时降级：不读日志，只靠投影缓存。 */
const zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null

/**
 * 扫描 zstd 拼接帧的边界，**不解析块内容**（只看帧头与块头的长度字段）。
 * 结构不完整就停下并返回已经找到的完整帧 —— 半截日志不该让盘点失败。
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, torn: true }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, torn: true }
    offset += 4
    if (offset === buffer.length) return { frames, torn: true }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, torn: true } // 保留位：结构不可信
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, torn: true }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, torn: true }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, torn: true } // 保留块类型
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, torn: true }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, torn: true }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length >= maxFrames) break
  }
  return { frames, torn: false }
}

/** 单帧解压；坏帧返回空串（坏日志不该让整个盘点失败）。 */
function decodeZstdFrame(buffer, start, end) {
  if (zstdDecompressSync === null) return ''
  try {
    return zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  } catch {
    return ''
  }
}

function isZstdFile(file) {
  return typeof file === 'string' && file.toLowerCase().endsWith('.zstd')
}

/** 文本的第一行。 */
function firstLine(text) {
  const nl = text.indexOf('\n')
  return nl < 0 ? text : text.slice(0, nl)
}

/**
 * 在一个会话目录里挑出主体文件：优先格式版本号最大的 session.v<N>.jsonl[.zstd]，
 * 其次任意 *.jsonl[.zstd] / session.json。挑不到返回空串。
 */
export function findSessionLog(dir) {
  const names = safeReaddir(dir)
  let best = ''
  let bestVersion = -1
  for (const name of names) {
    const m = /^session\.v(\d+)\.jsonl(\.zstd)?$/i.exec(name)
    if (m === null) continue
    const version = Number(m[1])
    if (version > bestVersion) {
      bestVersion = version
      best = join(dir, name)
    }
  }
  if (best !== '') return best
  for (const name of names) {
    if (/\.jsonl(\.zstd)?$/i.test(name) || /^session\.json$/i.test(name)) return join(dir, name)
  }
  return ''
}

/** 把解析出的 header 规范成面板能用的形状；形状不对返回 null。 */
function normalizeHeader(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  if (!isSessionId(id)) return null
  const meta = { id }
  if (typeof parsed.cwd === 'string' && parsed.cwd !== '') meta.cwd = parsed.cwd
  if (Number.isFinite(parsed.createdAt)) meta.createdAt = Number(parsed.createdAt)
  if (typeof parsed.parentSession === 'string' && parsed.parentSession !== '') meta.parentId = parsed.parentSession
  if (parsed.origin === 'subagent' || meta.parentId !== undefined) meta.isSubagent = true
  if (Number.isFinite(parsed.delegationDepth)) meta.delegationDepth = Number(parsed.delegationDepth)
  if (typeof parsed.agentPreset === 'string' && parsed.agentPreset !== '') meta.agentPreset = parsed.agentPreset
  return meta
}

/**
 * 读一个会话主体文件的 header（第一行）。
 * @returns 规范化后的元数据，或 null（读不到 / 不是会话主体）。
 */
export function readSessionHeader(file) {
  const buf = readHeadBytes(file, HEADER_READ_BYTES)
  if (buf === null || buf.length === 0) return null
  let text
  if (isZstdFile(file) || (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC)) {
    const { frames } = scanZstdFrames(buf, 1)
    if (frames.length === 0) return null
    text = decodeZstdFrame(buf, frames[0].start, frames[0].end)
  } else {
    text = buf.toString('utf8')
  }
  if (text === '') return null
  try {
    return normalizeHeader(JSON.parse(firstLine(text)))
  } catch {
    return null
  }
}

/** 从一段 JSONL 文本里找第一条 session/title 事件。 */
function titleFromLines(text) {
  if (typeof text !== 'string' || text === '' || text.indexOf('session/title') < 0) return ''
  for (const line of text.split('\n')) {
    if (line.indexOf('session/title') < 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.type !== 'session/title') continue
    const title = parsed.data?.title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  }
  return ''
}

/**
 * 从会话日志里读标题（session/title 事件，取第一条）。
 *
 * 有预算上限：标题在首轮对话后不久就写入，没必要为一个几十 MB 的日志全量解压。
 * 超出预算就放弃并返回空串 —— 面板少显示一个标题，总好过卡住整个盘点。
 */
export function readDurableTitle(file, options = {}) {
  const budget = Number.isFinite(options.budgetBytes) ? options.budgetBytes : TITLE_SCAN_BYTES
  const maxFrames = Number.isFinite(options.maxFrames) ? options.maxFrames : TITLE_SCAN_FRAMES
  const buf = readHeadBytes(file, budget)
  if (buf === null || buf.length === 0) return ''
  if (!isZstdFile(file) && !(buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC)) {
    return titleFromLines(buf.toString('utf8'))
  }
  const { frames } = scanZstdFrames(buf, maxFrames)
  let carry = '' // 帧边界可能切在行中间：留半行和后一帧拼起来
  for (const frame of frames) {
    const text = carry + decodeZstdFrame(buf, frame.start, frame.end)
    const nl = text.lastIndexOf('\n')
    const complete = nl >= 0 ? text.slice(0, nl) : ''
    carry = nl >= 0 ? text.slice(nl + 1) : text
    const found = titleFromLines(complete)
    if (found !== '') return found
  }
  return titleFromLines(carry)
}

// ------------------------------------------------------------------ 投影缓存

/**
 * 从一个投影缓存 JSON 里抽出可用的会话元数据。
 *
 * 这些 JSON 是「按行投影」的快照（{version, record:{identity, rows}}），
 * 每一行形如 {ver, seq, val}，其中 val 是**投影状态**（不是 wire 视图）。
 * 这里只取稳定、有用的几项：
 *   - identity.cwd / identity.createdAt
 *   - rows.title.val                         → 会话标题
 *   - rows.subagent.val.identity             → 本会话自己是子 agent（mode/label）
 *   - rows.sessionListMetadata.val           → blank / lastPromptAt
 *   - rows.titleInput.val.first.text         → 子 agent 的首条提示里显式写着父 id
 *
 * 任何一项缺失或类型不对都只是不填，绝不抛 —— 坏 JSON 不该让整个面板打不开。
 */
export function readProjectionMeta(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const record = json?.record
  if (record === null || typeof record !== 'object') return null
  const identity = record.identity ?? {}
  const rows = record.rows ?? {}
  const out = {}

  if (typeof identity.cwd === 'string' && identity.cwd !== '') out.cwd = identity.cwd
  if (typeof identity.createdAt === 'number') out.createdAt = identity.createdAt

  const title = rows?.title?.val
  if (typeof title === 'string' && title !== '') out.title = title

  // ⚠️ 历史 bug：这里曾经只看 rows.subagent 存不存在就判定「本会话是子 agent」。
  // 但 subagent 投影的状态是 { identity?: {...} } —— 普通根会话的状态是**空对象**
  // {}，于是根会话也被打上「子 agent」徽章（用户实测：根会话显示子 agent）。
  // 现在只认真正有 identity 内容的行。
  const sub = rows?.subagent?.val
  if (sub !== null && typeof sub === 'object') {
    const subIdentity = sub.identity
    if (subIdentity !== null && typeof subIdentity === 'object' && Object.keys(subIdentity).length > 0) {
      out.isSubagent = true
      if (typeof subIdentity.mode === 'string') out.subagentMode = subIdentity.mode
      if (typeof subIdentity.label === 'string' && subIdentity.label !== '') out.subagentLabel = subIdentity.label
    }
  }

  const listMeta = rows?.sessionListMetadata?.val
  if (listMeta !== null && typeof listMeta === 'object') {
    out.blank = listMeta.blank === true
    if (typeof listMeta.lastPromptAt === 'number') out.lastPromptAt = listMeta.lastPromptAt
  }

  // 老版本的磁盘侧没有 header（或者 header 太老没写 parentSession），这时子 agent
  // 的派发提示里那句 Your parent agent id is "session-<uuid>". 是唯一的血缘线索。
  // 三种形态都认：带 session- 前缀、不带前缀、以及任意位置被引号包住的 session-<uuid>。
  const firstText = rows?.titleInput?.val?.first?.text
  if (typeof firstText === 'string' && firstText !== '') {
    const m =
      /agent id is\s*["']?session-([0-9a-f-]{36})["']?/i.exec(firstText) ??
      /agent id is\s*["']?([0-9a-f-]{36})["']?/i.exec(firstText) ??
      /["']session-([0-9a-f-]{36})["']/i.exec(firstText)
    if (m !== null && isSessionId(m[1])) {
      out.parentId = SESSION_PREFIX + m[1].toLowerCase()
      out.isSubagent = true
    }
  }

  return out
}

// ------------------------------------------------------------------ 盘点

/** 会话目录根：<home>/sessions */
export function sessionsRoot(home) {
  return join(resolve(home), 'sessions')
}

/** 会话投影缓存根：<home>/storages/session_projcache/sessions */
export function projCacheRoot(home) {
  return join(resolve(home), 'storages', 'session_projcache', 'sessions')
}

/** 归一化归属键：同一会话的两种 id 写法必须落到同一个键上。 */
function identityKey(id) {
  const u = uuidOf(id).toLowerCase()
  return UUID_RE.test(u) ? u : 'raw:' + String(id).toLowerCase()
}

/** 元数据合并：header（权威）优先，投影缓存只补它没有的字段。 */
function mergeMeta(base, extra) {
  if (base === undefined) return extra === undefined ? undefined : { ...extra }
  if (extra === undefined) return { ...base }
  const out = { ...extra, ...base }
  if (base.isSubagent === true || extra.isSubagent === true) out.isSubagent = true
  if (out.subagentMode === undefined && typeof extra.subagentMode === 'string') out.subagentMode = extra.subagentMode
  if (out.subagentLabel === undefined && typeof extra.subagentLabel === 'string') out.subagentLabel = extra.subagentLabel
  return out
}

/**
 * 盘点 <home> 下的全部会话。
 *
 * @returns 数组，每项：
 *   { id, ids[], bytes, dirs[], files[], projFiles[], workspaceSlug?, meta? }
 *   - id  首选 id（header 里的 id 最权威）
 *   - ids 该会话在磁盘上出现过的全部 id 写法（两种前缀形态都在）
 *   - meta 见 readSessionHeader / readProjectionMeta
 *   按「最近活动」降序（lastPromptAt ?? createdAt ?? 0）。
 */
export function scanInventory(home) {
  const items = new Map()
  const bump = (id) => {
    const key = identityKey(id)
    let rec = items.get(key)
    if (rec === undefined) {
      rec = { id, ids: new Set([id]), bytes: 0, dirs: [], files: [], projFiles: [] }
      items.set(key, rec)
    } else {
      rec.ids.add(id)
    }
    return rec
  }

  // 1) 会话目录 / 老版单文件主体
  const root = sessionsRoot(home)
  for (const workspaceSlug of safeReaddir(root)) {
    const wsPath = join(root, workspaceSlug)
    if (!isDir(wsPath)) continue
    for (const entry of safeReaddir(wsPath)) {
      const full = join(wsPath, entry)
      if (!insideRoot(root, full)) continue
      const entryIsDir = isDir(full)
      if (!entryIsDir && !/\.(json|jsonl|jsonl\.zstd)$/i.test(entry)) continue
      const nameId = entryNameToId(entry)
      const logFile = entryIsDir ? findSessionLog(full) : full
      const header = logFile === '' ? null : readSessionHeader(logFile)
      const id = header?.id ?? nameId
      if (id === '' || !isSessionId(id)) continue
      const rec = bump(id)
      if (nameId !== '' && nameId !== id) rec.ids.add(nameId)
      if (entryIsDir) {
        rec.dirs.push(full)
        rec.bytes += dirBytes(full)
      } else {
        rec.files.push(full)
        rec.bytes += fileSize(full)
      }
      rec.workspaceSlug = workspaceSlug
      if (logFile !== '') rec.logFile = logFile
      if (header !== null) rec.meta = mergeMeta(header, rec.meta)
    }
  }

  // 2) 投影缓存（文件名就是会话 id：<id>.json，另加被挪到一边的 <id>.json.bak.<stamp>）
  const pcRoot = projCacheRoot(home)
  for (const name of safeReaddir(pcRoot)) {
    const docId = docNameToId(name)
    if (docId === '') continue
    const full = join(pcRoot, name)
    if (!insideRoot(pcRoot, full)) continue
    const rec = bump(docId)
    rec.projFiles.push(full)
    rec.bytes += fileSize(full)
    if (name.toLowerCase().endsWith('.json')) {
      const meta = readProjectionMeta(full)
      if (meta !== null) rec.meta = mergeMeta(rec.meta, meta)
    }
  }

  // 3) 还缺标题的会话：回退到日志里找（有预算上限，找不到就算了）
  for (const rec of items.values()) {
    if (typeof rec.meta?.title === 'string' && rec.meta.title !== '') continue
    if (typeof rec.logFile !== 'string' || rec.logFile === '') continue
    const title = readDurableTitle(rec.logFile)
    if (title !== '') rec.meta = { ...(rec.meta ?? {}), title }
  }

  const stamp = (rec) => rec.meta?.lastPromptAt ?? rec.meta?.createdAt ?? 0
  return [...items.values()]
    .map((rec) => ({
      id: rec.id,
      ids: [...rec.ids],
      bytes: rec.bytes,
      dirs: rec.dirs,
      files: rec.files,
      projFiles: rec.projFiles,
      ...(rec.workspaceSlug === undefined ? {} : { workspaceSlug: rec.workspaceSlug }),
      ...(rec.meta === undefined ? {} : { meta: rec.meta }),
    }))
    .sort((a, b) => stamp(b) - stamp(a))
}

// ------------------------------------------------------------------ 删除计划

/** 一个磁盘条目名可能对应的全部 id 别名（小写）。 */
function aliasesOfEntry(name) {
  const out = new Set()
  const add = (id) => {
    for (const alias of aliasesOf(id)) out.add(alias)
  }
  add(entryNameToId(name))
  add(docNameToId(name))
  const decoded = decodeSegment(name)
  if (decoded !== name && isSessionId(decoded)) add(decoded)
  return out
}

/** 该条目名是否属于目标会话（任一种 id 写法命中即算）。 */
function entryBelongsTo(name, wanted) {
  for (const alias of aliasesOfEntry(name)) {
    if (wanted.has(alias)) return true
  }
  return false
}

/**
 * 解析「删掉这个会话需要动哪些路径」，不落任何改动。
 *
 * 匹配规则：磁盘条目名反解出的 id 别名集合与目标会话的别名集合有交集即命中 ——
 * 于是 session-<uuid> 目录、裸 <uuid> 目录、老版单文件、投影文档 <id>.json
 * 及其 .bak 备份一次全部命中。
 *
 * @returns { id, ok, error?, paths[] } —— ok=false 时 paths 为空。
 */
export function planRemoval(home, id) {
  const clean = typeof id === 'string' ? id.trim() : ''
  const wanted = new Set(aliasesOf(clean))
  if (wanted.size === 0) return { id: String(id), ok: false, error: 'BAD_ID', paths: [] }
  const paths = new Set()

  const root = sessionsRoot(home)
  for (const workspaceSlug of safeReaddir(root)) {
    const wsPath = join(root, workspaceSlug)
    if (!isDir(wsPath)) continue
    for (const entry of safeReaddir(wsPath)) {
      const full = join(wsPath, entry)
      if (!insideRoot(root, full)) continue
      if (!entryBelongsTo(entry, wanted)) continue
      paths.add(full)
    }
  }

  const pcRoot = projCacheRoot(home)
  for (const name of safeReaddir(pcRoot)) {
    const full = join(pcRoot, name)
    if (!insideRoot(pcRoot, full)) continue
    if (!entryBelongsTo(name, wanted)) continue
    paths.add(full)
  }

  return { id: clean, ok: true, paths: [...paths] }
}

/**
 * 删除一批会话。
 *
 * @param home  DSH 主目录
 * @param ids   会话 id 数组（非数组/非法项会被逐条拒绝，不影响其余）
 * @param opts  { dryRun?:boolean, keepProjCache?:boolean }
 * @returns 每条：{ id, ok, dryRun?, paths[] | removed[], failed[], emptyDisk? }
 */
export function deleteSessions(home, ids, opts = {}) {
  const { dryRun = false, keepProjCache = false } = opts
  const list = Array.isArray(ids) ? ids : []
  const pcRoot = projCacheRoot(home)
  const results = []

  for (const id of list) {
    const plan = planRemoval(home, id)
    if (!plan.ok) {
      results.push(plan)
      continue
    }
    const paths = keepProjCache ? plan.paths.filter((p) => !insideRoot(pcRoot, p)) : plan.paths
    if (dryRun) {
      results.push({ id: plan.id, ok: true, dryRun: true, paths })
      continue
    }
    const removed = []
    const failed = []
    for (const p of paths) {
      // 双重复核：即便 planRemoval 已经查过，删除前再确认一次自己仍在允许的根内。
      const allowed = insideRoot(sessionsRoot(home), p) || insideRoot(pcRoot, p)
      if (!allowed) {
        failed.push({ path: p, error: 'OUTSIDE_ROOT' })
        continue
      }
      try {
        rmSync(p, { recursive: true, force: true })
        removed.push(p)
      } catch (error) {
        failed.push({ path: p, error: String(error?.message ?? error) })
      }
    }
    results.push({
      id: plan.id,
      ok: failed.length === 0,
      removed,
      failed,
      // 磁盘上已经没有这个会话的任何痕迹（例如文件早被删掉、只剩宿主内存里的行）。
      ...(removed.length === 0 && failed.length === 0 ? { emptyDisk: true } : {}),
    })
  }

  return results
}
