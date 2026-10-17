# 测试列表（dsh-delete）

> 按全局约定：**每次只测新增/修改部分**；只有在用户明确要求「全局测试」时才按本列表全跑，并只在用户要求「更新测试列表」时才改本文件。

零依赖、离线、**不碰真实 DSH 数据**（全部在临时目录里伪造一棵极小的 home）。

| 套件 | 命令 | 覆盖 |
|---|---|---|
| 宿主纯逻辑 | `node _smoke/logic-smoke.mjs` | 磁盘契约（会话目录名 = 会话 id、两种 id 写法、老版单文件、投影缓存与 `.bak`）、`encodeSegment` 往返、zstd 拼接帧读 header、标题回退链、盘点合并、删除计划与预演、`keepProjCache`、非法 id 拒绝 |
| 浏览器纯逻辑 | `node _smoke/client-smoke.mjs` | id 别名合并、`仅磁盘` 标记、标题回退链、父子建树与三种级联、体积格式化、`t()` 占位替换；**图片管理**：右侧栏页签四段注册与降级路径、纯选择逻辑（筛选 / 最早 N 张 / 除最近 N 张外全部 / 选择收缩 / 源文件徽标） |
| 宿主半路由 | `node _smoke/host-smoke.mjs` | 路由注册/注销、「先归档再删盘」顺序契约、归档失败不阻断、缺 registry 时如实上报；**图片管理**：images 盘点路由（真实 seq、异常报告、冷/活会话）、摘除路由（预演零副作用、追加事件形状、**用本体真实投影验收**、重复摘除被拒、冷会话 `NOT_LIVE`、跑着时 `SESSION_RUNNING`）、`image`/`thumb` 路由、**卸载→重载往返**（6 条 exact 路由全部注销后重新注册不抛错）、**先摘除后删盘**顺序契约（注入替代操作记录调用顺序） |
| **图片管理纯逻辑** | `node _smoke/image-smoke.mjs` | 见下 |
| 真实数据只读审计 | `node _smoke/real-inventory.mjs` | 对真实主目录**只读**盘点（只算路径，绝不删除） |
| **真实图片只读审计** | `node _smoke/real-image-audit.mjs` | 在真实日志上验证「真实 seq ↔ 位置」两套坐标的反查与选点演练，只读 |

## 第二轮修复新增的覆盖（活会话优先 / 异步读 / 跳过而非整批失败）

| 组 | 覆盖 | 在哪套 |
|---|---|---|
| 活会话优先 | `buildSessionModelFromSession`：用 `session.log` + `session.surface.nodes` 建模型（零 I/O）；没有内存日志时返回 `null` 退回读盘 | image-smoke |
| 异步读 | `readSessionEventsAsync` 与同步读**逐条等价**（行数、seq 序列、坏路径） | image-smoke |
| 引用索引缓存键 | `logsFingerprint` 稳定、日志集变化即失效、删回原状即恢复 | image-smoke |
| **活会话表面优先（真机 bug 回归）** | 活会话时 `source: live`、只盘点**当前表面**的图片；摘除时把「不在活表面」的项**跳过并注明 `NOT_ON_SURFACE`**、其余照常写入；全是不合法项 → `NOTHING_TO_OFFLOAD` + 逐条原因（而不再是一句 `APPEND_FAILED`） | host-smoke |
| 判定细分 | `judgeLiveItems`：`IMAGE_INDEX_MISSING` / `SEQ_GONE` / `NOT_ON_SURFACE` / `BAD_ITEM` 分类；同一项重复勾选只报一次 | host-smoke |
| 结果文案 | `offloadOutcome`：成功（含跳过项与删盘结果）、`NOTHING_TO_OFFLOAD`（说明原因）、失败（**必须带出宿主原始 `detail`**） | client-smoke |

## `image-smoke` 覆盖明细（第 1 步新增）

| 组 | 覆盖 |
|---|---|
| 路径安全 | 折叠规范化（拉平 `..`、大小写、尾分隔符、盘根保留）；系统区 **连子路径一起挡**（`C:\Windows\**`、`Program Files*`、`ProgramData`、`$Recycle.Bin`/`Recovery`/`EFI`、`<DSH_HOME>`、DSH 安装目录）；用户主目录（含 `AppData\Local\Temp`）放行；盘根 / UNC / 网络位置 / 相对路径 / 目录 / 符号链接 / 缺失文件各自拒绝 |
| 附件对象 | `sha256:<64hex>` → 磁盘路径；坏 id 与路径穿越形态不给路径；内容摘要与文件名不符时拒绝；缺失对象拒绝 |
| 日志读取 | zstd 拼接帧逐帧解压、明文 `.jsonl`、坏帧不抛、行序与 seq 对齐 |
| **会话模型（seq ↔ 位置）** | header 行排除在序号空间外（真机里它的 `seq` 与第一条事件撞号）、`seqToIndex` 空洞、`eventAtSeq` 按真实 seq 取事件；夹具故意让**位置 ≠ seq**，任何「拿 seq 当数组下标」的写法都会立刻测挂 |
| 盘点 | 表面节点、深度优先图片序号、已摘除的两种来源（`image/offload` 事件 / 投影标记）、合计口径（出现位置 / 仍在上下文 / 不同附件数）、缺省表面回退 |
| 摘除计划 | `targets` 用**真实事件 seq**；空勾选 / 越界 seq / 不在表面 / 非消息事件 / 不存在的图片序号 / 负数 / 非数字一律拒绝；同一条计划内重复勾选幂等 |
| 引用扫描 | 全库统计「被其它会话引用」与「只被当前会话引用」；**无 image 块的 `meta.path` 不进候选**（真实日志里 `.cpp` 之类也带 `meta.path`） |
| 磁盘删除 | 共享项跳过并标 `forceable`；独占项进入删除计划；`allowReferenced` 强制模式；实际落盘、共享文件不动、`reclaimedBytes`；重复执行不报假成功、按路径去重、原因分类正确 |
| 变体缓存 | `<home>/cache/attachments/request-images` 只计数不删除 |
