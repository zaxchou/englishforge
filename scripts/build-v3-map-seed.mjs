// 从 docs/curriculum-v4 的账本与原子目标生成服务端种子（server/data/v3-map-seed.json）。
//
// 为什么要有这一步：docs/ 目录是给人读的 PRD，不保证随发布包部署；服务端只依赖
// server/data/ 里的 JSON。账本（coverage-ledger.csv）是工作状态，每次文档更新后重跑：
//   node scripts/build-v3-map-seed.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CSV = resolve(ROOT, 'docs', 'curriculum-v4', 'coverage-ledger.csv')
const OBJ = resolve(ROOT, 'server', 'data', 'v3-objectives.json')
const OUT = resolve(ROOT, 'server', 'data', 'v3-map-seed.json')

/** 极小 CSV 解析：处理引号包裹与引号内逗号（账本 notes 列用到） */
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') inQuotes = false
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f !== '')) rows.push(row)
  return rows
}

const splitList = (s) => (s ? s.split(';').map((x) => x.trim()).filter(Boolean) : [])

const [headerLine, ...lines] = parseCsv(readFileSync(CSV, 'utf8'))
const cols = headerLine
const groups = lines.map((r) => {
  const o = Object.fromEntries(cols.map((c, i) => [c, r[i] ?? '']))
  return {
    groupId: o.group_id, unitId: o.unit_id, title: o.group_title,
    complexityBand: o.complexity_band,
    referenceScope: splitList(o.reference_scope),
    transcriptAnchors: splitList(o.transcript_anchors),
    unitExitTask: o.unit_exit_task,
    priority: o.priority,
    atomizationStatus: o.atomization_status,
    atomicTargetIds: splitList(o.atomic_target_ids),
    leafSourceRefs: splitList(o.leaf_source_refs),
    factReviewStatus: o.fact_review_status,
    teachingContractStatus: o.teaching_contract_status,
    skillExitStatus: o.skill_exit_status,
    workPackage: o.work_package,
    notes: o.notes,
  }
})

const objDoc = JSON.parse(readFileSync(OBJ, 'utf8'))
const objectives = objDoc.objectives

// 种子内部自检：账本里登记的 atomic_target_ids 必须都有实物，反之亦然
const byId = new Set(objectives.map((o) => o.objectiveId))
const problems = []
for (const g of groups) {
  for (const t of g.atomicTargetIds) if (!byId.has(t)) problems.push(`${g.groupId} 登记了不存在的目标 ${t}`)
  if (g.atomizationStatus === 'partial_draft' && g.atomicTargetIds.length === 0) problems.push(`${g.groupId} 标 partial_draft 却没有目标`)
}
for (const o of objectives) {
  const g = groups.find((x) => x.groupId === o.parentGroup)
  if (!g) problems.push(`${o.objectiveId} 的父组 ${o.parentGroup} 不在账本`)
  else if (!g.atomicTargetIds.includes(o.objectiveId)) problems.push(`${o.objectiveId} 未登记进 ${g.groupId} 的 atomic_target_ids`)
}
if (problems.length) { console.error('种子自检失败：\n' + problems.join('\n')); process.exit(1) }

const seed = {
  mapVersion: 'map-v1',
  generatedAt: new Date().toISOString(),
  generatedFrom: ['docs/curriculum-v4/coverage-ledger.csv', 'server/data/v3-objectives.json（转写 17-首条路径原子目标 v0.1）'],
  sources: objDoc.sources,
  sourceNotice: objDoc.notice,
  groups,
  objectives,
}

writeFileSync(OUT, JSON.stringify(seed, null, 1) + '\n')
console.log(`ok: ${groups.length} 组 / ${objectives.length} 条目标 -> ${OUT}`)
