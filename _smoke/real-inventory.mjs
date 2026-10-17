/**
 * 真实数据只读校验 —— 对着**真实**的 DSH 主目录跑一遍盘点与删除计划，
 * 但**绝不执行删除**。
 *
 * 它回答两个问题：
 *   1. 插件能不能正确看见这台机器上的会话（数量、体积、标题、父子关系）
 *   2. 对每一个会话算出的「待删路径」，是否 100% 落在允许的两个根之内
 *      —— 这是上线前对安全规则的真实数据审计
 *
 * 运行：node _smoke/real-inventory.mjs
 * 只读：不调用 deleteSessions，只调用 scanInventory / planRemoval。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { insideRoot, planRemoval, projCacheRoot, scanInventory, sessionsRoot } from '../lib/logic.js'

function resolveHome() {
  const list = []
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    list.push(process.env.DSH_HOME.trim())
  }
  list.push(join(homedir(), '.dsh'))
  for (const c of list.map((p) => resolve(p))) {
    if (existsSync(join(c, 'sessions')) || existsSync(join(c, 'storages'))) return c
  }
  return resolve(list[0])
}

const home = resolveHome()
const sessions = sessionsRoot(home)
const projCache = projCacheRoot(home)

console.log(`DSH_HOME      = ${home}`)
console.log(`sessions 根   = ${sessions}  (${existsSync(sessions) ? '存在' : '不存在'})`)
console.log(`projcache 根  = ${projCache}  (${existsSync(projCache) ? '存在' : '不存在'})`)

const items = scanInventory(home)

// 类型分布 + 逐个会话一览（这一版重点修的就是「名字 / 类型识别」）
const roots = items.filter((i) => i.meta?.isSubagent !== true)
const subs = items.filter((i) => i.meta?.isSubagent === true)
console.log('类型分布：根会话 ' + roots.length + ' 个，子 agent ' + subs.length + ' 个')
for (const item of items) {
  const kind = item.meta?.isSubagent === true ? '子 agent' : '根会话  '
  const title = String(item.meta?.title ?? '(无标题)').replace(/\s+/g, ' ').slice(0, 30)
  console.log('  ' + kind + '  ' + item.id.padEnd(46) + '  ' + title)
}
console.log(`\n发现会话 ${items.length} 个，合计 ${(items.reduce((n, i) => n + i.bytes, 0) / 1048576).toFixed(1)} MiB\n`)

// 按工作区聚合
const byWorkspace = new Map()
for (const item of items) {
  const key = item.workspaceSlug ?? '(仅缓存)'
  const rec = byWorkspace.get(key) ?? { count: 0, bytes: 0 }
  rec.count += 1
  rec.bytes += item.bytes
  byWorkspace.set(key, rec)
}
console.log('按工作区分组：')
for (const [ws, rec] of [...byWorkspace.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${ws.padEnd(24)} ${String(rec.count).padStart(4)} 个   ${(rec.bytes / 1048576).toFixed(1)} MiB`)
}

// 体积最大的 8 个
console.log('\n体积最大的 8 个：')
for (const item of [...items].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
  const title = (item.meta?.title ?? '(无标题)').replace(/\s+/g, ' ').slice(0, 34)
  const age = item.meta?.lastPromptAt ?? item.meta?.createdAt
  const when = typeof age === 'number' ? new Date(age).toISOString().slice(0, 10) : '未知'
  const paths = item.dirs.length + item.files.length + item.projFiles.length
  console.log(
    `  ${item.id.slice(0, 8)}  ${(item.bytes / 1048576).toFixed(1).padStart(7)} MiB  ${String(paths)} 路径  ${when}  ${title}`,
  )
}

// 关系抽样：子 agent / 有子会话的会话
const withParent = items.filter((i) => typeof i.meta?.parentId === 'string')
const ids = new Set(items.map((i) => i.id))
const orphanParents = withParent.filter((i) => !ids.has(i.meta.parentId))
const parents = new Set(withParent.map((i) => i.meta.parentId))
console.log(
  `\n关系：子 agent ${withParent.length} 个（其中 ${orphanParents.length} 个的父会话已不在盘点里）` +
    `；有子会话的会话 ${parents.size} 个`,
)

// 安全审计：逐条算出待删路径，检查是否都落在允许根内
let planned = 0
let violations = 0
let emptyPlan = 0
for (const item of items) {
  const plan = planRemoval(home, item.id)
  if (!plan.ok) {
    violations += 1
    console.log(`  ✗ 计划失败（不该发生）：${item.id} -> ${plan.error}`)
    continue
  }
  if (plan.paths.length === 0) emptyPlan += 1
  for (const p of plan.paths) {
    planned += 1
    const allowed = insideRoot(sessions, p) || insideRoot(projCache, p)
    if (!allowed) {
      violations += 1
      console.log(`  ✗ 越界路径：${p}`)
    }
  }
}
console.log(`\n安全审计：共解析出 ${planned} 条待删路径，越界 ${violations} 条`)
if (emptyPlan > 0) console.log(`  注意：${emptyPlan} 个会话算不出任何路径（只有缓存条目之类的边界情况）`)

// 非法 id 必须被拒
const probes = ['../../evil', '..', '', 'C:\\Windows', 'session-x', null]
let rejected = 0
for (const probe of probes) {
  if (planRemoval(home, probe).ok === false) rejected += 1
}
console.log(`非法 id 拒识：${rejected}/${probes.length}`)

console.log(
  violations === 0 && rejected === probes.length
    ? '\n✅ 只读校验通过（未删除任何文件）'
    : '\n❌ 只读校验存在问题，见上',
)
process.exit(violations === 0 && rejected === probes.length ? 0 : 1)
