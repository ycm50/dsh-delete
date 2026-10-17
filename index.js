/**
 * dsh-delete 宿主半 —— 会话删除的后端。
 *
 * 职责边界（刻意收窄）：
 *
 * 1. **盘点**：扫磁盘给出「每个会话在磁盘上的路径与体积」。会话列表面板需要
 *    「磁盘上还有什么」，而这件事只有宿主进程做得到（浏览器读不到任意路径）。
 *
 * 2. **归档 + 删除**：真正落盘删除。这是全插件唯一具破坏性的动作，所以安全规则
 *    全部收敛在 lib/logic.js 里（id 必须合法 UUID + 每条路径复核在允许根内）。
 *
 *    为什么删除前必须先归档？因为 DSH 的会话列表是「磁盘上的会话 ∪ 宿主内存里
 *    活着的会话」的并集（见 dsh-session-query 的 SessionCorpus.listSessions）。
 *    只删文件的话，一个还在宿主内存里的会话会继续出现在左侧栏里，看起来像
 *    「删不掉」；而文件一旦删掉，官方归档入口就会以「找不到该会话」拒绝，
 *    于是那条幽灵行再也清不掉。官方给插件的正确顺序是：
 *        archiveSession(id, { stopActivity: true })  →  再删磁盘文件
 *    归档 = 从所有分组界面隐藏（可被用户 unarchive 撤销），且归档本身不带磁盘副作用。
 *
 * 3. 客户端半只负责「选中哪些」，不碰文件系统。
 *
 * 路由用 kind: 'exact' 而不是 prefix：DSH 的 web server 按最长前缀匹配，
 * 一个挂在 /plugins/dsh-delete 上的 prefix 会连本插件自己的客户端 bundle
 * （/plugins/dsh-delete/client.js）一起吃掉，面板就永远挂不上去。
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { deleteSessions, projCacheRoot, scanInventory, sessionsRoot } from './lib/logic.js'
import {
  buildOffloadEvent,
  buildSessionModel,
  buildSessionModelFromSession,
  classifyAttachmentObject,
  countVariantFiles,
  DEFAULT_SCAN_CONCURRENCY,
  executeDiskDeletion,
  inventoryOccurrences,
  listSessionLogs,
  logsFingerprint,
  planDiskDeletion,
  planOffload,
  readSessionEventsAsync,
  scanReferences,
  sessionIdOfLogPath,
} from './lib/image-logic.js'

/** 本插件的路由前缀。 */
const ROUTE = '/plugins/dsh-delete'

/** 请求体上限：会话 id 列表而已，1 MiB 绰绰有余。 */
const MAX_BODY = 1024 * 1024

/**
 * 解析后的 schemastery 是否支持 .volatile()。
 *
 * 与 dsh-bgm 同样的探测而不是假定：老副本没有这个方法，直接调用会在模块求值期
 * 抛错，把整个宿主半（连带路由）一起干掉。探测不到就退化成普通字段 —— 插件照常
 * 工作，只是设置页少一行，apply 里会明确记一条日志。
 */
const LIVE_CAPABLE = typeof z.boolean().volatile === 'function'

/** 标记一个字段为「可热改」；库不支持时原样返回。 */
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema
}

/** cosmokit 给 volatile 引用挂的全局符号（跨 ESM/CJS 副本识别同一引用）。 */
const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')

/** 该配置值是「活引用」而不是普通快照。 */
function isLive(value) {
  return typeof value === 'object' && value !== null && VOLATILE_REF in value
}

/** 读一个 apply 配置字段：活引用走 get()，普通值直接用。 */
function readField(config, key) {
  const value = config?.[key]
  return isLive(value) && typeof value.get === 'function' ? value.get() : value
}

/**
 * 定位 DSH 主目录。
 *
 * 优先 DSH_HOME，其次 ~/.dsh；候选目录必须真的像 DSH 主目录
 * （含 sessions 或 storages）才被采用，否则退回第一个候选。
 * Config 里也留了 home 覆盖项，便于非标准布局。
 */
export function resolveHome(override) {
  const list = []
  if (typeof override === 'string' && override.trim() !== '') list.push(override.trim())
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    list.push(process.env.DSH_HOME.trim())
  }
  list.push(join(homedir(), '.dsh'))
  const candidates = list.map((p) => resolve(p))
  for (const c of candidates) {
    if (existsSync(join(c, 'sessions')) || existsSync(join(c, 'storages'))) return c
  }
  return candidates[0]
}

/** 本插件的宿主配置。四个字段都可热改，所以设置页能直接改并即时生效。 */
export const Config = z.object({
  /** 总开关。关掉后客户端不再显示入口（路由仍在，便于排查）。 */
  enabled: live(z.boolean().default(true)),
  /** 删除前是否要二次确认（默认要）。 */
  confirmBeforeDelete: live(z.boolean().default(true)),
  /** 是否保留投影缓存 JSON（默认不保留，一并删掉）。 */
  keepProjCache: live(z.boolean().default(false)),
  /**
   * 删除前是否先让 DSH 归档该会话（默认要）。
   *
   * 这是「删干净」的关键一步：宿主内存里还活着的会话只删文件是删不掉的，
   * 它会一直挂在左侧栏里。归档让它在所有分组界面消失（stopActivity 顺带停掉
   * 正在跑的工作），且可被用户在界面里撤销。关掉后本插件退化为「只删文件」。
   */
  archiveOnDelete: live(z.boolean().default(true)),
  /** 主目录覆盖；留空 = 自动探测（DSH_HOME → ~/.dsh）。 */
  home: live(z.string().default('')),
  /** 图片管理面板总开关（只影响面板入口，路由仍在，便于排查）。 */
  imageManagerEnabled: live(z.boolean().default(true)),
  /** 摘除前是否要二次确认（默认要）。 */
  confirmBeforeOffload: live(z.boolean().default(true)),
  /**
   * 会话正在跑时是否禁止摘除（默认禁止）。
   *
   * 为什么默认禁止：本体自己会在路由报 `IMAGE_OFFLOAD_REQUIRED` 时**自动**摘除最旧的
   * 几张并重试。若我们也往同一个会话追加摘除记录，同一轮请求里可能互相踩到
   * 「索引已被摘除」。默认等这一轮结束再动手，安全且可解释。
   */
  blockOffloadWhileRunning: live(z.boolean().default(true)),
  /** 缩略图长边像素（仅影响面板显示，不改动任何存储内容）。 */
  thumbnailMaxEdge: live(z.number().step(1).min(16).default(192)),
})

/** 写一个 JSON 响应（不复用别人实现，避免假设 res 的能力）。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      res.statusCode = status
      res.setHeader?.('Content-Type', 'application/json; charset=utf-8')
      res.end(body)
    } catch {
      /* 连接已断：无可为 */
    }
  }
}

/**
 * 读请求体。
 * 兼容两种宿主形态：已解析好的 req.body，或原始流（标准 node:http 请求）。
 * 超过上限一律截断失败，避免被撑爆内存。
 */
function readBody(req) {
  return new Promise((resolveBody) => {
    const parsed = req?.body
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object' && typeof parsed.on !== 'function') {
      resolveBody(parsed)
      return
    }
    if (typeof req?.on !== 'function') {
      resolveBody(null)
      return
    }
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        finish(null)
        try {
          req.destroy?.()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        finish(null)
        return
      }
      try {
        finish(JSON.parse(text))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

/** 从 URL 查询串里兜底取 ids（?ids=a,b,c），供无法读 body 的宿主形态使用。 */
function idsFromQuery(url) {
  try {
    const q = new URL(url ?? '', 'http://localhost').searchParams.get('ids')
    if (q === null) return undefined
    return q
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
  } catch {
    return undefined
  }
}

/**
 * 定位 DSH 的 workspaceRegistry 服务。
 *
 * 采用「动态注入 + 探测」而不是写进 inject 声明：声明成必选会在缺这个服务的
 * 宿主上把整条 fiber 停住（连删除功能一起没了）；探测不到就退化为「只删文件」，
 * 并在响应里如实告诉客户端（archiveCapable: false）。
 */
function registryOf(owner) {
  if (owner === undefined || owner === null) return undefined
  const direct = owner.workspaceRegistry
  if (direct !== undefined && direct !== null) return direct
  if (typeof owner.get === 'function') {
    const viaGet = owner.get('workspaceRegistry')
    if (viaGet !== undefined && viaGet !== null) return viaGet
  }
  return undefined
}

/**
 * 从注入上下文里安全取一个服务（与 registryOf 同一套「动态注入 + 探测」范式）。
 * 拿不到就退化为「该能力不可用」，绝不让缺服务的宿主把整条 fiber 停住。
 */
function serviceAt(owner, key) {
  if (owner === undefined || owner === null) return undefined
  const direct = owner[key]
  if (direct !== undefined && direct !== null) return direct
  if (typeof owner.get === 'function') {
    const viaGet = owner.get(key)
    if (viaGet !== undefined && viaGet !== null) return viaGet
  }
  return undefined
}

/**
 * 归档一个会话：让 DSH 的所有分组界面立刻不再显示它。
 *
 * 必须在删磁盘文件之前调用 —— 归档要求该会话「活着或还在持久化里」，
 * 文件删掉之后就一定失败了（那时界面里会留下一条永远清不掉的幽灵行）。
 * stopActivity: true 让正在运行的工作停下来（正在跑的会话不允许静默归档），
 * 这正是「删除一个正在运行的会话」应有的语义。
 *
 * @returns { ok, error? } —— 失败只做记录，不阻断磁盘删除。
 */
async function archiveSession(registry, id) {
  if (registry === undefined || typeof registry.archiveSession !== 'function') {
    return { ok: false, error: 'NO_REGISTRY' }
  }
  try {
    await registry.archiveSession(id, { stopActivity: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 组装盘点响应。 */
export function buildInventory(home, config, capabilities = {}) {
  const items = scanInventory(home)
  return {
    ok: true,
    enabled: readField(config, 'enabled') !== false,
    confirmBeforeDelete: readField(config, 'confirmBeforeDelete') !== false,
    keepProjCache: readField(config, 'keepProjCache') === true,
    archiveOnDelete: readField(config, 'archiveOnDelete') !== false,
    archiveCapable: capabilities.archiveCapable === true,
    home,
    roots: { sessions: sessionsRoot(home), projCache: projCacheRoot(home) },
    items,
  }
}

export const name = 'dsh-delete'

/* ============================================================================
 * 图片管理（宿主半）
 *
 * 与「会话删除」共用同一个插件与同一套路由前缀，但**机制完全不同**，刻意分开：
 *
 *   - 摘除图片 = 追加一条 DSH 官方的 `image/offload` 事件（只读历史、只追加记录）。
 *     投影由随附基础组合里的 @deepseek-ai/dsh-compaction-image-offload 注册，
 *     我们**不重复注册**（重复注册会直接抛错）。
 *   - 删磁盘 = 真正不可恢复的破坏性动作，因此：源文件与附件对象两条通路各自过闸，
 *     删前全库核引用、逐项复核，绝不通配。
 *
 * ## 两套坐标必须分开（这一段是真机踩出来的）
 *
 * 真机日志里**位置 ≠ seq**：header 占一行且自身 seq 与第一条事件撞号，中途还可能有空洞。
 * 所以：
 *   - **读事件**按位置（`seqToIndex` → `events[position]`）；
 *   - **写 targets** 按真实 seq（本体投影要求 `targets[].seq` 是表面节点序号）。
 * 本文件绝不把 seq 当数组下标。
 * ==========================================================================*/

/** 会话 id → 磁盘日志文件（按目录名反解，两种 id 写法都认）。 */
export function sessionLogIndex(home) {
  const map = new Map()
  for (const entry of listSessionLogs(home)) {
    const id = sessionIdOfLogPath(home, entry.path)
    if (id !== '') map.set(id, entry.path)
  }
  return map
}

/** 从 id 别名里找出磁盘上的日志文件（session-<uuid> 与裸 <uuid> 视为同一会话）。 */
export function findSessionLogFor(home, id) {
  const clean = typeof id === 'string' ? id.trim() : ''
  if (clean === '') return ''
  const index = sessionLogIndex(home)
  if (index.has(clean)) return index.get(clean)
  const bare = clean.toLowerCase().startsWith('session-') ? clean.slice('session-'.length) : clean
  if (index.has(bare)) return index.get(bare)
  if (index.has('session-' + bare)) return index.get('session-' + bare)
  return ''
}

/** 从查询串取参数（只用于简单只读路由；body 解析另有 readBody）。 */
function queryOf(req) {
  try {
    return new URL(req?.url ?? '', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** 两个会话 id 是否指向同一个会话（`session-<uuid>` 与裸 `<uuid>` 视为同一个）。 */
export function sameSessionId(a, b) {
  const bare = (value) => {
    const s = String(value ?? '').trim().toLowerCase()
    return s.startsWith('session-') ? s.slice('session-'.length) : s
  }
  const left = bare(a)
  const right = bare(b)
  return left !== '' && left === right
}

/** 每个 fiber 一份的缓存壳（插件卸载即随之消失，不留模块级状态）。 */
export function createImageCache() {
  return { models: new Map(), refs: new Map() }
}

/** 简单 LRU：超过上限就丢最早插入的那条。 */
function trimMap(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value
    map.delete(oldest)
  }
}

/**
 * 冷会话：异步读盘并建模型，按「路径|字节|mtime」缓存。
 * 日志没变时重复调用是纯内存命中 —— 这正是面板轮询不再拖慢宿主的原因。
 */
async function loadDiskModel(file, cache) {
  let stamp = ''
  try {
    const info = statSync(file)
    stamp = file + '|' + String(info.size) + '|' + String(Math.floor(info.mtimeMs))
  } catch {
    return null
  }
  const hit = cache?.models?.get(stamp)
  if (hit !== undefined) return hit
  const events = await readSessionEventsAsync(file)
  if (events.length === 0) return null
  const model = buildSessionModel(events)
  if (cache?.models !== undefined) {
    cache.models.set(stamp, model)
    trimMap(cache.models, 8)
  }
  return model
}

/**
 * 读一个会话的图片盘点。
 *
 * **活会话优先，冷会话才读盘**（实测踩出来的两条理由）：
 *   1. 一致性：本体追加 `image/offload` 时按 `session.surface.nodes` 校验目标 seq；
 *      磁盘日志里的表面可能已经不同（压缩 `replace` 移出旧节点），于是从磁盘算出的
 *      选点会被本体拒绝。活会话的 `log` + `surface.nodes` 就是本体正在用的那一份。
 *   2. 开销：读盘一次要解压 232 ms + parse 163 ms，全是同步阻塞；活会话零 I/O。
 * 冷会话仍然读盘（异步 + 按 `大小/修改时间` 缓存），保证「列表能看到张数」。
 */
export async function readSessionImages(home, sessionId, sessions, cache) {
  const live = sessions?.get?.(sessionId) ?? undefined

  // ① 活会话：直接用内存日志与当前表面，零磁盘 I/O
  const liveModel = buildSessionModelFromSession(live)
  if (liveModel !== null) {
    const inventory = inventoryOccurrences(liveModel)
    return {
      ok: true,
      sessionId,
      file: '',
      source: 'live',
      live: true,
      cwd: typeof live?.header?.cwd === 'string' ? live.header.cwd : '',
      events: liveModel.events.length,
      model: liveModel,
      ...inventory,
    }
  }

  // ② 冷会话：读磁盘日志（异步；按指纹缓存）
  const file = findSessionLogFor(home, sessionId)
  if (file === '') {
    return { ok: false, error: 'SESSION_LOG_NOT_FOUND', sessionId, live: live !== undefined }
  }
  const model = await loadDiskModel(file, cache)
  if (model === null) {
    return { ok: false, error: 'SESSION_LOG_UNREADABLE', sessionId, live: live !== undefined }
  }
  const inventory = inventoryOccurrences(model)
  // header 行里的 cwd 就是该会话的工作区根，用于把源文件标成「工作区内 / 外」。
  const header = model.events.find((event) => event?.type === 'session')
  return {
    ok: true,
    sessionId,
    file,
    source: 'disk',
    live: live !== undefined,
    cwd: typeof header?.cwd === 'string' ? header.cwd : '',
    events: model.events.length,
    model,
    ...inventory,
  }
}

/** 图片预览/缩略图的响应（读附件对象；`thumb` 用 sharp 降采样，拿不到就原图）。 */
async function serveAttachmentImage(res, home, attachmentId, options = {}) {
  const verdict = classifyAttachmentObject(home, attachmentId)
  if (!verdict.ok) {
    sendJson(res, verdict.reason === 'MISSING' ? 404 : 409, { ok: false, error: verdict.reason })
    return
  }
  let data
  try {
    data = await readFileBytes(verdict.path)
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    return
  }

  const maxEdge = options.maxEdge ?? 0
  const mediaType = options.mediaType || 'application/octet-stream'
  if (maxEdge > 0 && options.thumbnail !== false) {
    const shrunk = await shrinkPng(data, maxEdge)
    if (shrunk !== null) {
      sendBinary(res, 200, shrunk.data, shrunk.mediaType, options.etag)
      return
    }
  }
  sendBinary(res, 200, data, mediaType, options.etag)
}

/** 读文件字节（用 fs/promises，避免把大图同步读进事件循环）。 */
async function readFileBytes(file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file)
}

/** 发二进制响应。 */
function sendBinary(res, status, data, mediaType, etag) {
  try {
    res.writeHead(status, {
      'Content-Type': mediaType || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=86400, immutable',
      ...(typeof etag === 'string' && etag !== '' ? { ETag: etag } : {}),
    })
    res.end(data)
  } catch {
    try {
      res.statusCode = status
      res.setHeader?.('Content-Type', mediaType || 'application/octet-stream')
      res.end(data)
    } catch {
      /* 连接已断：无可为 */
    }
  }
}

/**
 * 用 sharp 把图片缩到长边 maxEdge（webp 输出）。
 * 宿主没带 sharp、或图片解不开时返回 null —— 调用方退回原图，绝不因此报错。
 */
async function shrinkPng(data, maxEdge) {
  try {
    const loaded = await import('sharp')
    const sharp = loaded.default ?? loaded
    const out = await sharp(data, { failOn: 'none' })
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
    return { data: out, mediaType: 'image/webp' }
  } catch {
    return null
  }
}

/** 从附件 id 推 mediaType（未知就按 octet-stream，由浏览器嗅探）。 */
function mediaTypeOfAttachment(home, attachmentId) {
  const verdict = classifyAttachmentObject(home, attachmentId)
  return verdict.ok ? 'image/webp' : ''
}

/** 只依赖 web server：没有它就没有浏览器通道。 */
export const inject = ['webServer']

export function apply(ctx, config) {
  if (!LIVE_CAPABLE) {
    ctx.logger?.warn?.(
      'dsh-delete: 解析到的 @deepseek-ai/schemastery 没有 .volatile()，设置页不会出现本插件的一行（面板与删除功能不受影响）。',
    )
  }

  const home = resolveHome(readField(config, 'home'))
  ctx.logger?.info?.('dsh-delete: home = ' + home)

  /** 每个 fiber 一份的缓存（模型 + 引用索引）；插件卸载即随之消失。 */
  const cache = createImageCache()

  const server = ctx.webServer

  // 可选的 workspaceRegistry：拿到它才能在删除前归档（见文件头的说明）。
  let registry
  try {
    ctx.inject(['workspaceRegistry'], (owner) => {
      const found = registryOf(owner)
      if (found === undefined) return
      registry = found
      ctx.effect(
        () => () => {
          if (registry === found) registry = undefined
        },
        'dsh-delete: workspaceRegistry binding',
      )
      ctx.logger?.info?.('dsh-delete: 已绑定 workspaceRegistry，删除前会先归档会话')
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-delete: workspaceRegistry 注入失败，将只删磁盘文件：' + String(error?.message ?? error))
  }

  // 可选的 sessions：拿到它才能把 image/offload 追加进**活会话**（冷会话写不进去）。
  let sessions
  try {
    ctx.inject(['sessions'], (owner) => {
      const found = serviceAt(owner, 'sessions')
      if (found === undefined) return
      sessions = found
      ctx.effect(
        () => () => {
          if (sessions === found) sessions = undefined
        },
        'dsh-delete: sessions binding',
      )
      ctx.logger?.info?.('dsh-delete: 已绑定 sessions，可对活会话追加 image/offload')
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-delete: sessions 注入失败，图片摘除将不可用：' + String(error?.message ?? error))
  }

  // 可选的 agents：用来判断会话是否正在跑（跑着时默认不摘除，见 blockOffloadWhileRunning）。
  let agents
  try {
    ctx.inject(['agents'], (owner) => {
      const found = serviceAt(owner, 'agents')
      if (found === undefined) return
      agents = found
      ctx.effect(
        () => () => {
          if (agents === found) agents = undefined
        },
        'dsh-delete: agents binding',
      )
    })
  } catch {
    /* 没有 agents 也能工作：只是无法判断「正在跑」 */
  }

  // GET /plugins/dsh-delete/inventory —— 会话盘点
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: ROUTE + '/inventory',
        handler: (req, res) => {
          try {
            sendJson(res, 200, buildInventory(home, config, { archiveCapable: registry !== undefined }))
          } catch (error) {
            ctx.logger?.error?.('dsh-delete: inventory 失败', error)
            sendJson(res, 200, { ok: false, error: String(error?.message ?? error), items: [] })
          }
        },
      }),
    'dsh-delete: inventory route',
  )

  // POST /plugins/dsh-delete/delete —— 先归档、再落盘删除（body: { ids, dryRun }）
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: ROUTE + '/delete',
        handler: (req, res) => {
          void (async () => {
            const body = await readBody(req)
            const ids = Array.isArray(body?.ids) ? body.ids : (idsFromQuery(req?.url) ?? [])
            const dryRun = body?.dryRun === true
            if (ids.length === 0) {
              sendJson(res, 200, { ok: false, error: 'NO_IDS', results: [] })
              return
            }

            const archiveWanted = readField(config, 'archiveOnDelete') !== false
            const registryNow = registry
            const archiveCapable = registryNow !== undefined
            // ⚠️ 顺序是契约的一部分：归档必须在删文件之前。文件一删，官方归档就会
            // 以「找不到该会话」失败，界面上那条行就再也清不掉了。
            const archives = []
            for (const id of ids) {
              archives.push(archiveWanted && !dryRun ? await archiveSession(registryNow, id) : { ok: false, error: 'SKIPPED' })
            }

            const results = deleteSessions(home, ids, {
              dryRun,
              keepProjCache: readField(config, 'keepProjCache') === true,
            })
            for (let i = 0; i < results.length; i += 1) {
              const archive = archives[i] ?? { ok: false, error: 'SKIPPED' }
              results[i].archived = archive.ok === true
              if (archive.ok !== true && archive.error !== 'SKIPPED') results[i].archiveError = archive.error
            }

            const removedCount = results.reduce((n, r) => n + (r.removed?.length ?? 0), 0)
            const archivedCount = results.filter((r) => r.archived === true).length
            ctx.logger?.info?.(
              'dsh-delete: ' +
                (dryRun ? '预演 ' : '') +
                '删除 ' +
                String(ids.length) +
                ' 个会话，' +
                (dryRun ? '将移除 ' : '已移除 ') +
                String(removedCount) +
                ' 条路径，归档 ' +
                String(archivedCount) +
                ' 个',
            )
            sendJson(res, 200, {
              ok: true,
              dryRun,
              home,
              archiveOnDelete: archiveWanted,
              archiveCapable,
              results,
            })
          })().catch((error) => {
            ctx.logger?.error?.('dsh-delete: delete 路由失败', error)
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            else if (!res.writableEnded) res.destroy?.()
          })
        },
      }),
    'dsh-delete: delete route',
  )

  /* ---------------------------------------------------------------- 图片管理 */

  // GET /plugins/dsh-delete/images?sessionId=… —— 图片盘点（张数 + 每处出现位置）
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: ROUTE + '/images',
        handler: (req, res) => {
          void (async () => {
            try {
            const query = queryOf(req)
            const sessionId = (query.get('sessionId') ?? '').trim()
            if (sessionId === '') {
              sendJson(res, 200, { ok: false, error: 'NO_SESSION_ID' })
              return
            }
            const view = await readSessionImages(home, sessionId, sessions, cache)
            if (view.ok !== true) {
              sendJson(res, 200, {
                ok: false,
                error: view.error,
                sessionId,
                live: view.live === true,
                imageManagerEnabled: readField(config, 'imageManagerEnabled') !== false,
              })
              return
            }
            const running = isSessionRunning(agents, sessionId)
            const blocked = readField(config, 'blockOffloadWhileRunning') === true
            // withPlan=1：顺带算好「删盘计划」（要扫全库核引用，所以默认不算，只在勾选时算）
            let diskPlan = null
            let refScanMeta = null
            if (query.get('withPlan') === '1') {
              const refs = await scanReferences(home, {
                concurrency: DEFAULT_SCAN_CONCURRENCY,
                isCurrent: (id) => sessions?.get?.(id) !== undefined,
              })
              diskPlan = slimPlan(
                planDiskDeletion(home, view.occurrences, refs, diskOptions(home, view.cwd)),
              )
              refScanMeta = { sessions: refs.sessions, elapsedMs: refs.elapsedMs }
            }
            sendJson(res, 200, {
              ok: true,
              sessionId,
              live: view.live,
              running,
              offloadAllowed: view.live === true && !(running && blocked),
              offloadBlockedReason:
                view.live !== true ? 'NOT_LIVE' : running && blocked ? 'SESSION_RUNNING' : '',
              imageManagerEnabled: readField(config, 'imageManagerEnabled') !== false,
              confirmBeforeOffload: readField(config, 'confirmBeforeOffload') !== false,
              blockOffloadWhileRunning: blocked,
              thumbnailMaxEdge: readField(config, 'thumbnailMaxEdge') ?? 192,
              cwd: view.cwd ?? '',
              source: view.source ?? 'disk',
              events: view.events,
              anomalies: view.model?.anomalies ?? {},
              totals: view.totals,
              items: view.occurrences,
              offloadEvents: view.offloadEvents,
              diskPlan,
              refScan: refScanMeta,
              variantCache: countVariantFiles(home),
            })
            } catch (error) {
              ctx.logger?.error?.('dsh-delete: images 路由失败', error)
              if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          })().catch((error) => {
            ctx.logger?.error?.('dsh-delete: images 路由失败', error)
            if (!res.headersSent && !res.writableEnded) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          })
        },
      }),
    'dsh-delete: images route',
  )

  // POST /plugins/dsh-delete/images/offload —— 摘除（可选同时删磁盘）
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: ROUTE + '/images/offload',
        handler: (req, res) => {
          void (async () => {
            const body = await readBody(req)
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
            const items = Array.isArray(body?.items) ? body.items : []
            const deleteDisk = body?.deleteDisk === true
            const forceShared = body?.forceShared === true
            const dryRun = body?.dryRun === true
            if (sessionId === '') {
              sendJson(res, 200, { ok: false, error: 'NO_SESSION_ID' })
              return
            }
            const report = await offloadSessionImages({
              home,
              config,
              sessions,
              agents,
              sessionId,
              items,
              deleteDisk,
              forceShared,
              dryRun,
              cache,
              logger: ctx.logger,
            })
            ctx.logger?.info?.(
              'dsh-delete: 图片' +
                (dryRun ? '预演 ' : '摘除 ') +
                sessionId +
                ' → ' +
                (report.ok ? String(report.offload?.count ?? 0) + ' 处' : String(report.error)) +
                (report.disk ? '，删盘 ' + String(report.disk.deleted?.length ?? 0) + ' 项' : ''),
            )
            sendJson(res, 200, report)
          })().catch((error) => {
            ctx.logger?.error?.('dsh-delete: images/offload 路由失败', error)
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            else if (!res.writableEnded) res.destroy?.()
          })
        },
      }),
    'dsh-delete: images offload route',
  )

  // GET /plugins/dsh-delete/image?attachment=sha256:… —— 原图预览
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: ROUTE + '/image',
        handler: (req, res) => {
          const attachmentId = (queryOf(req).get('attachment') ?? '').trim().toLowerCase()
          void serveAttachmentImage(res, home, attachmentId, {
            thumbnail: false,
            etag: '"' + attachmentId + '"',
          })
        },
      }),
    'dsh-delete: image route',
  )

  // GET /plugins/dsh-delete/thumb?attachment=sha256:… —— 缩略图（失败退回原图）
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: ROUTE + '/thumb',
        handler: (req, res) => {
          const attachmentId = (queryOf(req).get('attachment') ?? '').trim().toLowerCase()
          const maxEdge = Number(readField(config, 'thumbnailMaxEdge') ?? 192)
          void serveAttachmentImage(res, home, attachmentId, {
            maxEdge: Number.isSafeInteger(maxEdge) && maxEdge > 0 ? maxEdge : 192,
            mediaType: 'image/webp',
            etag: '"' + attachmentId + '-' + String(maxEdge) + '"',
          })
        },
      }),
    'dsh-delete: thumb route',
  )
}

/** 该会话是否正在跑一轮工作（拿不到 agents 时一律 false）。 */
function isSessionRunning(agents, sessionId) {
  if (agents === undefined || typeof agents.get !== 'function') return false
  try {
    const agent = agents.get(sessionId)
    if (agent === undefined || agent === null) return false
    if (typeof agent.running === 'boolean') return agent.running
    if (typeof agent.isRunning === 'function') return agent.isRunning() === true
    return agent.activity !== undefined
  } catch {
    return false
  }
}

/** 判定用的选项集（源文件与附件对象共用同一套 env / home / 工作区根）。 */
function diskOptions(home, workspaceRoot) {
  return {
    env: process.env,
    home,
    dshInstall: dshInstallRoot(),
    workspaceRoot: typeof workspaceRoot === 'string' ? workspaceRoot : '',
  }
}

/** DSH 本体安装目录（默认 A:\dsh；可用 DSH_INSTALL 覆盖）——删源文件时一并禁掉。 */
function dshInstallRoot() {
  const fromEnv = process.env.DSH_INSTALL
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return 'A:\\dsh'
}

/** 把计划裁成面板要的瘦身形状（不把内部字段全抛给浏览器）。 */
function slimPlan(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    kind: entry.kind,
    action: entry.action,
    path: entry.path,
    attachmentId: entry.attachmentId ?? '',
    reason: entry.reason ?? '',
    scope: entry.scope ?? '',
    risk: entry.risk ?? '',
    bytes: entry.bytes ?? 0,
    referencedBy: entry.referencedBy ?? [],
    forceable: entry.forceable === true,
    forced: entry.forced === true,
  }))
}

/** 把执行结果裁成面板要的瘦身形状。 */
function slimDiskReport(result) {
  return {
    deleted: result.deleted,
    skipped: result.skipped,
    failed: result.failed,
    reclaimedBytes: result.reclaimedBytes,
  }
}

/**
 * 摘除（可选同时删磁盘）的主流程。
 *
 * 顺序是契约的一部分：**先摘除（同步追加一条 image/offload）→ 再删盘**。
 * 理由是摘除可复盘、删盘不可恢复；先写记录再动手，任何一步失败都能如实上报。
 *
 * @returns 可直接 JSON 化的报告（不抛）。
 */
export async function offloadSessionImages(options) {
  const { home, config, sessions, agents, sessionId, items, deleteDisk, forceShared, dryRun, cache } = options

  // ① 必须能在宿主内存里找到这个会话：冷会话追加事件不持久化（SessionStore 是 in-memory）。
  const session = sessions?.get?.(sessionId)
  if (session === undefined || session === null || typeof session.append !== 'function') {
    return { ok: false, error: 'NOT_LIVE', sessionId, hint: '请先在界面上打开该会话，再摘除它的图片。' }
  }

  // ② 正在跑的一轮里不抢写（本体自己也会在超预算时自动摘除并重试）。
  const running = isSessionRunning(agents, sessionId)
  if (running && readField(config, 'blockOffloadWhileRunning') !== false) {
    return { ok: false, error: 'SESSION_RUNNING', sessionId, hint: '该会话正在跑，等这一轮结束后再试。' }
  }

  // ③ **按活会话复核**选点，并逐条给出结论（不合法就跳过，不让整批失败）。
  //
  //    这里是关键：本体追加时会用 `session.surface.nodes` 校验目标 seq。若我们拿磁盘
  //    日志算出的表面（压缩 replace 之后可能已不同）去写，本体就会拒绝整条事件，
  //    用户看到的就是「删了没反应」。所以判定必须与写入用同一份表面。
  const view = await readSessionImages(home, sessionId, sessions, cache)
  if (view.ok !== true) return { ok: false, error: view.error, sessionId }

  const model = buildSessionModelFromSession(session) ?? view.model
  const judged = judgeLiveItems(model, items)
  if (judged.accepted.length === 0) {
    return {
      ok: false,
      error: 'NOTHING_TO_OFFLOAD',
      sessionId,
      source: view.source,
      items: [],
      skippedItems: judged.skipped,
      hint: judged.skipped.length > 0 ? '选中的图片已不在当前上下文里（可能已被压缩替换或已摘除）。' : '没有选中任何图片。',
    }
  }

  const grouped = new Map()
  for (const item of judged.accepted) {
    const bucket = grouped.get(item.seq) ?? new Set()
    bucket.add(item.imageIndex)
    grouped.set(item.seq, bucket)
  }
  const targets = [...grouped.keys()].sort((a, b) => a - b).map((seq) => ({
    seq,
    imageIndexes: [...grouped.get(seq)].sort((a, b) => a - b),
  }))
  const eventData = buildOffloadEvent(targets)

  // ④ 删盘计划（需要时）：源文件 + 附件对象，各自过闸；被别处引用则默认跳过。
  let diskPlan = null
  let refScan = null
  if (deleteDisk === true) {
    refScan = await buildReferenceIndex(home, sessionId, sessions, cache)
    diskPlan = slimPlan(
      planDiskDeletion(home, judged.accepted, refScan, {
        ...diskOptions(home, view.cwd),
        allowReferenced: forceShared === true,
      }),
    )
  }

  const report = {
    ok: true,
    dryRun: dryRun === true,
    sessionId,
    source: view.source,
    offload: {
      targets: eventData.targets,
      count: judged.accepted.length,
      items: judged.accepted,
      skipped: judged.skipped,
      appended: false,
    },
  }
  if (diskPlan !== null) {
    report.disk = {
      planned: diskPlan,
      refScan: { sessions: refScan?.sessions ?? 0, elapsedMs: refScan?.elapsedMs ?? 0 },
      deleted: [],
      skipped: [],
      failed: [],
      reclaimedBytes: 0,
    }
  }
  if (dryRun === true) return report

  // ⑤ 真正追加：只此一处写会话，且是同步调用（中间没有 await，杜绝 TOCTOU）。
  try {
    session.append('image/offload', eventData)
    report.offload.appended = true
  } catch (error) {
    report.ok = false
    report.error = 'APPEND_FAILED'
    report.detail = String(error?.message ?? error)
    options.logger?.error?.('dsh-delete: image/offload 追加失败 —— ' + report.detail)
    return report
  }

  // 追加成功后把冷会话模型缓存丢掉：日志刚变，缓存键（大小/时间）可能还没更新到。
  if (cache?.models !== undefined) cache.models.clear()

  // ⑥ 落盘删除（在追加成功之后；删盘的失败不回滚摘除，如实上报）。
  if (diskPlan !== null) {
    const result = executeDiskDeletion(home, diskPlan, {
      ...diskOptions(home, view.cwd),
      // 离线测试可以注入替代操作，用来验证「先摘除、后删盘」的顺序而不真删文件。
      ...(options.ops !== undefined ? { ops: options.ops } : {}),
    })
    report.disk = { ...report.disk, ...slimDiskReport(result) }
  }
  return report
}

/**
 * 按**活会话模型**逐条判定用户勾选的出现位置。
 *
 * 与「本体追加时的校验」用同一份表面（`model.surfaceSeqs` 来自 `session.surface.nodes`），
 * 所以判定通过的项一定写得进去；判定不过的项**跳过并给出原因**，而不是让整批失败。
 *
 * @returns { accepted[], skipped[] }
 */
export function judgeLiveItems(model, items) {
  const list = Array.isArray(items) ? items : []
  const nodeSet = new Set(model?.surfaceSeqs ?? [])
  const { occurrences } = inventoryOccurrences(model)
  const byKey = new Map(occurrences.map((o) => [o.seq + ':' + o.imageIndex, o]))
  const accepted = []
  const skipped = []
  const seen = new Set()

  for (const item of list) {
    const seq = item?.seq
    const imageIndex = item?.imageIndex
    if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(imageIndex) || seq < 0 || imageIndex < 0) {
      skipped.push({ seq: seq ?? null, imageIndex: imageIndex ?? null, reason: 'BAD_ITEM' })
      continue
    }
    const key = seq + ':' + imageIndex
    if (seen.has(key)) continue // 幂等：同一条命令里重复勾选只算一次（合法与否都只报一次）
    seen.add(key)
    const hit = byKey.get(key)
    if (hit === undefined) {
      const known = model?.seqToIndex?.has(seq) === true
      const reason = !nodeSet.has(seq) ? (known ? 'NOT_ON_SURFACE' : 'SEQ_GONE') : 'IMAGE_INDEX_MISSING'
      skipped.push({ seq, imageIndex, reason })
      continue
    }
    if (hit.offloaded === true) {
      skipped.push({ seq, imageIndex, reason: 'ALREADY_OFFLOADED' })
      continue
    }
    accepted.push({
      seq,
      imageIndex,
      attachmentId: hit.attachmentId,
      bytes: hit.bytes,
      heldPath: hit.heldPath,
    })
  }
  return { accepted, skipped }
}

/**
 * 构建引用索引（全库扫一遍：附件 id 与源文件路径各被哪些会话引用）。
 *
 * 两条性能约定：
 *   - 扫描用**异步**读（同步版一次 400 ms，扫全库会把宿主堵住好几秒）；
 *   - 结果按「全部日志的 路径|大小|mtime 指纹」缓存，日志没变就不重扫。
 * 每次请求再按当前会话重算「别处引用」那一栏（缓存里存的是原样结果）。
 */
async function buildReferenceIndex(home, sessionId, sessions, cache) {
  let fingerprint = ''
  try {
    fingerprint = logsFingerprint(home)
  } catch {
    fingerprint = ''
  }
  let refs = fingerprint === '' ? undefined : cache?.refs?.get(fingerprint)
  if (refs === undefined) {
    refs = await scanReferences(home, { concurrency: DEFAULT_SCAN_CONCURRENCY })
    if (fingerprint !== '' && cache?.refs !== undefined) {
      cache.refs.set(fingerprint, refs)
      trimMap(cache.refs, 2)
    }
  }
  void sessions
  return refsView(refs, sessionId)
}

/** 把缓存的原始扫描结果投影成「针对某个当前会话」的视图。 */
function refsView(refs, sessionId) {
  const project = (map) => {
    const out = new Map()
    for (const [key, entry] of map ?? []) {
      const elsewhere = [...entry.sessions].filter((id) => id !== '' && !sameSessionId(id, sessionId))
      out.set(key, {
        sessions: entry.sessions,
        weight: entry.weight,
        elsewhere,
        currentOnly: elsewhere.length === 0,
      })
    }
    return out
  }
  return {
    sessions: refs?.sessions ?? 0,
    files: refs?.files ?? [],
    elapsedMs: refs?.elapsedMs ?? 0,
    attachments: project(refs?.attachments),
    sources: project(refs?.sources),
  }
}

/** 供离线测试使用；不属于插件契约。 */
export const internals = {
  ROUTE,
  readField,
  isLive,
  idsFromQuery,
  resolveHome,
  buildInventory,
  registryOf,
  archiveSession,
  LIVE_CAPABLE,
  // 图片管理（供离线测试）
  serviceAt,
  queryOf,
  sameSessionId,
  createImageCache,
  trimMap,
  loadDiskModel,
  sessionLogIndex,
  findSessionLogFor,
  readSessionImages,
  judgeLiveItems,
  isSessionRunning,
  diskOptions,
  dshInstallRoot,
  slimPlan,
  slimDiskReport,
  buildReferenceIndex,
  refsView,
  offloadSessionImages,
}
