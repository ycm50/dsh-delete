/**
 * dsh-delete 宿主半（index.js）的离线测试 —— 不装 DSH、不碰真实数据。
 *
 * 做法：把 index.js 读成文本，把它的两个外部依赖换成替身
 *   - @deepseek-ai/schemastery → 一个 data: URL 里的极简桩（无 volatile，验证降级）
 *   - ./lib/logic.js          → 真实的逻辑层（绝对的 file:// URL）
 * 然后把改写后的源码写进临时文件再 import，于是能在裸仓库里跑宿主半。
 *
 * 重点钉住的是**顺序契约**：删除路由必须「先归档、再删盘」。
 * 反过来（先删盘）会让官方归档以「找不到该会话」失败，宿主内存里那条会话就会
 * 永远挂在左侧栏 —— 这正是用户报的「你好 删不干净」。
 *
 * 运行：node _smoke/host-smoke.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

import { buildSessionModel } from '../lib/image-logic.js'

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
  ok(a === b, label + ' —— 期望 ' + b + '，实际 ' + a)
}

/** 内容的 sha256（hex）。 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 从本机 DSH 的 app.asar 里读**本体真实的** image/offload 投影定义。
 * 目的是用本体自己的验收逻辑来检验我们写的事件 —— 而不是自己给自己打分。
 * 读不到（没装 DSH / 版本不同）返回 null，调用方跳过这一条。
 */
async function loadNativeImageOffloadProjection() {
  try {
    const asar = 'A:\\dsh\\resources\\app.asar'
    if (!existsSync(asar)) return null
    const fd = readFileSync(asar)
    const headerSize = fd.readUInt32LE(12)
    const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString('utf8'))
    let node = header
    for (const part of [
      'files',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-compaction-image-offload',
      'lib',
      'types',
      'projection.js',
    ]) {
      node = node?.[part]
      if (node === undefined) return null
    }
    const body = fd.subarray(16 + headerSize + Number(node.offset), 16 + headerSize + Number(node.offset) + Number(node.size))
    const url = 'data:text/javascript;base64,' + body.toString('base64')
    const mod = await import(url)
    return mod.imageOffloadProjection ?? null
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 轮询到响应写完（宿主路由是 fire-and-forget 的 async）。 */
async function settle(res, timeoutMs) {
  const deadline = Date.now() + (timeoutMs ?? 2000)
  while (!res.writableEnded && Date.now() < deadline) await sleep(5)
  return res
}

// ------------------------------------------------- 把 index.js 装进测试环境

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const logicUrl = pathToFileURL(join(repo, 'lib', 'logic.js')).href
const imageLogicUrl = pathToFileURL(join(repo, 'lib', 'image-logic.js')).href

/** schemastery 替身：没有 .volatile()，用来验证「库不支持时也不能炸」。 */
const ZSTUB = 'data:text/javascript,' + encodeURIComponent(
  'function chain(){const api={default:()=>api,volatile:undefined};\n' +
  'for(const k of ["step","min","max","default","optional","readonly"])api[k]=()=>api;\n' +
  'return api}\n' +
  'const z={boolean:chain,string:chain,number:chain,object:(shape)=>shape}\n' +
  'export default z\n',
)

const source = readFileSync(join(repo, 'index.js'), 'utf8')
  .replace("import z from '@deepseek-ai/schemastery'", 'import z from ' + JSON.stringify(ZSTUB))
  .replace("from './lib/logic.js'", "from " + JSON.stringify(logicUrl))
  .replace("from './lib/image-logic.js'", "from " + JSON.stringify(imageLogicUrl))

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-delete-host-'))
const modulePath = join(sandbox, 'index.runtime.mjs')
writeFileSync(modulePath, source)

const mod = await import(pathToFileURL(modulePath).href)
const { apply, internals, buildInventory } = mod

ok(typeof apply === 'function', 'index.js 应导出 apply')
eq(typeof internals?.archiveSession, 'function', 'internals 暴露 archiveSession（测试用）')
eq(internals?.LIVE_CAPABLE, false, '替身没有 volatile → 探测到降级路径')

// ------------------------------------------------- 造一个假的 DSH 主目录

const ID_A = 'session-aaaaaaa1-1111-4111-8111-111111111111'
const ID_B = 'bbbbbbb2-2222-4222-8222-222222222222'

function frame(records) {
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

const home = join(sandbox, 'home')
const wsDir = join(home, 'sessions', '--A-Downloads--')
const pcDir = join(home, 'storages', 'session_projcache', 'sessions')
mkdirSync(wsDir, { recursive: true })
mkdirSync(pcDir, { recursive: true })

const dirA = join(wsDir, ID_A)
mkdirSync(dirA, { recursive: true })
writeFileSync(join(dirA, 'session.v4.jsonl.zstd'), frame([{ type: 'session', version: 4, id: ID_A, createdAt: 1000, cwd: 'A:\\Downloads', isSeeded: false, delegationDepth: 0 }]))
writeFileSync(join(pcDir, ID_A + '.json'), JSON.stringify({ version: 7, record: { identity: { cwd: 'A:\\Downloads', createdAt: 1000 }, rows: { title: { ver: 1, seq: 1, val: '被删的会话' } } } }))

const dirB = join(wsDir, ID_B)
mkdirSync(dirB, { recursive: true })
writeFileSync(join(dirB, 'session.v4.jsonl.zstd'), frame([{ type: 'session', version: 4, id: ID_B, createdAt: 2000, cwd: 'A:\\Downloads', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: ID_A }]))

// ------------------------------------------------- 盘点响应

const config = { enabled: true, confirmBeforeDelete: true, keepProjCache: false, archiveOnDelete: true, home }
const inventory = buildInventory(home, config, { archiveCapable: true })
eq(inventory.ok, true, '盘点 ok')
eq(inventory.items.length, 2, '盘点应看见两个会话（其中一个是裸 uuid 的子 agent）')
eq(inventory.archiveCapable, true, '盘点如实报告归档能力')
eq(inventory.archiveOnDelete, true, '盘点如实报告归档开关')

// ------------------------------------------------- 假 ctx / req / res

function makeCtx(options) {
  const opts = options ?? {}
  const routes = []
  const effects = []
  const injections = []
  const services = opts.services ?? {}
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(fn, label) { effects.push(label); return fn() },
    inject(names, cb) {
      injections.push(names.join(','))
      const entries = {}
      for (const name of names) {
        if (name === 'workspaceRegistry' && opts.registry !== undefined) entries[name] = opts.registry
        else if (services[name] !== undefined) entries[name] = services[name]
      }
      if (Object.keys(entries).length > 0) {
        cb({ ...entries, get: (name) => entries[name] })
      }
      return undefined
    },
  }
  return { ctx, routes, effects, injections }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    text: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}); this.headersSent = true },
    setHeader() {},
    end(chunk) { if (chunk !== undefined) this.text += String(chunk); this.writableEnded = true },
  }
  return res
}

function routeOf(routes, suffix) {
  return routes.find((route) => String(route.path).endsWith(suffix))
}

function jsonOf(res) {
  return JSON.parse(res.text)
}

// ------------------------------------------------- 归档替身：记录调用顺序

/** 归档替身会在被调用时记录「此刻目标会话的磁盘文件是否还在」。 */
function makeRegistry(log) {
  return {
    archiveSession(sessionId, options) {
      log.push({ sessionId, options, filesStillThere: existsSync(join(wsDir, sessionId)) })
      return Promise.resolve()
    },
  }
}

// ------------------------------------------------- 场景 1：有 registry（正常路径）

{
  const log = []
  const { ctx, routes } = makeCtx({ registry: makeRegistry(log) })
  apply(ctx, config)
  ok(routeOf(routes, '/inventory') !== undefined, '应注册 inventory 路由')
  ok(routeOf(routes, '/delete') !== undefined, '应注册 delete 路由')

  const res = fakeRes()
  routeOf(routes, '/delete').handler({ body: { ids: [ID_A, ID_B] }, url: '/plugins/dsh-delete/delete' }, res)
  await settle(res)
  const payload = jsonOf(res)
  eq(payload.ok, true, '删除响应 ok')
  eq(payload.archiveOnDelete, true, '响应里带归档开关')
  eq(payload.archiveCapable, true, '响应里带归档能力')

  eq(log.length, 2, '两个会话都先走过归档')
  eq(log[0].sessionId, ID_A, '归档顺序与请求顺序一致')
  eq(log[1].sessionId, ID_B, '子 agent（裸 uuid）同样会被归档')
  eq(log[0].options.stopActivity, true, '归档时必须 stopActivity（删一个正在跑的会话要停它的工作）')
  eq(log[0].filesStillThere, true, '⚠️ 顺序契约：归档发生在磁盘删除之前（文件此刻还在）')
  eq(log[1].filesStillThere, true, '⚠️ 子 agent 的目录在归档时也还在')

  eq(payload.results.length, 2, '两条结果')
  eq(payload.results[0].archived, true, '结果里标出已归档')
  eq(payload.results[0].removed.length, 2, '根会话删掉 2 条路径（目录 + 投影）')
  eq(payload.results[1].removed.length, 1, '子 agent 删掉 1 条路径（只有目录）')
  ok(!existsSync(dirA), '根会话目录已删除')
  ok(!existsSync(dirB), '子 agent 目录已删除')
  ok(!existsSync(join(pcDir, ID_A + '.json')), '投影缓存已删除')
}

// ------------------------------------------------- 场景 2：归档失败/缺失也不能阻断删盘

{
  const log = []
  const failing = {
    archiveSession(sessionId, options) {
      log.push({ sessionId, options })
      return Promise.reject(new Error('workspace unknown session'))
    },
  }
  const { ctx, routes } = makeCtx({ registry: failing })
  apply(ctx, config)
  const res = fakeRes()
  routeOf(routes, '/delete').handler({ body: { ids: [ID_A] }, url: '/plugins/dsh-delete/delete' }, res)
  await settle(res)
  const payload = jsonOf(res)
  eq(payload.results[0].archived, false, '归档失败时如实标记')
  ok(String(payload.results[0].archiveError).includes('workspace unknown session'), '带上归档失败原因')
  ok(!existsSync(dirA), '归档失败不阻断磁盘删除')
}

// ------------------------------------------------- 场景 3：宿主没有 workspaceRegistry

{
  const { ctx, routes } = makeCtx({})
  apply(ctx, config)
  const res = fakeRes()
  routeOf(routes, '/delete').handler({ body: { ids: [ID_A] }, url: '/plugins/dsh-delete/delete' }, res)
  await settle(res)
  const payload = jsonOf(res)
  eq(payload.archiveCapable, false, '没有 registry 时如实报告不可归档')
  eq(payload.results[0].archiveError, 'NO_REGISTRY', '没有 registry 时的错误码')
  ok(!existsSync(dirA), '没有 registry 也要照常删盘（降级为「只删文件」）')

  // 降级模式下的盘点响应
  const degraded = buildInventory(home, config, { archiveCapable: false })
  eq(degraded.archiveCapable, false, '降级盘点报告')
}

// ------------------------------------------------- 场景 4：dryRun 与空 ids

{
  const log = []
  const { ctx, routes } = makeCtx({ registry: makeRegistry(log) })
  apply(ctx, config)
  mkdirSync(dirA, { recursive: true })
  writeFileSync(join(dirA, 'session.v4.jsonl.zstd'), frame([{ type: 'session', version: 4, id: ID_A, createdAt: 1000, cwd: 'A:\\Downloads', isSeeded: false, delegationDepth: 0 }]))

  const res = fakeRes()
  routeOf(routes, '/delete').handler({ body: { ids: [ID_A], dryRun: true }, url: '/plugins/dsh-delete/delete' }, res)
  await settle(res)
  const payload = jsonOf(res)
  eq(payload.dryRun, true, '预演标记')
  eq(log.length, 0, '预演必须零副作用：不动归档集合（归档是持久改动）')
  eq(payload.results[0].archived, false, '预演结果不报告归档')
  ok(existsSync(dirA), '预演不删磁盘')

  const res2 = fakeRes()
  routeOf(routes, '/delete').handler({ body: { ids: [] }, url: '/plugins/dsh-delete/delete' }, res2)
  await settle(res2)
  eq(jsonOf(res2).error, 'NO_IDS', '空 ids 返回 NO_IDS')
}

// ------------------------------------------------- 纯函数级：registryOf / archiveSession

eq(internals.registryOf({ workspaceRegistry: { archiveSession() {} } }) !== undefined, true, 'registryOf 走属性')
eq(internals.registryOf({ get: () => ({ archiveSession() {} }) }) !== undefined, true, 'registryOf 走 get()')
eq(internals.registryOf(undefined), undefined, 'registryOf(undefined)')
eq((await internals.archiveSession(undefined, ID_A)).error, 'NO_REGISTRY', '没有 registry 时 archiveSession 返回 NO_REGISTRY')

// ================================================================ 图片管理
//
// 夹具刻意做成「位置 ≠ seq」：header 占位置 0 且自身 seq 与第一条事件撞号，
// 中间还有 seq 空洞 —— 任何把 seq 当数组下标的写法都会在这里测挂。

const IMG_SESSION = 'session-cccccccc-3333-4333-8333-cccccccccccc'
const IMG_DIR = join(wsDir, IMG_SESSION)
const SRC_WITH_IMG = join(sandbox, 'shots', 'shot_ok.png')

/** 造一个内容寻址的附件对象。 */
function putObject(bytes) {
  const digest = sha256Hex(bytes)
  const id = 'sha256:' + digest
  const file = join(home, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  return { id, file }
}

const ATT_A_OBJ = putObject(Buffer.from('img-a'))
const ATT_B_OBJ = putObject(Buffer.from('img-b'))
const ATT_A_ID = ATT_A_OBJ.id
const ATT_B_ID = ATT_B_OBJ.id

function imageToolResult(seq, { attachmentId, sourcePath, time }) {
  return {
    type: 'tool/result',
    seq,
    time,
    data: {
      turn: 1,
      message: {
        role: 'tool',
        content: [
          { type: 'text', text: '<path>' + sourcePath + '</path>' },
          { type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 5, width: 4, height: 4, name: 'shot.png' } },
        ],
      },
      meta: { path: sourcePath },
    },
    surfaceOp: 'append',
  }
}

/** 夹具事件（刻意让**位置 ≠ seq**：header 占位置 0 且自身 seq 与第一条事件撞号 + seq 空洞）。 */
function makeImageEvents() {
  return [
    { type: 'session', version: 4, seq: 0, id: IMG_SESSION, createdAt: 1000, cwd: 'A:\\Downloads', isSeeded: false, delegationDepth: 0 },
    imageToolResult(0, { attachmentId: ATT_A_ID, sourcePath: SRC_WITH_IMG, time: 100 }),
    // 带用量的 assistant 消息：缓存代价预估就靠它算（总量 = inputTokens + cacheReadTokens = 1000）
    {
      type: 'assistant/message',
      seq: 1,
      time: 110,
      data: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: { inputTokens: 100, cacheReadTokens: 900 },
      },
      surfaceOp: 'append',
    },
    imageToolResult(5, { attachmentId: ATT_B_ID, sourcePath: join(sandbox, 'shots', 'gone.png'), time: 120 }),
  ]
}

let IMG_EVENTS = makeImageEvents()

function writeImageSession() {
  mkdirSync(IMG_DIR, { recursive: true })
  mkdirSync(dirname(SRC_WITH_IMG), { recursive: true })
  writeFileSync(SRC_WITH_IMG, 'png')
  writeFileSync(join(IMG_DIR, 'session.v4.jsonl.zstd'), frame(IMG_EVENTS))
}

writeImageSession()

/** 记录 append 调用的假会话。 */
function makeSession(records) {
  return {
    append(type, data) {
      records.push({ type, data })
    },
  }
}

// ------------------------------------------------- 场景 5：images 盘点路由

{
  const { ctx, routes } = makeCtx({ services: { sessions: { get: (id) => (id === IMG_SESSION ? {} : undefined) } } })
  apply(ctx, config)
  const imagesRoute = routeOf(routes, '/images')
  ok(imagesRoute !== undefined, '应注册 images 路由')

  const res = fakeRes()
  imagesRoute.handler({ url: '/plugins/dsh-delete/images?sessionId=' + IMG_SESSION }, res)
  await settle(res)
  const payload = jsonOf(res)
  eq(payload.ok, true, '图片盘点 ok: ' + JSON.stringify(payload).slice(0, 300))
  eq(payload.totals.occurrences, 2, '盘点到 2 处图片出现位置')
  eq(payload.totals.retained, 2, '两处都仍在上下文')
  eq(payload.items.map((i) => i.seq), [0, 5], '条目带真实 seq（不是数组位置）')
  eq(payload.items[0].imageIndex, 0, '条目带深度优先图片序号')
  eq(payload.items[0].attachmentId, ATT_A_ID, '条目带附件 id')
  eq(payload.items[0].heldPath, SRC_WITH_IMG, '条目带源文件路径')
  eq(payload.anomalies.header, 1, '如实报告 header 行数')
  eq(payload.live, true, '如实报告会话是否活着')
  eq(payload.offloadAllowed, true, '活会话且未在跑 → 允许摘除')
  eq(payload.imageManagerEnabled, true, '如实报告面板开关')

  // 缓存代价预估：每个带图片的 seq 一条；越早的图代价越大
  eq(payload.cost?.source, 'usage', '盘点带上用量来源')
  eq(payload.cost?.total, 1000, '总量 = 最近一次请求的 inputTokens + cacheReadTokens')
  eq(payload.cost?.bySeq?.map((entry) => entry.seq), [0, 5], '为每个带图片的 seq 预算一条')
  eq(payload.cost?.bySeq?.[0]?.reprocess, 1000, '断点在最前面（seq 0）→ 全部重算')
  eq(payload.cost?.bySeq?.[1]?.reprocess, 0, '断点在 seq 5 → 前面的可复用，不用重算')

  const noId = fakeRes()
  imagesRoute.handler({ url: '/plugins/dsh-delete/images' }, noId)
  await settle(noId)
  eq(jsonOf(noId).error, 'NO_SESSION_ID', '缺 sessionId 返回 NO_SESSION_ID')

  const unknown = fakeRes()
  imagesRoute.handler({ url: '/plugins/dsh-delete/images?sessionId=session-ffffffff-4444-4444-8444-ffffffffffff' }, unknown)
  await settle(unknown)
  eq(jsonOf(unknown).error, 'SESSION_LOG_NOT_FOUND', '未知会话返回 SESSION_LOG_NOT_FOUND')
}

// ------------------------------------------------- 场景 6：摘除（含本体投影验收）

{
  const records = []
  const session = makeSession(records)
  const { ctx, routes } = makeCtx({ services: { sessions: { get: () => session } } })
  apply(ctx, config)
  const offloadRoute = routeOf(routes, '/images/offload')
  ok(offloadRoute !== undefined, '应注册 images/offload 路由')

  // 预演：不写、不删
  const dry = fakeRes()
  offloadRoute.handler(
    { body: { sessionId: IMG_SESSION, items: [{ seq: 5, imageIndex: 0 }], dryRun: true }, url: '/plugins/dsh-delete/images/offload' },
    dry,
  )
  await settle(dry)
  const dryPayload = jsonOf(dry)
  eq(dryPayload.ok, true, '预演 ok')
  eq(dryPayload.offload.appended, false, '预演不追加事件')
  eq(records.length, 0, '预演零副作用：append 未被调用')

  // 真删
  const res = fakeRes()
  offloadRoute.handler(
    { body: { sessionId: IMG_SESSION, items: [{ seq: 5, imageIndex: 0 }] }, url: '/plugins/dsh-delete/images/offload' },
    res,
  )
  await settle(res)
  const payload = jsonOf(res)
  eq(payload.ok, true, '摘除 ok')
  eq(payload.offload.appended, true, '已追加 image/offload')
  eq(payload.offload.count, 1, '摘除 1 处')
  eq(records.length, 1, 'append 被调用一次')
  eq(records[0].type, 'image/offload', '追加的事件类型是 image/offload')
  eq(records[0].data, { targets: [{ seq: 5, imageIndexes: [0] }] }, '事件数据体形状与本体要求一致')
  eq(payload.offload.cost?.seq, 5, '报告里带上这次摘除的缓存代价（断点 seq）')
  eq(payload.offload.cost?.reprocess, 0, '断点靠后 → 这一轮几乎不用重算')

  // 用**本体真实的投影**验收我们写的事件（从本机 app.asar 里读出来跑，不自己给自己打分）
  const projection = await loadNativeImageOffloadProjection()
  if (projection === null) {
    ok(true, '（跳过：本机 app.asar 里找不到 image-offload 投影）')
  } else {
    const sourceEvent = IMG_EVENTS[3]
    const accepted = projection.project(
      { data: records[0].data },
      {
        events: IMG_EVENTS,
        baseSeq: 0,
        nodes: new Set([0, 1, 5]),
        messages: new Map([[5, sourceEvent.data.message]]),
      },
    )
    eq(accepted instanceof Map, true, '本体投影接受我们写的事件（形状与 seq 都过它的校验）')
    const offloaded = accepted.get(5)
    eq(offloaded?.content?.[1]?.offloaded, true, '投影把被选中的图片标成 offloaded')
    eq(
      offloaded?.content?.[0]?.text,
      '<path>' + join(sandbox, 'shots', 'gone.png') + '</path>',
      '只改被选中的那块，其它块原样',
    )

    // 反向：写一个「不属于表面」的 seq，本体必须拒绝（证明我们的前置校验不是多余的）
    let rejected = false
    try {
      projection.project(
        { data: { targets: [{ seq: 2, imageIndexes: [0] }] } },
        { events: IMG_EVENTS, baseSeq: 0, nodes: new Set([0, 1, 5]), messages: new Map() },
      )
    } catch {
      rejected = true
    }
    eq(rejected, true, '本体拒绝表面外的 seq —— 我们的 SEQ_NOT_ON_SURFACE 与它同口径')
  }

  // 幂等防线：把这条记录**落进日志**后，同一位置再摘除必须被拒（投影标记/既有记录都算）
  IMG_EVENTS.push({ type: 'image/offload', seq: 6, time: 130, data: records[0].data })
  writeImageSession()
  const repeat = fakeRes()
  offloadRoute.handler(
    { body: { sessionId: IMG_SESSION, items: [{ seq: 5, imageIndex: 0 }] }, url: '/plugins/dsh-delete/images/offload' },
    repeat,
  )
  await settle(repeat)
  const repeatPayload = jsonOf(repeat)
  eq(repeatPayload.error, 'NOTHING_TO_OFFLOAD', '同一位置重复摘除：没有可摘除项')
  eq(repeatPayload.skippedItems?.[0]?.reason, 'ALREADY_OFFLOADED', '逐条给出原因（已摘除），而不是整批失败')
  eq(records.length, 1, '被拒时不追加事件')
}

// ------------------------------------------------- 场景 7：冷会话与正在跑

{
  const { ctx, routes } = makeCtx({ services: { sessions: { get: () => undefined } } })
  apply(ctx, config)
  const cold = fakeRes()
  routeOf(routes, '/images/offload').handler(
    { body: { sessionId: IMG_SESSION, items: [{ seq: 0, imageIndex: 0 }] }, url: '/plugins/dsh-delete/images/offload' },
    cold,
  )
  await settle(cold)
  eq(jsonOf(cold).error, 'NOT_LIVE', '冷会话摘除被拒（写不进内存史）')

  const coldImages = fakeRes()
  routeOf(routes, '/images').handler({ url: '/plugins/dsh-delete/images?sessionId=' + IMG_SESSION }, coldImages)
  await settle(coldImages)
  const coldPayload = jsonOf(coldImages)
  eq(coldPayload.ok, true, '冷会话仍可盘点（只读）')
  eq(coldPayload.live, false, '如实报告不是活会话')
  eq(coldPayload.offloadAllowed, false, '冷会话不允许摘除')
  eq(coldPayload.offloadBlockedReason, 'NOT_LIVE', '给出不允许的原因')
}

{
  const records = []
  const { ctx, routes } = makeCtx({
    services: { sessions: { get: () => makeSession(records) }, agents: { get: () => ({ running: true }) } },
  })
  apply(ctx, config)
  const res = fakeRes()
  routeOf(routes, '/images/offload').handler(
    { body: { sessionId: IMG_SESSION, items: [{ seq: 0, imageIndex: 0 }] }, url: '/plugins/dsh-delete/images/offload' },
    res,
  )
  await settle(res)
  eq(jsonOf(res).error, 'SESSION_RUNNING', '会话正在跑时默认拒绝摘除（不抢写）')
  eq(records.length, 0, '被拒时不追加事件')
}

// ------------------------------------------------- 场景 8：卸载 → 重载 可组合性

{
  const makeServer = (registered, disposed) => ({
    register(route) {
      registered.push(route.path)
      return () => disposed.push(route.path)
    },
  })
  const services = { sessions: { get: () => makeSession([]) } }

  /** 一个会收集 disposer 的 ctx（用来模拟「卸载」）。 */
  const makeUnloadable = (registered, disposed) => {
    const made = makeCtx({ services })
    const disposers = []
    made.ctx.webServer = makeServer(registered, disposed)
    made.ctx.effect = (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    }
    return { ...made, disposers }
  }

  const registered = []
  const disposed = []
  const first = makeUnloadable(registered, disposed)
  apply(first.ctx, config)
  const expected = ['/inventory', '/delete', '/images', '/images/offload', '/image', '/thumb']
  for (const suffix of expected) {
    ok(registered.some((p) => p.endsWith(suffix)), '重载前注册了 ' + suffix)
  }
  eq(registered.length, 6, '恰好注册 6 条 exact 路由（新增 4 条图片路由）')
  eq(first.injections.includes('sessions'), true, '动态注入过 sessions（探测式，不写进 inject 声明）')

  // 卸载：把所有 effect 的 disposer 逆序跑一遍
  for (const dispose of [...first.disposers].reverse()) dispose()
  eq(disposed.length, 6, '卸载后 6 条路由全部注销')

  // 再次 apply：不得因为「重复 (kind,path)」而抛错（webServer.register 重复会抛）
  const second = makeUnloadable([], [])
  let threw = null
  try {
    apply(second.ctx, config)
  } catch (error) {
    threw = String(error?.message ?? error)
  }
  eq(threw, null, '重载不抛错（disposer 把路由腾干净了）')
}

// ------------------------------------------------- 场景 9：删盘顺序契约（先摘除、后删盘）

{
  // 用一份**干净**的日志副本重来（场景 6 已把 seq 5 与 seq 0 写进摘除记录）
  IMG_EVENTS = makeImageEvents()
  writeImageSession()

  const order = []
  const session = {
    append(type) {
      order.push('offload:' + type)
    },
  }
  const report = await internals.offloadSessionImages({
    home,
    config,
    sessions: { get: () => session },
    agents: undefined,
    sessionId: IMG_SESSION,
    items: [{ seq: 0, imageIndex: 0 }],
    deleteDisk: true,
    forceShared: false,
    dryRun: false,
    ops: {
      sizeOf: () => 7,
      remove: (file) => {
        order.push('delete:' + file)
      },
    },
  })
  eq(report.ok, true, '摘除+删盘整体 ok')
  eq(order[0], 'offload:image/offload', '⚠️ 顺序契约：先摘除')
  eq(order.length > 1, true, '随后才动磁盘')
  eq(
    order.slice(1).every((step) => step.startsWith('delete:')),
    true,
    '删盘步骤都在摘除之后',
  )
  ok(report.disk.planned.some((entry) => entry.kind === 'source'), '删盘计划里有源文件项')
  ok(report.disk.planned.some((entry) => entry.kind === 'attachment'), '删盘计划里有附件对象项')
  eq(report.disk.deleted.length, report.disk.planned.filter((e) => e.action === 'DELETE').length, '应删项全部执行')
  eq(report.disk.reclaimedBytes > 0, true, '回收字节数 > 0')
  eq(report.disk.refScan.sessions > 0, true, '报告里带上全库引用扫描的会话数')

  // 源文件不存在的那条：审计里如实标 MISSING，不当成成功（此刻日志里 seq 5 仍未被摘除）
  const other = await internals.offloadSessionImages({
    home,
    config,
    sessions: { get: () => session },
    sessionId: IMG_SESSION,
    items: [{ seq: 5, imageIndex: 0 }],
    deleteDisk: true,
    dryRun: false,
    ops: { sizeOf: () => 7, remove: () => {} },
  })
  const missing = (other.disk?.planned ?? []).find((entry) => entry.kind === 'source')
  eq(missing?.reason, 'MISSING', '不存在的源文件被标 MISSING（夹具里 gone.png 本来就不存在）')
  eq(missing?.action, 'SKIPPED', '不存在的源文件不进入删除计划')
  // 预演 + 删盘：只算不写
  const orderBefore = order.length
  const dry = await internals.offloadSessionImages({
    home,
    config,
    sessions: { get: () => session },
    sessionId: IMG_SESSION,
    items: [{ seq: 0, imageIndex: 0 }],
    deleteDisk: true,
    dryRun: true,
    ops: { sizeOf: () => 7, remove: () => order.push('delete-should-not-happen') },
  })
  eq(dry.offload.appended, false, '预演不追加')
  eq(dry.disk?.deleted?.length ?? 0, 0, '预演不删盘')
  eq(order.length, orderBefore, '预演零副作用')
}

// ------------------------------------------------- 场景 10：活会话表面优先（修 APPEND_FAILED）

/**
 * 背景（真机踩到的 bug）：本体追加 `image/offload` 时会用 **活会话的当前表面**
 * 校验目标 seq。旧实现用**磁盘日志**算表面，两者可能不同（压缩 `replace` 会把旧节点
 * 移出表面），于是本体拒绝整条事件，用户看到的就是「点了删除没反应」（APPEND_FAILED）。
 *
 * 现在：盘点与判定都优先走活会话内存日志，逐条跳过不合法的项，不再整批失败。
 */
{
  IMG_EVENTS = makeImageEvents()
  writeImageSession()

  const records = []
  // 活会话比磁盘日志**更全**（多一张 seq 9 的图），且把 seq 0 移出了表面（模拟压缩 replace）
  const liveEvents = [
    ...makeImageEvents(),
    imageToolResult(9, { attachmentId: ATT_B_ID, sourcePath: SRC_WITH_IMG, time: 140 }),
  ]
  const liveSession = {
    log: liveEvents,
    surface: { nodes: [5, 9] },
    header: { cwd: 'A:\\Downloads' },
    append(type, data) {
      records.push({ type, data })
    },
  }
  const { ctx, routes } = makeCtx({ services: { sessions: { get: () => liveSession } } })
  apply(ctx, config)

  // 盘点：必须读活会话（3 处出现位置，而磁盘日志里只有 2 处）
  const imagesRes = fakeRes()
  routeOf(routes, '/images').handler({ url: '/plugins/dsh-delete/images?sessionId=' + IMG_SESSION }, imagesRes)
  await settle(imagesRes)
  const view = jsonOf(imagesRes)
  eq(view.ok, true, '活会话盘点 ok')
  eq(view.source, 'live', '活会话时来源标为 live（零磁盘 I/O）')
  eq(view.items.map((i) => i.seq), [5, 9], '只盘点活会话**当前表面**上的图片（seq 0 已被移出表面，不再计入）')
  eq(view.totals.occurrences, 2, '活会话表面上 2 处图片出现位置')

  // 摘除：seq 0 不在活表面上 → 跳过；seq 5 合法 → 写入
  const res = fakeRes()
  routeOf(routes, '/images/offload').handler(
    {
      body: { sessionId: IMG_SESSION, items: [{ seq: 0, imageIndex: 0 }, { seq: 5, imageIndex: 0 }] },
      url: '/plugins/dsh-delete/images/offload',
    },
    res,
  )
  await settle(res)
  const payload = jsonOf(res)
  eq(payload.ok, true, '部分不合法时整体仍然成功（不再整批失败）')
  eq(payload.offload.appended, true, '合法项照常写入')
  eq(payload.offload.targets, [{ seq: 5, imageIndexes: [0] }], '只写合法项的 targets')
  eq(payload.offload.skipped, [{ seq: 0, imageIndex: 0, reason: 'NOT_ON_SURFACE' }], '不在活表面上的项被跳过并注明原因')
  eq(records.length, 1, '仍只追加一条事件')

  // 全是非法项：如实报「没有可摘除项」，而不是 APPEND_FAILED
  IMG_EVENTS = makeImageEvents()
  writeImageSession()
  const onlyBad = fakeRes()
  routeOf(routes, '/images/offload').handler(
    { body: { sessionId: IMG_SESSION, items: [{ seq: 0, imageIndex: 0 }] }, url: '/plugins/dsh-delete/images/offload' },
    onlyBad,
  )
  await settle(onlyBad)
  const badPayload = jsonOf(onlyBad)
  eq(badPayload.error, 'NOTHING_TO_OFFLOAD', '全是不合法项时给出 NOTHING_TO_OFFLOAD')
  eq(badPayload.skippedItems?.[0]?.reason, 'NOT_ON_SURFACE', '并列出被跳过项的原因')
  eq(records.length, 1, '没有任何写入')
}

// ------------------------------------------------- 场景 11：判定函数的细分类

{
  const model = buildSessionModel([
    { type: 'session', version: 4, seq: 0, id: IMG_SESSION, cwd: 'A:\\x' },
    imageToolResult(0, { attachmentId: ATT_A_ID, sourcePath: SRC_WITH_IMG, time: 1 }),
    { type: 'assistant/message', seq: 7, time: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }, surfaceOp: 'append' },
  ], [0, 7])
  const judged = internals.judgeLiveItems(model, [
    { seq: 0, imageIndex: 0 },
    { seq: 0, imageIndex: 5 },
    { seq: 0, imageIndex: 5 },
    { seq: 3, imageIndex: 0 },
    { seq: 7, imageIndex: 0 },
    { seq: 'x', imageIndex: 0 },
  ])
  eq(judged.accepted.length, 1, '只接受合法的那个')
  eq(judged.accepted[0].seq, 0, '接受的 seq')
  const reasons = judged.skipped.map((s) => s.reason)
  eq(reasons.filter((r) => r === 'IMAGE_INDEX_MISSING').length, 2, '同一条消息里不存在的图片序号 → IMAGE_INDEX_MISSING（{0,5} 与 {7,0}）')
  eq(reasons.includes('SEQ_GONE'), true, '日志里根本没有的 seq → SEQ_GONE')
  eq(reasons.includes('BAD_ITEM'), true, '形状不对 → BAD_ITEM')
  eq(judged.skipped.length, 4, '重复勾选同一个非法项只报一次（{0,5} 只出现一次）')
}

// ------------------------------------------------------------------- 收尾

rmSync(sandbox, { recursive: true, force: true })

console.log('dsh-delete host smoke: ' + passed + ' 条通过, ' + failures.length + ' 条失败')
if (failures.length > 0) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✅')
