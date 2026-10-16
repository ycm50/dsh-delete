/**
 * `dsh-delete` 的纯逻辑层 —— 零依赖（只用 node: 内置模块），因此能脱离 DSH 直接离线测试。
 *
 * 这一层只做两件事，全部以 `home`（DSH 主目录）为入参、不读全局状态：
 *
 *   1. **盘点**：扫磁盘，列出「每个会话在磁盘上占用了哪些路径、多大、标题是什么」。
 *      数据源是会话目录本身，而不是内存里的会话列表 —— 删除工具必须看见
 *      「内存里已经不显示、但文件还在」的残留会话，否则永远清不干净。
 *
 *   2. **删除**：给定会话 id，解析出该删的路径并删除。
 *
 * 安全边界（这是本插件唯一真正危险的地方，所以规则写在最前面）：
 *   - 会话 id 必须是标准 UUID 形状，否则一律拒绝 —— 这样 `../..` 之类
 *     不可能构造出来，路径穿越在入口就被堵死。
 *   - 每一条待删路径都要通过 `insideRoot()` 复核，必须真的落在 sessions 根
 *     或 projcache 根之内；复核不通过就丢弃。
 *   - 只删「名字以 `session-<id>` 开头」的条目，绝不按目录名模糊匹配。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 标准会话 id：8-4-4-4-12 的十六进制 UUID。 */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 磁盘上会话条目的名字前缀。 */
export const SESSION_PREFIX = 'session-'

/**
 * 磁盘条目名 → 会话 id。
 * 兼容两种布局：
 *   - 目录 `session-<uuid>`（内含 session.v4.jsonl.zstd）
 *   - 文件 `session-<uuid>.jsonl.zstd` / `session-<uuid>.json`
 */
export const NAME_TO_ID_RE =
  /^session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[^/\\]*)?$/i

/** 该字符串是否是一个合法的会话 id。 */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value.trim())
}

/**
 * `target` 是否落在 `root` 之内（含 root 自身）。
 * 删除前对每条路径复核用它 —— 这是路径穿越的第二道闸。
 */
export function insideRoot(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r) return true
  return t.startsWith(r.endsWith(sep) ? r : r + sep)
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function fileSize(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/** 目录总字节数（递归；读不到的条目计 0，不抛）。 */
export function dirBytes(dir) {
  let total = 0
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry)
    if (isDir(full)) total += dirBytes(full)
    else total += fileSize(full)
  }
  return total
}

/** 会话目录根：<home>/sessions */
export function sessionsRoot(home) {
  return join(resolve(home), 'sessions')
}

/** 会话投影缓存根：<home>/storages/session_projcache/sessions */
export function projCacheRoot(home) {
  return join(resolve(home), 'storages', 'session_projcache', 'sessions')
}

/**
 * 从一个投影缓存 JSON 里抽出可用的会话元数据。
 *
 * 这些 JSON 是「按行投影」的快照（`{version, record:{identity, rows}}`），
 * 每一行形如 `{ver, seq, val}`。这里只取稳定、有用的几项：
 *   - identity.cwd / identity.createdAt
 *   - rows.title.val                       → 会话标题
 *   - rows.subagent.val                    → 本会话自己是子 agent（mode/label）
 *   - rows.sessionListMetadata.val         → blank / lastPromptAt
 *   - rows.titleInput.val.first.text       → 子 agent 的首条提示里显式写着父 id
 *
 * 任何一项缺失或类型不对都只是不填，绝不抛 —— 坏 JSON 不该让整个面板打不开。
 */
export function readProjectionMeta(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const record = json?.record
  if (record === null || typeof record !== 'object') return null
  const identity = record.identity ?? {}
  const rows = record.rows ?? {}
  const out = {}

  if (typeof identity.cwd === 'string' && identity.cwd !== '') out.cwd = identity.cwd
  if (typeof identity.createdAt === 'number') out.createdAt = identity.createdAt

  const title = rows?.title?.val
  if (typeof title === 'string' && title !== '') out.title = title

  const sub = rows?.subagent?.val
  if (sub !== null && typeof sub === 'object') {
    out.isSubagent = true
    const mode = sub.identity?.mode
    if (typeof mode === 'string') out.subagentMode = mode
    const label = sub.identity?.label
    if (typeof label === 'string' && label !== '') out.subagentLabel = label
  }

  const listMeta = rows?.sessionListMetadata?.val
  if (listMeta !== null && typeof listMeta === 'object') {
    out.blank = listMeta.blank === true
    if (typeof listMeta.lastPromptAt === 'number') out.lastPromptAt = listMeta.lastPromptAt
  }

  // 子 agent 的派发提示里必然出现父会话 id：
  //   Your parent agent id is "session-<uuid>".
  // 这是磁盘侧唯一能拿到父子关系的地方（会话列表快照才有 parentId 字段）。
  // 三种形态都认：带 session- 前缀（现网形态）、不带前缀（老版本/变体）、
  // 以及任意位置出现的引号包裹的 session-<uuid>。
  const firstText = rows?.titleInput?.val?.first?.text
  if (typeof firstText === 'string' && firstText !== '') {
    const m =
      /agent id is\s*["']?session-([0-9a-f-]{36})["']?/i.exec(firstText) ??
      /agent id is\s*["']?([0-9a-f-]{36})["']?/i.exec(firstText) ??
      /["']session-([0-9a-f-]{36})["']/i.exec(firstText)
    if (m !== null && isSessionId(m[1])) out.parentId = m[1].toLowerCase()
  }

  return out
}

/**
 * 盘点 <home> 下的全部会话。
 *
 * @returns 数组，每项：
 *   { id, bytes, dirs[], files[], projFiles[], workspaceSlug?, meta? }
 *   按「最近活动」降序（lastPromptAt ?? createdAt ?? 0）。
 */
export function scanInventory(home) {
  const items = new Map()
  const bump = (id) => {
    let rec = items.get(id)
    if (rec === undefined) {
      rec = { id, bytes: 0, dirs: [], files: [], projFiles: [] }
      items.set(id, rec)
    }
    return rec
  }

  // 1) 会话目录 / 会话文件
  const root = sessionsRoot(home)
  for (const workspaceSlug of safeReaddir(root)) {
    const wsPath = join(root, workspaceSlug)
    if (!isDir(wsPath)) continue
    for (const entry of safeReaddir(wsPath)) {
      const m = NAME_TO_ID_RE.exec(entry)
      if (m === null) continue
      const id = m[1].toLowerCase()
      const full = join(wsPath, entry)
      if (!insideRoot(root, full)) continue
      const rec = bump(id)
      rec.workspaceSlug = workspaceSlug
      if (isDir(full)) {
        rec.dirs.push(full)
        rec.bytes += dirBytes(full)
      } else {
        rec.files.push(full)
        rec.bytes += fileSize(full)
      }
    }
  }

  // 2) 投影缓存（两种命名：session-<uuid>.json 与 <uuid>.json 都见过）
  const pcRoot = projCacheRoot(home)
  for (const name of safeReaddir(pcRoot)) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const stem = name.slice(0, -'.json'.length)
    const id = (stem.toLowerCase().startsWith(SESSION_PREFIX) ? stem.slice(SESSION_PREFIX.length) : stem).toLowerCase()
    if (!isSessionId(id)) continue
    const full = join(pcRoot, name)
    if (!insideRoot(pcRoot, full)) continue
    const rec = bump(id)
    rec.projFiles.push(full)
    rec.bytes += fileSize(full)
    const meta = readProjectionMeta(full)
    if (meta !== null) rec.meta = { ...(rec.meta ?? {}), ...meta }
  }

  const stamp = (rec) => rec.meta?.lastPromptAt ?? rec.meta?.createdAt ?? 0
  return [...items.values()].sort((a, b) => stamp(b) - stamp(a))
}

/**
 * 解析「删掉这个会话需要动哪些路径」，不落任何改动。
 *
 * @returns { id, ok, error?, paths[] } —— ok=false 时 paths 为空。
 */
export function planRemoval(home, id) {
  const clean = typeof id === 'string' ? id.trim().toLowerCase() : ''
  if (!isSessionId(clean)) {
    return { id: String(id), ok: false, error: 'BAD_ID', paths: [] }
  }
  const paths = new Set()

  const root = sessionsRoot(home)
  for (const workspaceSlug of safeReaddir(root)) {
    const wsPath = join(root, workspaceSlug)
    if (!isDir(wsPath)) continue
    for (const entry of safeReaddir(wsPath)) {
      const m = NAME_TO_ID_RE.exec(entry)
      if (m === null || m[1].toLowerCase() !== clean) continue
      const full = join(wsPath, entry)
      if (insideRoot(root, full)) paths.add(full)
    }
  }

  const pcRoot = projCacheRoot(home)
  for (const name of [`${SESSION_PREFIX}${clean}.json`, `${clean}.json`]) {
    const full = join(pcRoot, name)
    if (existsSync(full) && insideRoot(pcRoot, full)) paths.add(full)
  }

  return { id: clean, ok: true, paths: [...paths] }
}

/**
 * 删除一批会话。
 *
 * @param home  DSH 主目录
 * @param ids   会话 id 数组（非数组/非法项会被逐条拒绝，不影响其余）
 * @param opts  { dryRun?:boolean, keepProjCache?:boolean }
 * @returns 每条：{ id, ok, dryRun?, paths[] | removed[], failed[] }
 */
export function deleteSessions(home, ids, opts = {}) {
  const { dryRun = false, keepProjCache = false } = opts
  const list = Array.isArray(ids) ? ids : []
  const pcRoot = projCacheRoot(home)
  const results = []

  for (const id of list) {
    const plan = planRemoval(home, id)
    if (!plan.ok) {
      results.push(plan)
      continue
    }
    const paths = keepProjCache ? plan.paths.filter((p) => !insideRoot(pcRoot, p)) : plan.paths
    if (dryRun) {
      results.push({ id: plan.id, ok: true, dryRun: true, paths })
      continue
    }
    const removed = []
    const failed = []
    for (const p of paths) {
      // 双重复核：即便 planRemoval 已经查过，删除前再确认一次自己仍在允许的根内。
      const allowed = insideRoot(sessionsRoot(home), p) || insideRoot(pcRoot, p)
      if (!allowed) {
        failed.push({ path: p, error: 'OUTSIDE_ROOT' })
        continue
      }
      try {
        rmSync(p, { recursive: true, force: true })
        removed.push(p)
      } catch (error) {
        failed.push({ path: p, error: String(error?.message ?? error) })
      }
    }
    results.push({ id: plan.id, ok: failed.length === 0, removed, failed })
  }

  return results
}
