/**
 * `dsh-delete` 浏览器侧的离线测试 —— 不起浏览器、不装 React。
 *
 * 做法：在 `node:vm` 里造一个最小的沙箱（`window.__ModuleLoader__` + `navigator`），
 * 把 `client.js` 真求值一遍，取出 factory 返回的 `_internals`，然后只针对
 * **纯函数**断言：磁盘盘点与会话列表快照的合并、父子建树、三种级联集合运算、
 * 体积格式化、词条占位替换。
 *
 * React 只用一个 stub（factory 里只用到 `React.createElement` 的赋值），
 * 因此完全不依赖 React 运行时。
 *
 * 运行：node _smoke/client-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

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
  ok(a === b, `${label} —— 期望 ${b}，实际 ${a}`)
}

// ------------------------------------------------------- 在沙箱里求值 bundle

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let loaded = null
const warnings = []
const sandbox = {
  navigator: { language: 'zh-CN' },
  document: { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild() {} } },
  location: { reload() {} },
  console: { log: console.log, error: console.error, warn: (...a) => warnings.push(a.map(String).join(' ')) },
  fetch: async () => ({ json: async () => ({}) }),
}
sandbox.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

ok(loaded !== null, 'bundle 应通过 __ModuleLoader__.load 注册自己')
eq(loaded?.id, 'dsh-delete', 'bundle id')

const ReactStub = { createElement: () => null }
const mod = loaded.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`client.js 只应 require platform externals，实际拿到 ${name}`)
})

ok(Array.isArray(mod?.inject), 'factory 应返回 inject 数组')
eq(mod?.inject?.length, 0, 'inject 应为空（依赖全部运行时探测）')
eq(typeof mod?.apply, 'function', 'factory 应返回 apply')

const { buildRows, buildTree, descendantsOf, siblingsOf, rootOf, cascadeSelection, subagentIds, fmtBytes, t } =
  mod._internals

// ------------------------------------------------------------- 测试数据

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'
const D = 'dddddddd-0000-4000-8000-000000000004'
const E = 'eeeeeeee-0000-4000-8000-000000000005'
const F = 'ffffffff-0000-4000-8000-000000000006'
const G = '77777777-0000-4000-8000-000000000007'

const inventory = {
  items: [
    { id: A, bytes: 1000, dirs: ['a'], files: [], projFiles: ['a.json'], workspaceSlug: '--ws--', meta: { title: '父(磁盘)', cwd: 'C:\\w', createdAt: 1000, lastPromptAt: 5000 } },
    { id: B, bytes: 200, dirs: ['b'], files: [], projFiles: [], workspaceSlug: '--ws--', meta: { title: '子(磁盘)', cwd: 'C:\\w', isSubagent: true, parentId: A, createdAt: 1500 } },
    { id: D, bytes: 0, dirs: [], files: [], projFiles: [], meta: { blank: true } },
    { id: E, bytes: 50, dirs: [], files: [], projFiles: ['e.json'], meta: { blank: true, title: '空白但有文件' } },
    { id: F, bytes: 30, dirs: [], files: ['f.zstd'], projFiles: [], meta: { title: '仅磁盘残留' } },
    { id: G, bytes: 10, dirs: ['c'], files: [], projFiles: [], workspaceSlug: '--ws--', meta: { isSubagent: true, parentId: A, createdAt: 1600 } },
  ],
}

const snapshot = {
  [A]: { title: '父(快照)', cwd: 'C:\\w', parentId: '', running: false, completed: true, blank: false, updatedAt: 9000 },
  [B]: { title: '子(快照)', cwd: 'C:\\w', parentId: A, running: true, completed: false, blank: false, updatedAt: 8000 },
  [C]: { title: '只在快照里', cwd: 'C:\\w2', parentId: '', running: false, completed: false, blank: false, updatedAt: 7000 },
  [D]: { title: '', cwd: '', parentId: '', blank: true, updatedAt: 0 },
  [G]: { title: '另一个子', cwd: 'C:\\w', parentId: A, running: false, completed: true, blank: false, updatedAt: 6000 },
}

// ------------------------------------------------------------- 合并断言

const rows = buildRows(inventory, snapshot)
const byId = new Map(rows.map((r) => [r.id, r]))

eq(rows.length, 6, '合并后应有 6 行（D 是 blank 且零字节，被过滤）')
ok(!byId.has(D), 'blank 且零字节的占位行应被过滤')
ok(byId.has(E), 'blank 但磁盘上有文件的行走保留（否则永远清不掉）')

eq(byId.get(A)?.title, '父(快照)', '有快照时标题以快照为准')
eq(byId.get(A)?.bytes, 1000, 'A 的体积来自磁盘盘点')
eq(byId.get(A)?.paths, 2, 'A 的路径数 = 目录 1 + 投影 1')
eq(byId.get(A)?.inSnapshot, true, 'A 在快照里')
eq(byId.get(A)?.diskOnly, false, 'A 不是仅磁盘')

eq(byId.get(B)?.parentId, A, 'B 的父来自快照')
eq(byId.get(B)?.isSubagent, true, 'B 被标为子 agent（来自磁盘元数据）')
eq(byId.get(B)?.running, true, 'B 运行中')
eq(byId.get(B)?.paths, 1, 'B 只有 1 条路径')

eq(byId.get(F)?.diskOnly, true, 'F 只在磁盘上 → 仅磁盘')
eq(byId.get(F)?.title, '仅磁盘残留', 'F 的标题来自磁盘元数据')
eq(byId.get(F)?.paths, 1, 'F 的路径数来自 files')

eq(byId.get(C)?.diskOnly, false, 'C 只在快照里（零字节）不算仅磁盘')
eq(byId.get(E)?.paths, 1, 'E 的路径数来自 projFiles')

// 空入参不抛
eq(buildRows(null, null).length, 0, 'buildRows(null, null) 返回空数组')
eq(buildRows({ items: [null, 42, {}] }, null).length, 0, '非法 item 被忽略')

// ------------------------------------------------------------- 建树断言

const tree = buildTree(rows)
eq(tree.roots.length, 4, '根节点应有 4 个（A / C / E / F）')
eq(tree.roots[0], A, '根按最近活动降序，A 在最前')
eq(tree.childrenOf.get(A), [B, G], 'A 的子按最近活动降序（B 8000 在 G 6000 前）')
eq(tree.childrenOf.get(B), undefined, 'B 没有子')

// --------------------------------------------------------- 级联集合断言

eq(descendantsOf(tree, A).sort(), [B, G].sort(), 'A 的后代')
eq(descendantsOf(tree, B).length, 0, 'B 无后代')
eq(descendantsOf(tree, F).length, 0, 'F 无后代')

eq(siblingsOf(tree, B), [G], 'B 的团队成员 = 同父的兄弟 G')
eq(siblingsOf(tree, G), [B], 'G 的团队成员 = B')
eq(siblingsOf(tree, A).length, 0, '根没有兄弟')

eq(rootOf(tree, B), A, 'B 的家族根是 A')
eq(rootOf(tree, G), A, 'G 的家族根是 A')
eq(rootOf(tree, A), A, 'A 自己是根')
eq(rootOf(tree, C), C, 'C 自己是根')

// ------------------------------- 级联选择（回归：空选择时曾经变成"全选"）

/**
 * 回归背景：第一版 batchPick 在「没有勾选任何会话」时把基准取成了**全部会话**，
 * 于是点一下「选中子 agent」等于全选（用户实测截图：153 个全被勾上）。
 * 正确语义是「扩展当前选择」：没有选择就没有基准，必须返回空集。
 */
eq(cascadeSelection(tree, [], 'subagents'), [], '空选择时「含子 agent」必须返回空集（不能变成全选）')
eq(cascadeSelection(tree, [], 'siblings'), [], '空选择时「含团队成员」必须返回空集')
eq(cascadeSelection(tree, [], 'family'), [], '空选择时「含整族」必须返回空集')
eq(cascadeSelection(tree, null, 'subagents'), [], 'base 为 null 时也不许全选')
eq(cascadeSelection(tree, ['不存在的id'], 'family'), [], '基准全是不存在的 id 时返回空集')

// 「含子 agent」= 已勾选会话 + 其全部后代
eq(cascadeSelection(tree, [A], 'subagents').sort(), [A, B, G].sort(), '含子 agent：A 自己 + 后代')
eq(cascadeSelection(tree, [C], 'subagents'), [C], '含子 agent：C 没有后代，只留它自己')
eq(cascadeSelection(tree, [B, G], 'subagents').sort(), [B, G].sort(), '含子 agent：已经是叶子时保持原样')

// 「含团队成员」= 已勾选会话 + 同父兄弟
eq(cascadeSelection(tree, [B], 'siblings').sort(), [B, G].sort(), '含团队成员：B 的兄弟 G')
eq(cascadeSelection(tree, [A], 'siblings'), [A], '根的兄弟为空，保持原样')

// 「含整族」= 上溯到根 + 根的整棵子树
eq(cascadeSelection(tree, [B], 'family').sort(), [A, B, G].sort(), '含整族：从 B 上溯到 A 并带走整棵子树')
eq(cascadeSelection(tree, [C], 'family'), [C], '含整族：C 是独苗')
eq(cascadeSelection(tree, [B, C], 'family').sort(), [A, B, C, G].sort(), '含整族：多个基准各取自己的家族')

// 结果里不许出现 tree 之外的 id
ok(
  cascadeSelection(tree, [A], 'family').every((id) => tree.byId.has(id)),
  '级联结果必须都在 tree 内',
)

// 「全选子 agent」只挑子 agent 行
eq(subagentIds(rows).sort(), [B, G].sort(), '全选子 agent：只挑有父的 / 标了 isSubagent 的行')
eq(subagentIds([]).length, 0, '全选子 agent：空列表返回空')

// 环保护：人为造一个 A → B → A 的环，rootOf 不能死循环
const loopRows = [
  { id: 'x', title: 'x', cwd: '', parentId: 'y', running: false, completed: false, blank: false, updatedAt: 0, bytes: 1, paths: 1, workspaceSlug: '', inSnapshot: true, isSubagent: false, diskOnly: false },
  { id: 'y', title: 'y', cwd: '', parentId: 'x', running: false, completed: false, blank: false, updatedAt: 0, bytes: 1, paths: 1, workspaceSlug: '', inSnapshot: true, isSubagent: false, diskOnly: false },
]
const loopTree = buildTree(loopRows)
ok(typeof rootOf(loopTree, 'x') === 'string', '父亲构成环时 rootOf 仍返回字符串（不死循环）')

// --------------------------------------------------------- 格式化与词条

eq(fmtBytes(0), '0 B', 'fmtBytes(0)')
eq(fmtBytes(1023), '1023 B', 'fmtBytes(1023)')
eq(fmtBytes(2048), '2.0 KB', 'fmtBytes(2048)')
eq(fmtBytes(1536), '1.5 KB', 'fmtBytes(1536)')
eq(fmtBytes(1024 * 1024), '1.0 MB', 'fmtBytes(1 MiB)')
eq(fmtBytes(Number.NaN), '0 B', 'NaN 体积返回 0 B')
eq(fmtBytes(-5), '0 B', '负数体积返回 0 B')

eq(t('selectedCount', { n: 3 }), '已选 3 个会话', '词条占位替换')
eq(t('confirmTitle', { n: 2 }), '确认删除 2 个会话？', '词条占位替换（含问号）')
eq(t('nonexistent-key'), 'nonexistent-key', '缺词回退到 key 本身')
eq(t('remove'), '删除选中', '无参数词条')

// --------------------------------------- apply / 插槽登记（历史 bug 的回归测试）

/**
 * 回归背景：第一版把插槽写成 `ctx.slots.inject(...)`，而 DSH 0.2.0-rc.x 的插槽是
 * 一个必须通过 `ctx.inject(['slots'], cb)` 才能拿到的服务 —— 直接访问 `ctx.slots`
 * 抛错被 catch 吞掉，于是**宿主路由正常、界面上一个入口都没有**（现象：左侧栏
 * 找不到任何删除功能）。下面这几条断言把那个写法钉死。
 */

function makeCtx({ withSlots = true } = {}) {
  const registered = []
  const effects = []
  const slots = {
    inject(slot, fn) {
      registered.push(slot)
      return fn()
    },
    register(opts) {
      registered.push(opts)
      return () => {}
    },
  }
  const owner = {
    get: (name) => (name === 'slots' && withSlots ? slots : undefined),
    effect: (fn, label) => {
      effects.push(label)
      return fn()
    },
  }
  return {
    inject: (services, cb) => cb(owner),
    get: () => undefined,
    _registered: registered,
    _effects: effects,
  }
}

delete sandbox.__dshDeleteStore__
const ctx = makeCtx()
mod.apply(ctx)
ok(
  ctx._registered.includes('sidebar.footer.action'),
  'apply 必须登记 sidebar.footer.action（历史 bug：写成 ctx.slots 导致一个入口都挂不上）',
)
ok(ctx._registered.includes('shell.overlay'), 'apply 必须登记 shell.overlay')
const entryOpt = ctx._registered.find((r) => r !== null && typeof r === 'object' && r.id === 'dsh-delete-entry')
const panelOpt = ctx._registered.find((r) => r !== null && typeof r === 'object' && r.id === 'dsh-delete-panel')
eq(entryOpt?.name, 'sidebar.footer.action', '入口条目的 name')
eq(panelOpt?.name, 'shell.overlay', '面板条目的 name')
ok(
  ctx._effects.some((label) => String(label).includes('dsh-delete')),
  '登记要挂在 owner.effect 上，fiber 销毁时才能注销',
)

// 降级路径：宿主没有 slots 服务时不能抛，只警告
delete sandbox.__dshDeleteStore__
const ctxNoSlots = makeCtx({ withSlots: false })
let threw = false
try {
  mod.apply(ctxNoSlots)
} catch {
  threw = true
}
ok(!threw, '宿主没有 slots 服务时 apply 不应抛错')
eq(ctxNoSlots._registered.length, 0, '没有 slots 时不应登记任何条目')
ok(
  warnings.some((w) => w.includes('slots')),
  '没有 slots 时应当留下一条警告（而不是静默失败）',
)

// 垃圾入参的防御
threw = false
try {
  mod.apply(undefined)
  mod.apply(null)
  mod.apply({})
} catch {
  threw = true
}
ok(!threw, 'apply(undefined / null / {}) 都不应抛错')

// ------------------------------------------------------------------- 收尾

console.log(`dsh-delete client smoke: ${passed} 条通过, ${failures.length} 条失败`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部通过 ✅')
