/**
 * `dsh-delete` 宿主半 —— 会话删除的后端。
 *
 * 职责边界（刻意收窄）：
 *
 * 1. **盘点**：扫磁盘给出「每个会话在磁盘上的路径与体积」。会话列表面板需要
 *    「磁盘上还有什么」，而这件事只有宿主进程做得到（浏览器读不到任意路径）。
 *
 * 2. **删除**：真正落盘删除。这是全插件唯一具破坏性的动作，所以安全规则全部
 *    收敛在 `lib/logic.js` 里（id 必须合法 UUID + 每条路径复核在允许根内）。
 *
 * 客户端半只负责「选中哪些」，不碰文件系统。
 *
 * 路由用 `kind: 'exact'` 而不是 prefix：DSH 的 web server 按最长前缀匹配，
 * 一个挂在 `/plugins/dsh-delete` 上的 prefix 会连本插件自己的客户端 bundle
 * （`/plugins/dsh-delete/client.js`）一起吃掉，面板就永远挂不上去。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { deleteSessions, projCacheRoot, scanInventory, sessionsRoot } from './lib/logic.js'

/** 本插件的路由前缀。 */
const ROUTE = '/plugins/dsh-delete'

/** 请求体上限：会话 id 列表而已，1 MiB 绰绰有余。 */
const MAX_BODY = 1024 * 1024

/**
 * 解析后的 schemastery 是否支持 `.volatile()`。
 *
 * 与 dsh-bgm 同样的探测而不是假定：老副本没有这个方法，直接调用会在模块求值期
 * 抛错，把整个宿主半（连带路由）一起干掉。探测不到就退化成普通字段 —— 插件照常
 * 工作，只是设置页少一行，`apply` 里会明确记一条日志。
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

/** 读一个 apply 配置字段：活引用走 `get()`，普通值直接用。 */
function readField(config, key) {
  const value = config?.[key]
  return isLive(value) && typeof value.get === 'function' ? value.get() : value
}

/**
 * 定位 DSH 主目录。
 *
 * 优先 `DSH_HOME`，其次 `~/.dsh`；候选目录必须真的像 DSH 主目录
 * （含 sessions 或 storages）才被采用，否则退回第一个候选。
 * Config 里也留了 `home` 覆盖项，便于非标准布局。
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

/** 本插件的宿主配置。三个字段都可热改，所以设置页能直接改并即时生效。 */
export const Config = z.object({
  /** 总开关。关掉后客户端不再显示入口（路由仍在，便于排查）。 */
  enabled: live(z.boolean().default(true)),
  /** 删除前是否要二次确认（默认要）。 */
  confirmBeforeDelete: live(z.boolean().default(true)),
  /** 是否保留投影缓存 JSON（默认不保留，一并删掉）。 */
  keepProjCache: live(z.boolean().default(false)),
  /** 主目录覆盖；留空 = 自动探测（DSH_HOME → ~/.dsh）。 */
  home: live(z.string().default('')),
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
 * 兼容两种宿主形态：已解析好的 `req.body`，或原始流（标准 node:http 请求）。
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

/** 从 URL 查询串里兜底取 ids（`?ids=a,b,c`），供无法读 body 的宿主形态使用。 */
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

/** 组装盘点响应。 */
export function buildInventory(home, config) {
  const items = scanInventory(home)
  return {
    ok: true,
    enabled: readField(config, 'enabled') !== false,
    confirmBeforeDelete: readField(config, 'confirmBeforeDelete') !== false,
    keepProjCache: readField(config, 'keepProjCache') === true,
    home,
    roots: { sessions: sessionsRoot(home), projCache: projCacheRoot(home) },
    items,
  }
}

export const name = 'dsh-delete'

/** 只依赖 web server：没有它就没有浏览器通道。 */
export const inject = ['webServer']

export function apply(ctx, config) {
  if (!LIVE_CAPABLE) {
    ctx.logger?.warn?.(
      'dsh-delete: 解析到的 @deepseek-ai/schemastery 没有 .volatile()，设置页不会出现本插件的一行（面板与删除功能不受影响）。',
    )
  }

  const home = resolveHome(readField(config, 'home'))
  ctx.logger?.info?.(`dsh-delete: home = ${home}`)

  const server = ctx.webServer

  // GET /plugins/dsh-delete/inventory —— 会话盘点
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: `${ROUTE}/inventory`,
        handler: (req, res) => {
          try {
            sendJson(res, 200, buildInventory(home, config))
          } catch (error) {
            ctx.logger?.error?.('dsh-delete: inventory 失败', error)
            sendJson(res, 200, { ok: false, error: String(error?.message ?? error), items: [] })
          }
        },
      }),
    'dsh-delete: inventory route',
  )

  // POST /plugins/dsh-delete/delete —— 落盘删除（body: { ids, dryRun }）
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: `${ROUTE}/delete`,
        handler: (req, res) => {
          void (async () => {
            const body = await readBody(req)
            const ids = Array.isArray(body?.ids) ? body.ids : (idsFromQuery(req?.url) ?? [])
            const dryRun = body?.dryRun === true
            if (ids.length === 0) {
              sendJson(res, 200, { ok: false, error: 'NO_IDS', results: [] })
              return
            }
            const results = deleteSessions(home, ids, {
              dryRun,
              keepProjCache: readField(config, 'keepProjCache') === true,
            })
            const removedCount = results.reduce((n, r) => n + (r.removed?.length ?? 0), 0)
            ctx.logger?.info?.(
              `dsh-delete: ${dryRun ? '预演' : '删除'} ${ids.length} 个会话，` +
                `${dryRun ? '将移除' : '已移除'} ${removedCount} 条路径`,
            )
            sendJson(res, 200, { ok: true, dryRun, home, results })
          })().catch((error) => {
            ctx.logger?.error?.('dsh-delete: delete 路由失败', error)
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            else if (!res.writableEnded) res.destroy?.()
          })
        },
      }),
    'dsh-delete: delete route',
  )
}

/** 供离线测试使用；不属于插件契约。 */
export const internals = {
  ROUTE,
  readField,
  isLive,
  idsFromQuery,
  resolveHome,
  buildInventory,
  LIVE_CAPABLE,
}
