/**
 * `dsh-delete` 浏览器半 —— 会话删除面板。
 *
 * 贡献两个条目：
 *
 * 1. **入口**（`sidebar.footer.action`）：侧边栏底部一行，点开/收起管理面板。
 * 2. **面板**（`shell.overlay`）：帧级浮层，位于所有面板的滚动容器之外，
 *    所以切会话、开设置都不会把它挤掉；关闭时**完全不渲染**，不挡任何操作。
 *
 * 数据来源有两条，各司其职：
 *   - **会话列表快照**（`ctx.get('sessions').list`）—— 官方口径，提供
 *     `parentId`（父子关系）、`running` / `completed`、`cwd`、标题。这是"左侧
 *     栏里看得见的会话"的权威来源。
 *   - **宿主盘点路由**（`/plugins/dsh-delete/inventory`）—— 磁盘口径，提供
 *     每个会话占用的真实路径与字节数，以及"列表里已消失但文件还在"的残留会话。
 *
 * 删除永远走宿主路由落盘（这是"删除磁盘文件"的唯一保证）；若宿主暴露了原生的
 * 删除/刷新方法，则额外调用一次，让内存里的列表同步。
 *
 * 加载方式：`window.__ModuleLoader__.load({ id, factory })`，
 * 其中 `require` 只解析平台自带的外部模块（`react`），不是文件系统路径。
 */

window.__ModuleLoader__.load({
  id: 'dsh-delete',

  factory: function (require) {
    const React = require('react')
    const h = React.createElement

    /** 入口所在的插槽：侧边栏底部动作区（其它插件也用这里）。 */
    const ENTRY_SLOT = 'sidebar.footer.action'
    const ENTRY_ID = 'dsh-delete-entry'
    /** 面板所在的插槽：帧级浮层。 */
    const OVERLAY_SLOT = 'shell.overlay'
    const OVERLAY_ID = 'dsh-delete-panel'
    /** 共享实例挂在 globalThis 上：客户端 HMR 重新求值 bundle 时复用同一个 store，
     *  而不是留下一份新的（否则面板状态会在每次热更后丢失）。 */
    const STORE_KEY = '__dshDeleteStore__'
    /** 样式标签的 id：只注入一次。 */
    const STYLE_ID = 'dsh-delete-style'

    const INVENTORY_URL = '/plugins/dsh-delete/inventory'
    const DELETE_URL = '/plugins/dsh-delete/delete'

    // ---------------------------------------------------------------- i18n

    const DICT_ZH = {
      entry: '会话管理',
      entryOpen: '关闭会话管理',
      title: '会话管理 / 删除',
      subtitle: '勾选要删除的会话；侧边栏里能看到的、以及磁盘上残留的，都会列出来。',
      refresh: '刷新',
      close: '关闭',
      search: '搜索标题 / 路径…',
      allWorkspaces: '全部工作区',
      selectAll: '全选',
      clear: '清空',
      expandAll: '展开全部',
      collapseAll: '折叠全部',
      pickSubagents: '选中子 agent',
      pickSiblings: '选中团队成员',
      pickFamily: '选中整族',
      loading: '正在读取会话…',
      empty: '没有匹配的会话',
      selectedCount: '已选 {n} 个会话',
      totalSize: '合计 {size}',
      diskOnly: '仅在磁盘',
      noSnapshot: '（读不到会话列表服务，仅显示磁盘盘点结果）',
      remove: '删除选中',
      confirmTitle: '确认删除 {n} 个会话？',
      confirmBody: '将从磁盘移除 {paths} 条路径（{size}）。此操作不可撤销。',
      confirmMore: '……以及另外 {n} 个',
      cancel: '取消',
      confirmYes: '确认删除',
      deleting: '正在删除…',
      doneTitle: '已删除 {n} 个会话',
      donePaths: '移除 {paths} 条路径，释放 {size}',
      doneFailed: '{n} 条路径删除失败',
      reloadHint: '列表可能仍显示已删除的会话，刷新页面即可。',
      reload: '刷新页面',
      error: '出错了：{msg}',
      badgeRunning: '运行中',
      badgeSubagent: '子 agent',
      badgeDiskOnly: '仅磁盘',
      sizeLabel: '{size}',
      openHint: '展开/折叠子会话',
    }

    const DICT_EN = {
      entry: 'Sessions',
      entryOpen: 'Close session manager',
      title: 'Session manager / delete',
      subtitle: 'Tick the sessions to delete — both the ones in the sidebar and any leftover on disk.',
      refresh: 'Refresh',
      close: 'Close',
      search: 'Search title / path…',
      allWorkspaces: 'All workspaces',
      selectAll: 'Select all',
      clear: 'Clear',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      pickSubagents: 'Select subagents',
      pickSiblings: 'Select teammates',
      pickFamily: 'Select whole family',
      loading: 'Reading sessions…',
      empty: 'No matching session',
      selectedCount: '{n} selected',
      totalSize: '{size} total',
      diskOnly: 'disk only',
      noSnapshot: '(session-list service unavailable — showing the disk inventory only)',
      remove: 'Delete selected',
      confirmTitle: 'Delete {n} session(s)?',
      confirmBody: 'This removes {paths} path(s) from disk ({size}). It cannot be undone.',
      confirmMore: '…and {n} more',
      cancel: 'Cancel',
      confirmYes: 'Delete',
      deleting: 'Deleting…',
      doneTitle: 'Deleted {n} session(s)',
      donePaths: 'Removed {paths} path(s), freed {size}',
      doneFailed: '{n} path(s) failed to delete',
      reloadHint: 'The list may still show deleted sessions; reload the page.',
      reload: 'Reload page',
      error: 'Error: {msg}',
      badgeRunning: 'running',
      badgeSubagent: 'subagent',
      badgeDiskOnly: 'disk only',
      sizeLabel: '{size}',
      openHint: 'Expand/collapse sub-sessions',
    }

    function currentDict() {
      try {
        const lang = String(navigator?.language ?? '').toLowerCase()
        if (lang.startsWith('zh')) return DICT_ZH
      } catch {
        /* 沙箱 frame 里 navigator 可能取不到：走中文默认 */
      }
      return DICT_ZH
    }

    const DICT = currentDict()

    /** 取词 + `{name}` 占位替换；缺词回退到中文再回退到 key 本身。 */
    function t(key, params) {
      const raw = DICT[key] ?? DICT_ZH[key] ?? key
      if (params === undefined) return raw
      return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
    }

    // -------------------------------------------------------------- 工具函数

    /** 人类可读体积。 */
    function fmtBytes(bytes) {
      const n = Number(bytes)
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let v = n
      let i = 0
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
      }
      return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
    }

    /** 相对时间（够用即可，不做 i18n 复数）。 */
    function fmtTime(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return ''
      const diff = Date.now() - n
      if (diff < 60_000) return '刚刚'
      const min = Math.floor(diff / 60_000)
      if (min < 60) return `${min} 分钟前`
      const hour = Math.floor(min / 60)
      if (hour < 24) return `${hour} 小时前`
      const day = Math.floor(hour / 24)
      if (day < 30) return `${day} 天前`
      try {
        return new Date(n).toLocaleDateString()
      } catch {
        return ''
      }
    }

    /** 取会话 id 的稳定短前缀（显示用）。 */
    function shortId(id) {
      const s = String(id ?? '')
      return s.length > 8 ? s.slice(0, 8) : s
    }

    /**
     * 从注入上下文里读一个服务。
     *
     * 与服务声明（`inject: [...]`）的区别是刻意的：声明了但缺失的服务会把整条
     * fiber 停住 —— 于是"某个服务稍后才激活"的部署会**彻底丢掉**本插件；动态
     * 读取则允许它在服务到位后自然接上。dsh-bgm 用的是同一套判断。
     */
    function serviceAt(owner, name) {
      if (owner === undefined || owner === null || typeof owner.get !== 'function') return undefined
      const value = owner.get(name)
      return value === null || value === undefined ? undefined : value
    }

    // ---------------------------------------------------------------- store

    /**
     * 面板状态与数据。刻意做成极小的订阅式 store，而不是 React context：
     * 入口和面板由不同的 owner 挂载，两棵树都不归本插件控制。
     */
    function createStore() {
      const listeners = new Set()
      const state = {
        open: false,
        version: 0,
        loading: false,
        error: null,
        inventory: null,
        rows: [],
        selected: new Set(),
        collapsed: new Set(),
        query: '',
        workspace: '',
        busy: false,
        confirm: false,
        result: null,
      }
      const emit = () => {
        state.version += 1
        for (const fn of listeners) {
          try {
            fn()
          } catch {
            /* 单个订阅者抛错不该打断其它订阅者 */
          }
        }
      }
      return {
        state,
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        patch(patch) {
          Object.assign(state, patch)
          emit()
        },
        toggleSelected(id) {
          if (state.selected.has(id)) state.selected.delete(id)
          else state.selected.add(id)
          emit()
        },
        addSelected(ids) {
          for (const id of ids) state.selected.add(id)
          emit()
        },
        setSelected(ids) {
          state.selected = new Set(ids)
          emit()
        },
        toggleCollapsed(id) {
          if (state.collapsed.has(id)) state.collapsed.delete(id)
          else state.collapsed.add(id)
          emit()
        },
      }
    }

    /** 取（或建）共享 store。 */
    function getStore() {
      const existing = globalThis[STORE_KEY]
      if (existing !== undefined && typeof existing?.patch === 'function') return existing
      const created = createStore()
      globalThis[STORE_KEY] = created
      return created
    }

    /** 订阅 store 版本号 —— useSyncExternalStore 需要的是一个稳定可比的快照值。 */
    function useStoreVersion(store) {
      return React.useSyncExternalStore(
        React.useCallback((fn) => store.subscribe(fn), [store]),
        React.useCallback(() => store.state.version, [store]),
        React.useCallback(() => store.state.version, [store]),
      )
    }

    // ---------------------------------------------------- 会话列表服务（快照）

    /**
     * 收窄 `ctx.get('sessions')`：只有真正具备 `list.getSnapshot` +
     * `list.subscribe` 的宿主才认（老版本没有 outward sessions 服务）。
     */
    function sessionsFaceOf(ctx) {
      try {
        const rec = ctx?.get?.('sessions')
        if (rec === null || typeof rec !== 'object') return null
        const list = rec.list
        if (list === null || typeof list !== 'object') return null
        if (typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return null
        return rec
      } catch {
        return null
      }
    }

    /** 从快照里取出 byId 表（防御式：任何一步不对都当作空）。 */
    function snapshotRows(face) {
      if (face === null) return {}
      try {
        const snap = face.list.getSnapshot()
        const byId = snap?.byId
        if (byId === null || typeof byId !== 'object') return {}
        return byId
      } catch {
        return {}
      }
    }

    /** 订阅会话列表快照。 */
    function useSessionSnapshot(ctx) {
      const face = React.useMemo(() => sessionsFaceOf(ctx), [ctx])
      const subscribe = React.useCallback(
        (fn) => {
          if (face === null) return () => {}
          try {
            return face.list.subscribe(fn)
          } catch {
            return () => {}
          }
        },
        [face],
      )
      const getSnapshot = React.useCallback(() => {
        const byId = snapshotRows(face)
        // 快照对象每次都是新的引用会引发无限重渲染，所以按 id 列表做浅比较键。
        return Object.keys(byId).sort().join(',')
      }, [face])
      const key = React.useSyncExternalStore(
        subscribe,
        getSnapshot,
        React.useCallback(() => '', []),
      )
      return React.useMemo(() => {
        const byId = snapshotRows(face)
        const out = {}
        for (const id of Object.keys(byId)) {
          const rec = byId[id]
          if (rec === null || typeof rec !== 'object') continue
          out[id] = {
            id,
            title: typeof rec.displayTitle === 'string' && rec.displayTitle !== ''
              ? rec.displayTitle
              : typeof rec.title === 'string'
                ? rec.title
                : '',
            cwd: typeof rec.cwd === 'string' ? rec.cwd : '',
            parentId: typeof rec.parentId === 'string' && rec.parentId !== '' ? rec.parentId : '',
            origin: typeof rec.origin === 'string' ? rec.origin : '',
            running: rec.running === true,
            completed: rec.completed === true,
            blank: rec.blank === true,
            updatedAt: Number.isFinite(Number(rec.updatedAt)) ? Number(rec.updatedAt) : 0,
          }
        }
        return out
        // key 参与了依赖：会话集合一变就重建
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [face, key])
    }

    // ------------------------------------------------------------ 数据装配

    /**
     * 把「磁盘盘点」和「会话列表快照」合并成行。
     *
     * 规则：
     *   - 以两者 id 的并集为准（磁盘上有的即使列表不显示也要能删）。
     *   - 血缘以快照的 `parentId` 为准，缺失时退回磁盘 JSON 里解析出的父 id。
     *   - `blank` 的占位行不显示（与官方列表一致），但**磁盘上仍有文件的行保留**，
     *     否则用户永远清不掉它。
     */
    function buildRows(inventory, snapshot) {
      const byId = new Map()
      const ensure = (id) => {
        let row = byId.get(id)
        if (row === undefined) {
          row = {
            id,
            title: '',
            cwd: '',
            parentId: '',
            running: false,
            completed: false,
            blank: false,
            updatedAt: 0,
            bytes: 0,
            paths: 0,
            workspaceSlug: '',
            inSnapshot: false,
            isSubagent: false,
            diskOnly: false,
          }
          byId.set(id, row)
        }
        return row
      }

      for (const item of inventory?.items ?? []) {
        if (item === null || typeof item !== 'object' || typeof item.id !== 'string') continue
        const row = ensure(item.id)
        const meta = item.meta ?? {}
        row.bytes = Number(item.bytes) || 0
        row.paths =
          (item.dirs?.length ?? 0) + (item.files?.length ?? 0) + (item.projFiles?.length ?? 0)
        row.workspaceSlug = typeof item.workspaceSlug === 'string' ? item.workspaceSlug : ''
        if (row.title === '' && typeof meta.title === 'string') row.title = meta.title
        if (row.cwd === '' && typeof meta.cwd === 'string') row.cwd = meta.cwd
        if (row.parentId === '' && typeof meta.parentId === 'string') row.parentId = meta.parentId
        if (row.updatedAt === 0) {
          row.updatedAt = Number(meta.lastPromptAt) || Number(meta.createdAt) || 0
        }
        row.blank = row.blank || meta.blank === true
        row.isSubagent = row.isSubagent || meta.isSubagent === true
      }

      for (const id of Object.keys(snapshot ?? {})) {
        const rec = snapshot[id]
        const row = ensure(id)
        row.inSnapshot = true
        if (typeof rec.title === 'string' && rec.title !== '') row.title = rec.title
        if (typeof rec.cwd === 'string' && rec.cwd !== '') row.cwd = rec.cwd
        if (typeof rec.parentId === 'string' && rec.parentId !== '') row.parentId = rec.parentId
        row.running = rec.running === true
        row.completed = rec.completed === true
        row.blank = rec.blank === true
        if (rec.updatedAt > 0) row.updatedAt = Math.max(row.updatedAt, rec.updatedAt)
      }

      const rows = [...byId.values()].filter((row) => !row.blank || row.bytes > 0)
      for (const row of rows) row.diskOnly = !row.inSnapshot && row.bytes > 0
      return rows
    }

    /** 由行集合构造父子索引与根集合。 */
    function buildTree(rows) {
      const byId = new Map(rows.map((r) => [r.id, r]))
      const childrenOf = new Map()
      const roots = []
      for (const row of rows) {
        const parent = row.parentId && byId.has(row.parentId) ? row.parentId : ''
        if (parent === '') {
          roots.push(row.id)
          continue
        }
        const list = childrenOf.get(parent)
        if (list === undefined) childrenOf.set(parent, [row.id])
        else list.push(row.id)
      }
      const stamp = (id) => byId.get(id)?.updatedAt ?? 0
      roots.sort((a, b) => stamp(b) - stamp(a))
      for (const list of childrenOf.values()) list.sort((a, b) => stamp(b) - stamp(a))
      return { byId, childrenOf, roots }
    }

    /** 某会话的全部后代。 */
    function descendantsOf(tree, id) {
      const out = []
      const stack = [...(tree.childrenOf.get(id) ?? [])]
      while (stack.length > 0) {
        const cur = stack.pop()
        out.push(cur)
        const kids = tree.childrenOf.get(cur)
        if (kids !== undefined) stack.push(...kids)
      }
      return out
    }

    /** 某会话的团队成员 = 同一父下的兄弟（不含自己）。 */
    function siblingsOf(tree, id) {
      const row = tree.byId.get(id)
      if (row === undefined || row.parentId === '' || !tree.byId.has(row.parentId)) return []
      return (tree.childrenOf.get(row.parentId) ?? []).filter((other) => other !== id)
    }

    /** 某会话所在家族的根（一路上溯到没有父的人）。 */
    function rootOf(tree, id) {
      let cur = id
      const seen = new Set([id])
      for (;;) {
        const row = tree.byId.get(cur)
        if (row === undefined || row.parentId === '' || !tree.byId.has(row.parentId)) return cur
        if (seen.has(row.parentId)) return cur // 环保护
        seen.add(row.parentId)
        cur = row.parentId
      }
    }

    // ---------------------------------------------------------------- 网络

    async function fetchInventory() {
      const res = await fetch(INVENTORY_URL, { cache: 'no-store' })
      const json = await res.json()
      if (json?.ok !== true) throw new Error(json?.error ?? `HTTP ${res.status}`)
      return json
    }

    async function requestDelete(ids, dryRun) {
      const res = await fetch(DELETE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, dryRun: dryRun === true }),
      })
      return await res.json()
    }

    /** 宿主是否暴露了原生删除/刷新方法（探测式，全部 typeof 保护）。 */
    function nativeDelete(ctx, id) {
      try {
        const s = ctx?.get?.('sessions')
        if (s === null || typeof s !== 'object') return false
        const pairs = [
          [s.list, s.list?.remove],
          [s.list, s.list?.delete],
          [s.list, s.list?.drop],
          [s, s.remove],
          [s, s.delete],
        ]
        for (const [owner, fn] of pairs) {
          if (typeof fn === 'function') {
            fn.call(owner, id)
            return true
          }
        }
      } catch {
        /* 探测失败就当没有原生方法 */
      }
      return false
    }

    /** 让内存里的会话列表重新读盘。 */
    function refreshSessionList(ctx) {
      try {
        const s = ctx?.get?.('sessions')
        const candidates = [s?.list?.refresh, s?.list?.reload, s?.refresh]
        for (const fn of candidates) {
          if (typeof fn === 'function') {
            fn.call(fn === s?.refresh ? s : s.list)
            return true
          }
        }
      } catch {
        /* ignore */
      }
      return false
    }

    // ---------------------------------------------------------------- 样式

    const CSS = `
.dshdel-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}
.dshdel-card{width:min(760px,100%);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1e1e21);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.5));overflow:hidden;font-size:13px}
.dshdel-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
.dshdel-head h3{margin:0;font-size:15px;font-weight:600}
.dshdel-sub{color:var(--dsw-alias-label-secondary,#9a9aa2);font-size:12px;margin-top:2px}
.dshdel-grow{flex:1}
.dshdel-btn{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:7px;padding:5px 10px;cursor:pointer;line-height:1.3;white-space:nowrap}
.dshdel-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.11))}
.dshdel-btn:disabled{opacity:.45;cursor:not-allowed}
.dshdel-btn.danger{background:var(--color-red-600,#c0392b);border-color:transparent;color:#fff;font-weight:600}
.dshdel-btn.danger:hover:not(:disabled){filter:brightness(1.12)}
.dshdel-toolbar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.dshdel-input,.dshdel-select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:7px;padding:5px 8px;min-width:0}
.dshdel-input{flex:1;min-width:140px}
.dshdel-body{flex:1;overflow:auto;padding:6px 8px}
.dshdel-row{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px}
.dshdel-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05))}
.dshdel-row.sel{background:color-mix(in srgb,var(--color-red-600,#c0392b) 16%,transparent)}
.dshdel-exp{width:18px;flex:none;text-align:center;cursor:pointer;color:var(--dsw-alias-label-secondary,#999);user-select:none;line-height:18px}
.dshdel-exp.leaf{visibility:hidden}
.dshdel-main{flex:1;min-width:0}
.dshdel-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdel-meta{display:flex;flex-wrap:wrap;gap:8px;color:var(--dsw-alias-label-secondary,#9a9aa2);font-size:11px;margin-top:2px}
.dshdel-badge{font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid currentColor;opacity:.85}
.dshdel-badge.run{color:var(--color-green-500,#2ecc71)}
.dshdel-badge.sub{color:var(--color-amber-500,#e0a800)}
.dshdel-badge.disk{color:var(--dsw-alias-label-secondary,#9a9aa2)}
.dshdel-check{margin-top:2px;flex:none}
.dshdel-foot{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
.dshdel-confirm{padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));background:color-mix(in srgb,var(--color-red-600,#c0392b) 12%,transparent)}
.dshdel-confirm p{margin:0 0 8px}
.dshdel-result{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));font-size:12px}
.dshdel-err{color:var(--color-red-500,#e74c3c)}
.dshdel-entry{width:100%;display:flex;align-items:center;gap:8px;text-align:left}
`

    /** 只注入一次样式标签。 */
    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
      } catch {
        /* 无 document（测试环境）时忽略 */
      }
    }

    // ---------------------------------------------------------------- 组件

    /** 侧边栏底部的入口按钮。 */
    function EntryButton() {
      const store = getStore()
      useStoreVersion(store)
      ensureStyle()
      const open = store.state.open
      return h(
        'button',
        {
          type: 'button',
          className: 'dshdel-btn dshdel-entry',
          title: open ? t('entryOpen') : t('title'),
          'aria-expanded': open,
          onClick: () => store.patch({ open: !open, result: null, confirm: false }),
        },
        h('span', { 'aria-hidden': 'true' }, '🗑'),
        h('span', null, t('entry')),
      )
    }

    /** 一行会话。 */
    function Row(props) {
      const { row, depth, tree, store } = props
      const selected = store.state.selected.has(row.id)
      const kids = tree.childrenOf.get(row.id) ?? []
      const collapsed = store.state.collapsed.has(row.id)
      const hasKids = kids.length > 0
      const meta = []
      if (row.running) meta.push(h('span', { className: 'dshdel-badge run', key: 'run' }, t('badgeRunning')))
      if (row.isSubagent || row.parentId !== '') {
        meta.push(h('span', { className: 'dshdel-badge sub', key: 'sub' }, t('badgeSubagent')))
      }
      if (row.diskOnly) meta.push(h('span', { className: 'dshdel-badge disk', key: 'disk' }, t('badgeDiskOnly')))
      const when = fmtTime(row.updatedAt)
      if (when !== '') meta.push(h('span', { key: 'when' }, when))
      if (row.bytes > 0) meta.push(h('span', { key: 'size' }, fmtBytes(row.bytes)))
      if (row.paths > 0) meta.push(h('span', { key: 'paths' }, `${row.paths} 条路径`))
      if (row.workspaceSlug) meta.push(h('span', { key: 'ws' }, row.workspaceSlug))

      return h(
        'div',
        {
          className: 'dshdel-row' + (selected ? ' sel' : ''),
          style: { paddingLeft: `${8 + depth * 16}px` },
        },
        h(
          'span',
          {
            className: 'dshdel-exp' + (hasKids ? '' : ' leaf'),
            title: hasKids ? t('openHint') : '',
            onClick: () => {
              if (hasKids) store.toggleCollapsed(row.id)
            },
          },
          collapsed ? '▸' : '▾',
        ),
        h('input', {
          className: 'dshdel-check',
          type: 'checkbox',
          checked: selected,
          onChange: () => store.toggleSelected(row.id),
        }),
        h(
          'div',
          { className: 'dshdel-main' },
          h('div', { className: 'dshdel-title', title: row.title || row.id }, row.title || shortId(row.id)),
          h(
            'div',
            { className: 'dshdel-meta' },
            meta.length > 0 ? meta : h('span', null, shortId(row.id)),
          ),
        ),
      )
    }

    /** 递归渲染一棵子树。 */
    function renderSubtree(tree, store, id, depth, out) {
      const row = tree.byId.get(id)
      if (row === undefined) return
      out.push(h(Row, { key: id, row, depth, tree, store }))
      if (store.state.collapsed.has(id)) return
      for (const kid of tree.childrenOf.get(id) ?? []) renderSubtree(tree, store, kid, depth + 1, out)
    }

    /** 主面板（浮层）。 */
    function Panel(props) {
      const store = getStore()
      useStoreVersion(store)
      ensureStyle()
      // 优先用挂载时注入进来的 owner（更新鲜），退回 apply 登记的全局引用。
      const ctx = props?.owner ?? globalThis.__dshDeleteCtx__
      const snapshot = useSessionSnapshot(ctx)
      const st = store.state

      // 打开时拉一次盘点
      React.useEffect(() => {
        if (!st.open) return
        if (st.inventory !== null || st.loading) return
        void reload()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [st.open])

      // 合并行
      const rows = React.useMemo(
        () => (st.inventory === null ? [] : buildRows(st.inventory, snapshot)),
        [st.inventory, snapshot],
      )
      const tree = React.useMemo(() => buildTree(rows), [rows])

      if (!st.open) return null

      const enabled = st.inventory?.enabled !== false
      const confirmBefore = st.inventory?.confirmBeforeDelete !== false
      const query = st.query.trim().toLowerCase()
      const filteredRoots = tree.roots.filter((id) => {
        if (st.workspace !== '') {
          const row = tree.byId.get(id)
          if ((row?.workspaceSlug ?? row?.cwd ?? '') !== st.workspace) return false
        }
        if (query === '') return true
        return subtreeMatches(tree, id, query)
      })

      const selectedIds = [...st.selected].filter((id) => tree.byId.has(id))
      const selectedBytes = selectedIds.reduce((n, id) => n + (tree.byId.get(id)?.bytes ?? 0), 0)
      const selectedPaths = selectedIds.reduce((n, id) => n + (tree.byId.get(id)?.paths ?? 0), 0)

      const workspaces = [...new Set(rows.map((r) => r.workspaceSlug).filter((s) => s !== ''))].sort()

      const body = []
      for (const rootId of filteredRoots) renderSubtree(tree, store, rootId, 0, body)

      return h(
        'div',
        {
          className: 'dshdel-backdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) store.patch({ open: false, confirm: false, result: null })
          },
        },
        h(
          'div',
          { className: 'dshdel-card', role: 'dialog', 'aria-label': t('title') },
          h(
            'div',
            { className: 'dshdel-head' },
            h(
              'div',
              null,
              h('h3', null, t('title')),
              h('div', { className: 'dshdel-sub' }, t('subtitle')),
            ),
            h('div', { className: 'dshdel-grow' }),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => void reload() }, t('refresh')),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn',
                onClick: () => store.patch({ open: false, confirm: false, result: null }),
              },
              t('close'),
            ),
          ),
          h(
            'div',
            { className: 'dshdel-toolbar' },
            h('input', {
              className: 'dshdel-input',
              placeholder: t('search'),
              value: st.query,
              onChange: (e) => store.patch({ query: e.target.value }),
            }),
            workspaces.length > 1
              ? h(
                  'select',
                  {
                    className: 'dshdel-select',
                    value: st.workspace,
                    onChange: (e) => store.patch({ workspace: e.target.value }),
                  },
                  h('option', { value: '' }, t('allWorkspaces')),
                  workspaces.map((ws) => h('option', { key: ws, value: ws }, ws)),
                )
              : null,
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => store.setSelected(rows.map((r) => r.id)) }, t('selectAll')),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => store.setSelected([]) }, t('clear')),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => batchPick(store, tree, rows, 'subagents') }, t('pickSubagents')),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => batchPick(store, tree, rows, 'siblings') }, t('pickSiblings')),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => batchPick(store, tree, rows, 'family') }, t('pickFamily')),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => store.patch({ collapsed: new Set() }) }, t('expandAll')),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn',
                onClick: () => store.patch({ collapsed: new Set(rows.filter((r) => (tree.childrenOf.get(r.id) ?? []).length > 0).map((r) => r.id)) }),
              },
              t('collapseAll'),
            ),
          ),
          h(
            'div',
            { className: 'dshdel-body' },
            st.loading && rows.length === 0
              ? h('div', { className: 'dshdel-sub', style: { padding: '16px' } }, t('loading'))
              : body.length === 0
                ? h('div', { className: 'dshdel-sub', style: { padding: '16px' } }, t('empty'))
                : body,
            st.inventory !== null && sessionsFaceOf(ctx) === null
              ? h('div', { className: 'dshdel-sub', style: { padding: '10px 8px' } }, t('noSnapshot'))
              : null,
          ),
          st.error !== null ? h('div', { className: 'dshdel-result dshdel-err' }, t('error', { msg: st.error })) : null,
          st.result !== null ? h(ResultBar, { store, result: st.result }) : null,
          st.confirm
            ? h(
                'div',
                { className: 'dshdel-confirm' },
                h('p', null, t('confirmTitle', { n: selectedIds.length })),
                h('p', null, t('confirmBody', { paths: selectedPaths, size: fmtBytes(selectedBytes) })),
                selectedIds.length > 5
                  ? h('p', { className: 'dshdel-sub' }, t('confirmMore', { n: selectedIds.length - 5 }))
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  h('button', { type: 'button', className: 'dshdel-btn', onClick: () => store.patch({ confirm: false }) }, t('cancel')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshdel-btn danger',
                      disabled: st.busy,
                      onClick: () => void doDelete(store, ctx, selectedIds),
                    },
                    st.busy ? t('deleting') : t('confirmYes'),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'dshdel-foot' },
            h('span', null, t('selectedCount', { n: selectedIds.length })),
            h('span', { className: 'dshdel-sub' }, t('totalSize', { size: fmtBytes(selectedBytes) })),
            h('div', { className: 'dshdel-grow' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn danger',
                disabled: selectedIds.length === 0 || st.busy || !enabled,
                onClick: () => {
                  if (confirmBefore) store.patch({ confirm: true, result: null })
                  else void doDelete(store, ctx, selectedIds)
                },
              },
              t('remove'),
            ),
          ),
        ),
      )
    }

    /** 删除结果条。 */
    function ResultBar(props) {
      const { store, result } = props
      const failed = (result.results ?? []).reduce((n, r) => n + (r.failed?.length ?? 0), 0)
      const reloaded = result.reloaded === true
      return h(
        'div',
        { className: 'dshdel-result' },
        h('div', null, t('doneTitle', { n: result.deleted ?? 0 })),
        h('div', { className: 'dshdel-sub' }, t('donePaths', { paths: result.paths ?? 0, size: fmtBytes(result.bytes ?? 0) })),
        failed > 0 ? h('div', { className: 'dshdel-err' }, t('doneFailed', { n: failed })) : null,
        !reloaded
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' } },
              h('span', { className: 'dshdel-sub' }, t('reloadHint')),
              h('button', { type: 'button', className: 'dshdel-btn', onClick: () => location.reload() }, t('reload')),
            )
          : null,
      )
    }

    /** 子树里是否有匹配查询的行（含自身）。 */
    function subtreeMatches(tree, id, query) {
      const row = tree.byId.get(id)
      if (row !== undefined) {
        const hay = `${row.title} ${row.cwd} ${row.id}`.toLowerCase()
        if (hay.includes(query)) return true
      }
      for (const kid of tree.childrenOf.get(id) ?? []) {
        if (subtreeMatches(tree, kid, query)) return true
      }
      return false
    }

    /** 批量选择：基于当前选择展开（子 agent / 团队成员 / 整族）。 */
    function batchPick(store, tree, rows, mode) {
      const base = store.state.selected.size > 0 ? [...store.state.selected] : rows.map((r) => r.id)
      const add = new Set(base)
      for (const id of base) {
        if (mode === 'subagents') {
          for (const d of descendantsOf(tree, id)) add.add(d)
        } else if (mode === 'siblings') {
          for (const s of siblingsOf(tree, id)) add.add(s)
        } else {
          const root = rootOf(tree, id)
          add.add(root)
          for (const d of descendantsOf(tree, root)) add.add(d)
        }
      }
      store.setSelected([...add].filter((id) => tree.byId.has(id)))
    }

    /** 重新拉盘点。 */
    async function reload() {
      const store = getStore()
      store.patch({ loading: true, error: null })
      try {
        const json = await fetchInventory()
        store.patch({ inventory: json, loading: false, error: null })
        // 丢掉已经不存在的选择
        const alive = new Set((json.items ?? []).map((i) => i.id))
        store.setSelected([...store.state.selected].filter((id) => alive.has(id)))
      } catch (error) {
        store.patch({ loading: false, error: String(error?.message ?? error) })
      }
    }

    /** 真正执行删除：宿主落盘 + 可行的原生同步 + 重新盘点。 */
    async function doDelete(store, ctx, ids) {
      if (ids.length === 0) return
      store.patch({ busy: true, confirm: false, error: null })
      try {
        const before = store.state.inventory
        const bytesOf = (id) => {
          const item = (before?.items ?? []).find((i) => i.id === id)
          return Number(item?.bytes) || 0
        }
        const expectedBytes = ids.reduce((n, id) => n + bytesOf(id), 0)

        const json = await requestDelete(ids, false)
        if (json?.ok !== true) throw new Error(json?.error ?? 'DELETE_FAILED')

        // 原生同步（如果宿主提供了方法）；宿主落盘已经完成，这一步只是让内存列表跟上。
        for (const id of ids) nativeDelete(ctx, id)
        const reloaded = refreshSessionList(ctx)

        const paths = (json.results ?? []).reduce((n, r) => n + (r.removed?.length ?? 0), 0)
        const deleted = (json.results ?? []).filter((r) => r.ok === true).length
        store.patch({
          busy: false,
          result: { deleted, paths, bytes: expectedBytes, results: json.results ?? [], reloaded },
        })
        store.setSelected([])
        await reload()
      } catch (error) {
        store.patch({ busy: false, error: String(error?.message ?? error) })
      }
    }

    // ---------------------------------------------------------------- apply

    function apply(ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return

      // 面板需要 ctx 去读会话列表服务；组件是闭包，取这里登记的引用。
      globalThis.__dshDeleteCtx__ = ctx
      // 先把共享 store 落到 globalThis 上，组件首次渲染时就能取到同一份。
      getStore()

      // 关键：**不能**写 `ctx.slots.inject(...)`。
      // 在 DSH 0.2.0-rc.x 里插槽是 `slots` 服务，必须通过 `ctx.inject(['slots'], cb)`
      // 拿到注入上下文后再读；直接访问 `ctx.slots` 会抛错，于是**一个入口都注册不上**
      // （宿主路由照常工作，界面上却什么都没有）。
      ctx.inject(['slots'], (owner) => {
        const slots = serviceAt(owner, 'slots')
        if (slots === undefined || typeof slots.inject !== 'function') {
          console.warn('dsh-delete: 宿主未提供 slots 服务，入口与面板都无法注册')
          return
        }

        /** 一次挂载两个条目，返回一个合并的注销函数（交给 owner.effect 持有）。 */
        const mount = () => {
          const disposers = []
          const register = (slot, id, order, render) => {
            disposers.push(slots.inject(slot, () => slots.register({ name: slot, id, order }, render)))
          }
          register(ENTRY_SLOT, ENTRY_ID, 900, () => h(EntryButton, null))
          register(OVERLAY_SLOT, OVERLAY_ID, 900, () => h(Panel, { owner }))
          return () => {
            for (const dispose of disposers) {
              try {
                if (typeof dispose === 'function') dispose()
              } catch {
                /* 注销失败不该影响其它条目 */
              }
            }
          }
        }

        try {
          if (typeof owner.effect === 'function') owner.effect(mount, 'dsh-delete: slots')
          else mount()
        } catch (error) {
          console.warn('dsh-delete: 插槽登记失败', error)
        }
      })

      // 提前预热一次盘点：用户点开入口时面板已经有内容。
      void reload()
    }

    return {
      // 声明为空：本插件在客户端不依赖任何必选服务，都是运行时探测；声明成必选
      // 会在缺服务的宿主上把整条 fiber 停住，连入口都不显示。
      inject: [],
      apply,
      /** 供离线测试使用；不属于插件契约。 */
      _internals: { buildRows, buildTree, descendantsOf, siblingsOf, rootOf, fmtBytes, t },
    }
  },
})
