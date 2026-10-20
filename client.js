/**
 * dsh-delete 浏览器半 —— 会话删除面板。
 *
 * 贡献两个条目：
 *
 * 1. **入口**（sidebar.footer.action）：侧边栏底部一行，点开/收起管理面板。
 * 2. **面板**（shell.overlay）：帧级浮层，位于所有面板的滚动容器之外，
 *    所以切会话、开设置都不会把它挤掉；关闭时**完全不渲染**，不挡任何操作。
 *
 * 数据来源有两条，各司其职：
 *   - **会话列表快照**（ctx.get('sessions').list）—— 官方口径，提供 parentId
 *     （父子关系）、origin（是不是子 agent）、running、cwd、标题、更新时间。
 *     这是「左侧栏里看得见的会话」的权威来源。
 *   - **宿主盘点路由**（/plugins/dsh-delete/inventory）—— 磁盘口径，提供每个会话
 *     占用的真实路径与字节数、header 里的权威元数据，以及「列表里已消失但文件
 *     还在」的残留会话。
 *
 * ## 合并两个世界时必须按 id 别名对齐（历史 bug 的根源）
 *
 * DSH 同一个会话有两种 id 写法：根会话是 session-<uuid>，**子 agent 是裸 <uuid>**；
 * 而磁盘目录名就是这两种写法本身。上一版把磁盘名强行剥成裸 uuid 再跟快照比，
 * 于是根会话在面板里出现**两行**（一行来自磁盘、一行来自快照，各自少了对方的
 * 信息），子 agent 会话则整类扫不到。现在两边都用 identityKey() 归一，
 * 且删除/归档一律用宿主认识的那个 id（快照里的 id 优先）。
 *
 * 删除永远走宿主路由：宿主会**先让 DSH 归档该会话、再删磁盘文件**。顺序不能反 ——
 * 文件删掉之后官方归档就会以「找不到该会话」失败，于是宿主内存里那条会话会永远
 * 挂在左侧栏（这就是用户报的「删不掉、删不干净」）。
 *
 * 加载方式：window.__ModuleLoader__.load({ id, factory })，
 * 其中 require 只解析平台自带的外部模块（react），不是文件系统路径。
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
    const IMAGES_URL = '/plugins/dsh-delete/images'
    const OFFLOAD_URL = '/plugins/dsh-delete/images/offload'
    const THUMB_URL = '/plugins/dsh-delete/thumb'

    /** 右侧栏页签的类型标识：定义、正文、标题三处共用同一个 id。 */
    const IMAGE_TAB_ID = 'dsh-delete/images'
    /** 右侧栏页签的 kind。 */
    const IMAGE_TAB_KIND = 'dsh-delete-images'

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
      pickSubagents: '含子 agent',
      pickSiblings: '含团队成员',
      pickFamily: '含整族',
      selectAllSubagents: '全选子 agent',
      pickHint: '先勾选至少一个会话',
      selectAllSubagentsHint: '把所有标记为「子agent」的行一次选上',
      pickSubagentsHint: '把已勾选会话的全部后代一并选上',
      pickSiblingsHint: '把已勾选会话的同父兄弟（团队成员）一并选上',
      pickFamilyHint: '上溯到家族根，把它整棵子树一并选上',
      loading: '正在读取会话…',
      empty: '没有匹配的会话',
      selectedCount: '已选 {n} 个会话',
      totalSize: '合计 {size}',
      diskOnly: '仅磁盘',
      noSnapshot: '（读不到会话列表服务，仅显示磁盘盘点结果）',
      remove: '删除选中',
      confirmTitle: '确认删除 {n} 个会话？',
      confirmBody: '将从磁盘移除 {paths} 条路径（{size}），并让 DSH 归档这些会话。此操作不可撤销。',
      confirmMore: '……以及另外 {n} 个',
      cancel: '取消',
      confirmYes: '确认删除',
      deleting: '正在删除…',
      doneTitle: '已删除 {n} 个会话',
      donePaths: '移除 {paths} 条路径，释放 {size}',
      doneFailed: '{n} 条路径删除失败',
      doneArchived: '已在 DSH 里归档 {n} 个（左侧栏立即不再显示）',
      doneArchiveFailed: '{n} 个会话归档失败（磁盘文件已删除）',
      doneEmptyDisk: '其中 {n} 个磁盘上早已没有文件，只清理了宿主列表里的条目',
      archiveUnavailable: '宿主未提供工作区注册表，无法归档：仍活在宿主内存里的会话可能继续挂在左侧栏，重启 DSH 后才会消失。',
      reloadHint: '列表可能仍显示已删除的会话，刷新页面即可。',
      reload: '刷新页面',
      error: '出错了：{msg}',
      badgeRunning: '运行中',
      badgeSubagent: '子 agent',
      badgeDiskOnly: '仅磁盘',
      badgeArchived: '已归档',
      badgeRemoved: '已删除',
      pathsLabel: '{n} 条路径',
      sizeLabel: '{size}',
      openHint: '展开/折叠子会话',

      // ---- 图片管理 ----
      imgTab: '图片管理',
      imgSubtitle: '列出这个会话在当前上下文里的图片，多选摘除；可另行勾选删除磁盘上的原文件。',
      imgTotal: '共 {n} 张图 · 仍在上下文 {k} 张 · {size}',
      imgOffloadedCount: '已摘除 {n} 张',
      imgSearch: '搜索文件名…',
      imgOriginAll: '全部来源',
      imgOriginUser: '你上传的',
      imgOriginTool: '工具截图',
      imgTimeAll: '全部时间',
      imgTimeDay: '最近 24 小时',
      imgTimeWeek: '最近 7 天',
      imgTimeMonth: '最近 30 天',
      imgPickOldestLabel: '最早 N 张',
      imgPickKeepLabel: '除最近 N 张外全部',
      imgPickApply: '选',
      imgSelectAll: '全选',
      imgClear: '清空',
      imgOffloaded: '已摘除',
      imgNoSource: '无源文件',
      imgSourceMissing: '源文件已不在',
      imgShared: '被 {n} 个会话引用',
      imgInWorkspace: '工作区内',
      imgOutsideWorkspace: '工作区外',
      imgInProfile: '用户目录',
      imgProgramData: '程序数据',
      imgSelected: '已选 {n} 张',
      imgReclaim: '移除后请求体积约减 {size}',
      imgNone: '这个会话当前上下文里没有图片',
      imgNotLive: '该会话当前不在内存中，只能查看：请先在界面上打开它，再摘除图片。',
      imgRunning: '该会话正在跑一轮工作，等结束后再摘除（避免与自动摘除抢写同一份记录）。',
      imgRefresh: '刷新',
      imgDeleteDisk: '同时删除磁盘上的原文件（源文件 + 附件对象），不可恢复',
      imgDiskSummary: '可删：源文件 {s} 个 · 附件对象 {a} 个 → 约 {size}',
      imgDiskSkipped: '将跳过 {n} 项（被别的会话引用或已不存在）',
      imgOffloadOnly: '摘除选中',
      imgOffloadAndDelete: '摘除并删除原文件',
      imgConfirmTitle: '确认摘除 {n} 张图？',
      imgConfirmBody: '这些图片将从**后续所有请求**里移除（模型只看到带只读路径的占位文本）；会话日志与附件文件保留。',
      imgConfirmDisk: '并且删除磁盘上的 {s} 个源文件与 {a} 个附件对象 —— 不进回收站、不可恢复。',
      imgConfirmForce: '其中 {n} 项被其它会话引用；删除后那些会话的历史将出现缺失附件。',
      imgConfirmMore: '……以及另外 {n} 个',
      imgConfirmYes: '确认摘除',
      imgConfirmYesDisk: '确认摘除并删除',
      imgBusy: '正在处理…',
      imgDoneOffload: '已摘除 {n} 张',
      imgDoneDisk: '并删除 {n} 个文件，释放 {size}',
      imgDoneSkipped: '跳过 {n} 项',
      imgDoneFailed: '{n} 项删除失败',
      imgDoneReadonly: '（附件库未被卸载：已摘除的图片仍可按占位文本里的路径回读）',
      imgError: '出错了：{msg}',
      imgErrorDetail: '出错了：{msg} —— {detail}',
      imgNothing: '没有可摘除的项：{why}',
      imgWhyOffloaded: '选中的图片已经被摘除过了',
      imgWhyOffscreen: '选中的图片已不在当前上下文里（可能被压缩替换掉了）',
      imgWhyMissing: '选中的位置在当前请求里找不到',
      imgWhyBad: '选中的位置信息不完整',
      imgWhyUnknown: '请刷新后重试',
      imgSkippedItems: '其中 {n} 项被跳过',
      imgCostLabel: '缓存代价预估：',
      imgCostLine: '这一轮需重算 ≈ {re} token（仍命中 ≈ {cached} · 命中率 {rate}%，平时 {base}%）· 一次性，之后恢复',
      imgCostTiny: '断点靠后，几乎不影响缓存：需重算 ≈ {re} token',
      imgCostNoCache: '这个会话平时就没有缓存命中（≈{base}%），摘除不会额外损失缓存；只是把图片换成占位文本（这一轮仍需处理 ≈{total} token）',
      imgCostUnknown: '无法估算缓存代价（这个会话还没有用量记录）',
      imgCostWhy: '断点 = 最早被摘除的那张图所在的消息（{seq}）；其后内容要重算一次',
      imgCostImages: '图片换成占位文本后实际请求会略小',
      imgLoadFailed: '读取失败：{msg}',
      imgThumbFail: '缩略图加载失败',
      imgTabHint: '图片管理 —— 统计张数、多选摘除、按需删除原文件',
      imgVariantKept: '另有 {n} 个派生缓存文件被保留（无害，读取时会自动重建）',
      imgAnomalies: '日志里有 {header} 行 header、{dup} 个重复序号（已按真实 seq 处理）',
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
      pickSubagents: 'Include subagents',
      pickSiblings: 'Include teammates',
      pickFamily: 'Include whole family',
      selectAllSubagents: 'All subagents',
      pickHint: 'Tick at least one session first',
      selectAllSubagentsHint: 'Select every row marked as a subagent, in one click',
      pickSubagentsHint: 'Also select every descendant of the ticked sessions',
      pickSiblingsHint: 'Also select the siblings (teammates) of the ticked sessions',
      pickFamilyHint: 'Walk up to the family root and select its whole subtree',
      loading: 'Reading sessions…',
      empty: 'No matching session',
      selectedCount: '{n} selected',
      totalSize: '{size} total',
      diskOnly: 'disk only',
      noSnapshot: '(session-list service unavailable — showing the disk inventory only)',
      remove: 'Delete selected',
      confirmTitle: 'Delete {n} session(s)?',
      confirmBody: 'This removes {paths} path(s) from disk ({size}) and archives them in DSH. It cannot be undone.',
      confirmMore: '…and {n} more',
      cancel: 'Cancel',
      confirmYes: 'Delete',
      deleting: 'Deleting…',
      doneTitle: 'Deleted {n} session(s)',
      donePaths: 'Removed {paths} path(s), freed {size}',
      doneFailed: '{n} path(s) failed to delete',
      doneArchived: 'Archived {n} in DSH (gone from the sidebar immediately)',
      doneArchiveFailed: '{n} session(s) could not be archived (disk files were removed)',
      doneEmptyDisk: '{n} of them already had no files on disk — only the host list entry was cleaned',
      archiveUnavailable: 'The host exposes no workspace registry, so archiving is unavailable: sessions still alive inside the host may linger in the sidebar until DSH restarts.',
      reloadHint: 'The list may still show deleted sessions; reload the page.',
      reload: 'Reload page',
      error: 'Error: {msg}',
      badgeRunning: 'running',
      badgeSubagent: 'subagent',
      badgeDiskOnly: 'disk only',
      badgeArchived: 'archived',
      badgeRemoved: 'deleted',
      pathsLabel: '{n} path(s)',
      sizeLabel: '{size}',
      openHint: 'Expand/collapse sub-sessions',

      // ---- image manager ----
      imgTab: 'Images',
      imgSubtitle: 'Every image in this session’s current context. Tick any to offload; optionally delete the originals on disk.',
      imgTotal: '{n} images · {k} still in context · {size}',
      imgOffloadedCount: '{n} offloaded',
      imgSearch: 'Search file name…',
      imgOriginAll: 'All sources',
      imgOriginUser: 'Attached by you',
      imgOriginTool: 'Tool screenshots',
      imgTimeAll: 'Any time',
      imgTimeDay: 'Last 24 hours',
      imgTimeWeek: 'Last 7 days',
      imgTimeMonth: 'Last 30 days',
      imgPickOldestLabel: 'oldest N',
      imgPickKeepLabel: 'all but newest N',
      imgPickApply: 'Pick',
      imgSelectAll: 'Select all',
      imgClear: 'Clear',
      imgOffloaded: 'offloaded',
      imgNoSource: 'no source file',
      imgSourceMissing: 'source file is gone',
      imgShared: 'used by {n} sessions',
      imgInWorkspace: 'in workspace',
      imgOutsideWorkspace: 'outside workspace',
      imgInProfile: 'user folder',
      imgProgramData: 'program data',
      imgSelected: '{n} selected',
      imgReclaim: 'request shrinks by about {size}',
      imgNone: 'No images in this session’s current context',
      imgNotLive: 'This session is not in memory right now — read-only. Open it in the UI first, then offload.',
      imgRunning: 'This session is running a turn. Offloading is blocked until it ends (avoids racing the automatic offload).',
      imgRefresh: 'Refresh',
      imgDeleteDisk: 'Also delete the originals on disk (source files + attachment objects) — irreversible',
      imgDiskSummary: 'Deletable: {s} source file(s) · {a} attachment object(s) → about {size}',
      imgDiskSkipped: '{n} item(s) will be skipped (shared with another session, or already gone)',
      imgOffloadOnly: 'Offload selected',
      imgOffloadAndDelete: 'Offload and delete originals',
      imgConfirmTitle: 'Offload {n} image(s)?',
      imgConfirmBody: 'They are removed from **every later request** (the model sees placeholder text with a read-only path); the session log and the attachment files stay.',
      imgConfirmDisk: 'And delete {s} source file(s) and {a} attachment object(s) on disk — no recycle bin, irreversible.',
      imgConfirmForce: '{n} item(s) are referenced by other sessions; their history will show missing attachments afterwards.',
      imgConfirmMore: '…and {n} more',
      imgConfirmYes: 'Offload',
      imgConfirmYesDisk: 'Offload and delete',
      imgBusy: 'Working…',
      imgDoneOffload: 'Offloaded {n} image(s)',
      imgDoneDisk: 'and deleted {n} file(s), reclaimed {size}',
      imgDoneSkipped: '{n} item(s) skipped',
      imgDoneFailed: '{n} deletion(s) failed',
      imgDoneReadonly: '(Attachment store untouched: offloaded images stay readable via the path in the placeholder text.)',
      imgError: 'Failed: {msg}',
      imgErrorDetail: 'Failed: {msg} — {detail}',
      imgNothing: 'Nothing to offload: {why}',
      imgWhyOffloaded: 'the selected images were already offloaded',
      imgWhyOffscreen: 'the selected images are no longer in the current context (compaction may have replaced them)',
      imgWhyMissing: 'the selected positions are not in the current request',
      imgWhyBad: 'the selected positions are incomplete',
      imgWhyUnknown: 'refresh and try again',
      imgSkippedItems: '{n} item(s) skipped',
      imgCostLabel: 'Cache cost estimate: ',
      imgCostLine: 'this turn re-processes ≈ {re} tokens (still cached ≈ {cached} · hit {rate}%, normally {base}%) — one-off, recovers afterwards',
      imgCostTiny: 'break point is late, so cache is barely affected: ≈ {re} tokens re-processed',
      imgCostNoCache: 'this session is not getting cache hits (≈{base}%), so offloading costs no extra cache; it only turns images into placeholder text (this turn still handles ≈{total} tokens)',
      imgCostUnknown: 'cannot estimate the cache cost (this session has no usage records yet)',
      imgCostWhy: 'break point = the message holding the earliest offloaded image ({seq}); everything after it is re-processed once',
      imgCostImages: 'the real request is slightly smaller once images become placeholder text',
      imgLoadFailed: 'Load failed: {msg}',
      imgThumbFail: 'thumbnail failed',
      imgTabHint: 'Image manager — count, multi-select offload, optional disk deletion',
      imgVariantKept: '{n} derived cache file(s) kept (harmless; rebuilt on read)',
      imgAnomalies: 'log has {header} header row(s) and {dup} duplicate seq(s) (handled by real seq)',
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

    /** 取词 + {name} 占位替换；缺词回退到中文再回退到 key 本身。 */
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
      return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i]
    }

    /** 相对时间（够用即可，不做 i18n 复数）。 */
    function fmtTime(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return ''
      const diff = Date.now() - n
      if (diff < 60_000) return '刚刚'
      const min = Math.floor(diff / 60_000)
      if (min < 60) return min + ' 分钟前'
      const hour = Math.floor(min / 60)
      if (hour < 24) return hour + ' 小时前'
      const day = Math.floor(hour / 24)
      if (day < 30) return day + ' 天前'
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
     * 会话 id 的归一化键：session-<uuid> 与 <uuid> 必须落到同一个键上。
     *
     * 这是「一行一个会话」的地基：磁盘口径与快照口径都对它做键，两个世界才能合并；
     * 同时它也用来匹配 DSH 的已归档集合。非 UUID 形状的 id 原样（小写）作键。
     */
    function identityKey(id) {
      const s = String(id ?? '').trim().toLowerCase()
      const bare = s.startsWith('session-') ? s.slice('session-'.length) : s
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bare)) return bare
      return 'raw:' + s
    }

    /** 目录路径 → 末段名字（DSH displayTitleOf 的 cwd 回退用的就是这个）。 */
    function baseName(path) {
      const s = String(path ?? '')
      if (s === '') return ''
      const parts = s.replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts.length === 0 ? '' : parts[parts.length - 1]
    }

    /**
     * 从注入上下文里读一个服务。
     *
     * 与服务声明（inject: [...]）的区别是刻意的：声明了但缺失的服务会把整条
     * fiber 停住 —— 于是「某个服务稍后才激活」的部署会**彻底丢掉**本插件；动态
     * 读取则允许它在服务到位后自然接上。dsh-bgm 用的是同一套判断。
     */
    function serviceAt(owner, name) {
      if (owner === undefined || owner === null || typeof owner.get !== 'function') return undefined
      const value = owner.get(name)
      return value === null || value === undefined ? undefined : value
    }

    // ------------------------------------------------------ 图片管理：纯选择逻辑
    //
    // 这一小段刻意做成**纯函数**（只吃 items 与筛选条件，不碰 DOM、不发请求），
    // 于是它能被离线套件直接断言 —— 界面里最容易出错的就是「快捷多选选错了哪几张」。

    /** 可操作的项：没被摘除、且带附件 id（没有 id 的没法缩略图/删盘）。 */
    function selectable(items) {
      return (Array.isArray(items) ? items : []).filter((item) => item != null && item.offloaded !== true)
    }

    /** 全部是「你上传的」（user/message）还是工具产出（tool/result）。 */
    function originOf(item) {
      return item?.origin === 'user/message' ? 'user' : 'tool'
    }

    /** 按来源 / 时间 / 关键词过滤（全部条件为 AND）。 */
    function applyFilters(items, filters) {
      const f = filters ?? {}
      const query = String(f.query ?? '').trim().toLowerCase()
      const now = Number.isFinite(f.now) ? f.now : Date.now()
      const span = f.time === 'day' ? 86400e3 : f.time === 'week' ? 7 * 86400e3 : f.time === 'month' ? 30 * 86400e3 : 0
      return (Array.isArray(items) ? items : []).filter((item) => {
        if (item == null) return false
        if (f.origin !== undefined && f.origin !== '' && f.origin !== 'all' && originOf(item) !== f.origin) return false
        if (f.onlyOffloaded === true && item.offloaded !== true) return false
        if (f.onlyOffloaded !== true && f.includeOffloaded !== true && item.offloaded === true) return false
        if (span > 0) {
          const at = Number(item.time) || 0
          if (at <= 0 || now - at > span) return false
        }
        if (query !== '') {
          const hay = String(item.name ?? '').toLowerCase() + ' ' + String(item.heldPath ?? '').toLowerCase()
          if (!hay.includes(query)) return false
        }
        return true
      })
    }

    /** 当前选中集合里仍然可操作的那些 key（同一条命令里选中项过期时自动收缩）。 */
    function liveSelection(items, selected) {
      const alive = new Set(selectable(items).map((item) => keyOfItem(item)))
      const picked = []
      for (const key of selected ?? []) {
        if (alive.has(key)) picked.push(key)
      }
      return new Set(picked)
    }

    /** 出现位置的稳定键（seq + 深度优先索引）。 */
    function keyOfItem(item) {
      return String(item?.seq) + ':' + String(item?.imageIndex)
    }

    /** 点一下复选框。 */
    function toggleSelection(selected, item) {
      const next = new Set(selected ?? [])
      const key = keyOfItem(item)
      if (next.has(key)) next.delete(key)
      else if (item?.offloaded !== true) next.add(key)
      return next
    }

    /** 「最早 N 张」：按（时间, seq）升序取前 N，**追加**进当前选择。 */
    function pickOldest(items, selected, count) {
      const next = new Set(selected ?? [])
      const n = Math.max(0, Number(count) || 0)
      const list = [...selectable(items)].sort(byTimeThenSeq)
      for (let i = 0; i < Math.min(n, list.length); i += 1) next.add(keyOfItem(list[i]))
      return next
    }

    /** 「除最近 N 张外全部」：保留最新的 N 张，其余追加进选择。 */
    function pickAllButNewest(items, selected, count) {
      const next = new Set(selected ?? [])
      const n = Math.max(0, Number(count) || 0)
      const list = [...selectable(items)].sort(byTimeThenSeq)
      const keep = new Set(list.slice(Math.max(0, list.length - n)).map((item) => keyOfItem(item)))
      for (const item of list) {
        const key = keyOfItem(item)
        if (!keep.has(key)) next.add(key)
      }
      return next
    }

    /** 时间升序（时间相同按 seq / 索引）。 */
    function byTimeThenSeq(a, b) {
      return (Number(a?.time) || 0) - (Number(b?.time) || 0) || (Number(a?.seq) || 0) - (Number(b?.seq) || 0) || (Number(a?.imageIndex) || 0) - (Number(b?.imageIndex) || 0)
    }

    /** 选中集合的合计（张数 / 字节 / 涉及的附件 id）。 */
    function selectionSummary(items, selected) {
      const picked = []
      for (const item of selectable(items)) {
        if ((selected ?? new Set()).has(keyOfItem(item))) picked.push(item)
      }
      return {
        count: picked.length,
        bytes: picked.reduce((total, item) => total + (Number(item.bytes) || 0), 0),
        attachmentIds: [...new Set(picked.map((item) => String(item.attachmentId ?? '')).filter((id) => id !== ''))],
        items: picked,
      }
    }

    /** token 数的紧凑显示（12.3k / 1.2M）。 */
    function fmtTokens(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) return '0'
      if (n < 1000) return String(Math.round(n))
      // 万级保留一位（74.9k 有信息量），十万级以上取整（452k）
      if (n < 1e5) return (n / 1000).toFixed(1) + 'k'
      if (n < 1e6) return (n / 1000).toFixed(0) + 'k'
      return (n / 1e6).toFixed(1) + 'M'
    }

    /**
     * 从宿主的 `cost.bySeq` 里取出「当前选择会造成多大缓存代价」（纯函数）。
     *
     * 规则：断点 = **被选中的最早那条消息**（其后内容都要重算），所以取选中项里
     * 最小的 seq 对应的那条预估。选得越老，代价越大——这正是要提前告诉用户的。
     *
     * @param cost     宿主 /images 返回的 `cost`（`{bySeq:[{seq,ok,reprocess,...}]}`）
     * @param selected 选中项的 key 集合（形如 "818:0"）
     * @returns 命中的那条预估，或 null（没选 / 没有用量数据）
     */
    function costForSelection(cost, selected) {
      if (cost === null || cost === undefined) return null
      const bySeq = Array.isArray(cost.bySeq) ? cost.bySeq : []
      if (bySeq.length === 0) return null
      let minSeq = null
      for (const key of selected ?? []) {
        const seq = Number(String(key).split(':')[0])
        if (!Number.isFinite(seq)) continue
        if (minSeq === null || seq < minSeq) minSeq = seq
      }
      if (minSeq === null) return null
      return bySeq.find((entry) => entry?.seq === minSeq) ?? null
    }

    /** 把代价预估翻成一句话（纯函数）。 */
    function costTextOf(estimate) {
      if (estimate === null || estimate === undefined) return ''
      if (estimate.ok !== true) return t('imgCostUnknown')
      const re = fmtTokens(estimate.reprocess)
      const base =
        estimate.baselineHitRatePct === null || estimate.baselineHitRatePct === undefined
          ? null
          : Number(estimate.baselineHitRatePct)
      // 这个会话平时就没有缓存命中 → 摘除不会「额外」损失缓存，别用命中率误导人
      if (base !== null && base < 5) {
        return t('imgCostNoCache', { base: base.toFixed(1), total: fmtTokens(estimate.total) })
      }
      if (Number(estimate.reprocess) <= 2000) return t('imgCostTiny', { re })
      const rate =
        estimate.hitRatePct === null || estimate.hitRatePct === undefined ? '-' : Number(estimate.hitRatePct).toFixed(1)
      return t('imgCostLine', { re, cached: fmtTokens(estimate.cached), rate, base: base === null ? '-' : base.toFixed(1) })
    }

    /** 把宿主报告里的「跳过原因」翻成一句话。 */
    function whyOf(reason) {      if (reason === 'ALREADY_OFFLOADED') return t('imgWhyOffloaded')
      if (reason === 'NOT_ON_SURFACE') return t('imgWhyOffscreen')
      if (reason === 'SEQ_GONE') return t('imgWhyOffscreen')
      if (reason === 'IMAGE_INDEX_MISSING') return t('imgWhyMissing')
      if (reason === 'BAD_ITEM') return t('imgWhyBad')
      return t('imgWhyUnknown')
    }

    /**
     * 把摘除报告翻成一行可读文本（纯函数，离线可断言）。
     *
     * 三种结局要分清，因为这正是用户会看到的差别：
     *   - `ok`           ：写进去了（可能还删了盘、可能有被跳过的项）
     *   - `NOTHING_TO_OFFLOAD`：一个都没写（先摘除过的、或已不在当前上下文里的），
     *                       要说明「为什么」，而不是只说一句「失败」
     *   - 其它错误码      ：真的失败了，**必须带出宿主的原始文本**（`detail`），
     *                       否则只剩一个错误码，排查无从下手
     */
    function offloadOutcome(result) {
      if (result === null || result === undefined) return ''
      if (result.ok === true) {
        const parts = [t('imgDoneOffload', { n: result.offload?.count ?? 0 })]
        const skipped = result.offload?.skipped?.length ?? 0
        if (skipped > 0) parts.push(t('imgSkippedItems', { n: skipped }))
        if (result.disk) {
          parts.push(t('imgDoneDisk', { n: result.disk.deleted?.length ?? 0, size: fmtBytes(result.disk.reclaimedBytes ?? 0) }))
          const diskSkipped = result.disk.skipped?.length ?? 0
          if (diskSkipped > 0) parts.push(t('imgDoneSkipped', { n: diskSkipped }))
          const failed = result.disk.failed?.length ?? 0
          if (failed > 0) parts.push(t('imgDoneFailed', { n: failed }))
        }
        parts.push(t('imgDoneReadonly'))
        return parts.join(' · ')
      }
      if (result.error === 'NOTHING_TO_OFFLOAD') {
        const reasons = (result.skippedItems ?? []).map((entry) => entry?.reason)
        const first = reasons.length > 0 ? whyOf(reasons[0]) : ''
        return t('imgNothing', { why: first })
      }
      const detail = typeof result.detail === 'string' && result.detail !== '' ? result.detail : ''
      return detail === ''
        ? t('imgError', { msg: String(result.error ?? 'FAILED') })
        : t('imgErrorDetail', { msg: String(result.error ?? 'FAILED'), detail })
    }

    // -------------------------------------------------------------- store

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
        /** 本次会话里刚删掉的 id：宿主内存里可能还活着，界面里标成「已删除」。 */
        removed: new Set(),
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
     * 收窄 ctx.get('sessions')：只有真正具备 list.getSnapshot + list.subscribe
     * 的宿主才认（老版本没有 outward sessions 服务）。
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
            key: identityKey(id),
            // title 是持久标题，displayTitle 是 DSH 算出来的展示名（可能是
            // cwd 目录名或裸 id）—— 两个都要留着，取词时按优先级用。
            title: typeof rec.title === 'string' ? rec.title : '',
            displayTitle: typeof rec.displayTitle === 'string' ? rec.displayTitle : '',
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

    /**
     * 读 DSH 的「已归档会话」集合（ctx.get('workspaces').list）。
     *
     * 归档是本插件删除流程的一部分（见文件头），所以面板必须能看见它：否则
     * 一个已经被归档、但宿主内存里还活着的会话看起来就像「没删掉」。
     * 读不到就返回空集 —— 绝不让面板打不开。
     */
    function archivedIdsOf(ctx) {
      try {
        const workspaces = ctx?.get?.('workspaces')
        const list = workspaces?.list
        if (list === null || typeof list !== 'object' || typeof list.getSnapshot !== 'function') return new Set()
        const ids = list.getSnapshot()?.archivedSessionIds
        return Array.isArray(ids) ? new Set(ids.map((value) => String(value))) : new Set()
      } catch {
        return new Set()
      }
    }

    /** 把已归档集合折算成 identityKey 集合（两种 id 写法都认）。 */
    function toKeySet(ids) {
      const out = new Set()
      for (const value of ids ?? []) out.add(identityKey(value))
      return out
    }

    // ------------------------------------------------------------ 数据装配

    /**
     * 把「磁盘盘点」和「会话列表快照」合并成行。
     *
     * 规则：
     *   - 以两者 id 别名的并集为准（磁盘上有的即使列表不显示也要能删）。
     *   - 行的 id 优先用**快照里的那个**：归档与删除都要求宿主认识这个字符串
     *     （workspaceRegistry.sessionKnown() 是精确匹配）。
     *   - 血缘以快照的 parentId / origin 为准，缺失时退回磁盘 header。
     *   - 标题回退链：持久标题 → 磁盘标题 → DSH 的 displayTitle → cwd 目录名，
     *     绝不把裸 id 当名字（除非连 cwd 都没有）。
     *   - blank 的占位行不显示（与官方列表一致），但**磁盘上仍有文件的行保留**，
     *     否则用户永远清不掉它。
     */
    function buildRows(inventory, snapshot, options) {
      const opts = options ?? {}
      const archivedKeys = toKeySet(opts.archived)
      const removedKeys = toKeySet(opts.removed)
      const byKey = new Map()
      const ensure = (id) => {
        const key = identityKey(id)
        let row = byKey.get(key)
        if (row === undefined) {
          row = {
            id,
            key,
            title: '',
            displayTitle: '',
            cwd: '',
            parentId: '',
            workspaceSlug: '',
            running: false,
            completed: false,
            blank: false,
            updatedAt: 0,
            bytes: 0,
            paths: 0,
            inSnapshot: false,
            isSubagent: false,
            subagentLabel: '',
            diskOnly: false,
            archived: archivedKeys.has(key),
            removed: removedKeys.has(key),
          }
          byKey.set(key, row)
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
        if (row.workspaceSlug === '' && typeof item.workspaceSlug === 'string') row.workspaceSlug = item.workspaceSlug
        if (row.title === '' && typeof meta.title === 'string') row.title = meta.title
        if (row.cwd === '' && typeof meta.cwd === 'string') row.cwd = meta.cwd
        if (row.parentId === '' && typeof meta.parentId === 'string' && meta.parentId !== '') row.parentId = meta.parentId
        if (row.updatedAt === 0) {
          row.updatedAt = Number(meta.lastPromptAt) || Number(meta.createdAt) || 0
        }
        row.blank = row.blank || meta.blank === true
        if (meta.isSubagent === true) row.isSubagent = true
        if (row.subagentLabel === '' && typeof meta.subagentLabel === 'string') row.subagentLabel = meta.subagentLabel
      }

      for (const id of Object.keys(snapshot ?? {})) {
        const rec = snapshot[id]
        const row = ensure(id)
        row.inSnapshot = true
        // 快照里的 id 是宿主真正认识的那一个（归档 / 删除都用它）
        row.id = id
        if (typeof rec.title === 'string' && rec.title !== '') row.title = rec.title
        if (typeof rec.displayTitle === 'string' && rec.displayTitle !== '') row.displayTitle = rec.displayTitle
        if (typeof rec.cwd === 'string' && rec.cwd !== '') row.cwd = rec.cwd
        if (typeof rec.parentId === 'string' && rec.parentId !== '') row.parentId = rec.parentId
        row.running = rec.running === true
        row.completed = rec.completed === true
        row.blank = rec.blank === true
        if (rec.origin === 'subagent') row.isSubagent = true
        if (rec.updatedAt > 0) row.updatedAt = Math.max(row.updatedAt, rec.updatedAt)
      }

      const rows = [...byKey.values()].filter((row) => !row.blank || row.bytes > 0)
      for (const row of rows) {
        row.diskOnly = !row.inSnapshot && row.bytes > 0
        if (row.title === '') {
          const display = row.displayTitle
          if (display !== '' && display !== row.id) row.title = display
          else if (row.cwd !== '') row.title = baseName(row.cwd)
        }
      }
      return rows
    }

    /** 由行集合构造父子索引与根集合。 */
    function buildTree(rows) {
      const byId = new Map(rows.map((r) => [r.id, r]))
      const byKey = new Map(rows.map((r) => [r.key, r]))
      const childrenOf = new Map()
      const roots = []
      for (const row of rows) {
        // 父 id 可能用另一种前缀写法出现：两种都试。
        const parentRow = byId.get(row.parentId) ?? byKey.get(identityKey(row.parentId)) ?? undefined
        const parent = row.parentId !== '' && parentRow !== undefined ? parentRow.id : ''
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
      return { byId, byKey, childrenOf, roots }
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

    /**
     * 在树里解析某一行的父行 —— 两个世界可能用不同的 id 写法（session-<uuid> / <uuid>），
     * 所以父查找必须同时认 byId 与别名索引，否则父子会悄悄散架。
     */
    function parentOf(tree, row) {
      if (row === undefined || row.parentId === '') return undefined
      return tree.byId.get(row.parentId) ?? tree.byKey.get(identityKey(row.parentId))
    }

    /** 某会话的团队成员 = 同一父下的兄弟（不含自己）。 */
    function siblingsOf(tree, id) {
      const row = tree.byId.get(id)
      const parent = parentOf(tree, row)
      if (row === undefined || parent === undefined) return []
      return (tree.childrenOf.get(parent.id) ?? []).filter((other) => other !== id)
    }

    /** 某会话所在家族的根（一路上溯到没有父的人）。 */
    function rootOf(tree, id) {
      let cur = id
      const seen = new Set([id])
      for (;;) {
        const row = tree.byId.get(cur)
        const parent = parentOf(tree, row)
        if (row === undefined || parent === undefined) return cur
        if (seen.has(parent.id)) return cur // 环保护
        seen.add(parent.id)
        cur = parent.id
      }
    }

    // ---------------------------------------------------------------- 网络

    async function fetchInventory() {
      const res = await fetch(INVENTORY_URL, { cache: 'no-store' })
      const json = await res.json()
      if (json?.ok !== true) throw new Error(json?.error ?? 'HTTP ' + res.status)
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

    // ---------------------------------------------------- 图片管理：网络

    /** 拉某个会话的图片盘点（withPlan=1 时顺带算好删盘计划）。 */
    async function fetchImages(sessionId, options) {
      const opts = options ?? {}
      const query = new URLSearchParams({ sessionId: String(sessionId) })
      if (opts.withPlan === true) query.set('withPlan', '1')
      const res = await fetch(IMAGES_URL + '?' + query.toString(), {
        cache: 'no-store',
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
      return await res.json()
    }

    /** 摘除（可选同时删盘）。 */
    async function requestOffload(payload, options) {
      const opts = options ?? {}
      const res = await fetch(OFFLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
      return await res.json()
    }

    /**
     * 让内存里的会话列表重新读盘（归档与删除之后都要做一次）。
     *
     * 客户端 sessions 服务的官方刷新入口是 `sessions.refresh()`（老版本可能只有
     * `list.refresh` / `list.reload`）；探测式调用，谁在就调谁，一个都没有就返回
     * false，由面板给出「刷新页面」的兜底按钮。
     */
    function refreshSessionList(ctx) {
      try {
        const s = ctx?.get?.('sessions')
        const candidates = [
          { fn: s?.refresh, owner: s },
          { fn: s?.list?.refresh, owner: s?.list },
          { fn: s?.list?.reload, owner: s?.list },
        ]
        for (const entry of candidates) {
          if (entry.fn === undefined || typeof entry.fn !== 'function') continue
          entry.fn.call(entry.owner)
          return true
        }
      } catch {
        /* 刷新失败不该让删除结果丢失：面板还有「刷新页面」兜底 */
      }
      return false
    }

    // ---------------------------------------------------------------- 样式

    const CSS = [
      '.dshdel-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dshdel-card{width:min(760px,100%);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1e1e21);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.5));overflow:hidden;font-size:13px}',
      '.dshdel-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
      '.dshdel-head h3{margin:0;font-size:15px;font-weight:600}',
      '.dshdel-sub{color:var(--dsw-alias-label-secondary,#9a9aa2);font-size:12px;margin-top:2px}',
      '.dshdel-grow{flex:1}',
      '.dshdel-btn{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:7px;padding:5px 10px;cursor:pointer;line-height:1.3;white-space:nowrap}',
      '.dshdel-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.11))}',
      '.dshdel-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dshdel-btn.danger{background:var(--color-red-600,#c0392b);border-color:transparent;color:#fff;font-weight:600}',
      '.dshdel-btn.danger:hover:not(:disabled){filter:brightness(1.12)}',
      '.dshdel-toolbar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}',
      '.dshdel-input,.dshdel-select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:7px;padding:5px 8px;min-width:0}',
      '.dshdel-input{flex:1;min-width:140px}',
      '.dshdel-body{flex:1;overflow:auto;padding:6px 8px}',
      '.dshdel-row{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px}',
      '.dshdel-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05))}',
      '.dshdel-row.sel{background:color-mix(in srgb,var(--color-red-600,#c0392b) 16%,transparent)}',
      '.dshdel-exp{width:18px;flex:none;text-align:center;cursor:pointer;color:var(--dsw-alias-label-secondary,#999);user-select:none;line-height:18px}',
      '.dshdel-exp.leaf{visibility:hidden}',
      '.dshdel-main{flex:1;min-width:0}',
      '.dshdel-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshdel-meta{display:flex;flex-wrap:wrap;gap:8px;color:var(--dsw-alias-label-secondary,#9a9aa2);font-size:11px;margin-top:2px}',
      '.dshdel-badge{font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid currentColor;opacity:.85}',
      '.dshdel-badge.run{color:var(--color-green-500,#2ecc71)}',
      '.dshdel-badge.sub{color:var(--color-amber-500,#e0a800)}',
      '.dshdel-badge.disk{color:var(--dsw-alias-label-secondary,#9a9aa2)}',
      '.dshdel-badge.arch{color:var(--color-blue-500,#4a9eff)}',
      '.dshdel-check{margin-top:2px;flex:none}',
      '.dshdel-foot{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
      '.dshdel-confirm{padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));background:color-mix(in srgb,var(--color-red-600,#c0392b) 12%,transparent)}',
      '.dshdel-confirm p{margin:0 0 8px}',
      '.dshdel-result{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));font-size:12px}',
      '.dshdel-warn{color:var(--color-amber-500,#e0a800);font-size:12px;padding:8px 16px 0}',
      '.dshdel-err{color:var(--color-red-500,#e74c3c)}',
      '.dshdel-entry{width:100%;display:flex;align-items:center;gap:8px;text-align:left}',
      // ---- 图片管理 ----
      '.dshdel-img{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px}',
      '.dshdel-img-head{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
      '.dshdel-img-sum{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dshdel-img-big{font-size:13px;font-weight:600}',
      '.dshdel-img-sub{color:var(--dsw-alias-label-secondary,#9a9aa2)}',
      '.dshdel-img-tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
      '.dshdel-img-tools .dshdel-input{min-width:120px}',
      '.dshdel-img-body{flex:1;min-height:0;overflow:auto;padding:8px}',
      '.dshdel-img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px}',
      '.dshdel-img-card{position:relative;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));cursor:pointer}',
      '.dshdel-img-card.sel{border-color:var(--color-red-600,#c0392b);box-shadow:0 0 0 1px var(--color-red-600,#c0392b) inset}',
      '.dshdel-img-card.off{opacity:.5}',
      '.dshdel-img-thumb{display:block;width:100%;height:86px;object-fit:cover;background:rgba(0,0,0,.25)}',
      '.dshdel-img-ph{display:flex;align-items:center;justify-content:center;height:86px;color:var(--dsw-alias-label-secondary,#888);font-size:11px}',
      '.dshdel-img-meta{padding:4px 6px;display:flex;flex-direction:column;gap:1px;min-height:44px}',
      '.dshdel-img-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}',
      '.dshdel-img-dim{color:var(--dsw-alias-label-secondary,#9a9aa2);font-size:10px}',
      '.dshdel-img-check{position:absolute;top:4px;left:4px;width:15px;height:15px}',
      '.dshdel-img-badge{position:absolute;top:3px;right:3px;padding:1px 4px;border-radius:4px;font-size:9px;background:rgba(0,0,0,.6);color:#fff}',
      '.dshdel-img-hint{padding:2px 6px 5px;font-size:10px;color:var(--dsw-alias-label-secondary,#9a9aa2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshdel-img-hint.warn{color:var(--color-amber-500,#e0a800)}',
      '.dshdel-img-foot{padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));display:flex;flex-direction:column;gap:6px}',
      '.dshdel-img-foot .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshdel-img-cb{display:flex;align-items:flex-start;gap:6px;cursor:pointer;line-height:1.35}',
      '.dshdel-img-warn{color:var(--color-amber-500,#e0a800)}',
      '.dshdel-img-cost{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,#9a9aa2);background:color-mix(in srgb,var(--color-amber-500,#e0a800) 8%,transparent);border-radius:6px;padding:4px 6px}',
      '.dshdel-img-cost-label{font-weight:600;color:var(--color-amber-500,#e0a800);margin-right:4px}',
      '.dshdel-img-cost-note{font-size:10px;opacity:.85;margin-top:2px}',
      '.dshdel-img-empty{padding:22px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#9a9aa2)}',
      '.dshdel-img-confirm{padding:8px 10px;border-radius:6px;background:color-mix(in srgb,var(--color-red-600,#c0392b) 14%,transparent)}',
      '.dshdel-img-list{margin:6px 0 0;padding-left:16px;max-height:120px;overflow:auto}',
      '.dshdel-img-list li{font-size:11px;word-break:break-all}',
    ].join('\n')

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

    /** 行所属工作区的稳定标识（用于筛选取值）。 */
    function workspacePathOf(row) {
      return row.cwd !== '' ? row.cwd : row.workspaceSlug
    }

    /** 行所属工作区的展示名（cwd 末段；没有 cwd 就退回磁盘目录键）。 */
    function workspaceLabelOf(row) {
      return baseName(row.cwd) || row.workspaceSlug
    }

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
      if (row.isSubagent) {
        meta.push(
          h(
            'span',
            { className: 'dshdel-badge sub', key: 'sub', title: row.subagentLabel === '' ? undefined : row.subagentLabel },
            t('badgeSubagent'),
          ),
        )
      }
      if (row.removed) meta.push(h('span', { className: 'dshdel-badge arch', key: 'removed' }, t('badgeRemoved')))
      else if (row.archived) meta.push(h('span', { className: 'dshdel-badge arch', key: 'archived' }, t('badgeArchived')))
      if (row.diskOnly) meta.push(h('span', { className: 'dshdel-badge disk', key: 'disk' }, t('badgeDiskOnly')))
      const when = fmtTime(row.updatedAt)
      if (when !== '') meta.push(h('span', { key: 'when' }, when))
      if (row.bytes > 0) meta.push(h('span', { key: 'size' }, fmtBytes(row.bytes)))
      if (row.paths > 0) meta.push(h('span', { key: 'paths' }, t('pathsLabel', { n: row.paths })))
      const workspace = workspaceLabelOf(row)
      if (workspace !== '') meta.push(h('span', { key: 'ws' }, workspace))

      return h(
        'div',
        {
          className: 'dshdel-row' + (selected ? ' sel' : ''),
          style: { paddingLeft: (8 + depth * 16) + 'px' },
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
          h('div', { className: 'dshdel-meta' }, meta.length > 0 ? meta : h('span', null, shortId(row.id))),
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

      // 已归档集合只在 store 版本变化时重读（归档是删除流程的一部分）
      const archived = React.useMemo(() => archivedIdsOf(ctx), [ctx, st.version])

      // 合并行
      const rows = React.useMemo(
        () => (st.inventory === null ? [] : buildRows(st.inventory, snapshot, { archived, removed: st.removed })),
        [st.inventory, snapshot, archived, st.removed],
      )
      const tree = React.useMemo(() => buildTree(rows), [rows])

      const workspaceOptions = React.useMemo(() => {
        const map = new Map()
        for (const row of rows) {
          const value = workspacePathOf(row)
          if (value === '' || map.has(value)) continue
          map.set(value, workspaceLabelOf(row))
        }
        return [...map.entries()]
          .map(([value, label]) => ({ value, label }))
          .sort((a, b) => a.label.localeCompare(b.label))
      }, [rows])

      if (!st.open) return null

      const enabled = st.inventory?.enabled !== false
      const confirmBefore = st.inventory?.confirmBeforeDelete !== false
      const archiveCapable = st.inventory?.archiveCapable === true
      const query = st.query.trim().toLowerCase()
      const filteredRoots = tree.roots.filter((id) => {
        if (st.workspace !== '') {
          const row = tree.byId.get(id)
          if (workspacePathOf(row ?? {}) !== st.workspace) return false
        }
        if (query === '') return true
        return subtreeMatches(tree, id, query)
      })

      const selectedIds = [...st.selected].filter((id) => tree.byId.has(id))
      const selectedBytes = selectedIds.reduce((n, id) => n + (tree.byId.get(id)?.bytes ?? 0), 0)
      const selectedPaths = selectedIds.reduce((n, id) => n + (tree.byId.get(id)?.paths ?? 0), 0)
      /** 三个「含…」级联键要求先有选择：它们做的是**扩展**，没有基准就没有意义。 */
      const noSelection = selectedIds.length === 0

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
            workspaceOptions.length > 1
              ? h(
                  'select',
                  {
                    className: 'dshdel-select',
                    value: st.workspace,
                    onChange: (e) => store.patch({ workspace: e.target.value }),
                  },
                  h('option', { value: '' }, t('allWorkspaces')),
                  workspaceOptions.map((ws) => h('option', { key: ws.value, value: ws.value }, ws.label)),
                )
              : null,
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => store.setSelected(rows.map((r) => r.id)) }, t('selectAll')),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => store.setSelected([]) }, t('clear')),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn',
                title: t('selectAllSubagentsHint'),
                onClick: () => store.setSelected(subagentIds(rows).filter((id) => tree.byId.has(id))),
              },
              t('selectAllSubagents'),
            ),
            // 三个级联键是「**扩展**当前选择」，所以必须先有选择；没有就置灰并说明原因。
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn',
                disabled: noSelection,
                title: noSelection ? t('pickHint') : t('pickSubagentsHint'),
                onClick: () => batchPick(store, tree, 'subagents'),
              },
              t('pickSubagents'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn',
                disabled: noSelection,
                title: noSelection ? t('pickHint') : t('pickSiblingsHint'),
                onClick: () => batchPick(store, tree, 'siblings'),
              },
              t('pickSiblings'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn',
                disabled: noSelection,
                title: noSelection ? t('pickHint') : t('pickFamilyHint'),
                onClick: () => batchPick(store, tree, 'family'),
              },
              t('pickFamily'),
            ),
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
          st.inventory !== null && !archiveCapable && st.inventory.archiveOnDelete !== false
            ? h('div', { className: 'dshdel-warn' }, t('archiveUnavailable'))
            : null,
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
      const { result } = props
      const failed = (result.results ?? []).reduce((n, r) => n + (r.failed?.length ?? 0), 0)
      const reloaded = result.reloaded === true
      const archived = Number(result.archived) || 0
      const archiveFailed = Number(result.archiveFailed) || 0
      const emptyDisk = Number(result.emptyDisk) || 0
      return h(
        'div',
        { className: 'dshdel-result' },
        h('div', null, t('doneTitle', { n: result.deleted ?? 0 })),
        h('div', { className: 'dshdel-sub' }, t('donePaths', { paths: result.paths ?? 0, size: fmtBytes(result.bytes ?? 0) })),
        archived > 0 ? h('div', { className: 'dshdel-sub' }, t('doneArchived', { n: archived })) : null,
        archiveFailed > 0
          ? h('div', { className: 'dshdel-warn', style: { padding: 0 } }, t('doneArchiveFailed', { n: archiveFailed }))
          : null,
        emptyDisk > 0 ? h('div', { className: 'dshdel-sub' }, t('doneEmptyDisk', { n: emptyDisk })) : null,
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
        const hay = (row.title + ' ' + row.cwd + ' ' + row.id).toLowerCase()
        if (hay.includes(query)) return true
      }
      for (const kid of tree.childrenOf.get(id) ?? []) {
        if (subtreeMatches(tree, kid, query)) return true
      }
      return false
    }

    /**
     * 纯函数：把「当前勾选的会话」**扩展**成一个新集合。
     *
     * ⚠️ 这里曾经写错过：空选择时把基准取成了**全部会话**，于是「选中子 agent」从
     * 全部会话出发再加后代，结果等同于全选（用户实测：按一下全被勾上）。
     * 正确语义是「扩展当前选择」——没有选择就没有可扩展的基准，返回空集，
     * UI 侧把按钮置灰并说明原因。
     *
     * @param tree    由 buildTree 得到的索引
     * @param baseIds 当前勾选的会话 id
     * @param mode    subagents（全部后代）| siblings（同父兄弟）| family（上溯到根后整棵子树）
     */
    function cascadeSelection(tree, baseIds, mode) {
      const add = new Set((baseIds ?? []).filter((id) => tree.byId.has(id)))
      if (add.size === 0) return []
      // 先快照再遍历：descendantsOf 已经给出整棵子树，不需要在循环里递归展开新加入的节点。
      for (const id of [...add]) {
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
      return [...add].filter((id) => tree.byId.has(id))
    }

    /** 纯函数：所有「子 agent」行（只有真正的子 agent，分支不算）。 */
    function subagentIds(rows) {
      return rows.filter((r) => r.isSubagent === true).map((r) => r.id)
    }

    /** 批量选择：把当前勾选扩展为「含子 agent / 含团队成员 / 含整族」。 */
    function batchPick(store, tree, mode) {
      const next = cascadeSelection(tree, [...store.state.selected], mode)
      if (next.length > 0) store.setSelected(next)
    }

    // -------------------------------------------------------- 图片管理：页签与面板

    /**
     * 右侧栏页签的类型定义（与「工作区文件 / 上下文 / 终端 / 浏览器」同一套官方路径）。
     *
     * `multiple: true` 让每个会话各自一个标签页；`guides` 里的那条给出空态入口，
     * 点它就走 `sidebar.actions.openTab(kind, { params: { sessionId } })`。
     */
    function imageTabDefinition() {
      const id = IMAGE_TAB_ID
      return {
        id,
        kind: IMAGE_TAB_KIND,
        multiple: true,
        priority: 'builtin',
        title: () => t('imgTab'),
        guide: [
          {
            id: 'images',
            order: 40,
            title: () => t('imgTab'),
            description: () => t('imgTabHint'),
          },
        ],
      }
    }

    /**
     * 页签标题上的小徽标（图片张数）。
     *
     * ⚠️ 这里刻意**延迟且条件化**拉取：DSH 启动时会恢复上次开着的页签，每个页签都
     * 立刻打一次宿主就会把启动时间拖长（一次冷读要解压 10 MB 日志）。所以：
     * 延迟 2.5 秒、只在页面可见时拉一次；拉不到就只显示静态标题。
     */
    function ImageTabTitle(props) {
      ensureStyle()
      const [state, setState] = React.useState({ n: null })
      const sessionId = props?.sessionId
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return undefined
        let alive = true
        const controller = new AbortController()
        const timer = setTimeout(() => {
          fetchImages(sessionId, { signal: controller.signal })
            .then((json) => {
              if (alive) setState({ n: json?.totals?.occurrences ?? null })
            })
            .catch(() => {})
        }, 2500)
        return () => {
          alive = false
          clearTimeout(timer)
          controller.abort()
        }
      }, [sessionId])
      const label = t('imgTab')
      return h('span', { title: t('imgTabHint') }, state.n === null ? label : label + ' ' + String(state.n))
    }

    /** 面板主体：缩略图墙 + 多选 + 快捷选 + 可选删盘。 */
    function ImageTab(props) {
      ensureStyle()
      const sessionId = props?.sessionId
      const openTab = props?.openTab

      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState('')
      const [selected, setSelected] = React.useState(() => new Set())
      const [query, setQuery] = React.useState('')
      const [origin, setOrigin] = React.useState('all')
      const [timeFilter, setTimeFilter] = React.useState('all')
      const [pickCount, setPickCount] = React.useState('10')
      const [keepCount, setKeepCount] = React.useState('5')
      const [deleteDisk, setDeleteDisk] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [confirming, setConfirming] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const abortRef = React.useRef(null)

      /** 拉一次盘点（withPlan 时顺带算好删盘计划）。 */
      const refresh = React.useCallback(
        async (withPlan) => {
          if (typeof sessionId !== 'string' || sessionId === '') return
          try {
            abortRef.current?.abort()
            const controller = new AbortController()
            abortRef.current = controller
            setLoading(true)
            setLoadError('')
            const json = await fetchImages(sessionId, { signal: controller.signal, withPlan: withPlan === true })
            if (json?.ok !== true) throw new Error(json?.error ?? 'LOAD_FAILED')
            setData(json)
            setSelected((prev) => liveSelection(json.items, prev))
          } catch (error) {
            if (String(error?.name ?? '') !== 'AbortError') setLoadError(String(error?.message ?? error))
          } finally {
            setLoading(false)
          }
        },
        [sessionId],
      )

      // 会话变化 → 重新拉；挂载期间每 8 秒静默刷新一次（历史变了张数就跟着变）
      React.useEffect(() => {
        setSelected(new Set())
        setResult(null)
        setConfirming(false)
        setData(null)
        void refresh(false)
        return () => abortRef.current?.abort()
      }, [refresh])

      // 静默刷新：20 秒一次，且只在「页面可见 + 活会话 + 没有请求在飞」时做。
      // 活会话的盘点是零磁盘 I/O 的内存读取；冷会话没必要轮询（磁盘内容不会自己变）。
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (busy || confirming || loading) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if (data?.live !== true) return
          void refresh(false)
        }, 20_000)
        return () => clearInterval(timer)
      }, [busy, confirming, loading, data, refresh])

      const items = Array.isArray(data?.items) ? data.items : []
      const shown = applyFilters(items, { query, origin, time: timeFilter, includeOffloaded: true })
      const picked = selectionSummary(items, selected)
      const plan = data?.diskPlan ?? null
      const diskPlanned = Array.isArray(plan) ? plan : []
      const diskDeletable = diskPlanned.filter((entry) => entry.action === 'DELETE')
      const diskSourceCount = diskDeletable.filter((entry) => entry.kind === 'source').length
      const diskAttachCount = diskDeletable.filter((entry) => entry.kind === 'attachment').length
      const diskSkipped = diskPlanned.filter((entry) => entry.action !== 'DELETE')
      const diskShared = diskDeletable.filter((entry) => entry.forced === true)
      const diskBytes = diskDeletable.reduce((total, entry) => total + (Number(entry.bytes) || 0), 0)
      const canAct = picked.count > 0 && data?.offloadAllowed === true && busy !== true
      const hint = data?.offloadAllowed === true ? '' : String(data?.offloadBlockedReason ?? '')
      /** 缓存代价预估：断点 = 被选中的最早那条消息；没选就没有。 */
      const costEstimate = costForSelection(data?.cost ?? null, selected)
      const costText = costTextOf(costEstimate)

      /** 勾选复选框：跟随键盘/点按都可。 */
      const onToggle = (item) => setSelected((prev) => toggleSelection(prev, item))

      /** 执行摘除（可选删盘）。 */
      const commit = async () => {
        if (picked.count === 0) return
        setBusy(true)
        setConfirming(false)
        setResult(null)
        try {
          const json = await requestOffload({
            sessionId,
            items: picked.items.map((item) => ({ seq: item.seq, imageIndex: item.imageIndex })),
            deleteDisk: deleteDisk === true,
            dryRun: false,
          })
          setResult(json)
          if (json?.ok === true) {
            setSelected(new Set())
            await refresh(deleteDisk === true)
          }
        } catch (error) {
          setResult({ ok: false, error: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      /** 打开这个会话（冷会话只能先打开才写得进去）。 */
      const openSession = () => {
        if (typeof openTab !== 'function') return
        try {
          openTab('chat', { params: { sessionId } })
        } catch {
          /* 老版本没有这个入口：界面已经写了「请先打开会话」 */
        }
      }

      return h(
        'div',
        { className: 'dshdel-img' },
        h(
          'div',
          { className: 'dshdel-img-head' },
          h(
            'div',
            { className: 'dshdel-img-sum' },
            h('span', { className: 'dshdel-img-big' }, t('imgTab')),
            h(
              'span',
              { className: 'dshdel-img-sub' },
              t('imgTotal', {
                n: data?.totals?.occurrences ?? 0,
                k: data?.totals?.retained ?? 0,
                size: fmtBytes(data?.totals?.retainedBytes ?? 0),
              }),
            ),
            data?.totals?.offloaded > 0
              ? h('span', { className: 'dshdel-img-sub' }, t('imgOffloadedCount', { n: data.totals.offloaded }))
              : null,
          ),
          h(
            'div',
            { className: 'dshdel-img-sub', style: { marginTop: '4px' } },
            t('imgSubtitle'),
          ),
          h(
            'div',
            { className: 'dshdel-img-tools' },
            h('input', {
              className: 'dshdel-input',
              type: 'search',
              value: query,
              placeholder: t('imgSearch'),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'select',
              { className: 'dshdel-select', value: origin, onChange: (event) => setOrigin(event.target.value) },
              h('option', { value: 'all' }, t('imgOriginAll')),
              h('option', { value: 'user' }, t('imgOriginUser')),
              h('option', { value: 'tool' }, t('imgOriginTool')),
            ),
            h(
              'select',
              { className: 'dshdel-select', value: timeFilter, onChange: (event) => setTimeFilter(event.target.value) },
              h('option', { value: 'all' }, t('imgTimeAll')),
              h('option', { value: 'day' }, t('imgTimeDay')),
              h('option', { value: 'week' }, t('imgTimeWeek')),
              h('option', { value: 'month' }, t('imgTimeMonth')),
            ),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => void refresh(deleteDisk) }, t('imgRefresh')),
          ),
          h(
            'div',
            { className: 'dshdel-img-tools' },
            h(
              'button',
              { type: 'button', className: 'dshdel-btn', onClick: () => setSelected(new Set(selectable(items).map(keyOfItem))) },
              t('imgSelectAll'),
            ),
            h('button', { type: 'button', className: 'dshdel-btn', onClick: () => setSelected(new Set()) }, t('imgClear')),
            h('span', { className: 'dshdel-img-sub' }, t('imgPickOldestLabel')),
            h('input', {
              className: 'dshdel-input',
              style: { width: '52px', minWidth: '52px', flex: 'none' },
              type: 'number',
              min: '1',
              value: pickCount,
              onChange: (event) => setPickCount(event.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn',
                onClick: () => setSelected((prev) => pickOldest(items, prev, pickCount)),
              },
              t('imgPickApply'),
            ),
            h('span', { className: 'dshdel-img-sub' }, t('imgPickKeepLabel')),
            h('input', {
              className: 'dshdel-input',
              style: { width: '52px', minWidth: '52px', flex: 'none' },
              type: 'number',
              min: '0',
              value: keepCount,
              onChange: (event) => setKeepCount(event.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdel-btn',
                onClick: () => setSelected((prev) => pickAllButNewest(items, prev, keepCount)),
              },
              t('imgPickApply'),
            ),
          ),
        ),

        h(
          'div',
          { className: 'dshdel-img-body' },
          loading && data === null
            ? h('div', { className: 'dshdel-img-empty' }, t('loading'))
            : loadError !== ''
              ? h('div', { className: 'dshdel-img-empty dshdel-err' }, t('imgLoadFailed', { msg: loadError }))
              : items.length === 0
                ? h('div', { className: 'dshdel-img-empty' }, t('imgNone'))
                : h(
                    'div',
                    { className: 'dshdel-img-grid' },
                    ...shown.map((item) => {
                      const key = keyOfItem(item)
                      const isSelected = selected.has(key)
                      const sourceInfo = item.heldPath === '' ? t('imgNoSource') : sourceBadgeOf(item, data)
                      return h(
                        'label',
                        {
                          key,
                          className: 'dshdel-img-card' + (isSelected ? ' sel' : '') + (item.offloaded ? ' off' : ''),
                          title: item.heldPath === '' ? item.name : item.heldPath,
                        },
                        h('input', {
                          className: 'dshdel-img-check',
                          type: 'checkbox',
                          checked: isSelected,
                          disabled: item.offloaded === true,
                          onChange: () => onToggle(item),
                        }),
                        item.offloaded ? h('span', { className: 'dshdel-img-badge' }, t('imgOffloaded')) : null,
                        item.attachmentId === ''
                          ? h('div', { className: 'dshdel-img-ph' }, t('imgThumbFail'))
                          : h('img', {
                              className: 'dshdel-img-thumb',
                              loading: 'lazy',
                              src: THUMB_URL + '?attachment=' + encodeURIComponent(item.attachmentId),
                              alt: item.name,
                              onError: (event) => {
                                event.target.style.visibility = 'hidden'
                              },
                            }),
                        h(
                          'div',
                          { className: 'dshdel-img-meta' },
                          h('span', { className: 'dshdel-img-name' }, item.name === '' ? shortId(item.attachmentId) : item.name),
                          h(
                            'span',
                            { className: 'dshdel-img-dim' },
                            String(item.width) + '×' + String(item.height) + ' · ' + fmtBytes(item.bytes),
                          ),
                          h('span', { className: 'dshdel-img-dim' }, fmtTime(item.time)),
                        ),
                        h('div', { className: 'dshdel-img-hint' }, sourceInfo.text),
                      )
                    }),
                  ),
        ),

        h(
          'div',
          { className: 'dshdel-img-foot' },
          hint === 'NOT_LIVE'
            ? h(
                'div',
                { className: 'dshdel-img-warn' },
                t('imgNotLive'),
                typeof openTab === 'function'
                  ? h(
                      'button',
                      { type: 'button', className: 'dshdel-btn', style: { marginLeft: '6px' }, onClick: openSession },
                      t('imgTab'),
                    )
                  : null,
              )
            : hint === 'SESSION_RUNNING'
              ? h('div', { className: 'dshdel-img-warn' }, t('imgRunning'))
              : null,

          h(
            'div',
            { className: 'row' },
            h('span', { className: 'dshdel-img-big' }, t('imgSelected', { n: picked.count })),
            picked.count > 0 ? h('span', { className: 'dshdel-img-sub' }, t('imgReclaim', { size: fmtBytes(picked.bytes) })) : null,
          ),

          // 摘除前的「缓存代价预估」：告诉用户这一轮要重算多少 token、命中率会掉到多少
          picked.count > 0
            ? h(
                'div',
                { className: 'dshdel-img-cost' },
                h('span', { className: 'dshdel-img-cost-label' }, t('imgCostLabel')),
                h('span', null, costText),
                costEstimate?.ok === true && Number(costEstimate.reprocess) > 2000
                  ? h('div', { className: 'dshdel-img-cost-note' }, t('imgCostWhy', { seq: String(costEstimate.seq) }) + ' · ' + t('imgCostImages'))
                  : null,
              )
            : null,

          h(
            'label',
            { className: 'dshdel-img-cb' },
            h('input', {
              type: 'checkbox',
              checked: deleteDisk,
              onChange: (event) => {
                const next = event.target.checked === true
                setDeleteDisk(next)
                void refresh(next)
              },
            }),
            h('span', null, t('imgDeleteDisk')),
          ),

          deleteDisk
            ? h(
                'div',
                { className: 'dshdel-img-sub' },
                plan === null
                  ? t('loading')
                  : [
                      t('imgDiskSummary', { s: diskSourceCount, a: diskAttachCount, size: fmtBytes(diskBytes) }),
                      diskSkipped.length > 0 ? ' · ' + t('imgDiskSkipped', { n: diskSkipped.length }) : '',
                    ].join(''),
              )
            : null,

          confirming
            ? h(
                'div',
                { className: 'dshdel-img-confirm' },
                h('div', { className: 'dshdel-img-big' }, t('imgConfirmTitle', { n: picked.count })),
                h('p', { style: { margin: '4px 0' } }, t('imgConfirmBody').replace(/\*\*/g, '')),
                deleteDisk
                  ? h(
                      'p',
                      { style: { margin: '4px 0' }, className: 'dshdel-img-warn' },
                      t('imgConfirmDisk', { s: diskSourceCount, a: diskAttachCount }),
                    )
                  : null,
                deleteDisk && diskShared.length > 0
                  ? h('p', { style: { margin: '4px 0' }, className: 'dshdel-img-warn' }, t('imgConfirmForce', { n: diskShared.length }))
                  : null,
                costText === ''
                  ? null
                  : h(
                      'p',
                      { style: { margin: '4px 0' }, className: 'dshdel-img-cost' },
                      h('span', { className: 'dshdel-img-cost-label' }, t('imgCostLabel')),
                      h('span', null, costText),
                    ),
                h(
                  'ul',
                  { className: 'dshdel-img-list' },
                  ...picked.items.slice(0, 10).map((item, index) =>
                    h('li', { key: String(index) }, (item.name === '' ? shortId(item.attachmentId) : item.name) + (item.heldPath === '' ? '' : ' → ' + item.heldPath)),
                  ),
                  picked.items.length > 10 ? h('li', { key: 'more' }, t('imgConfirmMore', { n: picked.items.length - 10 })) : null,
                ),
                h(
                  'div',
                  { className: 'row', style: { marginTop: '6px' } },
                  h(
                    'button',
                    { type: 'button', className: 'dshdel-btn', onClick: () => setConfirming(false), disabled: busy },
                    t('cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshdel-btn danger',
                      onClick: () => void commit(),
                      disabled: busy,
                    },
                    deleteDisk ? t('imgConfirmYesDisk') : t('imgConfirmYes'),
                  ),
                ),
              )
            : h(
                'div',
                { className: 'row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshdel-btn' + (deleteDisk ? '' : ' danger'),
                    disabled: !canAct,
                    onClick: () => setConfirming(true),
                  },
                  deleteDisk ? t('imgOffloadAndDelete') : t('imgOffloadOnly'),
                ),
                busy ? h('span', { className: 'dshdel-img-sub' }, t('imgBusy')) : null,
              ),

          result !== null
            ? h(
                'div',
                { className: 'dshdel-img-sub' + (result.ok === true ? '' : ' dshdel-err') },
                offloadOutcome(result),
              )
            : null,

          data?.variantCache?.count > 0
            ? h('div', { className: 'dshdel-img-sub' }, t('imgVariantKept', { n: data.variantCache.count }))
            : null,
        ),
      )
    }

    /** 卡片下方的源文件提示（存在 / 已失效 / 被别的会话引用 / 风险等级）。 */
    function sourceBadgeOf(item, data) {
      const plan = Array.isArray(data?.diskPlan) ? data.diskPlan : []
      const hit = plan.find((entry) => entry.kind === 'source' && entry.path === item.heldPath)
      if (hit === undefined) return { text: item.heldPath }
      if (hit.reason === 'MISSING') return { text: t('imgSourceMissing') }
      if (hit.reason === 'SHARED_WITH_OTHER_SESSION') return { text: t('imgShared', { n: (hit.referencedBy ?? []).length }) }
      if (typeof hit.reason === 'string' && hit.reason !== '') return { text: hit.reason }
      const scope =
        hit.scope === 'in-workspace'
          ? t('imgInWorkspace')
          : hit.scope === 'programdata'
            ? t('imgProgramData')
            : hit.scope === 'in-profile'
              ? t('imgInProfile')
              : t('imgOutsideWorkspace')
      return { text: scope + (hit.risk === 'high' ? ' ⚠' : '') }
    }

    /** 重新拉盘点。 */
    async function reload() {
      const store = getStore()
      store.patch({ loading: true, error: null })
      try {
        const json = await fetchInventory()
        store.patch({ inventory: json, loading: false, error: null })
        // 丢掉已经不存在的选择
        const alive = new Set((json.items ?? []).map((i) => identityKey(i.id)))
        store.setSelected([...store.state.selected].filter((id) => alive.has(identityKey(id))))
      } catch (error) {
        store.patch({ loading: false, error: String(error?.message ?? error) })
      }
    }

    /**
     * 真正执行删除。
     *
     * 唯一的破坏性动作在宿主侧（/delete 路由）：它会**先归档、再删盘**。
     * 客户端只负责：发起请求 → 让列表刷新 → 把结果如实呈现（含归档失败、
     * 「磁盘上早已没有文件」这两种需要用户知道的情况）。
     */
    async function doDelete(store, ctx, ids) {
      if (ids.length === 0) return
      store.patch({ busy: true, confirm: false, error: null })
      try {
        const before = store.state.inventory
        const bytesOf = (id) => {
          const key = identityKey(id)
          const item = (before?.items ?? []).find((i) => identityKey(i.id) === key)
          return Number(item?.bytes) || 0
        }
        const expectedBytes = ids.reduce((n, id) => n + bytesOf(id), 0)

        const json = await requestDelete(ids, false)
        if (json?.ok !== true) throw new Error(json?.error ?? 'DELETE_FAILED')

        // 宿主已经先归档、再删盘；这一步只是让内存里的列表跟上。
        const reloaded = refreshSessionList(ctx)

        const results = json.results ?? []
        const paths = results.reduce((n, r) => n + (r.removed?.length ?? 0), 0)
        const deleted = results.filter((r) => r.ok === true).length
        const archived = results.filter((r) => r.archived === true).length
        const archiveFailed = results.filter((r) => r.archived !== true && typeof r.archiveError === 'string').length
        const emptyDisk = results.filter((r) => r.emptyDisk === true).length

        // 记住这次删掉的 id：宿主内存里可能还活着（尤其是刚删掉的当前会话），
        // 那种行会在面板里以「已删除」出现，而不是看起来什么都没发生。
        const removed = new Set(store.state.removed ?? [])
        for (const r of results) {
          if (r.ok === true || r.archived === true) removed.add(r.id)
        }

        store.patch({
          busy: false,
          removed,
          result: {
            deleted,
            paths,
            bytes: expectedBytes,
            results,
            reloaded,
            archived,
            archiveFailed,
            emptyDisk,
            archiveCapable: json.archiveCapable === true,
            archiveOnDelete: json.archiveOnDelete !== false,
          },
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

      // 面板需要 ctx 去读会话列表服务与工作区归档集合；组件是闭包，取这里登记的引用。
      globalThis.__dshDeleteCtx__ = ctx
      // 先把共享 store 落到 globalThis 上，组件首次渲染时就能取到同一份。
      const sharedStore = getStore()

      // 卸载时把这两个全局引用收回去（**只在仍指向本实例时才删**，避免误删新实例的）。
      // 不收回的话：插件卸载后 `globalThis.__dshDeleteCtx__` 会留着一个悬空 ctx，
      // store 也会跨 fiber 残留 —— 都是可组合性上的泄漏。
      try {
        ctx.effect(
          () => () => {
            if (globalThis.__dshDeleteCtx__ === ctx) delete globalThis.__dshDeleteCtx__
            if (globalThis[STORE_KEY] === sharedStore) delete globalThis[STORE_KEY]
          },
          'dsh-delete: global bindings',
        )
      } catch {
        /* 拿不到 effect（老宿主）时保持旧行为：多留两个全局引用，不影响功能 */
      }

      // 关键：**不能**写 ctx.slots.inject(...)。
      // 在 DSH 0.2.0-rc.x 里插槽是 slots 服务，必须通过 ctx.inject(['slots'], cb)
      // 拿到注入上下文后再读；直接访问 ctx.slots 会抛错，于是**一个入口都注册不上**
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

      // 右侧栏「图片管理」页签：同样是动态注入 + 探测 —— 缺 slots / sidebarRightTabs 的
      // 宿主上只是少一个页签，删除功能照旧（声明式 inject 会把整条 fiber 停住）。
      ctx.inject(['slots', 'sidebarRightTabs'], (owner) => {
        const slots = serviceAt(owner, 'slots')
        const tabs = serviceAt(owner, 'sidebarRightTabs')
        const right = serviceAt(owner, 'sidebarRight')
        if (slots === undefined || tabs === undefined || typeof tabs.register !== 'function') {
          console.warn('dsh-delete: 宿主未提供 sidebarRightTabs，图片管理页签不注册')
          return
        }

        const mountImages = () => {
          const disposers = []
          const push = (value) => {
            if (typeof value === 'function') disposers.push(value)
          }
          push(tabs.register(imageTabDefinition()))
          push(
            slots.inject('sidebar.right.pane.tab', () =>
              slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: IMAGE_TAB_ID,
                  inject: (sessionId) => ({
                    sessionId,
                    active: true,
                    openTab:
                      right !== undefined && typeof right.openTab === 'function'
                        ? (kind, params) => right.openTab(kind, params)
                        : undefined,
                  }),
                },
                ImageTab,
              ),
            ),
          )
          push(
            slots.inject('sidebar.right.pane.tab.title', () => slots.register({ name: 'sidebar.right.pane.tab.title', key: IMAGE_TAB_ID }, ImageTabTitle)),
          )
          return () => {
            for (const dispose of [...disposers].reverse()) {
              try {
                if (typeof dispose === 'function') dispose()
              } catch {
                /* 注销失败不该影响其它条目 */
              }
            }
          }
        }

        try {
          if (typeof owner.effect === 'function') owner.effect(mountImages, 'dsh-delete: image tab')
          else mountImages()
        } catch (error) {
          console.warn('dsh-delete: 图片页签登记失败', error)
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
      _internals: {
        buildRows,
        buildTree,
        descendantsOf,
        siblingsOf,
        rootOf,
        cascadeSelection,
        subagentIds,
        fmtBytes,
        fmtTime,
        t,
        identityKey,
        baseName,
        archivedIdsOf,
        workspaceLabelOf,
        refreshSessionList,
        // 图片管理：纯选择逻辑（离线可断言）
        IMAGE_TAB_ID,
        IMAGE_TAB_KIND,
        imageTabDefinition,
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
      },
    }
  },
})
