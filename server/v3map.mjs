// W1：能力目标与来源账本（docs/curriculum-v4/15 §3）。
//
// 职责：把种子（216 个 K 组 + 首批 15 条原子目标）落库；校验前置图（引用存在、无环、
// 父组存在、账本登记一致）；给 GET /api/v1/map 提供索引。
// 铁律：未核验的目标/组**永远**不以“已覆盖/已验证”的口径暴露 —— 状态只有
// pending / partial_draft / decomposed / verified 四档，verified 目前一个都没有。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureV3Schema } from './v3db.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEED_PATH = resolve(HERE, 'data', 'v3-map-seed.json')

let seedCache = null

export function loadSeed() {
  if (!seedCache) seedCache = JSON.parse(readFileSync(SEED_PATH, 'utf8'))
  return seedCache
}

/** 种子落库：组是工作状态（可随文档演进更新）；目标只增版本，已存在的版本不动 */
export function seedMap() {
  const conn = ensureV3Schema()
  const seed = loadSeed()
  const now = Date.now()

  const upGroup = conn.prepare(
    `INSERT INTO coverage_groups (group_id, unit_id, title, complexity_band, reference_scope, transcript_anchors,
       unit_exit_task, priority, atomization_status, atomic_target_ids, leaf_source_refs, fact_review_status,
       teaching_contract_status, skill_exit_status, work_package, notes, owner, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(group_id) DO UPDATE SET
       unit_id=excluded.unit_id, title=excluded.title, complexity_band=excluded.complexity_band,
       reference_scope=excluded.reference_scope, transcript_anchors=excluded.transcript_anchors,
       unit_exit_task=excluded.unit_exit_task, priority=excluded.priority,
       atomization_status=excluded.atomization_status, atomic_target_ids=excluded.atomic_target_ids,
       leaf_source_refs=excluded.leaf_source_refs, fact_review_status=excluded.fact_review_status,
       teaching_contract_status=excluded.teaching_contract_status, skill_exit_status=excluded.skill_exit_status,
       work_package=excluded.work_package, notes=excluded.notes, updated_at=excluded.updated_at`,
  )
  for (const g of seed.groups) {
    upGroup.run(
      g.groupId, g.unitId, g.title, g.complexityBand, JSON.stringify(g.referenceScope),
      JSON.stringify(g.transcriptAnchors), g.unitExitTask, g.priority, g.atomizationStatus,
      JSON.stringify(g.atomicTargetIds), JSON.stringify(g.leafSourceRefs), g.factReviewStatus,
      g.teachingContractStatus, g.skillExitStatus, g.workPackage, g.notes, 'zcode', now,
    )
  }

  const insObj = conn.prepare(
    `INSERT INTO objective_versions (objective_id, version, parent_group, unit_id, layer, name, behavior, boundary,
       prerequisites, prereq_notes, misconceptions, task_families, skills, skill_not_applicable, complexity_dims,
       strategies, source_refs, verification, flags, status, owner, first_path, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(objective_id, version) DO NOTHING`,
  )
  for (const o of seed.objectives) {
    insObj.run(
      o.objectiveId, o.version ?? 1, o.parentGroup, o.unitId, o.layer, o.name, o.behavior, o.boundary,
      JSON.stringify(o.prerequisites ?? []), o.prereqNotes ?? '', JSON.stringify(o.misconceptions ?? []),
      JSON.stringify(o.taskFamilies ?? []), JSON.stringify(o.skills ?? {}), o.skillNotApplicable ?? '',
      JSON.stringify(o.complexityDims ?? []), JSON.stringify(o.strategies ?? []),
      JSON.stringify((o.sourceRefs ?? []).map(decodeSourceRef(seed))), o.verification, JSON.stringify(o.flags ?? []),
      'draft', 'zcode', g_firstPath(seed, o.parentGroup) ? 1 : 0, now,
    )
  }

  const validation = validateMap(conn)
  if (!validation.ok) throw new Error('MAP_INVALID: ' + validation.errors.join('；'))
  return { groups: seed.groups.length, objectives: seed.objectives.length, validation }
}

function decodeSourceRef(seed) {
  return (ref) => {
    const [code, ...rest] = String(ref).split(':')
    const base = seed.sources[code]
    if (!base) return { ref: code, kind: 'unknown', claim: '', status: 'unresolved' }
    return { ref: code, aspect: rest.join(':') || null, kind: base.kind, title: base.title,
      url: base.url || null, claim: base.claim, limit: base.limit, status: 'claim_checked' }
  }
}

function g_firstPath(seed, groupId) {
  return seed.groups.find((g) => g.groupId === groupId)?.priority === 'first_path'
}

/**
 * 地图不变量校验（15 §3）：前置引用存在且无环、父组在账本、账本登记与实物一致、
 * 没有任何东西冒充 fact_verified。任何一条失败都让种子落库直接失败。
 */
export function validateMap(conn = ensureV3Schema()) {
  const errors = []
  const objs = conn.prepare('SELECT * FROM objective_versions').all().map(rowToObjective)
  const groups = conn.prepare('SELECT group_id, atomic_target_ids, atomization_status FROM coverage_groups').all()
    .map((g) => ({ groupId: g.group_id, atomicTargetIds: JSON.parse(g.atomic_target_ids || '[]'), atomizationStatus: g.atomization_status }))
  const ids = new Set(objs.map((o) => o.objectiveId))

  for (const o of objs) {
    for (const p of o.prerequisites) if (!ids.has(p)) errors.push(`${o.objectiveId} 前置 ${p} 不存在`)
    if (!groups.some((g) => g.groupId === o.parentGroup)) errors.push(`${o.objectiveId} 父组 ${o.parentGroup} 不在账本`)
    if (o.verification === 'fact_verified') errors.push(`${o.objectiveId} 冒充 fact_verified（首批准入只有 claim_checked/design_rationale）`)
  }
  // 账本登记 ↔ 实物双向一致
  for (const g of groups) {
    for (const t of g.atomicTargetIds) if (!ids.has(t)) errors.push(`${g.groupId} 登记了不存在的目标 ${t}`)
    if (g.atomizationStatus === 'verified' && g.atomicTargetIds.length === 0) errors.push(`${g.groupId} 标 verified 却没有目标`)
  }
  for (const o of objs) {
    const g = groups.find((x) => x.groupId === o.parentGroup)
    if (g && !g.atomicTargetIds.includes(o.objectiveId)) errors.push(`${o.objectiveId} 未登记进 ${o.parentGroup}`)
  }
  // 前置图无环（DFS 三色标记）
  const color = new Map()
  const visit = (id, stack) => {
    color.set(id, 1)
    for (const p of objs.find((o) => o.objectiveId === id)?.prerequisites ?? []) {
      if (color.get(p) === 1) errors.push(`前置环：${stack.join('→')}${id}→${p}`)
      else if (!color.get(p)) visit(p, [...stack, id + '→'])
    }
    color.set(id, 2)
  }
  for (const id of ids) if (!color.get(id)) visit(id, [])

  return { ok: errors.length === 0, errors, checkedAt: Date.now() }
}

export function rowToObjective(r) {
  return {
    objectiveId: r.objective_id, version: r.version, parentGroup: r.parent_group, unitId: r.unit_id,
    layer: r.layer, name: r.name, behavior: r.behavior, boundary: r.boundary,
    prerequisites: JSON.parse(r.prerequisites || '[]'), prereqNotes: r.prereq_notes || '',
    misconceptions: JSON.parse(r.misconceptions || '[]'), taskFamilies: JSON.parse(r.task_families || '[]'),
    skills: JSON.parse(r.skills || '{}'), skillNotApplicable: r.skill_not_applicable || '',
    complexityDims: JSON.parse(r.complexity_dims || '[]'), strategies: JSON.parse(r.strategies || '[]'),
    sourceRefs: JSON.parse(r.source_refs || '[]'), verification: r.verification,
    flags: JSON.parse(r.flags || '[]'), status: r.status, owner: r.owner, firstPath: !!r.first_path,
  }
}

export function rowToGroup(r) {
  return {
    groupId: r.group_id, unitId: r.unit_id, title: r.title, complexityBand: r.complexity_band,
    referenceScope: JSON.parse(r.reference_scope || '[]'), transcriptAnchors: JSON.parse(r.transcript_anchors || '[]'),
    unitExitTask: r.unit_exit_task, priority: r.priority, atomizationStatus: r.atomization_status,
    atomicTargetIds: JSON.parse(r.atomic_target_ids || '[]'), leafSourceRefs: JSON.parse(r.leaf_source_refs || '[]'),
    factReviewStatus: r.fact_review_status, teachingContractStatus: r.teaching_contract_status,
    skillExitStatus: r.skill_exit_status, workPackage: r.work_package, notes: r.notes || '',
    owner: r.owner, updatedAt: r.updated_at,
  }
}

/** GET /api/v1/map：索引 + 状态 + 覆盖缺口。未核验的明示状态，绝不显示“已覆盖” */
export function mapIndex({ group, status } = {}) {
  const conn = ensureV3Schema()
  seedMap() // 幂等：每次都确保账本与种子一致（文档更新后无需迁移）
  const groups = conn.prepare('SELECT * FROM coverage_groups ORDER BY group_id').all().map(rowToGroup)
    .filter((g) => (!group || g.groupId === group) && (!status || g.atomizationStatus === status))
  const objectives = conn.prepare('SELECT * FROM objective_versions ORDER BY objective_id').all().map(rowToObjective)
  const byAtomization = {}
  for (const g of conn.prepare('SELECT atomization_status AS s, COUNT(*) AS n FROM coverage_groups GROUP BY s').all()) byAtomization[g.s] = g.n
  const byFactReview = {}
  for (const g of conn.prepare('SELECT fact_review_status AS s, COUNT(*) AS n FROM coverage_groups GROUP BY s').all()) byFactReview[g.s] = g.n
  const seed = loadSeed()
  return {
    mapVersion: seed.mapVersion,
    generatedAt: Date.now(),
    legacyNotice: '旧账户的 XP/题量/box/阶梯层数是历史活动记录，不换算为本图上的能力状态（15 §13）',
    sourceNotice: seed.sourceNotice,
    summary: {
      groups: groups.length,
      byAtomization, byFactReview,
      objectives: objectives.length,
      factVerifiedObjectives: objectives.filter((o) => o.verification === 'fact_verified').length,
      coveredClaims: 0, // 全图核验完成前恒为 0：这是账本，不是覆盖证明（00 §1）
    },
    validation: validateMap(conn),
    groups, objectives,
  }
}
