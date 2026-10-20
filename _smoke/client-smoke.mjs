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

const {
  buildRows,
  buildTree,
  descendantsOf,
  siblingsOf,
  rootOf,
  cascadeSelection,
  subagentIds,
  fmtBytes,
  t,
  identityKey,
  baseName,
  archivedIdsOf,
  workspaceLabelOf,
  refreshSessionList,
  IMAGE_TAB_ID,
  IMAGE_TAB_KIND,
  keyOfItem,
  selectable,
  originOf,
  applyFilters,
  liveSelection,
  toggleSelection,
  pickOldest,
  pickAllButNewest,
  selectionSummary,
  sourceBadgeOf,
  offloadOutcome,
  whyOf,
  fmtTokens,
  costForSelection,
  costTextOf,
} = mod._internals

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

// ------------------------- 回归：id 别名、标题、类型、归档（用户报的三类 bug）

/**
 * 回归背景（用户实测截图）：
 *   1. **会话名识别错误**：子 agent 会话在面板里显示成 "Downloads"（cwd 目录名），
 *      而磁盘日志里明明白白写着它的真实标题；根会话则显示成裸 id。
 *   2. **会话类型识别错误**：根会话被打上「子 agent」徽章（subagent 投影的空对象
 *      被当成"是子 agent"）；同时磁盘名被剥成裸 uuid，导致快照行与磁盘行对不上，
 *      同一会话出现两行、running 之类信息各缺一半。
 *   3. **删不干净**：裸 uuid 目录（子 agent）旧版根本扫不到；而且归档/删除用的
 *      id 写法跟宿主认识的对不上，文件删了但左侧栏里的行还在。
 * 下面这几组断言把这三点钉死。
 */

const H = '11111111-0000-4000-8000-00000000000b' // 根：磁盘写 session-<H>，快照写 <H>
const I = '22222222-0000-4000-8000-00000000000c' // 子 agent：磁盘写 <I>，父 id 写 session-<H>
const J = '33333333-0000-4000-8000-00000000000d' // 只在快照里（宿主内存里的会话）
const K = '44444444-0000-4000-8000-00000000000e' // 分支（fork）：有 parentId，但不是子 agent

const inventory2 = {
  items: [
    {
      id: 'session-' + H,
      ids: ['session-' + H, H],
      bytes: 500,
      dirs: ['h'],
      files: [],
      projFiles: [],
      workspaceSlug: '--ws--',
      // 磁盘侧（header / 日志）给的标题与类型
      meta: { title: '磁盘标题', cwd: 'C:\\w', isSubagent: false, createdAt: 1000 },
    },
    {
      id: I,
      ids: [I],
      bytes: 200,
      dirs: ['i'],
      files: [],
      projFiles: [],
      workspaceSlug: '--ws--',
      meta: { title: '# 任务：子任务标题', cwd: 'C:\\w', isSubagent: true, parentId: 'session-' + H, createdAt: 1500 },
    },
  ],
}

const snapshot2 = {
  [H]: { id: H, title: '', displayTitle: 'Downloads', cwd: 'C:\\w', parentId: '', origin: '', running: false, blank: false, updatedAt: 9000 },
  [I]: { id: I, title: '', displayTitle: 'Downloads', cwd: 'C:\\w', parentId: 'session-' + H, origin: 'subagent', running: true, blank: false, updatedAt: 8000 },
  [J]: { id: J, title: '', displayTitle: 'Downloads', cwd: 'C:\\w', parentId: '', origin: '', running: false, blank: false, updatedAt: 7000 },
  [K]: { id: K, title: '分支会话', displayTitle: '分支会话', cwd: 'C:\\w', parentId: 'session-' + H, origin: 'branch', running: false, blank: false, updatedAt: 7500 },
}

const rows2 = buildRows(inventory2, snapshot2)
eq(rows2.length, 4, '两种 id 写法必须合并成 4 行（含分支行）')
const byKey2 = new Map(rows2.map((r) => [identityKey(r.id), r]))
const rowH = byKey2.get(H)
const rowI = byKey2.get(I)
const rowJ = byKey2.get(J)
const rowK = byKey2.get(K)
ok(rowH !== undefined, '磁盘上带前缀的会话应出现在合并结果里')
ok(rowI !== undefined, '磁盘上裸 uuid 的子 agent 应出现在合并结果里')
eq(rowH.id, H, '行的 id 优先取快照里的那个（宿主认识的写法）')
eq(rowH.diskOnly, false, '磁盘行与快照行合并后不再标「仅磁盘」')
eq(rowH.title, '磁盘标题', '快照没有持久标题时用磁盘标题，而不是 cwd 目录名')
eq(rowI.title, '# 任务：子任务标题', '子 agent 的真实标题来自磁盘（旧版显示 Downloads）')
eq(rowI.isSubagent, true, '子 agent 类型正确（快照 origin + 磁盘 header）')
eq(rowI.running, true, '子 agent 的运行状态来自快照')
eq(rowI.parentId, 'session-' + H, '父 id 保留宿主写法')
eq(rowJ.title, 'Downloads', '只有快照的会话退回 DSH 的 displayTitle')
eq(rowH.paths, 1, '合并后路径数来自磁盘盘点')
eq(rowK.isSubagent, false, '分支（fork）有 parentId 但不是子 agent')
eq(rowK.parentId, 'session-' + H, '分支的父 id 仍保留（用于树形展示）')

const tree2 = buildTree(rows2)
eq(tree2.roots.length, 2, '父 id 与子行 id 写法不同也要能挂上（H / J 是根）')
eq(tree2.childrenOf.get(H), [I, K], '子 agent 和分支都挂在父行下（跨前缀写法）')
eq(descendantsOf(tree2, H).sort(), [I, K].sort(), '后代计算跨前缀写法，含分支')
eq(subagentIds(rows2).sort(), [I], '「全选子 agent」只挑真正的子 agent，不含分支')

// 纯函数：id 归一与路径末段
eq(identityKey('session-' + H), H, 'identityKey 剥掉 session- 前缀')
eq(identityKey(H), H, 'identityKey 对裸 uuid 幂等')
eq(identityKey('session-' + H.toUpperCase()), H, 'identityKey 大小写不敏感')
eq(baseName('A:\\Downloads'), 'Downloads', 'baseName 取目录末段')
eq(baseName('A:\\Downloads\\'), 'Downloads', 'baseName 忽略结尾分隔符')
eq(workspaceLabelOf({ cwd: 'A:\\Downloads', workspaceSlug: '--A-Downloads--' }), 'Downloads', '工作区展示名用 cwd 末段')
eq(workspaceLabelOf({ cwd: '', workspaceSlug: '--A-Downloads--' }), '--A-Downloads--', '没有 cwd 时退回磁盘目录键')

// 归档 / 刚删除的标记（面板要把这两件事显示出来）
const rows3 = buildRows(inventory2, snapshot2, { archived: ['session-' + H], removed: ['session-' + I] })
const byKey3 = new Map(rows3.map((r) => [identityKey(r.id), r]))
ok(byKey3.get(H).archived === true, '已归档集合按 id 别名匹配（前缀写法也算命中）')
ok(byKey3.get(I).removed === true, '本次删掉的会话标记为已删除')
ok(byKey3.get(J).archived === false, '没归档的会话不带归档标记')

const fakeCtx = {
  get: (name) =>
    name === 'workspaces'
      ? { list: { getSnapshot: () => ({ archivedSessionIds: ['session-' + H] }) } }
      : undefined,
}
eq(archivedIdsOf(fakeCtx).has('session-' + H), true, 'archivedIdsOf 读工作区服务的归档集合')
eq(archivedIdsOf(undefined).size, 0, '读不到工作区服务时返回空集')
eq(
  archivedIdsOf({ get: () => ({ list: { getSnapshot: () => { throw new Error('boom') } } }) }).size,
  0,
  '工作区服务抛错时返回空集（不能让面板打不开）',
)

// 新增词条
eq(t('pathsLabel', { n: 3 }), '3 条路径', '路径数词条')
eq(t('badgeArchived'), '已归档', '已归档徽章词条')
eq(t('badgeRemoved'), '已删除', '已删除徽章词条')

// 刷新探测：客户端 sessions 服务的 refresh() 才是官方入口（历史 bug：写成 entry.fn 永远调不到）
{
  let called = 0
  let thisOk = false
  const sessions = {
    refresh() {
      called += 1
      thisOk = this === sessions
    },
  }
  eq(refreshSessionList({ get: (name) => (name === 'sessions' ? sessions : undefined) }), true, '有 sessions.refresh 时应调用它')
  eq(called, 1, 'refresh 只调一次')
  eq(thisOk, true, 'refresh 必须以服务自身为 this 调用')

  let legacy = 0
  const legacyList = {
    reload() {
      legacy += 1
    },
  }
  eq(refreshSessionList({ get: () => ({ list: legacyList }) }), true, '老版本只有 list.reload 时也能刷新')
  eq(legacy, 1, 'list.reload 被调用')

  eq(refreshSessionList({ get: () => ({}) }), false, '没有任何刷新方法时返回 false')
  eq(refreshSessionList(undefined), false, 'ctx 缺失时返回 false')
  eq(
    refreshSessionList({ get: () => ({ refresh() { throw new Error('boom') } }) }),
    false,
    '刷新抛错时返回 false 且不冒泡',
  )
}

// --------------------------------------- apply / 插槽登记（历史 bug 的回归测试）

/**
 * 回归背景：第一版把插槽写成 `ctx.slots.inject(...)`，而 DSH 0.2.0-rc.x 的插槽是
 * 一个必须通过 `ctx.inject(['slots'], cb)` 才能拿到的服务 —— 直接访问 `ctx.slots`
 * 抛错被 catch 吞掉，于是**宿主路由正常、界面上一个入口都没有**（现象：左侧栏
 * 找不到任何删除功能）。下面这几条断言把那个写法钉死。
 */

function makeCtx({ withSlots = true, withRightTabs = true } = {}) {
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
  const sidebarRightTabs = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  const sidebarRight = { openTab() {} }
  const owner = {
    get: (name) => {
      if (name === 'slots' && withSlots) return slots
      if (name === 'sidebarRightTabs' && withRightTabs) return sidebarRightTabs
      if (name === 'sidebarRight') return sidebarRight
      return undefined
    },
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

// ------------------------------------------------ 右侧栏「图片管理」页签（四段式挂载）

{
  delete sandbox.__dshDeleteStore__
  const ctxTabs = makeCtx()
  mod.apply(ctxTabs)
  const tab = ctxTabs._registered.find((r) => r !== null && typeof r === 'object' && r.id === IMAGE_TAB_ID)
  ok(tab !== undefined, 'apply 必须把页签定义注册进 sidebarRightTabs')
  eq(tab?.kind, IMAGE_TAB_KIND, '页签定义带 kind')
  eq(tab?.multiple, true, '多个会话各开一个页签（multiple: true）')
  eq(typeof tab?.title, 'function', '页签标题是函数（语言切换后取新词）')
  eq(t('imgTab'), tab?.title(), '页签标题用词条 imgTab')
  eq(Array.isArray(tab?.guide) && tab.guide.length > 0, true, '带空态引导入口')
  eq(tab?.guide?.[0]?.title(), t('imgTab'), '引导入口的标题可翻译')

  const body = ctxTabs._registered.find(
    (r) => r !== null && typeof r === 'object' && r.name === 'sidebar.right.pane.tab',
  )
  ok(body !== undefined, '必须注册 sidebar.right.pane.tab 正文')
  eq(body?.key, IMAGE_TAB_ID, '正文的 key 与页签定义 id 一致')
  eq(typeof body?.inject, 'function', '正文要能按会话注入')
  eq(body.inject('sess-1').sessionId, 'sess-1', '正文注入会话 id')
  eq(typeof body.inject('sess-1').openTab, 'function', '正文注入 openTab（冷会话时用来打开会话）')

  const title = ctxTabs._registered.find(
    (r) => r !== null && typeof r === 'object' && r.name === 'sidebar.right.pane.tab.title',
  )
  ok(title !== undefined, '必须注册 sidebar.right.pane.tab.title')
  eq(title?.key, IMAGE_TAB_ID, '标题 chip 的 key 与定义 id 一致')

  ok(
    ctxTabs._effects.some((label) => String(label).includes('image tab')),
    '页签登记挂在 owner.effect 上（声明式注入找不到 fiber 时不会留下悬空注册）',
  )
}

// 降级：宿主没有 sidebarRightTabs 时不能抛，删除功能照旧
{
  delete sandbox.__dshDeleteStore__
  const ctxNoTabs = makeCtx({ withRightTabs: false })
  let tabThrew = false
  try {
    mod.apply(ctxNoTabs)
  } catch {
    tabThrew = true
  }
  ok(!tabThrew, '缺 sidebarRightTabs 时 apply 不应抛错')
  ok(ctxNoTabs._registered.includes('sidebar.footer.action'), '缺 sidebarRightTabs 时侧边栏入口照旧注册')
  ok(
    warnings.some((w) => w.includes('sidebarRightTabs')),
    '缺 sidebarRightTabs 时留下警告（而不是静默失败）',
  )
}

// ------------------------------------------------ 图片管理的纯选择逻辑

{
  const now = 1_700_000_000_000
  const mk = (seq, imageIndex, time, extra) => ({
    seq,
    imageIndex,
    time,
    bytes: 10,
    width: 4,
    height: 4,
    name: 'n' + String(seq) + '.png',
    attachmentId: 'sha256:' + String(seq).padStart(2, '0').repeat(32),
    origin: 'tool/result',
    heldPath: 'A:\\x\\n' + String(seq) + '.png',
    offloaded: false,
    ...(extra ?? {}),
  })
  const items = [
    mk(0, 0, now - 10 * 86400e3),
    mk(1, 0, now - 3 * 86400e3),
    mk(2, 0, now - 3600e3, { origin: 'user/message', name: 'mine.png' }),
    mk(3, 0, now - 1000, { offloaded: true }),
  ]

  eq(keyOfItem({ seq: 7, imageIndex: 2 }), '7:2', '出现位置的稳定键')
  eq(
    selectable(items).map((i) => i.seq),
    [0, 1, 2],
    '已摘除的不在可操作集合里',
  )

  const oldest2 = pickOldest(items, new Set(), 2)
  eq([...oldest2].sort(), ['0:0', '1:0'], '「最早 N 张」按时间取，跳过已摘除')
  eq([...pickOldest(items, new Set(), 99)].length, 3, 'N 超过总数时取全部')
  eq([...pickOldest(items, oldest2, 1)].length, 2, '「最早 N 张」是追加：已在选择里的不重复计数')
  eq([...pickOldest(items, oldest2, 3)].length, 3, '「最早 N 张」追加后覆盖全部可操作项')

  const keep1 = pickAllButNewest(items, new Set(), 1)
  eq([...keep1].sort(), ['0:0', '1:0'], '「除最近 N 张外全部」保留最新 N 张')
  const keep0 = pickAllButNewest(items, new Set(), 0)
  eq([...keep0].sort(), ['0:0', '1:0', '2:0'], 'N=0 时选全部可操作的')

  eq(applyFilters(items, { query: 'mine' }).map((i) => i.seq), [2], '按文件名搜索')
  eq(applyFilters(items, { origin: 'user' }).map((i) => i.seq), [2], '按来源筛选（你上传的）')
  eq(applyFilters(items, { origin: 'tool' }).map((i) => i.seq), [0, 1], '按来源筛选（工具）不含已摘除')
  eq(applyFilters(items, { origin: 'tool', includeOffloaded: true }).map((i) => i.seq), [0, 1, 3], 'includeOffloaded 时才带已摘除项')
  eq(applyFilters(items, { time: 'day', now }).map((i) => i.seq), [2], '按时间筛选（最近 24 小时）')
  eq(applyFilters(items, { time: 'week', now, includeOffloaded: true }).map((i) => i.seq), [1, 2, 3], '按时间筛选（最近 7 天）')
  eq(applyFilters(items, {}).map((i) => i.seq), [0, 1, 2], '无筛选时只给可操作项')

  const one = selectionSummary(items, new Set(['1:0']))
  eq(one.count, 1, '选择合计张数')
  eq(one.bytes, 10, '选择合计字节')
  eq(one.attachmentIds.length, 1, '选择涉及的附件 id')

  const stale = liveSelection(items, new Set(['1:0', '3:0', '99:0']))
  eq([...stale], ['1:0'], '选择收缩：已摘除 / 已消失的自动丢掉')

  eq([...toggleSelection(new Set(), items[0])], ['0:0'], '勾选')
  eq([...toggleSelection(new Set(['0:0']), items[0])], [], '取消勾选')
  eq([...toggleSelection(new Set(), items[3])], [], '已摘除的勾不上')

  eq(originOf(items[2]), 'user', 'origin 归一（user/message → user）')
  eq(originOf(items[0]), 'tool', 'origin 归一（tool/result → tool）')

  // 源文件徽标：读删盘计划里的同名条目
  const badge = sourceBadgeOf(items[0], {
    diskPlan: [{ kind: 'source', path: items[0].heldPath, action: 'SKIPPED', reason: 'SHARED_WITH_OTHER_SESSION', referencedBy: ['a', 'b'] }],
  })
  eq(badge.text, t('imgShared', { n: 2 }), '源文件徽标：被别的会话引用')
  const badge2 = sourceBadgeOf(items[0], {
    diskPlan: [{ kind: 'source', path: items[0].heldPath, action: 'DELETE', scope: 'outside-workspace', risk: 'medium' }],
  })
  eq(badge2.text, t('imgOutsideWorkspace'), '源文件徽标：工作区外')

  // 结果文案：三种结局必须分得清，尤其**必须带出宿主的原始错误文本**
  const okText = offloadOutcome({
    ok: true,
    offload: { count: 3, skipped: [{ seq: 1, imageIndex: 0, reason: 'ALREADY_OFFLOADED' }] },
    disk: { deleted: [{ path: 'a' }], skipped: [{ path: 'b' }], failed: [], reclaimedBytes: 2048 },
  })
  eq(okText.includes(t('imgDoneOffload', { n: 3 })), true, '成功文案带摘除张数')
  eq(okText.includes(t('imgSkippedItems', { n: 1 })), true, '成功文案带被跳过项数')
  eq(okText.includes(t('imgDoneDisk', { n: 1, size: fmtBytes(2048) })), true, '成功文案带删盘结果')

  const nothing = offloadOutcome({
    ok: false,
    error: 'NOTHING_TO_OFFLOAD',
    skippedItems: [{ seq: 1, imageIndex: 0, reason: 'ALREADY_OFFLOADED' }],
  })
  eq(nothing.includes(t('imgWhyOffloaded')), true, '「没有可摘除项」要说明原因，而不是只说失败')

  const offscreen = offloadOutcome({ ok: false, error: 'NOTHING_TO_OFFLOAD', skippedItems: [{ reason: 'NOT_ON_SURFACE' }] })
  eq(offscreen.includes(t('imgWhyOffscreen')), true, '已不在当前上下文 → 对应解释')

  const failed = offloadOutcome({
    ok: false,
    error: 'APPEND_FAILED',
    detail: 'image/offload: target seq 818 is not a current surface node',
  })
  eq(failed.includes('APPEND_FAILED'), true, '失败文案带错误码')
  eq(failed.includes('not a current surface node'), true, '⚠️ 失败文案必须带出宿主原始文本（否则只有错误码，排查无从下手）')

  const bare = offloadOutcome({ ok: false, error: 'SOMETHING' })
  eq(bare, t('imgError', { msg: 'SOMETHING' }), '没有 detail 时退回只显示错误码')
  eq(offloadOutcome(null), '', 'null 报告 → 空文案')

  // ---- 缓存代价预估 ----
  eq(fmtTokens(999), '999', 'fmtTokens: 三位以下原样')
  eq(fmtTokens(74870), '74.9k', 'fmtTokens: 万级保留一位')
  eq(fmtTokens(1234567), '1.2M', 'fmtTokens: 百万级')
  eq(fmtTokens('x'), '0', 'fmtTokens: 非法值归零')

  const cost = {
    source: 'usage',
    total: 451758,
    baselineHitRatePct: 99.9,
    bySeq: [
      { ok: true, seq: 818, total: 451758, cached: 376888, reprocess: 74870, hitRatePct: 83.4, baselineHitRatePct: 99.9 },
      { ok: true, seq: 6888, total: 451758, cached: 451456, reprocess: 302, hitRatePct: 99.9, baselineHitRatePct: 99.9 },
    ],
  }
  // 断点 = 被选中的最早那条：选 (818) 与 (6888) → 取 818 那条
  const pickWorst = costForSelection(cost, new Set(['818:0', '6888:0']))
  eq(pickWorst?.seq, 818, '多选时取最早的那条作为断点（代价最大）')
  const pickLatest = costForSelection(cost, new Set(['6888:0']))
  eq(pickLatest?.seq, 6888, '只选最新的那张 → 断点靠后')
  eq(costForSelection(cost, new Set()), null, '没选 → 无预估')
  eq(costForSelection(null, new Set(['818:0'])), null, '没有 cost 数据 → 无预估')
  eq(costForSelection({ bySeq: [] }, new Set(['818:0'])), null, 'bySeq 为空 → 无预估')

  const bigText = costTextOf(pickWorst)
  eq(bigText.includes('74.9k'), true, '代价文案带重算 token 数')
  eq(bigText.includes('83.4'), true, '代价文案带断点后的命中率')
  eq(bigText.includes('99.9'), true, '代价文案带平时命中率作对比')
  eq(costTextOf(pickLatest), t('imgCostTiny', { re: '302' }), '重算量很小 → 用「几乎不影响缓存」的说法')
  eq(costTextOf({ ok: false, reason: 'NO_USAGE' }), t('imgCostUnknown'), '没有用量记录 → 说明无法估算')
  eq(costTextOf(null), '', 'null 预估 → 空文案')

  // 该会话平时就没有缓存命中（真机里确实有这种会话）→ 不能说「命中率要掉」，否则误导
  const noCache = costTextOf({
    ok: true,
    seq: 10,
    total: 385017,
    cached: 313136,
    reprocess: 71881,
    hitRatePct: 81.3,
    baselineHitRatePct: 0.6,
  })
  eq(noCache, t('imgCostNoCache', { base: '0.6', total: '385k' }), '平时命中率 <5% → 改成「不会额外损失缓存」的说法')
}

// ------------------------------------------------------------------- 收尾

console.log(`dsh-delete client smoke: ${passed} 条通过, ${failures.length} 条失败`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部通过 ✅')

