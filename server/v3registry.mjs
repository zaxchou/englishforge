// 审计内容注册表（31 第三批余下）：来源命题账本 + 已审素材池 + 内容版本签名。
// 独立小模块：只读 data/*.json、不碰 DB —— v3gen 与 v3lessons 都能用而不成环。
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const fileStamp = (f) => { const p = resolve(HERE, 'data', f); const st = statSync(p); return `${st.mtimeMs}:${st.size}` }
let ledgerCache = null // { stamp, data }
let materialsCache = null // { stamp, data }
let sigCache = null // { sig, stamp }

/**
 * 38-S2/F3：内容合同版本束。任一版本变化 ⇒ 全局内容签名变化 ⇒ 旧签名的在途任务/未分发课失效。
 * 评估合同版本必须与 v3evidence 的 evaluatorVersion、生成合同版本必须与 v3gen 的
 * GEN_CONTRACT_V1.version 一致（回归测试断言，防止两处漂移）。
 */
export const CONTENT_CONTRACTS = {
  evaluation: 'deterministic-contract-v2',
  generation: 'gen-contract-v1',
  semanticReview: 'semrev-v2',
}

/** 来源账本（v3-objectives.json sources）：代号 → {claim, limit}。命题级核验的锚点。
 * 缓存按文件 mtime+size 失效——改文件立即生效，不以重启当失效规则。 */
export function sourceLedger() {
  const stamp = fileStamp('v3-objectives.json')
  if (!ledgerCache || ledgerCache.stamp !== stamp) {
    ledgerCache = { stamp, data: JSON.parse(readFileSync(resolve(HERE, 'data', 'v3-objectives.json'), 'utf8')).sources ?? {} }
  }
  return ledgerCache.data
}

/**
 * 已审素材池（v3-materials.json）：生成活动的 materialId 必须绑定这里的条目。
 * status: 'audited' = 来源/许可/文本已核，可绑定；'pending_review'（如 LibriVox 听校未做）
 * 只能作为候选出现在提示里，**不得绑定**——绑了质量门直接拒。
 * objectiveIds 为空数组 = 不限目标（通用素材）；非空 = 只限列出的目标。
 */
export function loadMaterials() {
  const stamp = fileStamp('v3-materials.json')
  if (!materialsCache || materialsCache.stamp !== stamp) {
    materialsCache = { stamp, data: JSON.parse(readFileSync(resolve(HERE, 'data', 'v3-materials.json'), 'utf8')).materials ?? [] }
  }
  return materialsCache.data
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
 * 内容版本签名（34-F3 重做）：**完整内容依赖清单**——
 *   地图种子（目标定义/版本）+ 来源命题账本 + 素材池全文（正文/版本/适配/状态）+ 三份内容合同版本。
 * 任一变化 ⇒ 携带旧签名的在途任务按失效处理、未分发的个体生成课不再适用（新签名的新任务才有效）。
 * 缓存按**文件 mtime+size** 失效：改数据文件立即生效，不以重启服务当失效规则（34-F3 明确要求）。
 * 历史无签名的记录不追溯（诚实兼容）。
 */
const CONTENT_FILES = ['v3-map-seed.json', 'v3-objectives.json', 'v3-materials.json']
let digestOverride = null // 测试缝：隔离库测试用替换字节复现"内容变化"，不动真实数据文件

function digestInputs() {
  if (digestOverride) return digestOverride
  return CONTENT_FILES.map((f) => {
    const p = resolve(HERE, 'data', f)
    const st = statSync(p)
    return { file: f, stamp: `${st.mtimeMs}:${st.size}`, bytes: readFileSync(p) }
  })
}

/** 测试专用：临时替换签名输入（返回恢复函数）。生产路径不得调用。 */
export function __overrideContentDigest(inputs) {
  digestOverride = inputs
  return () => { digestOverride = null }
}

export function contentSignature() {
  const inputs = digestInputs()
  const stamp = inputs.map((f) => `${f.file}:${f.stamp}`).join('|') + '|' + Object.values(CONTENT_CONTRACTS).join('/')
  if (sigCache && sigCache.stamp === stamp) return sigCache.sig
  const h = createHash('sha256')
  for (const f of inputs) h.update(f.file).update('\0').update(f.bytes).update('\0')
  h.update(stamp)
  sigCache = { sig: h.digest('hex').slice(0, 16), stamp }
  return sigCache.sig
}

/** 发行时冻结素材正文（34-F3）：把活动声明依赖的段原文随活动定义落库——
 * 之后素材文件改动不再改写已发行课的下发正文（已开始课用冻结版本完成，不偷偷换正文）。 */
export function materialSnapshot(materialId, segmentIds = null) {
  const m = getMaterial(materialId)
  if (!m || !Array.isArray(m.segments)) return null
  const segs = Array.isArray(segmentIds) && segmentIds.length
    ? m.segments.filter((s) => segmentIds.includes(s.segmentId))
    : m.segments
  if (!segs.length) return null
  return segs.map((s) => ({ segmentId: s.segmentId, title: s.title, text: s.text }))
}

/** 学习者可见正文（34-F3 冻结优先）：已发行活动优先用**发行时冻结的段原文**；
 * 无快照回退实时读取。两条路径都受同一条硬规则约束：**listen 素材永不下发正文**
 * （音频即素材，首听无脚本，21 §6.2）——快照不得成为绕过口。 */
export function materialForLearnerFrozen(a) {
  const materialId = String(a?.materialId ?? '')
  const m = materialId ? getMaterial(materialId) : null
  if (m && m.kind !== 'read') return null
  if (Array.isArray(a?.materialSnapshot) && a.materialSnapshot.length) {
    return { materialId, kind: 'read', segments: a.materialSnapshot }
  }
  return materialForLearner(materialId, a?.segmentIds ?? null)
}
