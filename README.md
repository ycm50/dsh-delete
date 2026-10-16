# dsh-delete

**DSH 会话删除插件** —— 在左侧栏底部加一个入口，打开一张多选面板，把会话**连同它在磁盘上的文件**一起删掉；支持按关系级联选中「子 agent」「团队成员」「整族」。

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
```

---

## 特性

| | |
|---|---|
| **侧边栏入口** | 挂在 `sidebar.footer.action`，与其它插件（费用/上下文）同一个动作区 |
| **多选删除** | 每行一个复选框，工具栏有全选 / 清空 |
| **可复选的级联** | 「选中子 agent」= 所有后代；「选中团队成员」= 同父的兄弟；「选中整族」= 上溯到根再带全部后代 |
| **磁盘口径** | 列表同时呈现「左侧栏看得见的」和「列表里已消失、但文件还在的残留会话」，后者标 `仅磁盘` |
| **体积与路径数** | 每行显示该会话在磁盘上占多少、由几条路径组成 |
| **二次确认** | 默认开启，确认条里给出「将移除 N 条路径 / 释放多少」 |
| **搜索与工作区过滤** | 多工作区时自动出现下拉 |
| **运行中提示** | 会话在跑时标 `运行中`（v0.1 只提示、不阻拦） |
| **不改本体** | 全部通过官方的插槽与 web server 通道，宿主与浏览器两半都是独立包 |

---

## 删除到底动了哪些文件

一个会话在磁盘上散落成两处（本插件**只**动这两处，其余一律不碰）：

| 路径 | 说明 |
|---|---|
| `<DSH_HOME>/sessions/<工作区>/session-<uuid>/` | 会话主体目录（内含 `session.v4.jsonl.zstd`）。兼容文件形态 `session-<uuid>.jsonl.zstd` |
| `<DSH_HOME>/storages/session_projcache/sessions/session-<uuid>.json` | 会话投影缓存。兼容老命名 `<uuid>.json` |

`<DSH_HOME>` 默认是 `~/.dsh`（也可用环境变量 `DSH_HOME`，或在设置里覆盖）。

**不动**的东西：附件（内容寻址、可能被多个会话共享）、费用账本 `cost-meter/ledger.json`、其它插件的数据。

### 两种「残留」形态（实测）

会话在磁盘上**并不总是**「目录 + 缓存」两件套。对本机真实数据做只读审计（148 个会话）：

- **3 个**是完整的：会话目录 + 投影缓存 = 2 条路径；
- **145 个**只剩投影缓存 —— 日志目录早已不存在（连它原来的工作区 `A:\Downloads\tell-shell` 都没了），
  却仍占着 38.4 MiB 的缓存 JSON。

这正是「删除工具必须看磁盘，而不能只看内存里的列表」的原因：这些残留会话在**左侧栏里根本不显示**，
只有扫盘才能发现并清掉。面板会给它们打上 `仅磁盘` 标记。

真实数据只读审计结果：148 个会话共解析出 **151 条待删路径**（3×2 + 145×1 = 151，逐条复核），
**越界 0 条**；非法 id（`../../evil` / `..` / 空串 / `C:\Windows` / `session-x` / `null`）**6/6 全部拒绝**。

---

## 安全规则

删除是全插件唯一具破坏性的动作，所以规则写在 `lib/logic.js` 的最前面，且**每条路径都要过两道闸**：

1. **会话 id 必须是标准 UUID 形状**（`8-4-4-4-12` 十六进制）。`../..`、空串、带前缀的串全部在入口被拒 —— 路径穿越不可能构造出来。
2. **每条待删路径都要 `insideRoot()` 复核**，必须真的落在 `<home>/sessions` 或 `<home>/storages/session_projcache/sessions` 之内；复核不过就丢弃，绝不执行。
3. 只删「名字以 `session-<id>` 开头」的条目，**不按目录名模糊匹配**，也没有任何通配删除。

> ⚠️ 删除**不可撤销**，不进回收站。删之前请确认选中项。

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

`cordis.patch.yml` **不需要手改**：本包自带一份（`dsh.bundle.patch` 会把它叠上去），里面就是一行 `insert: { id: dsh-delete, name: dsh-delete }`。

### 4. 重启 DSH

> **为什么必须重启**：客户端模块图是**启动时快照** —— `client-modules` 在启动时扫描
> loader 条目、组合客户端 bundle。宿主半改完刷新页面即可生效，但浏览器半要等重启
> 才会被组合进模块图。

重启后侧边栏底部就会出现 **🗑 会话管理**。

---

## 设置

`设置 → 插件配置 → dsh-delete` 三行（全部 `.volatile()`，改完即时生效，无需重启）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | 开 | 总开关。关掉后客户端不显示入口（路由仍在，便于排查） |
| `confirmBeforeDelete` | 开 | 删除前是否要二次确认 |
| `keepProjCache` | 关 | 保留投影缓存 JSON，只删会话主体 |

`home` 字段可在 `cordis.patch.yml` 里写死（非标准布局时才需要）。

---

## 测试

零依赖的离线套件，**不碰真实 DSH 数据**（全部在临时目录里伪造一棵极小的 home）：

```bash
node _smoke/logic-smoke.mjs     # 宿主逻辑：77 条断言
node _smoke/client-smoke.mjs    # 浏览器侧纯逻辑
```

**无需 `npm install`。** `index.js` 里的 `@deepseek-ai/schemastery` 是 DSH 提供的 peer 依赖
（本插件绝不自带副本），而 `lib/logic.js` 只用 `node:` 内置模块，所以逻辑测试可以完全脱离 DSH 运行。

覆盖范围：

- **盘点**：目录形态 / 文件形态 / 两种投影缓存命名 / 坏 JSON（仍进盘点但解析不出 meta）/ 无关文件不进盘点
- **元数据**：标题、`cwd`、`lastPromptAt`、子 agent 身份、父 id 的三种文本形态（带 `session-` 前缀、不带前缀、任意引号包裹）
- **计划与删除**：预演不动盘；真删只删该删的；`keepProjCache` 生效；不存在的 id 算成功且 0 路径；批量里混入非法 id 不影响其它条目；非数组入参不抛
- **安全**：`../../evil` / `..` / 空串 / `null` / 少一位 / 带前缀 一律拒绝；同前缀不同目录（`C:\a` vs `C:\ab`）不算在内；逃逸路径不算在内
- **客户端纯逻辑**：磁盘盘点与列表快照的合并（含 `仅磁盘` 标记、`blank` 占位行过滤）、父子建树、后代 / 兄弟 / 整族三种级联的集合运算、体积格式化、`t()` 占位替换

---

## 架构

```
dsh-delete/
├── package.json         dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml     - insert: { id: dsh-delete, name: dsh-delete }
├── index.js             宿主半：Config schema + inventory/delete 两条路由
├── lib/logic.js         纯逻辑：盘点 / 元数据解析 / 路径安全 / 删除（零依赖，可离线测）
├── client.js            浏览器半：侧边栏入口 + 多选面板
└── _smoke/              离线测试
```

### 宿主半（`index.js`）

- **两条 exact 路由**，都挂在 `/plugins/dsh-delete` 下：

  | 路由 | 作用 |
  |---|---|
  | `GET /plugins/dsh-delete/inventory` | 扫磁盘，返回每个会话的路径、体积、标题、父 id |
  | `POST /plugins/dsh-delete/delete` | body `{ids, dryRun}`，落盘删除并逐条回报 |

  > **为什么必须是 `exact` 而不是 `prefix`**：DSH 的 web server 按最长前缀匹配，一个挂在
  > `/plugins/dsh-delete` 上的 prefix 会连本插件自己的客户端 bundle
  > （`/plugins/dsh-delete/client.js`）一起吃掉 —— 那个请求会命中本插件的 404，
  > bundle 永远物化不出来，入口也就永远不出现。

- **设置声明**：`export const Config` 的三个字段全部 `.volatile()`。这是关键：
  `dsh-settings` 只投影 volatile 字段，没有 volatile 字段的条目会被整个跳过。
  读值走 `readField()`，因为 volatile 字段在 `apply(ctx, config)` 里给的是 `{ get() }` 引用而不是值。

### 浏览器半（`client.js`）

数据来自两条通道，各取所长：

- **会话列表快照**（`ctx.get('sessions').list.getSnapshot()`）——官方口径，提供
  `parentId`（父子关系的权威来源）、`running` / `completed`、`cwd`、标题。
- **宿主盘点路由** —— 磁盘口径，提供真实路径与字节数，以及"列表里已消失但文件还在"的残留会话。

两边的 id 取并集；血缘优先用快照的 `parentId`，缺失时退回磁盘 JSON 里从子 agent 提示文本解析出的父 id。

删除时**永远走宿主路由落盘**（这是"删掉磁盘文件"的唯一保证）；若宿主恰好暴露了原生的删除 / 刷新方法，则额外探测调用一次，让内存里的列表跟上。探测失败不影响落盘删除，面板会给一个「刷新页面」的兜底按钮。

状态用一个挂在 `globalThis` 上的极小订阅式 store，而不是 React context：入口和面板由不同的 owner 挂载，两棵树都不归本插件控制；`globalThis` 缓存同时让客户端 HMR 重新求值 bundle 时复用同一份状态。

---

## 已知限制（v0.1）

- **运行中的会话不阻拦。** 会标 `运行中`，但仍允许删除 —— 删掉正在写入的会话文件可能让那一轮跑挂。删之前请自己在左侧栏确认没有在跑的任务。
- **内存列表未必立刻消失。** 落盘删除后若宿主没有可用的原生刷新方法，左侧栏可能仍显示已删除的会话；面板会给出「刷新页面」按钮。文件本身确实已经删掉了（可在同一面板重新「刷新」验证）。
- **附件不清理。** `<home>/attachments` 是内容寻址的，可能与其它会话共享，故一律不碰。
- **费用账本不清。** `cost-meter/ledger.json` 是全局账本，删除会话不会回填它。
- **`home` 自动探测**：优先 `DSH_HOME`，其次 `~/.dsh`，并检查该目录确实含 `sessions` 或 `storages`。

---

## License

MIT
