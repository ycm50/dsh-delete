# dsh-delete

**DSH 会话与图片管理插件** —— 两个互不干扰的能力，装在同一个包里：

1. **会话删除**：左侧栏底部一个入口，打开多选面板，把会话**连同它在磁盘上的文件**一起删掉，并让 DSH 自己把它从界面上收走；支持按关系级联选中「子 agent」「团队成员」「整族」。
2. **图片管理**：右侧栏（与「工作区文件 / 上下文 / 新建终端 / 浏览器」并列）一个页签，统计会话里有多少张图、多选**摘除**，并可另行勾选**删除磁盘上的原文件**（源文件 + 附件对象）。

不改 DSH 本体任何一行源码。

```
侧边栏底部
  🗑 会话管理                          ← 点开面板

┌─ 会话管理 / 删除 ─────────────────────────────────────────────┐
│ 勾选要删除的会话；侧边栏里能看到的、磁盘上残留的，都会列出来。  │
│                                                               │
│ [搜索…] [全部工作区▾] [全选][清空] [选中子agent][选中团队][整族] │
│                                                               │
│ ▾ ☐ 父会话标题            2 分钟前 · 1.2 MB · 2 条路径         │
│    ▾ ☑ 子 agent 标题  [子agent] [运行中]  512 KB               │
│ ▸ ☐ 另一个会话            3 天前 · 8.4 MB                      │
│     ☐ 残留会话  [仅磁盘]  156 KB                                │
│                                                               │
│ 已选 2 个会话   合计 1.7 MB                    [删除选中]      │
└───────────────────────────────────────────────────────────────┘

右侧栏（与工作区文件 / 上下文 / 终端 / 浏览器 并列）
  🖼 图片管理

┌ 🖼 图片管理 ────────────────────────────────────────────────┐
│ 共 27 张图 · 仍在上下文 19 张 · 31.2 MB                      │
│ [搜索文件名…] [全部来源▾] [全部时间▾]              [刷新]     │
│ [全选][清空]  最早 N 张 [10][选]  除最近 N 张外全部 [5][选]   │
├────────────────────────────────────────────────────────────┤
│ ☑ 🖼 hw_r150.png  2412×1080  74.8 KB   昨天 12:03           │
│       工作区内                                              │
│ ☐ 🖼 shot_now3.png 已摘除                                    │
│ ☐ 🖼 hw_r151.png  被 3 个会话引用                             │
├────────────────────────────────────────────────────────────┤
│ 已选 3 张   移除后请求体积约减 2.1 MB                        │
│ ☐ 同时删除磁盘上的原文件（源文件 + 附件对象），不可恢复      │
│   可删：源文件 2 个 · 附件对象 2 个 → 约 2.3 MB              │
│                              [摘除选中]                      │
└────────────────────────────────────────────────────────────┘
```

---

## 特性

| | |
|---|---|
| **侧边栏入口** | 挂在 `sidebar.footer.action`，与其它插件（费用/上下文）同一个动作区 |
| **多选删除** | 每行一个复选框，工具栏有全选 / 清空 |
| **可复选的级联** | 「选中子 agent」= 所有后代；「选中团队成员」= 同父的兄弟；「选中整族」= 上溯到根再带全部后代 |
| **磁盘口径** | 列表同时呈现「左侧栏看得见的」和「列表里已消失、但文件还在的残留会话」，后者标 `仅磁盘` |
| **先归档再删盘** | 删除时先让 DSH 归档该会话（左侧栏立刻不再显示），再删磁盘文件 —— 只删文件的会话会变成永远清不掉的幽灵行 |
| **体积与路径数** | 每行显示该会话在磁盘上占多少、由几条路径组成 |
| **二次确认** | 默认开启，确认条里给出「将移除 N 条路径 / 释放多少」 |
| **搜索与工作区过滤** | 多工作区时自动出现下拉 |
| **运行中提示** | 会话在跑时标 `运行中`（归档时会 stopActivity，停掉它的工作） |
| **图片张数统计** | 右侧栏页签给出「共几张 / 仍在上下文几张 / 占多少字节 / 已摘除几张」 |
| **图片多选摘除** | 缩略图墙 + 复选框；快捷「最早 N 张」「除最近 N 张外全部」；按来源与时间筛选 |
| **可选删原文件** | 一个**默认关闭**的复选框：勾上才同时删除磁盘上的源文件与附件对象，并在确认前列出「可删几个 / 跳过几个」 |
| **不改本体** | 全部通过官方的插槽、右侧栏页签与 web server 通道，宿主与浏览器两半都是独立包 |

---

## 图片管理（第二步能力）

### 它解决什么

一个会话里图片攒多了，**新消息可能发不出去**：DSH 本体对图片有若干处限额 ——
单条消息的图片张数（`dsh-attachment-local` 的 `maxImagesPerMessage`）、单条请求的
图片字节/张数预算（`dsh-llm-deepseek` 的 `maxRequestFilesBytes` / `maxImagesPerRequest`，
`dsh-llm-pi-ai` 的 `maxRequestImageBytes`）。超限时路由会拒绝请求。
本面板让你**看见每一张图**，并把选中的那些从后续请求里摘掉。

> ⚠️ **一个容易混淆的点**：「一条消息最多添加 N 张图片」是**单条消息**的上限
> （由 `dsh-attachment-local.maxImagesPerMessage` 控制，默认 20）。本面板不改变那个限额；
> 它处理的是「历史里图片太多，把请求撑爆 / 被路由拒绝」。两者互不替代。
> 若你确实要放宽单条消息的张数，那是另一处配置：
> `设置 → 插件配置 → dsh-attachment-local → maxImagesPerMessage`。

### 摘除是怎么实现的（为什么安全）

复用 DSH **官方**的 `image/offload` 事件，而不是重写日志：

```
① 路由发现保留图片超预算 → 以 IMAGE_OFFLOAD_REQUIRED 失败，并说明还要省略多少张
② dsh-compaction-image-offload 追加一条 image/offload（按事件 seq + 消息内图片序号选点）
③ 它注册的投影把这些出现位置换成「占位文本」（带附件 id 与只读路径）后重试
```

本插件做的只是**追加同一种事件**（投影已由随附基础组合注册，我们**不重复注册**）：

- 会话日志、附件文件**一个字节都不改**；已摘除的位置在后续请求里只花占位文本，
  **不再消耗视觉 token**；KV 复用止于第一张被改的图片。
- 被摘除的图片仍可按占位文本里的**只读路径**读回来（`read` / `read_image`）。
- 重放 / fork / 切换路由 / 重启后语义一致 —— 因为它是日志里的一条记录，不是内存状态。
- **不可逆**：标记不会自动回归（本体设计如此）。

### 两套坐标：`seq` 与「位置」分开（真机踩出来的）

真机日志里**位置 ≠ seq** 是常态：header 占一行且自身 `seq` 与第一条事件撞号，
中途还会有空洞（实测 9490 行日志里 9378 条位置 ≠ seq）。所以：

| 动作 | 坐标 |
|---|---|
| 读事件 | **位置**（`seqToIndex` 映射 → `events[position]`） |
| 写 `image/offload` 的 `targets[].seq` | **真实 seq**（本体投影要求它是表面节点序号） |

`lib/image-logic.js` 的 `buildSessionModel` 把两者显式分开，`_smoke/image-smoke.mjs` 的夹具
**故意**造成位置≠seq，任何「拿 seq 当数组下标」的写法都会立刻测挂。

### 删除磁盘上的原文件（默认关闭）

勾选后，两条通路**各自独立判定**，逐项给出「删 / 跳过 / 拒绝」与原因：

| 通路 | 位置 | 判定要点 |
|---|---|---|
| **源文件** | `tool/result` 事件里 `data.meta.path` 指的原始文件（如 `A:\Downloads\tat\TMP\hw_r150.png`） | 只认「同一事件里与 image 块同排出现」的路径；必须是绝对路径且规范化后不变；非普通文件（目录 / 符号链接 / 重解析点）一律跳过 |
| **附件对象** | `<DSH_HOME>/attachments/v1/objects/<前2位>/<sha256>` | 路径**只由 `sha256` id 派生**（客户端永远不传路径）；删除前重算内容 sha256 必须等于文件名 |

**安全闸（三层）**

1. **系统区连子路径一起挡**：`C:\Windows\**`、`C:\Program Files\**`、`C:\Program Files (x86)\**`、
   `C:\ProgramData\**`、卷元数据（`$Recycle.Bin` / `Recovery` / `System Volume Information` / `EFI`）、
   `<DSH_HOME>`（会话日志与投影缓存）、DSH 安装目录；另外挡盘根、UNC / 网络位置、其它用户主目录
   （例外：`%SystemRoot%\Temp` 放行）。
   **用户主目录（含 `AppData`）是可删的** —— 按用户要求收窄成上面这份名单。
2. **全库核引用**：删之前扫 `$DSH_HOME/sessions/**` 全部会话日志，统计每个源文件路径与附件 id
   被哪些会话引用。**被其它会话引用的默认跳过**并在报告里注明（附件是内容寻址的，可能被
   fork / 恢复出的会话共享）。确实要连它一起删，需要一个**额外的二次确认**
   （面板会写明「那些会话的历史将出现缺失附件」）。
3. **删除前逐项复核**：源文件重新过一次判定、附件对象重新对一次摘要，任何一项不符就跳过，
   **绝不报假成功**。

**不做的事**：`<DSH_HOME>/cache/attachments/request-images/`（派生缓存）**不碰**。
理由：那条缓存键由本体内部的变换描述符派生，实测无法可靠地把一个缓存文件对应回某个附件 id；
盲删是猜测，而残留的派生缓存**无害** —— 读取时会按当前变换校验，不匹配就当 miss 重算。
面板会如实写出「另有 N 个派生缓存文件被保留」。

> ⚠️ 删除**不进回收站、不可恢复**（按用户要求）。同一批里被摘除与删盘是**先摘除、后删盘**：
> 摘除可复盘，删盘不可逆。

### 什么时候不能摘除

| 情况 | 行为 |
|---|---|
| 会话不在内存里（冷会话 / 已归档） | 面板可**只读**列出张数，写入口禁用并提示「请先打开该会话」；宿主侧返回 `NOT_LIVE` |
| 会话正在跑一轮工作 | 默认拒绝（`SESSION_RUNNING`）：本体自己会在超预算时自动摘除最旧的几张并重试，同时写会同一条记录可能互相踩到。可在设置里关掉 `blockOffloadWhileRunning` |
| 宿主没有 `sessions` 服务 | 图片摘除不可用，如实降级（会话删除不受影响） |
| 选中的图片已不在**当前上下文**（被压缩 `replace` 掉、或已摘除） | **跳过该项并说明原因**，其余照常摘除；一项都不剩时返回 `NOTHING_TO_OFFLOAD` + 逐条原因，而不是整批失败 |

### 一致性与性能（这一节是两个真机 bug 换来的）

**① 判定与写入必须用同一份「表面」。** 本体追加 `image/offload` 时会用
`session.surface.nodes` 校验「目标 seq 是不是当前表面节点」。第一版用**磁盘日志**
算表面，而压缩（`compaction` 的 `replace`）会把旧节点移出表面、日志里那些事件却还在 ——
于是本体直接拒绝整条事件，界面上只看到一句 `APPEND_FAILED`，用户体感是「点了删除没反应」。

现在：**活会话直接读它自己的内存日志**（`session.log` + `session.surface.nodes`，零磁盘 I/O），
冷会话才读盘；勾选项逐条按活会话复核，**不合法的跳过而不是整批失败**，
并且失败时把宿主的**原始错误文本**（`detail`）一并显示，不再只给一个错误码。

**② 不要用同步读盘拖慢宿主。** 实测：一个 10 MB 会话日志读一次要 **解压 232 ms + 逐行 parse 163 ms**，
全是同步阻塞；面板每次刷新、每个页签标题都会各触发一次。三处修掉：

| 措施 | 效果 |
|---|---|
| 活会话零 I/O | 常看的会话完全不读盘 |
| 冷会话改**异步**读（`node:fs/promises` + 逐帧异步解压） | 同样 600 ms 墙钟，但**事件循环不再被堵**（实测：读盘期间 20 ms 定时器仍触发 24 次；同步版 0–1 次） |
| 模型按 `路径\|字节\|mtime` 缓存 | 日志没变时再次盘点 **460 ms → 2 ms** |
| 引用扫描同样异步 + 按全库日志指纹缓存 | 勾选「删除原文件」不再把宿主冻住几秒 |
| 页签徽标**延迟 2.5 s 且仅页面可见时**拉一次；面板轮询 20 s、仅活会话、仅可见、且无请求在飞 | DSH 启动时恢复页签不再叠加多次冷读 |

所有缓存都建在 `apply` 的 fiber 内（插件卸载即消失），没有模块级状态。

---

## 磁盘契约（对齐 DSH 0.2.0-rc.x，读源码 + 实测）

这一版最重要的一课：**不要假设磁盘布局**。真实契约是：

| 事实 | 说明 |
|---|---|
| **会话目录名 = `encodeSegment(会话 id)`** | 不是写死的 `session-<uuid>`。根会话的 id 是 `session-<uuid>`（带前缀），**子 agent 会话的 id 是裸 `<uuid>`** —— 两种名字同时存在于 `sessions/` 下 |
| **会话主体第一行就是 header** | `{ type:'session', version, id, createdAt, cwd, parentSession?, origin?, delegationDepth, agentPreset? }`。`id` 是权威 id；`origin:'subagent'` / `parentSession` 是权威的「子 agent」判据 |
| **标题是日志里的 `session/title` 事件** | 投影缓存里存着它的缓存副本（`record.rows.title.val`）。缓存不一定有 —— 子 agent 会话常常没有，必须回退读日志 |
| **投影缓存文件名就是记录键** | `storages/session_projcache/sessions/<id>.json`；记录校验失败时 domain 会把它挪成 `<id>.json.bak.<stamp>`，那也属于同一个会话 |

一个会话在磁盘上散落成两处（本插件**只**动这两处，其余一律不碰）：

| 路径 | 说明 |
|---|---|
| `<DSH_HOME>/sessions/<工作区>/<会话 id>/` | 会话主体目录（内含 `session.v4.jsonl.zstd`）。兼容老版单文件 `<会话 id>.jsonl.zstd` / `.jsonl` |
| `<DSH_HOME>/storages/session_projcache/sessions/<会话 id>.json` | 会话投影缓存（含 `.json.bak.*`） |

`<DSH_HOME>` 默认是 `~/.dsh`（也可用环境变量 `DSH_HOME`，或在设置里覆盖）。

**不动**的东西：附件（内容寻址、可能被多个会话共享）、费用账本 `cost-meter/ledger.json`、其它插件的数据。

### 旧版错在哪（本次修复的三类现象）

| 现象（用户实测） | 根因 |
|---|---|
| 子 agent 会话显示成 `Downloads`（工作区目录名）；删除面板里两行同名 | 只读投影缓存，缓存没有标题就退回 cwd 目录名；磁盘日志里其实写着真实标题，却没人去读 |
| 根会话被打上 `子 agent` 徽章 | `subagent` 投影的状态是 `{ identity?: … }`，普通会话是**空对象** `{}` —— 旧版只看「这一行存不存在」，于是把根会话也当成子 agent |
| 同一会话出现两行（一行有体积、一行有标题） | 旧版把磁盘名强行剥成裸 uuid 再跟快照的 `session-<uuid>` 比，两个世界对不上 |
| **子 agent 会话根本删不掉；删完的文件又"回来"** | 裸 `<uuid>` 目录整类扫不到；而且删除只删文件、不归档 —— 宿主内存里还活着的会话继续挂在左侧栏，而文件删掉后官方归档会以「找不到该会话」失败，那条幽灵行就再也清不掉了 |

### 「两种残留」形态

会话在磁盘上**并不总是**「目录 + 缓存」两件套：只读审计里大量会话只剩投影缓存（日志目录早已不存在），
它们在**左侧栏里根本不显示**，只有扫盘才能发现并清掉。面板会给它们打上 `仅磁盘` 标记。

本机真实数据只读审计（`node _smoke/real-inventory.mjs`）：5 个会话（3 个根会话 + 2 个子 agent，其中 2 个的父会话已被删除）、
共解析出 8 条待删路径，**逐条复核越界 0 条**；非法 id（`../../evil` / `..` / 空串 / `C:\Windows` / `session-x` / `null`）**6/6 全部拒绝**。

---

## 删除时到底发生了什么（顺序是契约的一部分）

```
POST /plugins/dsh-delete/delete  { ids: [...] }
  │
  ├─ 1. 先归档：ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
  │      → DSH 的所有分组界面立刻不再显示它；正在跑的工作被停掉
  │
  └─ 2. 再删盘：sessions/<工作区>/<id>/  +  storages/session_projcache/sessions/<id>.json
```

**为什么顺序不能反**：DSH 的会话列表是「磁盘上的会话 ∪ 宿主内存里活着的会话」的并集
（`dsh-session-query` 的 `SessionCorpus.listSessions`）。只删文件的话，一个还在宿主内存里的会话会继续出现在左侧栏，
看起来像「删不掉」；而文件一旦删掉，官方归档入口就会以 `workspace unknown session` 拒绝 —— 于是那条行**永远**清不掉。
归档还要求会话「活着或还在持久化里」，所以它必须发生在删盘之前。

归档是持久但**可撤销**的（界面里可以 unarchive，工作区记账槽位不动）；磁盘删除则不可撤销。
把设置里的 `archiveOnDelete` 关掉，本插件就退化为「只删文件」，此时宿主内存里的会话可能继续显示到 DSH 重启为止
（面板会给出明确的黄色提示）。

---

## 安全规则

删除是全插件唯一具破坏性的动作，所以规则写在 `lib/logic.js` 的最前面，且**每条路径都要过两道闸**：

1. **会话 id 必须是合法形状**：裸 `8-4-4-4-12` 十六进制 UUID，或带前缀的 `session-<UUID>`（大小写不敏感）。
   `../..`、空串、其它任何形态全部在入口被拒 —— 路径穿越不可能构造出来。
2. **每条待删路径都要 `insideRoot()` 复核**，必须真的落在 `<home>/sessions` 或 `<home>/storages/session_projcache/sessions` 之内；复核不过就丢弃，绝不执行。
3. **只删「名字能反解出该会话 id」的条目**（会话目录 / 主体文件 / 投影文档及其 `.bak`），
   不按目录名模糊匹配，也没有任何通配删除。磁盘名先过 `encodeSegment` 的反解，再按 id 别名匹配。

> ⚠️ 磁盘删除**不可撤销**，不进回收站。删之前请确认选中项。

---

## 安装

插件按 DSH 的 **bundle 层**接入 profile（默认 `~/.dsh/profiles/desktop`）。
### 1. 取得代码

```powershell
# 放在任意位置；下例假设 A:\Downloads\dsh-delete
```

### 2. 链接进 profile

```powershell
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-delete" `
  -Target "A:\Downloads\dsh-delete"
```

### 3. 声明为 bundle

编辑 `~/.dsh/profiles/desktop/package.json`，在 `dependencies` 与 `dsh.profile.bundles` 里各加一项：

```jsonc
{
  "dependencies": {
    "dsh-delete": "file:A:/Downloads/dsh-delete"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …已有条目…
        "dsh-delete"
      ]
    }
  }
}
```

`cordis.patch.yml` **不需要手改**：本包自带一份（`dsh.bundle.patch` 会把它叠上去），里面就是一行
`insert: { id: dsh-delete, name: dsh-delete }`。

### 4. 重启 DSH

> **为什么必须重启**：客户端模块图是**启动时快照** —— `client-modules` 在启动时扫描
> loader 条目、组合客户端 bundle。宿主半改完刷新页面即可生效，但浏览器半要等重启
> 才会被组合进模块图。

重启后侧边栏底部就会出现 **🗑 会话管理**。

---

## 设置

`设置 → 插件配置 → dsh-delete`（全部 `.volatile()`，改完即时生效，无需重启）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | 开 | 会话管理总开关。关掉后客户端不显示入口（路由仍在，便于排查） |
| `confirmBeforeDelete` | 开 | 删除会话前是否要二次确认 |
| `keepProjCache` | 关 | 保留投影缓存 JSON，只删会话主体 |
| `archiveOnDelete` | 开 | 删除前先让 DSH 归档该会话（「删干净」的关键；关掉就只删文件） |
| `imageManagerEnabled` | 开 | 图片管理面板总开关（关掉后不注册右侧栏页签，路由仍在） |
| `confirmBeforeOffload` | 开 | 摘除前是否要二次确认 |
| `blockOffloadWhileRunning` | **开** | 会话正在跑一轮工作时不摘除（避免与本体自动摘除抢写同一条记录） |
| `thumbnailMaxEdge` | `192` | 缩略图长边像素（只影响面板显示；不改动任何存储内容） |

`home` 字段可在 `cordis.patch.yml` 里写死（非标准布局时才需要）；
`DSH_INSTALL` 环境变量可覆盖 DSH 安装目录（默认 `A:\dsh`，删源文件时会一并禁掉它）。

---

## 测试

零依赖的离线套件，**不碰真实 DSH 数据**（全部在临时目录里伪造一棵极小的 home）：

```bash
node _smoke/logic-smoke.mjs     # 宿主纯逻辑：磁盘契约 / header / 标题 / 计划 / 删除
node _smoke/image-smoke.mjs     # 图片管理纯逻辑：路径安全 / 附件对象 / 会话模型 / 摘除计划 / 引用扫描 / 删盘
node _smoke/client-smoke.mjs    # 浏览器侧纯逻辑：id 别名合并 / 级联 / 页签四段注册 / 图片选择
node _smoke/host-smoke.mjs      # 宿主半 index.js：路由 + 顺序契约 + 图片摘除 + 卸载重载往返
node _smoke/real-inventory.mjs  # 对真实主目录的**只读**审计（只算路径，绝不删除）
node _smoke/real-image-audit.mjs # 对真实日志的**只读**图片审计（seq↔位置 反查 + 选点演练）
```

`host-smoke` 会把 `index.js` 读成文本、把 `@deepseek-ai/schemastery` 换成 data: URL 里的桩、
把 `./lib/logic.js` 与 `./lib/image-logic.js` 指到真实逻辑层，再 import 改写后的源码 ——
所以**无需 `npm install`**，在裸仓库里也能跑宿主半（`index.js` 的 schemastery 是 DSH 提供的
peer 依赖，本插件绝不自带副本）。它还会从本机 `app.asar` 里读出**本体真实的**
`imageOffloadProjection`，用它来验收我们写的事件（而不是自己给自己打分）。

覆盖范围（完整清单见 [`TEST-LIST.md`](TEST-LIST.md)）：

- **磁盘契约**：`session-<uuid>` 目录 / 裸 `<uuid>` 目录 / 老版单文件 / 明文 `.jsonl` / 投影缓存与 `.bak` / `encodeSegment` 往返
- **header 与标题**：zstd 拼接帧里读 header（id / cwd / 父子 / `origin`）、多帧日志里找 `session/title`、坏帧不抛
- **元数据**：标题、`cwd`、`lastPromptAt`、子 agent 身份（含「空对象不是子 agent」的回归）、父 id 的文本形态
- **计划与删除**：两种 id 写法命中同一批路径；预演不动盘也不动归档；真删只删该删的；`keepProjCache` 生效；
  不存在的 id 算成功且 0 路径并标 `emptyDisk`；批量里混入非法 id 不影响其它条目；非数组入参不抛
- **顺序契约**：删除路由归档时代替 registry 会断言「此刻文件还在」，并检查 `stopActivity: true`；
  归档失败 / 宿主没有 registry 时如实上报且**不阻断**删盘；图片摘除是「先摘除、后删盘」
- **安全**：`../../evil` / `..` / 空串 / `null` / 少一位 / 畸形前缀 一律拒绝；同前缀不同目录（`C:\a` vs `C:\ab`）不算在内；逃逸路径不算在内
- **客户端纯逻辑**：磁盘口径与列表快照按 id 别名合并（跨 `session-` 前缀）、`仅磁盘` 标记、`blank` 占位行过滤、
  标题回退链、跨写法的父子建树与三种级联、体积格式化、`t()` 占位替换
- **图片管理**：折叠规范化（拉平 `..`、大小写、尾分隔符、盘根保留）；系统区**连子路径一起挡**；用户主目录放行；
  附件对象内容摘要复核；**会话模型（`seq` ↔ 位置）**与工件夹具里故意错位；摘除计划的逐条校验与幂等；
  全库引用扫描（无 image 块的 `meta.path` 不进候选）；删盘计划与执行（共享跳过、删前复核、真正落盘）；
  右侧栏页签四段注册与降级路径；`最早 N 张` / `除最近 N 张外全部` / 筛选 / 选择收缩

---

## 架构

```
dsh-delete/
├── package.json         dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml     - insert: { id: dsh-delete, name: dsh-delete }
├── index.js             宿主半：Config schema + 6 条 exact 路由（会话 2 条 + 图片 4 条）
├── lib/logic.js         会话纯逻辑：id 编解码 / header 与标题读取 / 盘点 / 路径安全 / 删除
├── lib/image-logic.js   图片纯逻辑：日志读取 / 会话模型(seq↔位置) / 盘点 / 摘除计划 / 引用扫描 / 删盘三道闸
├── client.js            浏览器半：侧边栏入口 + 会话面板 + 右侧栏「图片管理」页签
├── TEST-LIST.md         测试列表（按全局约定只在被要求时全跑）
└── _smoke/              离线测试（logic / image / client / host / real-inventory / real-image-audit）
```

### 宿主半（`index.js`）

- **六条 exact 路由**，都挂在 `/plugins/dsh-delete` 下：

  | 路由 | 作用 |
  |---|---|
  | `GET /plugins/dsh-delete/inventory` | 扫磁盘，返回每个会话的路径、体积、权威元数据，以及归档能力 |
  | `POST /plugins/dsh-delete/delete` | body `{ids, dryRun}`：**先归档、再落盘删除**，逐条回报 |
  | `GET /plugins/dsh-delete/images?sessionId=&withPlan=` | 图片盘点：张数口径 + 每处出现位置（真实 seq / 图片序号 / 附件 id / 源文件路径 / 是否已摘除）+ 异常报告；`withPlan=1` 时顺带算好删盘计划 |
  | `POST /plugins/dsh-delete/images/offload` | body `{sessionId, items, deleteDisk, forceShared, dryRun}`：**先追加 `image/offload`，再落盘删除**，逐项回报 |
  | `GET /plugins/dsh-delete/image?attachment=sha256:…` | 原图预览（严格校验 id 形状，读前复核内容摘要） |
  | `GET /plugins/dsh-delete/thumb?attachment=sha256:…` | 缩略图（动态 `import('sharp')`，拿不到就退回原图） |

  | 路由 | 作用 |
  |---|---|
  | `GET /plugins/dsh-delete/inventory` | 扫磁盘，返回每个会话的路径、体积、权威元数据，以及归档能力 |
  | `POST /plugins/dsh-delete/delete` | body `{ids, dryRun}`：**先归档、再落盘删除**，逐条回报 |

  > **为什么必须是 `exact` 而不是 `prefix`**：DSH 的 web server 按最长前缀匹配，一个挂在
  > `/plugins/dsh-delete` 上的 prefix 会连本插件自己的客户端 bundle
  > （`/plugins/dsh-delete/client.js`）一起吃掉 —— 那个请求会命中本插件的 404，
  > bundle 永远物化不出来，入口也就永远不出现。

- **归档是可选注入**：`ctx.inject(['workspaceRegistry'], cb)` 动态探测（**不**写进 `inject` 声明，
  否则缺这个服务的宿主会把整条 fiber 停住）。拿不到就退化为「只删文件」，并在盘点/删除响应里如实报告
  `archiveCapable: false`，面板据此显示黄色提示。

- **设置声明**：`export const Config` 的四个字段全部 `.volatile()` —— `dsh-settings` 只投影 volatile 字段，
  没有 volatile 字段的条目会被整个跳过。读值走 `readField()`，因为 volatile 字段在 `apply(ctx, config)` 里给的是 `{ get() }` 引用而不是值。

### 浏览器半（`client.js`）

数据来自两条通道，各取所长，**按 id 别名（剥掉 `session-` 前缀后的 uuid）合并**：

- **会话列表快照**（`ctx.get('sessions').list.getSnapshot()`）—— 官方口径，提供
  `parentId` / `origin`（父子关系与类型）、`running`、`cwd`、持久标题 `title`、`displayTitle`。
- **宿主盘点路由** —— 磁盘口径，提供真实路径与字节数、header 里的权威元数据，以及「列表里已消失但文件还在」的残留会话。

行的 id 优先取**快照里的那个**：归档（`workspaceRegistry.sessionKnown()`）与删除都要求宿主认识这个字符串；
快照的 `title` → 磁盘标题 → 快照的 `displayTitle` → `cwd` 目录名 构成完整回退链，绝不把裸 id 当名字。
宿主路由返回归档结果后，面板把本次删掉的 id 标成 `已删除`、把 DSH 归档集合里的 id 标成 `已归档` ——
两者都让「宿主内存里还活着的会话」看起来不再像「没删掉」。

状态用一个挂在 `globalThis` 上的极小订阅式 store，而不是 React context：入口和面板由不同的 owner 挂载，两棵树都不归本插件控制；`globalThis` 缓存同时让客户端 HMR 重新求值 bundle 时复用同一份状态。卸载时（`ctx.effect` 的 disposer）会把 `globalThis.__dshDeleteCtx__` 与该 store **收回**（只在仍指向本实例时才删），不留悬空引用。

**图片管理**走另一条官方路径：`ctx.sidebarRightTabs.register(定义)` + `sidebar.right.pane.tab`（正文）+ `sidebar.right.pane.tab.title`（chip）+ 空态引导入口；四段全部挂在同一个 `owner.effect` 上，卸载时按注册逆序注销、重载可重新注册（`host-smoke` 里有这条往返断言）。

---

## 已知限制

- **运行中的会话会被停掉。** 归档走 `stopActivity: true`，正在跑的那一轮工作会被中止。删之前请自己在左侧栏确认。
- **归档失败时只删文件。** 若宿主没有 `workspaceRegistry`（或该会话已既不在内存也不在持久化里），
  文件仍会被删除，但左侧栏里的行可能要等 DSH 重启才消失 —— 响应与面板都会明确写出来。
- **会话删除不清理附件。** `<home>/attachments` 是内容寻址的，可能与其它会话共享，所以「删除会话」**一律不碰**它。
  要清理附件，用图片管理里那个**默认关闭**的复选框（它会先核全库引用，被别处引用的默认跳过）。
- **费用账本不清。** `cost-meter/ledger.json` 是全局账本，删除会话不会回填它。
- **`home` 自动探测**：优先 `DSH_HOME`，其次 `~/.dsh`，并检查该目录确实含 `sessions` 或 `storages`。
- **图片摘除不可逆、删盘不进回收站。** 这是本体的设计（标记不自动回归）与你选定的行为（直接删）。
  回读手段是占位文本里的只读路径。
- **派生缓存不删。** `<home>/cache/attachments/request-images/` 保持原样（无法可靠对应回附件 id；残留无害）。
- **图片面板只对活会话可写。** 冷会话 / 归档会话只读 —— 宿主内存里没有它，追加事件不会持久化。
- **单条消息的图片张数上限不由本插件负责。** 那是 `dsh-attachment-local.maxImagesPerMessage`（默认 20）。

---

## License

MIT
