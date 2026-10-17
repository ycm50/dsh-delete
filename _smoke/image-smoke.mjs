/**
 * 「图片管理」纯逻辑的离线测试 —— 零依赖、**不碰真实 DSH 数据**。
 *
 * 覆盖：
 *   - 路径安全：折叠规范化、系统区**连子路径一起挡**、盘根/UNC/网络/非普通文件、
 *     以及用户主目录（含 AppData）**放行**
 *   - 附件对象：id ↔ 磁盘路径、内容摘要复核、坏 id 拒绝
 *   - 日志读取：zstd 拼接帧、明文 .jsonl、坏帧不抛
 *   - 盘点：表面节点、深度优先图片序号、已摘除标记（投影 / 事件两条来源）、合计口径
 *   - 摘除计划：seq 用真实事件序号、索引严格递增、已摘除/越界/非消息事件一律拒绝、重复勾选幂等
 *   - 引用扫描：全库统计「被其它会话引用」与「只被当前会话引用」
 *   - 磁盘删除：共享项跳过、执行前复核、摘要不符拒绝、真正落盘
 *
 * 运行：node _smoke/image-smoke.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  attachmentObjectPath,
  buildOffloadEvent,
  buildSessionModel,
  buildSessionModelFromSession,
  classifyAttachmentObject,
  classifySourceFile,
  costBySeq,
  usageAnchors,
  countVariantFiles,
  estimateBreakCost,
  eventAtSeq,
  executeDiskDeletion,
  foldPath,
  insideFolded,
  inventoryOccurrences,
  isDriveRoot,
  isNetworkPath,
  listSessionLogs,
  logsFingerprint,
  parseEventLines,
  planDiskDeletion,
  planOffload,
  readSessionEvents,
  readSessionEventsAsync,
  scanReferences,
  sessionIdOfLogPath,
} from '../lib/image-logic.js'

// --------------------------------------------------------------- 测试框架

let passed = 0
const failures = []

function ok(condition, label) {
  if (condition) passed += 1
  else failures.push(label)
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(a === b, label + ' —— 期望 ' + b + '，实际 ' + a)
}

// --------------------------------------------------------------- 造数据

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-image-smoke-'))
const HOME = join(ROOT, 'dsh-home')
const ENV = {
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  SystemDrive: 'C:',
  USERPROFILE: 'C:\\Users\\Administrator',
}
const DSH_INSTALL = join(ROOT, 'dsh-install')
const WORKSPACE = join(ROOT, 'workspace')

/** 测试用的源文件目录（工作区内）。 */
const SHOTS = join(WORKSPACE, 'TMP')

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function attachmentId(data) {
  return 'sha256:' + sha256(data)
}

/** 造一个内容寻址的附件对象。 */
function putObject(bytes) {
  const id = attachmentId(bytes)
  const path = attachmentObjectPath(HOME, id)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return { id, path }
}

/** 会话 header 行（真实日志第一行；**位置 0、自身 seq 0**，不参与 seq→位置 索引）。 */
function headerEvent(id, cwd) {
  return { type: 'session', version: 4, seq: 0, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 }
}

/** 造一个 tool/result 事件：图片块 + 源文件路径（与真实日志同形状）。 */
function imageEvent(seq, { attachment, sourcePath, time, turn = 1, offloaded = false }) {
  return {
    type: 'tool/result',
    seq,
    time,
    data: {
      turn,
      message: {
        role: 'tool',
        content: [
          { type: 'text', text: '<path>' + sourcePath + '</path>' },
          {
            type: 'image',
            attachment: { attachmentId: attachment.id, mediaType: 'image/png', bytes: attachment.bytes, width: 10, height: 10, name: attachment.name ?? 'a.png' },
            ...(offloaded ? { offloaded: true } : {}),
          },
        ],
      },
      meta: { path: sourcePath },
    },
    surfaceOp: 'append',
  }
}

/** 造一个 image/offload 事件。 */
function offloadEvent(seq, targets) {
  return { type: 'image/offload', seq, time: 1, data: { targets } }
}

/** 把事件数组写成 zstd 拼接帧的会话日志（每行一帧，模拟真机）。 */
function writeZstdLog(file, events) {
  mkdirSync(dirname(file), { recursive: true })
  const frames = events.map((event) => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
  writeFileSync(file, Buffer.concat(frames))
}

/** 把事件数组写成明文 .jsonl。 */
function writePlainLog(file, events) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

const SESSION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SESSION_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

const BYTES_A = Buffer.from('fake png bytes A')
const BYTES_B = Buffer.from('fake png bytes B')
const OBJ_A = putObject(BYTES_A)
const OBJ_B = putObject(BYTES_B)
const SRC_A = join(SHOTS, 'shot_a.png')
const SRC_B = join(SHOTS, 'shot_b.png')
const SRC_DUP = join(SHOTS, 'shared_shot.png')
mkdirSync(SHOTS, { recursive: true })
writeFileSync(SRC_A, 'a')
writeFileSync(SRC_B, 'b')
writeFileSync(SRC_DUP, 'dup')

// 会话 A：**故意让位置 ≠ seq**（真机实测就是这样：header 占位置 0，第一条事件 seq 0 落在位置 1，
// 且中途还有别的 seq 空洞），这样任何「拿 seq 当数组下标」的写法都会立刻测挂。
//   位置 0: header(seq 0)
//   位置 1: tool/result(seq 0)  ← 图片 A / 源文件 SRC_A
//   位置 2: assistant/message(seq 1)
//   位置 3: image/offload(seq 2)  → 摘除 seq 0 的图片 0
//   位置 4: assistant/message(seq 5) ← 制造 seq 空洞
//   位置 5: tool/result(seq 6)  ← 图片 B / 源文件 SRC_B
//   位置 6: tool/result(seq 7)  ← 图片 A 再次出现 / 源文件 SRC_DUP（并被会话 B 引用）
writeZstdLog(join(HOME, 'sessions', '--ws--', SESSION_A, 'session.v4.jsonl.zstd'), [
  headerEvent(SESSION_A, WORKSPACE),
  imageEvent(0, { attachment: { ...OBJ_A, bytes: BYTES_A.length, name: 'a.png' }, sourcePath: SRC_A, time: 100 }),
  { type: 'assistant/message', seq: 1, time: 110, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }, surfaceOp: 'append' },
  offloadEvent(2, [{ seq: 0, imageIndexes: [0] }]),
  { type: 'assistant/message', seq: 5, time: 115, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'again' }] } }, surfaceOp: 'append' },
  imageEvent(6, { attachment: { ...OBJ_B, bytes: BYTES_B.length, name: 'b.png' }, sourcePath: SRC_B, time: 120 }),
  imageEvent(7, { attachment: { ...OBJ_A, bytes: BYTES_A.length, name: 'a.png' }, sourcePath: SRC_DUP, time: 130, offloaded: true }),
])

// 会话 B：也引用 OBJ_A 与 SRC_DUP（用来验证「被其它会话引用」）
writeZstdLog(join(HOME, 'sessions', '--ws--', SESSION_B, 'session.v4.jsonl.zstd'), [
  headerEvent(SESSION_B, WORKSPACE),
  imageEvent(0, { attachment: { ...OBJ_A, bytes: BYTES_A.length, name: 'a.png' }, sourcePath: SRC_DUP, time: 200 }),
])

const LOG_A = join(HOME, 'sessions', '--ws--', SESSION_A, 'session.v4.jsonl.zstd')

// --------------------------------------------------------------- 1. 路径安全

{
  eq(foldPath('C:\\Windows\\System32\\..\\Temp\\x.png'), 'c:\\windows\\temp\\x.png', 'foldPath 拉平 ..')
  ok(insideFolded('C:\\Windows', 'C:\\windows\\Temp\\x.png'), 'insideFolded 大小写不敏感')

  // 系统区：连子路径一起挡
  eq(classifySourceFile('C:\\Windows\\notepad.exe', { env: ENV, home: HOME }).reason, 'FORBIDDEN_ROOT:windows', 'Windows 子路径被挡')
  eq(classifySourceFile('C:\\Windows\\System32\\drivers\\etc\\hosts', { env: ENV, home: HOME }).reason, 'FORBIDDEN_ROOT:windows', 'Windows 深层子路径被挡')
  eq(classifySourceFile('C:\\Program Files\\App\\a.png', { env: ENV, home: HOME }).reason, 'FORBIDDEN_ROOT:program-files', 'Program Files 子路径被挡')
  eq(classifySourceFile('C:\\Program Files (x86)\\App\\a.png', { env: ENV, home: HOME }).reason, 'FORBIDDEN_ROOT:program-files-x86', 'Program Files (x86) 子路径被挡')
  eq(classifySourceFile('C:\\ProgramData\\Vendor\\a.png', { env: ENV, home: HOME }).reason, 'FORBIDDEN_ROOT:programdata', 'ProgramData 子路径被挡')
  eq(classifySourceFile('C:\\Users\\Administrator\\.dsh\\x.png', { env: ENV, home: 'C:\\Users\\Administrator\\.dsh', dshInstall: DSH_INSTALL }).reason, 'FORBIDDEN_ROOT:dsh-home', 'DSH 主目录被挡')
  const insideHome = join(HOME, 'sessions', 'x.png')
  mkdirSync(dirname(insideHome), { recursive: true })
  writeFileSync(insideHome, 'x')
  eq(classifySourceFile(insideHome, { env: ENV, home: HOME }).reason, 'FORBIDDEN_ROOT:dsh-home', '本测试 home 内的路径被挡（守卫优先于存在性）')
  eq(classifySourceFile(join(DSH_INSTALL, 'a.png'), { env: ENV, home: HOME, dshInstall: DSH_INSTALL }).reason, 'FORBIDDEN_ROOT:dsh-install', 'DSH 安装目录被挡')

  // 用户主目录（含 AppData）放行
  const appdata = join(ROOT, 'profile', 'AppData', 'Local', 'Temp', 'a.png')
  mkdirSync(dirname(appdata), { recursive: true })
  writeFileSync(appdata, 'x')
  const appdataVerdict = classifySourceFile(appdata, { env: { ...ENV, USERPROFILE: join(ROOT, 'profile') }, home: HOME })
  eq(appdataVerdict.ok, true, '用户主目录内的源文件可删')
  eq(appdataVerdict.scope, 'in-profile', '用户主目录被判为 in-profile')

  // 工作区内
  const inWs = classifySourceFile(SRC_A, { env: ENV, home: HOME, workspaceRoot: WORKSPACE })
  eq(inWs.ok, true, '工作区内源文件可删')
  eq(inWs.scope, 'in-workspace', '工作区内被判为 in-workspace')
  eq(inWs.risk, 'low', '工作区内风险等级 low')

  // 工作区外
  const outside = join(ROOT, 'other', 'a.png')
  mkdirSync(dirname(outside), { recursive: true })
  writeFileSync(outside, 'x')
  const outsideVerdict = classifySourceFile(outside, { env: ENV, home: HOME, workspaceRoot: WORKSPACE })
  eq(outsideVerdict.ok, true, '工作区外源文件仍可删')
  eq(outsideVerdict.risk, 'medium', '工作区外风险等级 medium')

  // 形状类拒绝
  eq(classifySourceFile('relative\\a.png', { env: ENV, home: HOME }).reason, 'NOT_ABSOLUTE', '相对路径被拒')
  eq(classifySourceFile('C:\\', { env: ENV, home: HOME }).reason, 'DRIVE_ROOT', '盘根被拒')
  ok(isDriveRoot('C:\\') && !isDriveRoot('C:\\x'), 'isDriveRoot 只认盘根')
  eq(classifySourceFile('\\\\server\\share\\a.png', { env: ENV, home: HOME }).reason, 'UNC_PATH', 'UNC 被拒')
  ok(isNetworkPath('\\\\server\\share'), 'UNC 被判为网络位置')
  eq(classifySourceFile(join(ROOT, 'nope.png'), { env: ENV, home: HOME }).reason, 'MISSING', '不存在的文件被拒')
  eq(classifySourceFile(SHOTS, { env: ENV, home: HOME }).reason, 'IS_DIRECTORY', '目录被拒')

  // 符号链接
  const linkPath = join(ROOT, 'link.png')
  try {
    symlinkSync(SRC_A, linkPath)
    eq(classifySourceFile(linkPath, { env: ENV, home: HOME }).reason, 'IS_LINK', '符号链接被拒')
  } catch {
    ok(true, '（跳过符号链接用例：本机不允许创建）')
  }
}

// --------------------------------------------------------------- 2. 附件对象

{
  ok(attachmentObjectPath(HOME, OBJ_A.id) === OBJ_A.path, '附件 id → 磁盘路径')
  eq(attachmentObjectPath(HOME, 'sha256:xyz'), '', '坏附件 id 不给路径')
  eq(attachmentObjectPath(HOME, '../../etc/passwd'), '', '路径穿越形态不给路径')
  eq(attachmentObjectPath(HOME, 'sha256:' + 'A'.repeat(64)), attachmentObjectPath(HOME, 'sha256:' + 'a'.repeat(64)), '大写 id 也认')

  const goodVerdict = classifyAttachmentObject(HOME, OBJ_A.id)
  eq(goodVerdict.ok, true, '附件对象校验通过')
  eq(goodVerdict.digestMatches, true, '附件对象摘要相符')

  // 摘要不符：把对象内容改掉
  writeFileSync(OBJ_B.path, Buffer.from('tampered'))
  eq(classifyAttachmentObject(HOME, OBJ_B.id).reason, 'DIGEST_MISMATCH', '内容与文件名不符时拒绝')
  writeFileSync(OBJ_B.path, BYTES_B)

  eq(classifyAttachmentObject(HOME, 'sha256:' + 'f'.repeat(64)).reason, 'MISSING', '不存在的附件对象')
}

// --------------------------------------------------------------- 3. 日志读取

{
  const events = readSessionEvents(LOG_A)
  eq(events.length, 7, 'zstd 拼接帧逐行读出 7 条事件（含 header）')
  eq(events[0].type, 'session', '位置 0 是 header')
  eq(events[1].seq, 0, '位置 1 的事件自身 seq 是 0（位置 ≠ seq，真机如此）')
  eq(readSessionEvents(join(ROOT, 'nope.zstd')).length, 0, '读不到的文件返回空数组')

  const plainFile = join(ROOT, 'plain.jsonl')
  writePlainLog(plainFile, [imageEvent(0, { attachment: { ...OBJ_A, bytes: 3 }, sourcePath: SRC_A, time: 1 })])
  eq(readSessionEvents(plainFile).length, 1, '明文 .jsonl 也能读')

  const logs = listSessionLogs(HOME)
  eq(logs.length, 2, '列出 2 个会话日志')
  eq(sessionIdOfLogPath(HOME, LOG_A), SESSION_A, '从日志路径反解会话 id')
  eq(sessionIdOfLogPath(HOME, join(ROOT, 'outside.jsonl')), '', '根外的路径反解为空')
}

// --------------------------------------------------------------- 3.5 会话模型（seq→位置）

{
  const model = buildSessionModel(readSessionEvents(LOG_A), [0, 1, 5, 6, 7])
  eq(model.events.length, 7, '模型持有 7 个位置')
  eq(model.seqToIndex.get(0), 1, 'seq 0 → 位置 1（header 占了位置 0）')
  eq(model.seqToIndex.get(6), 5, 'seq 6 → 位置 5')
  eq(model.seqToIndex.get(2), 3, 'seq 2（摘除事件）→ 位置 3')
  eq(model.seqToIndex.has(3), false, 'seq 3 是空洞，不在映射里')
  eq(model.anomalies.header, 1, 'header 行被识别并排除在序号空间之外（它的 seq 会与第一条事件撞号）')
  eq(model.anomalies.duplicateSeq, [], '排除 header 后没有重复 seq')
  eq(eventAtSeq(model, 6).data.meta.path, SRC_B, 'eventAtSeq 按真实 seq 取到正确事件')
  eq(eventAtSeq(model, 3), null, '空洞 seq 取到 null')

  // 缺省表面：按 surfaceOp 回退（header 与摘除事件都不该进来）
  const fallback = buildSessionModel(readSessionEvents(LOG_A))
  eq(fallback.surfaceSeqs, [0, 1, 5, 6, 7], '缺省表面按 surfaceOp 回退得到真实 seq 列表')
}

// --------------------------------------------------------------- 3.6 异步读与活会话模型

{
  // 异步读必须与同步读等价（宿主半用异步版，避免阻塞宿主事件循环）
  const sync = readSessionEvents(LOG_A)
  const asyncEvents = await readSessionEventsAsync(LOG_A)
  eq(asyncEvents.length, sync.length, '异步读与同步读行数一致')
  eq(
    asyncEvents.map((e) => (e === null ? null : e.seq)),
    sync.map((e) => (e === null ? null : e.seq)),
    '异步读与同步读的 seq 序列一致',
  )
  eq((await readSessionEventsAsync(join(ROOT, 'nope.zstd'))).length, 0, '异步读读不到时返回空数组')

  // 活会话模型：直接用内存 log + surface.nodes（零磁盘 I/O，表面与本体一致）
  const live = { log: sync, surface: { nodes: [0, 1, 5, 6, 7] }, header: { cwd: 'A:\\Downloads' } }
  const liveModel = buildSessionModelFromSession(live)
  eq(liveModel !== null, true, '能从活会话建模型')
  eq(liveModel.surfaceSeqs, [0, 1, 5, 6, 7], '表面节点取自 session.surface.nodes')
  eq(inventoryOccurrences(liveModel).totals.occurrences, 3, '活会话模型同样盘点出 3 处图片')
  eq(eventAtSeq(liveModel, 6).data.meta.path, SRC_B, '活会话模型按真实 seq 取事件')

  // 活会话只给部分表面时**以活会话为准**（磁盘日志更全也不算）
  const partial = buildSessionModelFromSession({ log: sync, surface: { nodes: [6] } })
  eq(inventoryOccurrences(partial).totals.occurrences, 1, '活会话表面只有 seq 6 时只盘点出 1 处')

  // 没有内存日志时返回 null（调用方退回读盘）
  eq(buildSessionModelFromSession({}), null, '没有 log 字段 → null')
  eq(buildSessionModelFromSession(null), null, 'null 会话 → null')
}

// --------------------------------------------------------------- 3.8 缓存代价预估

{
  /** 造一条带用量的 assistant 消息（真实日志里 usage 挂在它的 data.usage 上）。 */
  const withUsage = (seq, input, hit) => ({
    type: 'assistant/message',
    seq,
    time: 1,
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      usage: { inputTokens: input, cacheReadTokens: hit },
    },
    surfaceOp: 'append',
  })
  const events = [
    { type: 'session', version: 4, seq: 0, id: 'x' },
    withUsage(1, 300, 700), // 总量 1000
    withUsage(10, 100, 2900), // 总量 3000
    withUsage(20, 50, 4940), // 总量 4990
    { type: 'assistant/message', seq: 30, time: 1, data: { message: { role: 'assistant', content: [] } }, surfaceOp: 'append' },
    withUsage(40, 0, 0), // 总量 0 → 忽略
  ]
  const model = buildSessionModel(events, [1, 10, 20])

  const usage = usageAnchors(model)
  eq(usage.source, 'usage', '识别出用量锚点')
  eq(
    usage.anchors.map((a) => [a.seq, a.total]),
    [
      [1, 1000],
      [10, 3000],
      [20, 4990],
    ],
    '锚点 = inputTokens + cacheReadTokens（忽略 0 与缺失）',
  )
  eq(usage.total, 4990, '总量取最近一次请求')
  eq(usage.totalSeq, 20, '总量对应的 seq')
  // 平时命中率取最近几次的**中位数**（单次冷启动/刚被打断不该当基线）
  // 三个锚点分别是 700/1000=70%、2900/3000≈96.7%、4940/4990≈99.0% → 中位数 96.7%
  eq(Math.round(usage.baselineHitRatePct), 97, '平时命中率 = 最近几次的中位数（不是单看最后一次）')
  eq(Math.round(usage.lastHitRatePct), 99, '另外给出「最近一次」的命中率作对照')

  const at1 = estimateBreakCost(usage, 1)
  eq([at1.ok, at1.cached, at1.reprocess], [true, 0, 4990], '断点在最前面 → 全部重算')
  const at10 = estimateBreakCost(usage, 10)
  eq([at10.cached, at10.reprocess], [1000, 3990], '断点在 seq 10 → 可复用 seq 10 之前的 1000')
  const at40 = estimateBreakCost(usage, 40)
  eq([at40.cached, at40.reprocess], [4990, 0], '断点在最后 → 几乎不用重算')
  eq(Math.round(at10.hitRatePct), 20, '命中率 = 可复用 / 总量')
  eq(at10.approximate, true, '标注为估算')

  const noUsage = usageAnchors(buildSessionModel([{ type: 'session', version: 4, seq: 0, id: 'x' }], [0]))
  eq(noUsage.source, 'none', '没有用量时 source = none')
  eq(estimateBreakCost(noUsage, 10).reason, 'NO_USAGE', '没有用量时给出 NO_USAGE')
  eq(estimateBreakCost(usage, 'x').reason, 'BAD_SEQ', '非法 seq 被拒')

  const occurrences = [
    { seq: 20, imageIndex: 0 },
    { seq: 10, imageIndex: 0 },
    { seq: 10, imageIndex: 1 },
  ]
  const cost = costBySeq(model, occurrences)
  eq(cost.bySeq.map((entry) => entry.seq), [10, 20], '每个带图片的 seq 一条（去重、升序）')
  eq(
    cost.bySeq.map((entry) => entry.reprocess),
    [3990, 1990],
    '各自的「若在此处打断」重算量（断点消息自身的内容也算进重算）',
  )
  eq(cost.source, 'usage', 'cost 带上用量来源')
}

// --------------------------------------------------------------- 3.7 引用索引缓存键

{
  const before = logsFingerprint(HOME)
  ok(before.includes(SESSION_A), '指纹里带会话日志路径')
  eq(logsFingerprint(HOME), before, '同一状态下指纹稳定（缓存才能命中）')
  const extra = join(HOME, 'sessions', '--ws--', 'dddddddd-4444-4444-8444-dddddddddddd', 'session.v4.jsonl.zstd')
  writePlainLog(extra, [imageEvent(0, { attachment: { ...OBJ_A, bytes: 1 }, sourcePath: SRC_A, time: 1 })])
  ok(logsFingerprint(HOME) !== before, '日志集变了指纹就变（缓存自动失效）')
  rmSync(join(HOME, 'sessions', '--ws--', 'dddddddd-4444-4444-8444-dddddddddddd'), { recursive: true, force: true })
  eq(logsFingerprint(HOME), before, '删掉后又回到原指纹')
}

// --------------------------------------------------------------- 4. 盘点

{
  const model = buildSessionModel(readSessionEvents(LOG_A), [0, 1, 5, 6, 7])
  const { occurrences, offloadEvents, totals } = inventoryOccurrences(model)

  eq(occurrences.length, 3, '表面上有 3 处图片出现位置')
  eq(occurrences.map((o) => [o.seq, o.imageIndex]), [[0, 0], [6, 0], [7, 0]], '按时间排序给出 (真实 seq, imageIndex)')
  eq(occurrences.map((o) => o.offloaded), [true, false, true], '已摘除标记：事件来源 + 投影来源都认')
  eq(occurrences[0].offloadSource, 'event', 'seq 0 的摘除来源是 image/offload 事件')
  eq(occurrences[2].offloadSource, 'projection', 'seq 7 的摘除来源是投影标记')
  eq(occurrences[1].heldPath, SRC_B, '出现位置带上源文件路径')
  eq(offloadEvents.length, 1, '摘除记录 1 条')
  eq(offloadEvents[0].seq, 2, '摘除记录报的是事件自身 seq')
  eq(totals.occurrences, 3, '合计出现位置 3')
  eq(totals.retained, 1, '仍在上下文 1 处')
  eq(totals.offloaded, 2, '已摘除 2 处')
  eq(totals.distinctAttachments, 2, '不同附件 2 个')

  // 空日志
  eq(inventoryOccurrences(buildSessionModel([], [])).totals.occurrences, 0, '空日志 0 处')

  // 回归：位置 ≠ seq 时，绝不能用 seq 当数组下标（用真实日志的位置错位做断言）
  const naive = model.events[0]
  eq(naive.type, 'session', '位置 0 是 header —— 若用 events[seq] 取 seq 0 就会拿到 header 而不是图片事件')
}

// --------------------------------------------------------------- 5. 摘除计划

{
  const model = buildSessionModel(readSessionEvents(LOG_A), [0, 1, 5, 6, 7])

  const plan = planOffload(model, [{ seq: 6, imageIndex: 0 }])
  eq(plan.ok, true, '可摘除：seq 6 的唯一图片')
  eq(plan.targets, [{ seq: 6, imageIndexes: [0] }], 'targets 用真实事件 seq')
  eq(buildOffloadEvent(plan.targets), { targets: [{ seq: 6, imageIndexes: [0] }] }, '事件数据体形状')
  eq(plan.items[0].heldPath, SRC_B, '计划里带上源文件路径供删盘使用')

  eq(planOffload(model, []).reason, 'NO_ITEMS', '空勾选被拒')
  eq(planOffload(model, [{ seq: 0, imageIndex: 0 }]).reason, 'ALREADY_OFFLOADED', '已摘除的不能再摘除')
  eq(planOffload(model, [{ seq: 99, imageIndex: 0 }]).reason, 'SEQ_OUT_OF_RANGE', '不存在的 seq 被拒')
  eq(planOffload(model, [{ seq: 1, imageIndex: 0 }]).reason, 'SEQ_NOT_MESSAGE', 'assistant 消息不参与摘除')
  eq(planOffload(model, [{ seq: 2, imageIndex: 0 }]).reason, 'SEQ_NOT_ON_SURFACE', '不在表面上的事件被拒')
  eq(planOffload(model, [{ seq: 6, imageIndex: 7 }]).reason, 'IMAGE_INDEX_MISSING', '不存在的图片序号被拒')
  eq(planOffload(model, [{ seq: 6, imageIndex: -1 }]).reason, 'BAD_ITEM', '负数序号被拒')
  eq(planOffload(model, [{ seq: '6', imageIndex: 0 }]).reason, 'BAD_ITEM', '非数字 seq 被拒')

  // 幂等：同一条计划里重复勾选同一位置
  const dup = planOffload(model, [
    { seq: 6, imageIndex: 0 },
    { seq: 6, imageIndex: 0 },
  ])
  eq(dup.ok, true, '重复勾选仍成功')
  eq(dup.targets, [{ seq: 6, imageIndexes: [0] }], '重复勾选只算一次')
  eq(dup.count, 1, '重复勾选计数为 1')

  // 混入已摘除项：整批拒绝，不静默丢弃
  const multi = planOffload(model, [
    { seq: 6, imageIndex: 0 },
    { seq: 7, imageIndex: 0 },
  ])
  eq(multi.reason, 'ALREADY_OFFLOADED', '混入已摘除项时整批被拒（不静默丢弃）')
}

// --------------------------------------------------------------- 6. 引用扫描

const refs = await scanReferences(HOME, { isCurrent: (id) => id === SESSION_A })
{
  eq(refs.sessions, 2, '引用扫描覆盖 2 个会话')
  const aRef = refs.attachments.get(OBJ_A.id)
  eq([...aRef.sessions].sort(), [SESSION_A, SESSION_B].sort(), '附件 A 被两个会话引用')
  eq(aRef.elsewhere, [SESSION_B], '附件 A 的「别处引用」= 会话 B')

  const bRef = refs.attachments.get(OBJ_B.id)
  eq(bRef.elsewhere, [], '附件 B 只被当前会话引用')

  const srcAKey = [...refs.sources.keys()].find((k) => k.endsWith('shot_a.png'))
  ok(srcAKey !== undefined, '源文件 A 进了引用索引')
  eq(refs.sources.get(srcAKey).elsewhere, [], '源文件 A 未被别处引用')

  const dupKey = [...refs.sources.keys()].find((k) => k.endsWith('shared_shot.png'))
  eq(refs.sources.get(dupKey).elsewhere, [SESSION_B], '共享源文件被会话 B 引用')

  // 普通代码文件带 meta.path 但**没有 image 块**时不得进候选
  const codeOnly = join(ROOT, 'code', 'x.cpp')
  mkdirSync(dirname(codeOnly), { recursive: true })
  writeFileSync(codeOnly, 'int main(){}')
  writePlainLog(join(HOME, 'sessions', '--ws--', 'cccccccc-3333-4333-8333-cccccccccccc', 'session.v4.jsonl.zstd'), [
    {
      type: 'tool/result',
      seq: 0,
      time: 1,
      data: { turn: 1, message: { role: 'tool', content: [{ type: 'text', text: 'read' }] }, meta: { path: codeOnly } },
      surfaceOp: 'append',
    },
  ])
  const refs2 = await scanReferences(HOME, { isCurrent: () => false })
  eq([...refs2.sources.keys()].some((k) => k.endsWith('x.cpp')), false, '无 image 块的 meta.path 不进候选')
  eq(refs2.sessions, 3, '扫描覆盖 3 个会话（含新增的无图片会话）')
}

// --------------------------------------------------------------- 7. 磁盘删除计划

{
  const items = [
    { attachmentId: OBJ_A.id, heldPath: SRC_DUP }, // 附件被 B 引用、源文件被 B 引用 → 都跳过
    { attachmentId: OBJ_B.id, heldPath: SRC_B }, // 都只被当前会话引用 → 都删
    { attachmentId: '', heldPath: SRC_A }, // 只有源文件（被摘除过的那张）
  ]
  const plan = planDiskDeletion(HOME, items, refs, {
    env: ENV,
    home: HOME,
    workspaceRoot: WORKSPACE,
    isCurrent: (id) => id === SESSION_A,
  })

  const byKey = (kind, needle) => plan.find((entry) => entry.kind === kind && (entry.path ?? '').includes(needle))
  const digestOf = (id) => id.slice('sha256:'.length)
  eq(byKey('source', 'shared_shot.png').reason, 'SHARED_WITH_OTHER_SESSION', '共享源文件跳过')
  eq(byKey('source', 'shared_shot.png').forceable, true, '共享源文件标记可强制')
  eq(byKey('attachment', digestOf(OBJ_A.id)).reason, 'SHARED_WITH_OTHER_SESSION', '共享附件跳过')
  eq(byKey('source', 'shot_b.png').action, 'DELETE', '独占源文件可删')
  eq(byKey('attachment', digestOf(OBJ_B.id)).action, 'DELETE', '独占附件可删')
  eq(byKey('source', 'shot_a.png').action, 'DELETE', '只带源文件的项也可删')

  // 强制模式：共享项也进入删除计划
  const forced = planDiskDeletion(HOME, [{ attachmentId: OBJ_A.id, heldPath: SRC_DUP }], refs, {
    env: ENV,
    home: HOME,
    workspaceRoot: WORKSPACE,
    isCurrent: (id) => id === SESSION_A,
    allowReferenced: true,
  })
  eq(forced.filter((entry) => entry.action === 'DELETE').length, 2, '强制模式下共享项进入删除计划')
  eq(forced[0].forced, true, '强制项带 forced 标记')

  // 落盘执行
  const result = executeDiskDeletion(HOME, plan, { env: ENV, home: HOME, workspaceRoot: WORKSPACE })
  eq(result.deleted.length, 3, '实际删除 3 项')
  ok(!existsSync(SRC_B), '源文件 B 已不存在')
  ok(!existsSync(SRC_A), '源文件 A 已不存在')
  ok(!existsSync(OBJ_B.path), '附件对象 B 已不存在')
  ok(existsSync(SRC_DUP), '共享源文件仍在')
  ok(existsSync(OBJ_A.path), '共享附件对象仍在')
  ok(result.reclaimedBytes > 0, '回收字节数 > 0')

  // 再执行一次：文件已不存在 → 复核拒绝，不报假成功，也不重复计数
  const again = executeDiskDeletion(HOME, plan, { env: ENV, home: HOME, workspaceRoot: WORKSPACE })
  eq(again.deleted.length, 0, '重复执行不报假成功')
  const uniqueSkippedPaths = new Set(again.skipped.map((entry) => entry.path))
  eq(uniqueSkippedPaths.size, 5, '重复执行覆盖 5 个已消失的路径（3 源文件 + 2 附件）')
  eq(again.skipped.length, uniqueSkippedPaths.size, '重复执行无重复路径条目（按路径去重）')
  const reasonKinds = new Set(again.skipped.map((entry) => (String(entry.reason).startsWith('RECHECK_FAILED') ? 'recheck' : entry.reason)))
  eq([...reasonKinds].sort(), ['SHARED_WITH_OTHER_SESSION', 'recheck'], '重复执行的跳过项只有「复核失败」与「共享」两类原因')
}

// --------------------------------------------------------------- 8. 变体缓存计数

{
  const stats = countVariantFiles(HOME)
  eq(stats.count, 0, '本临时 home 没有变体缓存文件')
}

// --------------------------------------------------------------- 收尾

rmSync(ROOT, { recursive: true, force: true })

console.log('dsh-delete image smoke: ' + passed + ' 条通过, ' + failures.length + ' 条失败')
if (failures.length > 0) {
  for (const failure of failures) console.log('  ✗ ' + failure)
  process.exit(1)
}
console.log('全部通过 ✅')
