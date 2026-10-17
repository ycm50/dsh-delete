/**
 * 对**真实 DSH 主目录**做只读的「图片盘点」审计 —— 绝不写盘、绝不删任何东西。
 *
 * 为什么需要它：本插件的 `image/offload` 选点依赖「真实事件 seq」与「位置」两套坐标，
 * 而真机日志里**位置 ≠ seq 是常态**（header 占一行、还可能有空洞）。这个脚本在真数据上
 * 验证：盘点出的每处出现位置，都能按 seq 反查到 `user/message`/`tool/result` 事件，
 * 并且据此算出的 `image/offload` targets 形状合法。
 *
 * 运行：node _smoke/real-image-audit.mjs [会话id前缀]
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  buildOffloadEvent,
  buildSessionModel,
  inventoryOccurrences,
  listSessionLogs,
  planOffload,
  readSessionEvents,
  scanReferences,
  sessionIdOfLogPath,
} from '../lib/image-logic.js'

const home =
  process.env.DSH_HOME && existsSync(process.env.DSH_HOME) ? process.env.DSH_HOME : join(homedir(), '.dsh')
const filter = process.argv[2] ?? ''

const logs = listSessionLogs(home).filter((entry) => filter === '' || entry.session.includes(filter))
console.log('DSH 主目录：' + home)
console.log('会话日志：' + logs.length + ' 个' + (filter === '' ? '' : '（过滤：' + filter + '）'))

let totalOccurrences = 0
let totalRetained = 0
let totalOffloaded = 0
let checkedTargets = 0
let broken = 0

for (const entry of logs) {
  const events = readSessionEvents(entry.path)
  if (events.length === 0) continue
  const model = buildSessionModel(events)
  const { occurrences, offloadEvents, totals } = inventoryOccurrences(model)
  if (occurrences.length === 0 && offloadEvents.length === 0) continue

  const id = sessionIdOfLogPath(home, entry.path)
  console.log(
    '\n· ' +
      id +
      '  位置=' +
      events.length +
      ' 事件=' +
      model.seqToIndex.size +
      ' 空洞/异常=' +
      JSON.stringify(model.anomalies) +
      '\n  图片出现位置=' +
      totals.occurrences +
      '（仍在上下文 ' +
      totals.retained +
      ' / 已摘除 ' +
      totals.offloaded +
      '，不同附件 ' +
      totals.distinctAttachments +
      '）',
  )

  for (const occurrence of occurrences) {
    const event = model.events[model.seqToIndex.get(occurrence.seq) ?? -1]
    const shapeOk = event?.type === 'tool/result' || event?.type === 'user/message'
    // 反向验证：按 seq 取到的事件，其消息里第 imageIndex 个图片块的 attachmentId 必须一致
    const blocks = (event?.data?.message ?? event?.data)?.content ?? []
    const images = Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'image') : []
    const sameAttachment = images[occurrence.imageIndex]?.attachment?.attachmentId === occurrence.attachmentId
    if (!shapeOk || !sameAttachment) {
      broken += 1
      console.log(
        '    ✗ seq=' +
          occurrence.seq +
          ' idx=' +
          occurrence.imageIndex +
          ' 反查失败（事件类型=' +
          String(event?.type) +
          '，附件一致=' +
          String(sameAttachment) +
          '）',
      )
    } else if (filter !== '') {
      console.log(
        '    ' +
          (occurrence.offloaded ? '已摘除' : '在上下文') +
          '  seq=' +
          occurrence.seq +
          ' idx=' +
          occurrence.imageIndex +
          '  ' +
          (occurrence.name || '(无名)') +
          '  ' +
          occurrence.width +
          'x' +
          occurrence.height +
          '  ' +
          occurrence.bytes +
          'B' +
          (occurrence.heldPath ? '  源文件=' + occurrence.heldPath : ''),
      )
    }
  }

  // 选点演练：拿第一个仍在上下文的出现位置算一次 targets（只算不写）
  const first = occurrences.find((o) => !o.offloaded)
  if (first !== undefined) {
    const plan = planOffload(model, [{ seq: first.seq, imageIndex: first.imageIndex }])
    if (!plan.ok) {
      broken += 1
      console.log('    ✗ 选点演练失败：' + plan.reason)
    } else {
      checkedTargets += 1
      if (filter !== '') console.log('    演练 targets=' + JSON.stringify(buildOffloadEvent(plan.targets)))
    }
  }

  totalOccurrences += totals.occurrences
  totalRetained += totals.retained
  totalOffloaded += totals.offloaded
}

const refs = await scanReferences(home, { isCurrent: () => false })
console.log(
  '\n引用扫描：' + refs.sessions + ' 个会话，附件 ' + refs.attachments.size + ' 个，源文件 ' + refs.sources.size + ' 条',
)
for (const [id, entry] of [...refs.attachments.entries()].filter(([, e]) => e.sessions.size > 1)) {
  console.log('  共享附件 ' + id.slice(0, 19) + '… 被 ' + entry.sessions.size + ' 个会话引用')
}

console.log(
  '\n合计：出现位置 ' +
    totalOccurrences +
    '（在上下文 ' +
    totalRetained +
    ' / 已摘除 ' +
    totalOffloaded +
    '）；选点演练 ' +
    checkedTargets +
    ' 次；反查不一致 ' +
    broken +
    ' 处',
)
if (broken > 0) {
  console.log('❌ 存在不一致，先别上线')
  process.exit(1)
}
console.log('✅ 只读校验通过（未写入、未删除任何文件）')
