/**
 * dsh-delete 宿主逻辑的离线测试 —— 零依赖、不碰真实 DSH 数据。
 *
 * 全部在一个临时目录里伪造一棵极小的 DSH 主目录树，然后验证：
 *   - 磁盘契约：目录名就是会话 id（session-<uuid> 与裸 <uuid> 两种都在），
 *     老版单文件布局也认；encodeSegment 的编码能反解
 *   - header 读取：zstd 拼接帧里的第一行给出 id / cwd / 父子 / 是否子 agent
 *   - 标题：投影缓存优先，缓存没有就回退到日志里的 session/title 事件
 *   - 盘点：磁盘目录 + 老版文件 + 投影缓存（含 .bak）合并成「一个会话一行」
 *   - 计划与删除：两种 id 写法都能命中同一批路径；预演不动手；keepProjCache 生效
 *   - 安全：非法 id 一律拒绝（这是路径穿越的唯一入口）
 *
 * 运行：node _smoke/logic-smoke.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  docNameToId,
  encodeSegment,
  decodeSegment,
  deleteSessions,
  dirBytes,
  entryNameToId,
  insideRoot,
  isSessionId,
  planRemoval,
  projCacheRoot,
  readDurableTitle,
  readProjectionMeta,
  readSessionHeader,
  scanInventory,
  scanZstdFrames,
  sessionsRoot,
} from '../lib/logic.js'

// --------------------------------------------------------------- 测试框架

let passed = 0
const failures = []

function ok(condition, label) {
  if (condition) {
    passed += 1
  } else {
    failures.push(label)
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(a === b, label + ' —— 期望 ' + b + '，实际 ' + a)
}

/** 运行时没有 zstd（老 Node）就跳过读取日志的那几条断言。 */
const CAN_ZSTD = typeof zstdCompressSync === 'function'

// --------------------------------------------------------------- 造测试数据

const ROOT = '11111111-1111-4111-8111-111111111111' // 目录 session-<ROOT>（现版根会话）
const SUB = '22222222-2222-4222-8222-222222222222' // 目录 <SUB>（现版子 agent：裸 uuid）
const BRANCH = '88888888-8888-4888-8888-888888888888' // 分支（fork）：有 parentSession，不是子 agent
const LEGACY = '33333333-3333-4333-8333-333333333333' // 老版单文件 session-<LEGACY>.jsonl.zstd
const GHOST = '44444444-4444-4444-8444-444444444444' // 只有投影缓存
const BROKEN = '55555555-5555-4555-8555-555555555555' // 坏投影缓存（占着磁盘，仍要能删）
const FROMBAK = '66666666-6666-4666-8666-666666666666' // 投影缓存 + 被挪到一边的 .bak
const PLAIN = '77777777-7777-4777-8777-777777777777' // 明文 .jsonl（老布局）
const UNKNOWN = '99999999-9999-4999-8999-999999999999'

const home = mkdtempSync(join(tmpdir(), 'dsh-delete-smoke-'))
const ws = '--A-Downloads--'
const wsDir = join(sessionsRoot(home), ws)
const pcDir = projCacheRoot(home)
mkdirSync(wsDir, { recursive: true })
mkdirSync(pcDir, { recursive: true })

/** 一帧 zstd：内容是一批 JSON 行。 */
function frameOf(records) {
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

/** 伪造一份会话日志：header 一帧，事件按批分帧（真实布局就是拼接帧）。 */
function makeLog(header, batches = []) {
  const frames = [frameOf([header])]
  for (const batch of batches) frames.push(frameOf(batch))
  return Buffer.concat(frames)
}

function headerOf(id, extra) {
  return Object.assign(
    {
      type: 'session',
      version: 4,
      id,
      createdAt: 1_700_000_000_000,
      cwd: 'A:\\Downloads',
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard-compact-55',
    },
    extra ?? {},
  )
}

function titleEvent(title, seq) {
  return { type: 'session/title', seq, data: { title } }
}

/** 现版：会话目录 session-<id>，主体 session.v4.jsonl.zstd。 */
function writeSessionDir(dirName, header, batches) {
  const dir = join(wsDir, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), makeLog(header, batches))
  return dir
}

function writeProjectionFile(name, record) {
  const file = join(pcDir, name)
  writeFileSync(file, JSON.stringify({ version: 7, record }, null, 2))
  return file
}

// 现版根会话：目录名带 session- 前缀，标题在日志里（投影缓存也有）
const rootDir = writeSessionDir('session-' + ROOT, headerOf('session-' + ROOT), [
  [titleEvent('根会话标题', 2)],
])
const rootProj = writeProjectionFile('session-' + ROOT + '.json', {
  identity: { cwd: 'A:\\Downloads', createdAt: 1_700_000_000_000, formatVersion: 4 },
  rows: {
    title: { ver: 1, seq: 2, val: '根会话标题' },
    // ⚠️ 回归点：普通会话的 subagent 投影状态是**空对象**，绝不能被当成子 agent
    subagent: { ver: 2, seq: 2, val: {} },
    sessionListMetadata: { ver: 1, seq: 2, val: { blank: false, lastPromptAt: 1_700_000_500_000 } },
  },
})

// 现版子 agent：目录名是**裸 uuid**（这正是旧版扫不到、删不掉的那一类）；
// 没有投影缓存，标题/血缘只能靠 header + 日志
const subDir = writeSessionDir(SUB, headerOf(SUB, { origin: 'subagent', parentSession: 'session-' + ROOT, delegationDepth: 1 }), [
  [{ type: 'user/message', seq: 1, data: { source: { kind: 'user' } } }],
  [titleEvent('# 任务：把子任务做完', 2)],
])

// 分支（fork）：同样带 parentSession，但 origin 不是 subagent、delegationDepth=0，
// 绝不能被当成子 agent（回归：旧逻辑见 parentSession 就标子 agent）。
const branchDir = writeSessionDir('session-' + BRANCH, headerOf('session-' + BRANCH, { parentSession: 'session-' + ROOT, delegationDepth: 0 }), [
  [titleEvent('分支会话', 2)],
])

// 老版单文件布局（主体不在目录里，而是 workspace 目录下的一个文件）
const legacyFile = join(wsDir, 'session-' + LEGACY + '.jsonl.zstd')
writeFileSync(legacyFile, makeLog(headerOf('session-' + LEGACY), [[titleEvent('老版单文件会话', 1)]]))

// 明文 jsonl（更老的布局）：header 行 + 事件行
const plainFile = join(wsDir, PLAIN + '.jsonl')
writeFileSync(
  plainFile,
  JSON.stringify(headerOf(PLAIN)) + '\n' + JSON.stringify(titleEvent('明文日志会话', 1)) + '\n',
)

// 只有投影缓存的「幽灵」会话（磁盘上已无主体，但仍占一份缓存）
const ghostProj = writeProjectionFile('session-' + GHOST + '.json', {
  identity: { cwd: 'A:\\Downloads', createdAt: 1_600_000_000_000 },
  rows: { title: { ver: 1, seq: 1, val: '残留会话' } },
})

// 坏 JSON：解析失败但**不能抛**（它仍占着磁盘，所以仍应进盘点、仍可被删）
const brokenProj = join(pcDir, 'session-' + BROKEN + '.json')
writeFileSync(brokenProj, '{ this is not json')

// 投影缓存 + domain 挪到一边的 .bak（也算这个会话占用的路径）
const frombakProj = writeProjectionFile('session-' + FROMBAK + '.json', {
  identity: { cwd: 'A:\\Downloads', createdAt: 1_650_000_000_000 },
  rows: {
    title: { ver: 1, seq: 1, val: '有备份的会话' },
    subagent: { ver: 2, seq: 1, val: { identity: { mode: 'continuable', label: '子任务' } } },
  },
})
const frombakBak = join(pcDir, 'session-' + FROMBAK + '.json.bak.202610161430')
writeFileSync(frombakBak, '{}')

// 与 DSH 无关的干扰文件，绝不能被动
const bystander = join(sessionsRoot(home), 'not-a-session.txt')
writeFileSync(bystander, 'keep me')
const bystanderProj = join(pcDir, 'notes.json')
writeFileSync(bystanderProj, '{}')

// ------------------------------------------------------------------ 开始断言

// 1) id 校验：这是路径穿越的唯一闸门；两种前缀写法都合法
ok(isSessionId(ROOT), '裸 UUID 应通过')
ok(isSessionId(ROOT.toUpperCase()), '大写 UUID 应通过（大小写不敏感）')
ok(isSessionId('session-' + ROOT), '带 session- 前缀的 id 应通过（现版根会话）')
ok(!isSessionId('session-' + ROOT + '-x'), '畸形前缀 id 必须被拒绝')
ok(!isSessionId('../../evil'), '路径穿越串必须被拒绝')
ok(!isSessionId('..'), '.. 必须被拒绝')
ok(!isSessionId(''), '空串必须被拒绝')
ok(!isSessionId(null), 'null 必须被拒绝')
ok(!isSessionId(undefined), 'undefined 必须被拒绝')
ok(!isSessionId('11111111-1111-4111-8111-11111111111'), '少一位必须被拒绝')

// 2) 磁盘名 → id
eq(entryNameToId('session-' + ROOT), 'session-' + ROOT, '现版根会话目录名')
eq(entryNameToId(SUB), SUB, '现版子 agent 目录名（裸 uuid）')
eq(entryNameToId('session-' + LEGACY + '.jsonl.zstd'), 'session-' + LEGACY, '老版单文件名')
eq(entryNameToId(PLAIN + '.jsonl'), PLAIN, '老版明文单文件名')
eq(entryNameToId('not-a-session.txt'), '', '无关文件名不解析')
eq(entryNameToId('session-../../evil'), '', '穿越型名字不解析')
eq(docNameToId('session-' + ROOT + '.json'), 'session-' + ROOT, '投影文档名')
eq(docNameToId(SUB + '.json'), SUB, '裸 uuid 的投影文档名')
eq(docNameToId('session-' + FROMBAK + '.json.bak.202610161430'), 'session-' + FROMBAK, '被挪到一边的投影备份')
eq(docNameToId('notes.json'), '', '无关 json 不解析')

// 3) 路径段编码：DSH 用 encodeSegment 把 id 变成目录名，必须能反解
eq(decodeSegment(encodeSegment('a b')), 'a b', 'encodeSegment ↔ decodeSegment 往返')
eq(encodeSegment('a b'), 'a~0020b', '空格编码成 ~0020')
eq(entryNameToId(encodeSegment('session-' + ROOT)), 'session-' + ROOT, '编码过的目录名也能反解出 id')

// 4) insideRoot
ok(insideRoot('C:\\a', 'C:\\a\\b'), '子路径应在根内')
ok(insideRoot('C:\\a', 'C:\\a'), '根自身算在根内')
ok(!insideRoot('C:\\a', 'C:\\ab'), '同前缀不同目录不算在内')
ok(!insideRoot('C:\\a', 'C:\\a\\..\\b'), '逃逸路径不算在内')

// 5) header 读取（zstd 拼接帧的第一帧）
if (CAN_ZSTD) {
  const subHeader = readSessionHeader(join(subDir, 'session.v4.jsonl.zstd'))
  eq(subHeader?.id, SUB, '子 agent 的权威 id 来自 header')
  eq(subHeader?.isSubagent, true, 'header.origin=subagent 判定为子 agent')
  eq(subHeader?.parentId, 'session-' + ROOT, 'header.parentSession 给出父 id')
  eq(subHeader?.delegationDepth, 1, 'header.delegationDepth')

  const rootHeader = readSessionHeader(join(rootDir, 'session.v4.jsonl.zstd'))
  eq(rootHeader?.id, 'session-' + ROOT, '根会话 header id 带前缀')
  eq(rootHeader?.isSubagent, undefined, '根会话不是子 agent')

  const branchHeader = readSessionHeader(join(branchDir, 'session.v4.jsonl.zstd'))
  eq(branchHeader?.isSubagent, undefined, '分支（fork）不是子 agent（即使有 parentSession）')
  eq(branchHeader?.parentId, 'session-' + ROOT, '分支的父 id 仍保留')
  eq(branchHeader?.delegationDepth, 0, '分支的 delegationDepth 保持 0')

  eq(readSessionHeader(join(wsDir, PLAIN + '.jsonl'))?.id, PLAIN, '明文日志也能读 header')

  eq(readDurableTitle(join(subDir, 'session.v4.jsonl.zstd')), '# 任务：把子任务做完', '标题来自日志的 session/title 事件')
  eq(readDurableTitle(join(rootDir, 'session.v4.jsonl.zstd')), '根会话标题', '多帧日志里也能找到标题')
  eq(readDurableTitle(join(wsDir, PLAIN + '.jsonl')), '明文日志会话', '明文日志里的标题')

  const frames = scanZstdFrames(makeLog(headerOf(ROOT), [[titleEvent('x', 1)]]), 10)
  eq(frames.frames.length, 2, 'scanZstdFrames 数出 2 帧')
  ok(frames.torn === false, '完整日志不算残缺')
} else {
  console.log('提示：当前 Node 没有 zstd 支持，跳过 header / 标题读取的断言')
}

// 6) 投影元数据解析
const metaRoot = readProjectionMeta(rootProj)
eq(metaRoot?.title, '根会话标题', '根会话标题')
eq(metaRoot?.cwd, 'A:\\Downloads', '根会话 cwd')
eq(metaRoot?.lastPromptAt, 1_700_000_500_000, '根会话 lastPromptAt')
eq(metaRoot?.isSubagent, undefined, '空对象的 subagent 投影不能被当成子 agent（回归）')

const metaFromBak = readProjectionMeta(frombakProj)
eq(metaFromBak?.isSubagent, true, '有 identity 的 subagent 投影仍识别为子 agent')
eq(metaFromBak?.subagentMode, 'continuable', '子 agent mode')
eq(metaFromBak?.subagentLabel, '子任务', '子 agent label')

eq(readProjectionMeta(brokenProj), null, '坏 JSON 返回 null 且不抛')
eq(readProjectionMeta(join(pcDir, 'nope.json')), null, '不存在的文件返回 null')

// 7) 盘点：两种目录名 + 老版文件 + 投影缓存（含 .bak）合并成一个会话一行
const inventory = scanInventory(home)
const byId = new Map(inventory.map((i) => [i.id, i]))
ok(byId.has('session-' + ROOT), '盘点应含现版根会话（带前缀 id）')
ok(byId.has(SUB), '盘点应含现版子 agent（裸 uuid 目录）—— 旧版整类扫不到')
ok(byId.has('session-' + LEGACY), '盘点应含老版单文件会话')
ok(byId.has(PLAIN), '盘点应含明文日志会话')
ok(byId.has('session-' + GHOST), '盘点应含仅存在于缓存的会话')
ok(byId.has('session-' + BROKEN), '坏 JSON 的缓存文件仍应进盘点（它确实占着磁盘，必须能删）')
eq(byId.get('session-' + BROKEN)?.meta, undefined, '坏 JSON 解析不出 meta（不影响删除）')
eq(byId.get('session-' + BROKEN)?.projFiles.length, 1, '坏 JSON 的缓存路径仍被登记')
ok(!byId.has('notes'), '与 DSH 无关的 json 不进盘点')

eq(byId.get('session-' + ROOT)?.dirs.length, 1, '根会话有 1 个目录')
eq(byId.get('session-' + ROOT)?.projFiles.length, 1, '根会话有 1 个投影文件')
eq(byId.get(SUB)?.dirs.length, 1, '子 agent 有 1 个目录')
eq(byId.get(SUB)?.projFiles.length, 0, '子 agent 没有投影缓存')
eq(byId.get('session-' + LEGACY)?.files.length, 1, '老版单文件记在 files 里')
eq(byId.get('session-' + LEGACY)?.dirs.length, 0, '老版单文件没有目录')
eq(byId.get('session-' + FROMBAK)?.projFiles.length, 2, '投影缓存 + .bak 都算路径')
eq(byId.get(SUB)?.workspaceSlug, ws, '工作区 slug')
ok(byId.get('session-' + ROOT).bytes > 0, '根会话体积应 > 0')
eq(byId.get('session-' + LEGACY)?.ids.includes('session-' + LEGACY), true, '盘点记录里保留磁盘上的 id 写法')

if (CAN_ZSTD) {
  eq(byId.get(SUB)?.meta?.isSubagent, true, '盘点里子 agent 类型来自 header')
  eq(byId.get(SUB)?.meta?.parentId, 'session-' + ROOT, '盘点里父 id 来自 header')
  eq(byId.get(SUB)?.meta?.title, '# 任务：把子任务做完', '盘点里子 agent 的标题来自日志（旧版会退化成 cwd 目录名）')
  eq(byId.get('session-' + ROOT)?.meta?.isSubagent, undefined, '盘点里根会话不是子 agent（旧版被空投影误判）')
  eq(byId.get('session-' + BRANCH)?.meta?.isSubagent, undefined, '盘点里分支（fork）不是子 agent')
  eq(byId.get('session-' + BRANCH)?.meta?.parentId, 'session-' + ROOT, '盘点里分支的父 id 保留')
  eq(byId.get('session-' + BRANCH)?.meta?.title, '分支会话', '分支标题来自日志')
  eq(byId.get('session-' + LEGACY)?.meta?.title, '老版单文件会话', '老版单文件的标题也能读到')
}

// 排序：最近活动的根会话（lastPromptAt 最大）应在最前
eq(inventory[0].id, 'session-' + ROOT, '按最近活动降序，最近有提示的会话在最前')

// 8) 删除计划：两种 id 写法命中同一批路径
const planRoot = planRemoval(home, 'session-' + ROOT)
ok(planRoot.ok, '根会话计划应成功')
eq(planRoot.paths.length, 2, '根会话应计划删除 2 条路径（目录 + 投影）')
ok(planRoot.paths.includes(rootDir), '计划里应有会话目录')
ok(planRoot.paths.includes(rootProj), '计划里应有投影文件')

const planRootBare = planRemoval(home, ROOT)
eq(planRootBare.paths.length, 2, '用裸 uuid 也能命中带前缀的那条会话')

const planSub = planRemoval(home, SUB)
eq(planSub.paths.length, 1, '子 agent 只有目录可删')
ok(planSub.paths.includes(subDir), '子 agent 的目录在计划里')
const planSubPrefixed = planRemoval(home, 'session-' + SUB)
eq(planSubPrefixed.paths.length, 1, '用带前缀的写法也能命中裸 uuid 的那条会话')

eq(planRemoval(home, 'session-' + FROMBAK).paths.length, 2, '投影备份也在计划里')

const planBad = planRemoval(home, '../../evil')
eq(planBad.ok, false, '非法 id 的计划必须失败')
eq(planBad.error, 'BAD_ID', '非法 id 的错误码')
eq(planBad.paths.length, 0, '非法 id 不产生任何路径')

// 9) 预演：不许动磁盘
const dry = deleteSessions(home, ['session-' + ROOT], { dryRun: true })
eq(dry[0].ok, true, '预演应成功')
eq(dry[0].dryRun, true, '预演标记')
ok(existsSync(rootDir), '预演后目录仍在')
ok(existsSync(rootProj), '预演后投影仍在')

// 10) 真删：只删该删的（子 agent 用裸 uuid 删）
const realSub = deleteSessions(home, [SUB])
eq(realSub[0].ok, true, '子 agent 删除应成功')
eq(realSub[0].removed.length, 1, '子 agent 应删掉 1 条路径')
ok(!existsSync(subDir), '子 agent 目录已删除')
ok(existsSync(rootDir), '根会话目录不受影响')
ok(existsSync(bystander), '无关文件绝不能被删')
ok(existsSync(bystanderProj), '无关 json 绝不能被删')

// 11) keepProjCache：保留投影缓存
const keep = deleteSessions(home, ['session-' + ROOT], { keepProjCache: true })
eq(keep[0].removed.length, 1, 'keepProjCache 时只删 1 条路径')
ok(!existsSync(rootDir), '目录仍被删除')
ok(existsSync(rootProj), '投影缓存被保留')

// 12) 不存在 / 非法的 id 混在批量里，不影响其它条目
const mixed = deleteSessions(home, [UNKNOWN, 'bad-id', 'session-' + LEGACY])
eq(mixed.length, 3, '批量结果应有 3 条')
eq(mixed[0].ok, true, '不存在的合法 id 算成功')
eq(mixed[0].removed.length, 0, '不存在的 id 没有可删路径')
eq(mixed[0].emptyDisk, true, '不存在的 id 标出「磁盘上已无痕迹」')
eq(mixed[1].ok, false, '非法 id 失败')
eq(mixed[1].error, 'BAD_ID', '非法 id 错误码')
ok(!existsSync(legacyFile), '合法 id 仍被正常删除')

// 13) 非数组入参不应抛
eq(deleteSessions(home, null).length, 0, 'null ids 返回空结果')
eq(deleteSessions(home, 'not-an-array').length, 0, '非数组 ids 返回空结果')

// 14) dirBytes 对不存在的路径返回 0 而不抛
eq(dirBytes(join(home, 'definitely-not-here')), 0, 'dirBytes 对不存在路径返回 0')

// ------------------------------------------------------------------- 收尾

rmSync(home, { recursive: true, force: true })

console.log('dsh-delete logic smoke: ' + passed + ' 条通过, ' + failures.length + ' 条失败')
if (failures.length > 0) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✅')
