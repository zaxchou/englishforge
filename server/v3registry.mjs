// 审计内容注册表（31 第三批余下）：来源命题账本 + 已审素材池 + 内容版本签名。
// 独立小模块：只读 data/*.json、不碰 DB —— v3gen 与 v3lessons 都能用而不成环。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let ledgerCache = null
let materialsCache = null
let sigCache = null

/** 来源账本（v3-objectives.json sources）：代号 → {claim, limit}。命题级核验的锚点。 */
export function sourceLedger() {
  if (!ledgerCache) ledgerCache = JSON.parse(readFileSync(resolve(HERE, 'data', 'v3-objectives.json'), 'utf8')).sources ?? {}
  return ledgerCache
}

/**
 * 已审素材池（v3-materials.json）：生成活动的 materialId 必须绑定这里的条目。
 * status: 'audited' = 来源/许可/文本已核，可绑定；'pending_review'（如 LibriVox 听校未做）
 * 只能作为候选出现在提示里，**不得绑定**——绑了质量门直接拒。
 * objectiveIds 为空数组 = 不限目标（通用素材）；非空 = 只限列出的目标。
 */
export function loadMaterials() {
  if (!materialsCache) materialsCache = JSON.parse(readFileSync(resolve(HERE, 'data', 'v3-materials.json'), 'utf8')).materials ?? []
  return materialsCache
}

export function materialUsableFor(materialId, objectiveId) {
  const m = loadMaterials().find((x) => x.materialId === materialId)
  if (!m || m.status !== 'audited') return false
  return !Array.isArray(m.objectiveIds) || m.objectiveIds.length === 0 || m.objectiveIds.includes(objectiveId)
}

/** 给提示用的已审素材清单（该目标可用；pending_review 单独列出并注明不可绑定） */
export function materialsForPrompt(objectiveId) {
  const usable = loadMaterials().filter((m) => m.status === 'audited'
    && (!Array.isArray(m.objectiveIds) || m.objectiveIds.length === 0 || m.objectiveIds.includes(objectiveId)))
  const pending = loadMaterials().filter((m) => m.status !== 'audited')
  return {
    audited: usable.map((m) => ({ materialId: m.materialId, kind: m.kind, sourceRef: m.sourceRef, note: m.note })),
    pendingReview: pending.map((m) => ({ materialId: m.materialId, reason: m.status === 'pending_review' ? '待人工听校/审' : m.status })),
  }
}

/**
 * 内容版本签名：地图版本 + 来源命题集合。任一变化 ⇒ 携带旧签名的在途任务按失效处理、
 * 未分发的个体生成课不再适用（新签名的新任务才有效）。历史无签名的记录不追溯（诚实兼容）。
 */
export function contentSignature() {
  if (sigCache) return sigCache
  const mapVersion = JSON.parse(readFileSync(resolve(HERE, 'data', 'v3-map-seed.json'), 'utf8')).mapVersion ?? 'unknown'
  const claims = Object.entries(sourceLedger()).map(([k, v]) => `${k}:${v.claim ?? ''}:${v.limit ?? ''}`).sort().join('|')
  sigCache = createHash('sha256').update(`${mapVersion}|${claims}`).digest('hex').slice(0, 16)
  return sigCache
}
