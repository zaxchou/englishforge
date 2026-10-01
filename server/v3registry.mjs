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

/** 目标适配（34-F5）：objectiveIds 为空的旧语义作废——read 素材必须显式声明适配目标；
 * listen 素材同理。不匹配 = 不可绑定（防止"任何目标都能绑通用素材"把限定/非限定混进对照目标）。 */
export function materialUsableFor(materialId, objectiveId) {
  const m = getMaterial(materialId)
  if (!m || m.status !== 'audited') return false
  if (!Array.isArray(m.objectiveIds) || !m.objectiveIds.includes(objectiveId)) return false
  // read 素材必须有正文段；listen 素材正文=音频本身（转写不下发），不要求段
  if (m.kind === 'read' && (!Array.isArray(m.segments) || !m.segments.length)) return false
  return true
}

/** 已审素材的完整条目。审核身份分字段（34-F5）：review.humanReviewed=false = 零真人核验，
 * "audited"只表示机器整理+自校订完成，绝不冒充专业核验。 */
export function getMaterial(materialId) {
  return loadMaterials().find((x) => x.materialId === materialId) ?? null
}

/** 学习者可见的素材附件：read 类只下发**被选题声明的那几个段**（34-F1：不做整包下发
 * 而题目指向不清）；listen 类不下发正文（音频即素材，首听无脚本，21 §6.2）。 */
export function materialForLearner(materialId, segmentIds = null) {
  const m = getMaterial(materialId)
  if (!m || m.status !== 'audited' || m.kind !== 'read') return null
  const segs = Array.isArray(m.segments) ? m.segments : []
  const picked = Array.isArray(segmentIds) && segmentIds.length
    ? segs.filter((s) => segmentIds.includes(s.segmentId))
    : segs
  if (!picked.length) return null
  return {
    materialId: m.materialId, materialVersion: m.materialVersion ?? 1, kind: m.kind,
    segments: picked.map((s) => ({ segmentId: s.segmentId, title: s.title, text: s.text })),
  }
}

/** 给提示用的已审素材清单（34-F1）：带 materialVersion + **完整段正文**（segmentId/标题/文本），
 * 生成器据此出题——不再只给描述让模型对不存在的信息提问。 */
export function materialsForPrompt(objectiveId) {
  const usable = loadMaterials().filter((m) => materialUsableFor(m.materialId, objectiveId))
  const pending = loadMaterials().filter((m) => m.status !== 'audited')
  return {
    audited: usable.map((m) => ({
      materialId: m.materialId, materialVersion: m.materialVersion ?? 1, kind: m.kind, sourceRef: m.sourceRef,
      note: m.note, hintGuidance: m.hintGuidance ?? '',
      segments: (m.segments ?? []).map((s) => ({ segmentId: s.segmentId, title: s.title, text: s.text })),
    })),
    pendingReview: pending.map((m) => ({ materialId: m.materialId, reason: m.status === 'pending_review' ? '待人工听校/审' : m.status })),
  }
}

/** 34-F1 机器可验的支撑检查：引用句必须是所绑定段的**原文子串**（归一空白）。
 * 题目问到段里没有的信息时模型引不出原文 → 整课拒收。 */
export function segmentText(materialId, segmentId) {
  const m = getMaterial(materialId)
  return (m?.segments ?? []).find((s) => s.segmentId === segmentId)?.text ?? null
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
