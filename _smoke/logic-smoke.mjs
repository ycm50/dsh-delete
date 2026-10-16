/**
 * `dsh-delete` 宿主逻辑的离线测试 —— 零依赖、不碰真实 DSH 数据。
 *
 * 全部在一个临时目录里伪造一棵极小的 DSH 主目录树，然后验证：
 *   - 盘点：能不能看见两种磁盘布局（目录 + 文件）和两种投影缓存命名
 *   - 元数据：标题 / cwd / 子 agent 父 id 的解析
 *   - 计划：该删哪些路径
 *   - 删除：预演不动手；真删只删该删的；keepProjCache 生效
 *   - 安全：非法 id 一律拒绝（这是路径穿越的唯一入口）
 *
 * 运行：node _smoke/logic-smoke.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NAME_TO_ID_RE,
  deleteSessions,
  dirBytes,
  insideRoot,
  isSessionId,
  planRemoval,
  projCacheRoot,
  readProjectionMeta,
  scanInventory,
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
  ok(a === b, `${label} —— 期望 ${b}，实际 ${a}`)
}

// --------------------------------------------------------------- 造测试数据

const ID_PARENT = '11111111-1111-4111-8111-111111111111'
const ID_CHILD = '22222222-2222-4222-8222-222222222222'
const ID_FILE_LAYOUT = '33333333-3333-4333-8333-333333333333'
const ID_GHOST = '44444444-4444-4444-8444-444444444444'
const ID_BROKEN = '55555555-5555-4555-8555-555555555555'
const ID_ALT_PARENT = '66666666-6666-4666-8666-666666666666'
const ID_ALT_CHILD = '77777777-7777-4777-8777-777777777777'
const ID_UNKNOWN = '99999999-9999-4999-8999-999999999999'

const home = mkdtempSync(join(tmpdir(), 'dsh-delete-smoke-'))
const ws = '--A-Downloads--'
const wsDir = join(sessionsRoot(home), ws)
const pcDir = projCacheRoot(home)
mkdirSync(wsDir, { recursive: true })
mkdirSync(pcDir, { recursive: true })

function writeSessionDir(id, payload) {
  const dir = join(wsDir, `session-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), payload)
  return dir
}

function writeProjectionFile(name, record) {
  const file = join(pcDir, name)
  writeFileSync(file, JSON.stringify({ version: 7, record }, null, 2))
  return file
}

const parentDir = writeSessionDir(ID_PARENT, Buffer.alloc(2048, 1))
const childDir = writeSessionDir(ID_CHILD, Buffer.alloc(512, 2))
const fileLayoutPath = join(wsDir, `session-${ID_FILE_LAYOUT}.jsonl.zstd`)
writeFileSync(fileLayoutPath, Buffer.alloc(256, 3))

const parentProj = writeProjectionFile(`session-${ID_PARENT}.json`, {
  identity: { cwd: 'A:\\Downloads', createdAt: 1_700_000_000_000, formatVersion: 4 },
  rows: {
    title: { ver: 1, seq: 1, val: '父会话标题' },
    sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt: 1_700_000_500_000 } },
  },
})

// 老命名（无 session- 前缀）+ 子 agent 提示里带父 id
const childProj = writeProjectionFile(`${ID_CHILD}.json`, {
  identity: { cwd: 'A:\\Downloads', createdAt: 1_700_000_100_000 },
  rows: {
    title: { ver: 1, seq: 1, val: '子 agent 标题' },
    subagent: { ver: 2, seq: 1, val: { identity: { mode: 'continuable', label: '子任务' } } },
    titleInput: {
      ver: 3,
      seq: 9,
      val: { first: { seq: 9, text: `做点事。\nYour parent agent id is "session-${ID_PARENT}". 完毕。` } },
    },
  },
})

// 只在投影缓存里存在的“幽灵”会话（磁盘上已无主体，但仍占一份缓存）
const ghostProj = writeProjectionFile(`session-${ID_GHOST}.json`, {
  identity: { cwd: 'A:\\Downloads', createdAt: 1_600_000_000_000 },
  rows: { title: { ver: 1, seq: 1, val: '残留会话' } },
})

// 坏 JSON：解析失败但**不能抛**（它仍占着磁盘，所以仍应进盘点、仍可被删）
const brokenProj = join(pcDir, `session-${ID_BROKEN}.json`)
writeFileSync(brokenProj, '{ this is not json')

// 老形态：提示文本里的父 id 不带 session- 前缀，也必须能解析出来
const altParentProj = writeProjectionFile(`session-${ID_ALT_PARENT}.json`, {
  identity: { cwd: 'A:\\Downloads', createdAt: 1_650_000_000_000 },
  rows: { title: { ver: 1, seq: 1, val: '老形态父会话' } },
})
const altChildProj = writeProjectionFile(`session-${ID_ALT_CHILD}.json`, {
  identity: { cwd: 'A:\\Downloads', createdAt: 1_650_000_100_000 },
  rows: {
    title: { ver: 1, seq: 1, val: '老形态子会话' },
    subagent: { ver: 2, seq: 1, val: { identity: { mode: 'one-shot' } } },
    titleInput: { ver: 3, seq: 1, val: { first: { seq: 1, text: `Your parent agent id is "${ID_ALT_PARENT}".` } } },
  },
})
void altParentProj

// 与 DSH 无关的干扰文件，绝不能被动
const bystander = join(sessionsRoot(home), 'not-a-session.txt')
writeFileSync(bystander, 'keep me')

// ------------------------------------------------------------------ 开始断言

// 1) id 校验：这是路径穿越的唯一闸门
ok(isSessionId(ID_PARENT), '合法 UUID 应通过')
ok(isSessionId(ID_PARENT.toUpperCase()), '大写 UUID 应通过（大小写不敏感）')
ok(!isSessionId('../../evil'), '路径穿越串必须被拒绝')
ok(!isSessionId('..'), '.. 必须被拒绝')
ok(!isSessionId(''), '空串必须被拒绝')
ok(!isSessionId(null), 'null 必须被拒绝')
ok(!isSessionId(undefined), 'undefined 必须被拒绝')
ok(!isSessionId('11111111-1111-4111-8111-11111111111'), '少一位必须被拒绝')
ok(!isSessionId('session-11111111-1111-4111-8111-111111111111'), '带前缀必须被拒绝')

// 2) 名称 → id 解析（目录形态与文件形态）
eq(NAME_TO_ID_RE.exec(`session-${ID_PARENT}`)?.[1], ID_PARENT, '目录名解析')
eq(NAME_TO_ID_RE.exec(`session-${ID_FILE_LAYOUT}.jsonl.zstd`)?.[1], ID_FILE_LAYOUT, '文件名解析')
eq(NAME_TO_ID_RE.exec('not-a-session.txt'), null, '无关文件名不解析')
eq(NAME_TO_ID_RE.exec('session-../../evil'), null, '穿越型名字不解析')

// 3) insideRoot
ok(insideRoot('C:\\a', 'C:\\a\\b'), '子路径应在根内')
ok(insideRoot('C:\\a', 'C:\\a'), '根自身算在根内')
ok(!insideRoot('C:\\a', 'C:\\ab'), '同前缀不同目录不算在内')
ok(!insideRoot('C:\\a', 'C:\\a\\..\\b'), '逃逸路径不算在内')

// 4) 投影元数据解析
const metaParent = readProjectionMeta(parentProj)
eq(metaParent?.title, '父会话标题', '父会话标题')
eq(metaParent?.cwd, 'A:\\Downloads', '父会话 cwd')
eq(metaParent?.lastPromptAt, 1_700_000_500_000, '父会话 lastPromptAt')
eq(metaParent?.parentId, undefined, '父会话没有 parentId')

const metaChild = readProjectionMeta(childProj)
eq(metaChild?.title, '子 agent 标题', '子会话标题')
eq(metaChild?.isSubagent, true, '识别为子 agent')
eq(metaChild?.subagentMode, 'continuable', '子 agent mode')
eq(metaChild?.parentId, ID_PARENT, '从提示文本解析出父 id')

eq(readProjectionMeta(brokenProj), null, '坏 JSON 返回 null 且不抛')
eq(readProjectionMeta(join(pcDir, 'nope.json')), null, '不存在的文件返回 null')

const metaAlt = readProjectionMeta(altChildProj)
eq(metaAlt?.parentId, ID_ALT_PARENT, '不带 session- 前缀的父 id 也要能解析')
eq(metaAlt?.isSubagent, true, '老形态子 agent 也识别')
eq(metaAlt?.subagentMode, 'one-shot', '老形态 mode')

// 5) 盘点
const inventory = scanInventory(home)
const byId = new Map(inventory.map((i) => [i.id, i]))
ok(byId.has(ID_PARENT), '盘点应含父会话')
ok(byId.has(ID_CHILD), '盘点应含子会话')
ok(byId.has(ID_FILE_LAYOUT), '盘点应含文件布局会话')
ok(byId.has(ID_GHOST), '盘点应含仅存在于缓存的会话')
ok(byId.has(ID_BROKEN), '坏 JSON 的缓存文件仍应进盘点（它确实占着磁盘，必须能删）')
eq(byId.get(ID_BROKEN)?.meta, undefined, '坏 JSON 解析不出 meta（不影响删除）')
eq(byId.get(ID_BROKEN)?.projFiles.length, 1, '坏 JSON 的缓存路径仍被登记')
eq(byId.get(ID_ALT_CHILD)?.meta?.parentId, ID_ALT_PARENT, '盘点里的父 id 来自老形态文本')

eq(byId.get(ID_PARENT)?.dirs.length, 1, '父会话有 1 个目录')
eq(byId.get(ID_PARENT)?.projFiles.length, 1, '父会话有 1 个投影文件')
eq(byId.get(ID_FILE_LAYOUT)?.files.length, 1, '文件布局会话记在 files 里')
eq(byId.get(ID_FILE_LAYOUT)?.dirs.length, 0, '文件布局会话没有目录')
eq(byId.get(ID_CHILD)?.workspaceSlug, ws, '工作区 slug')
ok(byId.get(ID_PARENT).bytes >= 2048, '父会话体积应 >= 2048')
ok(byId.get(ID_CHILD).bytes >= 512, '子会话体积应 >= 512')
// 排序：最近活动的父会话应排在子会话之前（lastPromptAt 最大）
eq(inventory[0].id, ID_PARENT, '按最近活动降序，父会话应在最前')

// 6) 删除计划
const planParent = planRemoval(home, ID_PARENT)
ok(planParent.ok, '父会话计划应成功')
eq(planParent.paths.length, 2, '父会话应计划删除 2 条路径（目录 + 投影）')
ok(planParent.paths.includes(parentDir), '计划里应有会话目录')
ok(planParent.paths.includes(parentProj), '计划里应有投影文件')

const planUpper = planRemoval(home, ID_PARENT.toUpperCase())
eq(planUpper.paths.length, 2, '大写 id 应命中同一批路径')

const planBad = planRemoval(home, '../../evil')
eq(planBad.ok, false, '非法 id 的计划必须失败')
eq(planBad.error, 'BAD_ID', '非法 id 的错误码')
eq(planBad.paths.length, 0, '非法 id 不产生任何路径')

// 7) 预演：不许动磁盘
const dry = deleteSessions(home, [ID_PARENT], { dryRun: true })
eq(dry[0].ok, true, '预演应成功')
eq(dry[0].dryRun, true, '预演标记')
ok(existsSync(parentDir), '预演后目录仍在')
ok(existsSync(parentProj), '预演后投影仍在')

// 8) 真删：只删该删的
const realChild = deleteSessions(home, [ID_CHILD])
eq(realChild[0].ok, true, '子会话删除应成功')
eq(realChild[0].removed.length, 2, '子会话应删掉 2 条路径')
ok(!existsSync(childDir), '子会话目录已删除')
ok(!existsSync(childProj), '子会话投影已删除')
ok(existsSync(parentDir), '父会话目录不受影响')
ok(existsSync(fileLayoutPath), '文件布局会话不受影响')
ok(existsSync(bystander), '无关文件绝不能被删')

// 9) keepProjCache：保留投影缓存
const keep = deleteSessions(home, [ID_PARENT], { keepProjCache: true })
eq(keep[0].removed.length, 1, 'keepProjCache 时只删 1 条路径')
ok(!existsSync(parentDir), '目录仍被删除')
ok(existsSync(parentProj), '投影缓存被保留')

// 10) 不存在 / 非法的 id 混在批量里，不影响其它条目
const mixed = deleteSessions(home, [ID_UNKNOWN, 'bad-id', ID_FILE_LAYOUT])
eq(mixed.length, 3, '批量结果应有 3 条')
eq(mixed[0].ok, true, '不存在的合法 id 算成功')
eq(mixed[0].removed.length, 0, '不存在的 id 没有可删路径')
eq(mixed[1].ok, false, '非法 id 失败')
eq(mixed[1].error, 'BAD_ID', '非法 id 错误码')
ok(!existsSync(fileLayoutPath), '合法 id 仍被正常删除')

// 11) 非数组入参不应抛
eq(deleteSessions(home, null).length, 0, 'null ids 返回空结果')
eq(deleteSessions(home, 'not-an-array').length, 0, '非数组 ids 返回空结果')

// 12) dirBytes 对不存在的路径返回 0 而不抛
eq(dirBytes(join(home, 'definitely-not-here')), 0, 'dirBytes 对不存在路径返回 0')

// ------------------------------------------------------------------- 收尾

rmSync(home, { recursive: true, force: true })

console.log(`dsh-delete logic smoke: ${passed} 条通过, ${failures.length} 条失败`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部通过 ✅')
