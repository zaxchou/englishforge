// W4：按需生成供给（docs/curriculum-v4/15 §7 生成质量门、§11.5、§6⑧）。
//
// 铁律：
// · 生成走后台 job，绝不在学习者作答请求里调长模型（§8）；
// · 本模块自带**独立的版本化生成/审核合同**（GEN_CONTRACT_V1）—— 旧 content-ai 的
//   REVIEW_SYSTEM 以旧教材主张为不可质疑标准，与新课程的语言事实核验不兼容，
//   这里不引用它，也不复用它的提示词（15 §1 语义冲突条款）；
// · 质量门任一关键门失败 → 拒收并记录原因；重试有上限；仍失败则撤出候选，
//   计划层诚实显示"内容不足"，不循环熟题凑数（§7）；
// · 需要人审的生成（新语法解释/未核验目标）只到 ready，不自动 published（§5）；
// · 课窗 = 接下来 2 节完整课 + ≤4 个候选位置，每课后重估；新证据可作废缓存课，
//   作废留原因（T6）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureV3Schema, getMeta, setMeta } from './v3db.mjs'
import { ApiError } from './db.mjs'
import { rowToObjective } from './v3map.mjs'
import { runQualityGates, lessonForStrategy, lessonForObjective, getLesson, lessonApplicable } from './v3lessons.mjs'
import { activityById } from './v3evidence.mjs'
import { decide } from './v3plan.mjs'
import { sourceLedger, loadMaterials, materialUsableFor, materialsForPrompt, contentSignature, segmentText, materialSnapshot, CONTENT_CONTRACTS } from './v3registry.mjs'
import { chatWithMeta, LlmError } from './llm.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export { sourceLedger }

/**
 * C4：内容指纹 —— prompt+关系标签+候选句/禁例 归一化后哈希。
 * 任务族标签是自由文本，改名即"新题"；指纹相同即重复投递（20 号 F3「重命名旧题不能伪装陌生迁移」）。
 * 归一化刻意偏严（去空白/标点、小写）：把两道相近题误判为重复是安全侧错误。
 */
export function activityFingerprint(def) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ')
    .replace(/[，。！？；：、,.!?;:"'"'()（）\-—…]/g, '').trim()
  const relations = def?.relations ?? def?.evaluationContract?.relations ?? []
  const parts = [
    norm(def?.prompt),
    ...relations.flatMap((r) => [norm(r?.label), ...(r?.anyOf ?? []).map(norm)]),
    ...(def?.mustNot ?? def?.evaluationContract?.mustNot ?? []).map(norm),
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)
}

export const GEN_CONTRACT_V1 = {
  version: 'gen-contract-v1',
  note: '新课程生成/审核合同：语言事实以 objective.sourceRefs 声明的公开资料为准；讲解风格沿用本书"做动作的/挨动作的"式白话，禁语法术语；与旧 content-ai 流水线无关。',
  system: [
    '你是这套成人英语课程的**出题与讲课模块**。给一个能力目标和学习证据摘要，产出一个课程包 JSON。',
    '硬性要求：',
    '1) 只输出 JSON：{"title","whyNow","teachingNote","explanationKind":"established|new",',
    '   "activities":[{"taskFamilyId","prompt","hints":[],"relations":[{"id","label","anyOf":[],"required"}],"mustNot":[]}],',
    '   "sourceRefs":[{"ref","claim"}]}；不要 markdown 包装。',
    '2) relations/anyOf 关键词判定表**可以省略**（省略时由 AI 老师按意思批改，更准确）；如果要给，每个活动至少 2 个 required 关系，且参考答案自身必须能通过这些关键词——拿不准就别给。',
    '3) teachingNote 用白话讲关系（像"做动作的/挨动作的"），**禁止**主格/宾格/物主代词/三单/谓语/从句这类术语。',
    '4) sourceRefs 至少 1 条，形如 {"ref":"代号","claim":"该材料实际依赖的具体语言命题"}；ref 必须是该目标声明过的来源代号，claim 必须写具体命题（≥6 字），不得只报代号。',
    '5) 素材是**虚构教学情境**，不得声称真实项目/讲座；不得与给定"最近用过的家族"重复。',
  ].join('\n'),
}

const MAX_RETRIES = 2 // 首次 + 2 次重试
const WINDOW_LESSONS = 2
const WINDOW_CANDIDATES = 4

/** 教学控制约束。词表反馈可选补练方向，不能确定语言根因或上调能力带。 */
export function teachingAdaptation(feedback = [], { states = [], band = 1 } = {}) {
  const validBand = Number.isFinite(band) && band >= 1 ? Math.floor(band) : 1
  const misses = new Map()
  for (const sample of feedback) for (const d of sample.dimensions ?? []) {
    if (d.required && d.hit === false) misses.set(d.id, { id:d.id, label:d.label, count:(misses.get(d.id)?.count ?? 0)+1 })
  }
  const recurring = [...misses.values()].filter(d=>d.count >= 2).sort((a,b)=>b.count-a.count).slice(0,3)
  const supported = feedback.some(f=>Number(f.conditions?.hintLevel)>0 || f.conditions?.transcriptShown || f.conditions?.lookupUsed)
  const independentlyConfirmed = states.some(s=>['independent','transferred','retained'].includes(s.state))
  const mode = recurring.length ? 'focused_probe' : supported ? 'fade_support' : feedback.length ? 'new_context_probe' : 'find_start'
  return { mode, focusDimensions:recurring, evidenceLimit:'教学假设，不是确定根因或能力认证',
    targetBand:validBand, maxBand:validBand + (independentlyConfirmed && !supported && !recurring.length ? 1 : 0),
    instruction: mode==='focused_probe' ? '用不同材料区分反复漏掉的关系，先给短讲和可撤除提示，不复读旧句。'
      : mode==='fade_support' ? '保留相同目标与复杂度，用新材料逐步撤掉提示或文字稿，再观察是否能独立完成。'
      : mode==='new_context_probe' ? '用新的实用情境检验能否迁移；只有关键词反馈时不要直接跳过本目标或自动升难度。'
      : '先给一个有挑战但有边界的短任务，获取反馈后再补讲；不要预判个人短板。' }
}

// ---------------------------------------------------------------- 活动：生成题的存取（与静态注册表同形）

function getGeneratedActivity(id) {
  const row = ensureV3Schema().prepare('SELECT definition FROM generated_activities WHERE activity_id = ?').get(id)
  return row ? JSON.parse(row.definition) : null
}

export function registerGeneratedActivities(jobId, activities) {
  const conn = ensureV3Schema()
  const ins = conn.prepare('INSERT OR REPLACE INTO generated_activities (activity_id, version, job_id, definition, created_at) VALUES (?,?,?,?,?)')
  const now = Date.now()
  const ids = []
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i]
    const activityId = `gen_${jobId}_${i}` // 强制前缀：不接受模型自报 id，防跨 job 改写已发布课的评分合同
    const def = {
      activityId, version: 1, role: a.role || 'practice', taskFamilyId: a.taskFamilyId,
      objectiveIds: a.objectiveIds, skillByObjective: a.skillByObjective,
      responseKind: 'text', prompt: a.prompt, hints: a.hints ?? [],
      materialId: a.materialId ?? null, // 素材绑定必须落库，否则下发端无从取正文（实测丢失事故）
      segmentIds: Array.isArray(a.segmentIds) ? a.segmentIds : null, // 34-F1：本题依据的段（下发只给这些段）
      // 34-F3：发行即冻结——所引段原文随活动定义落库。之后素材文件改动不改写已发行课的
      // 下发正文（已开始课用冻结版本完成），未开始课由内容签名失效兜住
      materialSnapshot: materialSnapshot(String(a.materialId ?? ''), Array.isArray(a.segmentIds) ? a.segmentIds : null),
      referenceAnswer: typeof a.referenceAnswer === 'string' ? a.referenceAnswer : null, // 参考答案：复核/对照用，不下发学习者
      supportingQuotes: Array.isArray(a.supportingQuotes) ? a.supportingQuotes : null, // 支撑原句：可追溯出题依据
      conditionsSpec: ['firstExposure', 'hintLevel', 'transcriptShown', 'playCount', 'lookupUsed', 'responseMode'],
      evaluationContract: { dimensions: a.dimensions ?? (a.relations ?? []).map((r) => r.label), relations: a.relations ?? [], mustNot: a.mustNot ?? [] },
      complexityBand: a.complexityBand ?? null,
      transcriptShownByDefault: a.transcriptShownByDefault === true,
      oralEvidenceDeferred: a.oralEvidenceDeferred === true,
      generated: true,
    }
    ins.run(activityId, 1, jobId, JSON.stringify(def), now)
    ids.push(activityId)
  }
  return ids
}

/** 38-S1：语义审核执行器。审核输入**完整覆盖**它声称要兜底的内容：
 * 精华讲解（teachingNote）、每题全部提示（hints）、评分合同（relations/mustNot 全文）、
 * 参考答案、支撑句、所引段正文、目标行为/边界、判题规则与正/误样例说明。
 * 机器强制的部分（不靠模型自觉）：
 *  · 必审字段缺失 → 即使注入的 judge 自报 supported 也**强制降级 pending**（缺依据不得背书）；
 *  · judge 输出缺任一活动的任一必审维度 → pending；
 *  · listen 类素材无审核转写 → 可答性维度 unmeasurable → pending（38 边界：空输入证明不了听力一致）。
 * 同时返回 reviewHash（审核对象的 sha256）：发布前最终核对用它确认"审核背书的对象=要发布的对象"。 */
const REVIEW_DIMENSIONS = ['answerability', 'languageFacts', 'objectiveAlignment', 'scoringConsistency']

async function runSemanticReview({ pkg, ctx, chat, judge }) {
  try {
    const segs = []
    const acts = []
    let inputComplete = true
    const missing = []
    const require = (v, field, ai) => {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) {
        inputComplete = false
        missing.push(ai ? `${field}@${ai}` : field)
      }
    }
    // 目标行为/边界：审核者必须知道"这题该测什么、不该测什么"才能判目标对齐
    const objective = { objectiveId: ctx.objectiveId, behavior: ctx.objectiveBehavior ?? null, boundary: ctx.objectiveBoundary ?? null }
    require(ctx.objectiveBehavior, 'objective.behavior')
    require(ctx.objectiveBoundary, 'objective.boundary')
    require(pkg.teachingNote, 'teachingNote')
    for (const [i, a] of (pkg.activities ?? []).entries()) {
      const mid = String(a.materialId ?? '')
      const texts = (Array.isArray(a.segmentIds) ? a.segmentIds : []).map((sid) => segmentText(mid, String(sid)))
      if (texts.length) segs.push({ materialId: mid, segmentIds: a.segmentIds, texts })
      // 评分合同的机器事实：锚点匹配 + 否定语境扫描 + mustNot 守卫 —— 审核者据此判"评分一致性"
      const scoringRule = {
        mechanism: '锚点词表匹配（否定语境感知：否定出现不算命中；mustNot 至少一次非否定出现才算违规）',
        acceptAnchors: (a.relations ?? []).map((r) => ({ id: r.id, label: r.label, anyOf: r.anyOf, required: !!r.required, polarity: r.polarity ?? null })),
        rejectAnchors: a.mustNot ?? [],
        referenceAnswerMustPass: true,
        correctParaphraseExample: '与参考答案同义、含任一接受锚点的说法必须通过',
        wrongExample: '把限定条件说成普遍事实、或与正文矛盾的说法必须不通过',
      }
      require(a.prompt, 'prompt', i)
      require(Array.isArray(a.hints), 'hints', i) // 字段必须在（空数组=没有提示可审，合法）
      require(a.referenceAnswer, 'referenceAnswer', i)
      require(a.relations === undefined || Array.isArray(a.relations), 'relations', i) // 50 号：可选（缺省=AI 批改开放题）
      const material = loadMaterials().find((m) => m.materialId === mid)
      const listenWithoutAudit = material && material.kind !== 'read' // 无审核转写/时间片段：可答性不可测
      if (listenWithoutAudit) inputComplete = false // 有 listening 事实的题缺审核输入 → 不得 supported
      acts.push({
        idx: i, taskFamilyId: a.taskFamilyId ?? null, prompt: a.prompt, hints: a.hints ?? [],
        referenceAnswer: a.referenceAnswer ?? null, supportingQuotes: a.supportingQuotes ?? null,
        relations: a.relations ?? [], mustNot: a.mustNot ?? [], scoringRule,
        answerabilityMeasurable: !listenWithoutAudit,
      })
    }
    const input = { reviewContract: CONTENT_CONTRACTS.semanticReview, objective, teachingNote: pkg.teachingNote ?? null, segments: segs, activities: acts }
    const reviewHash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)
    const fn = judge ?? makeDefaultSemanticJudge(chat)
    const r = await fn(input)
    const verdict = r?.verdict === 'supported' || r?.verdict === 'unsupported' ? r.verdict : 'pending'
    // 机器复核 judge 的结构化输出：逐题四维度齐全才算 supported；缺维度=必要维度 pending
    let dimensionsComplete = verdict === 'supported'
    if (verdict === 'supported') {
      const byIdx = new Map((Array.isArray(r?.activities) ? r.activities : []).map((x) => [Number(x?.idx ?? x?.index), x]))
      for (const [i, a] of acts.entries()) {
        const row = byIdx.get(i)
        if (!acts[i].answerabilityMeasurable || !row || REVIEW_DIMENSIONS.some((d) => row[d] !== 'supported')) {
          dimensionsComplete = false
          missing.push(`dimension@${i}`)
        }
      }
    }
    const effective = verdict === 'supported' && !(inputComplete && dimensionsComplete) ? 'pending' : verdict
    // 口径：unsupported 是**更严**的结论，保留原样（缺维度只影响"升到 supported"的资格）；
    // supported 必须输入完整 + 逐题四维度齐全，否则降级 pending（38-S1：缺依据不得背书）。
    return {
      verdict: effective, judgeVerdict: verdict, reviewer: r?.reviewer ?? 'none', reasons: String(r?.reasons ?? ''),
      inputComplete, missing: [...new Set(missing)].slice(0, 12), reviewHash, contentSignature: contentSignature(),
    }
  } catch (e) {
    return { verdict: 'pending', reviewer: 'semantic-review-error', reasons: String(e?.message ?? e).slice(0, 160), contentSignature: contentSignature() }
  }
}

/** 36-R1→38-S1：内容语义审核（模型复核可辅助，不冒充真人核验）。
 * 输入=runSemanticReview 组装的完整审核对象（目标边界/短讲/全部提示/评分合同/段正文/参考答案）；
 * 输出必须**逐题给出四个维度**结论（可答性/语言事实与解释/目标对齐/评分一致性）——
 * 只报总体结论=审核不完整，由 runSemanticReview 强制降级 pending。
 * 输出不可解析 → pending（宁可不发布）。 */
export function makeDefaultSemanticJudge(chat) {
  return async (input) => {
    const prompt = [
      '你是课程内容审核员。对下面每一道题**分别**判断四个维度：',
      '1) answerability 可答性：问题（含每条提示引导的方向）是否只问材料段里实际存在的信息？参考答案是否与材料一致？',
      '2) languageFacts 语言事实与解释：短讲和提示有没有教错误的语言规则（如把标点/位置当判断规则、把对照说成必然限制）？',
      '3) objectiveAlignment 目标对齐：题目是否测目标边界内的能力，有没有混入别的目标的题型？',
      '4) scoringConsistency 评分一致性：按给出的评分规则，参考答案自己能通过吗？与参考答案同义的说法会被误拒吗？与正文矛盾的说法会被误收吗？',
      '审核对象：' + JSON.stringify(input),
      '规则：任何一题的任何一维度不成立 → 该维度写 "unsupported" 并在 reasons 说明；全部成立才 verdict=supported。只输出 JSON：',
      '{"verdict":"supported|unsupported","reasons":"…","activities":[{"idx":0,"answerability":"supported|unsupported","languageFacts":"…","objectiveAlignment":"…","scoringConsistency":"…"}]}',
    ].join(String.fromCharCode(10))
    try {
      const out = await chat([{ role: 'user', content: prompt }], { maxTokens: 1400 })
      const raw = typeof out === 'string' ? out : out.text
      const parsed = JSON.parse(raw)
      if (parsed?.verdict === 'supported' || parsed?.verdict === 'unsupported') {
        return { verdict: parsed.verdict, reviewer: 'model-assist', reasons: String(parsed.reasons ?? ''), activities: Array.isArray(parsed.activities) ? parsed.activities : [] }
      }
      return { verdict: 'pending', reviewer: 'model-assist', reasons: '审核输出不可解析' }
    } catch (e) {
      return { verdict: 'pending', reviewer: 'semantic-judge-error', reasons: String(e?.message ?? e).slice(0, 160) }
    }
  }
}

// ---------------------------------------------------------------- 质量门（§7，机器可验部分）

const TERM_BLACKLIST = ['主格', '宾格', '物主代词', '三单', '谓语', '从句', '定语', '状语', '系动词', '助动词', '过去分词', '现在分词']

export function validateGeneratedPackage(pkg, ctx) {
  const gates = {}
  // 50 号：relations 可选——模型自造关键词锚点经常与参考答案自相矛盾（实测 3/3 生成被语义审核拦）。
  // 省略锚点的开放题 = 练习层（keywordOnly 不产生掌握事件），批改由 AI 老师担任（46 号）；封闭结构不受影响。
  gates.schemaComplete = !!(pkg && pkg.title && pkg.whyNow && pkg.teachingNote
    && Array.isArray(pkg.activities) && pkg.activities.length >= 2
    && pkg.activities.every((a) => a.prompt && (a.relations === undefined || Array.isArray(a.relations))))
  gates.answersConsistent = gates.schemaComplete && pkg.activities.every((a) =>
    !(a.relations ?? []).length
    || ((a.relations ?? []).filter((r) => r.required).length >= 1
    && (a.relations ?? []).every((r) => r.id && r.label && Array.isArray(r.anyOf) && r.anyOf.length >= 2)))
  // C4（F8 残留）：命题级来源绑定 —— 只报代号不再算"有来源"。每个 ref 必须：
  // ① 在该目标声明过的来源里（不越出已核范围）；② 账本里该代号本身带具体命题（claim_checked 锚点）；
  // ③ 生成包自带它主张的具体命题（≥6 字符的实质命题，不能是代号复读）。
  // 命题与账本主张的**语义**一致性机器判不了 → 这类课仍走人审签署（needsSign 不因此放宽）。
  gates.sourcesUsable = Array.isArray(pkg.sourceRefs) && pkg.sourceRefs.length >= 1
    && pkg.sourceRefs.every((s) => {
      const ref = String(typeof s === 'string' ? s : s?.ref ?? '').split(':')[0]
      const claim = typeof s === 'string' ? '' : String(s?.claim ?? '').trim()
      return !!ref && ctx.objectiveDeclaredSources.includes(ref)
        && typeof ctx.sourceLedger?.[ref]?.claim === 'string' && ctx.sourceLedger[ref].claim.trim().length > 0
        && claim.length >= 6 && claim !== ref
    })
  // C4（F3 残留）：任务族去重 = 标签不重复 **且** 内容指纹不重复（防改名换皮）**且** 包内互不重复
  const fingerprints = (pkg.activities ?? []).map((a) => activityFingerprint(a))
  gates.familyFresh = Array.isArray(pkg.activities) && pkg.activities.every((a) =>
    a.taskFamilyId && !ctx.recentFamilies.includes(a.taskFamilyId))
    && fingerprints.every((f) => !ctx.recentFingerprints.includes(f))
    && new Set(fingerprints).size === fingerprints.length
  // F8：术语门带感知——band≤3 基础组禁术语；band≥5 高级组允许精确术语（禁“从句”会妨碍高级解释）
  const termGate = (ctx.band ?? 1) >= 5 ? [] : TERM_BLACKLIST
  gates.explanationClean = typeof pkg.teachingNote === 'string'
    && !termGate.some((t) => pkg.teachingNote.includes(t))
    && pkg.activities.every((a) => !(a.explain && termGate.some((t) => a.explain.includes(t))))
  gates.holdoutIsolated = gates.schemaComplete && pkg.activities.every((a) => a.role !== 'holdout')
  // D2（31 第三批自审补）：难度上限从提示约定升级为**机器门**——生成活动声明的复杂度带
  // 不得超过教学适配的 maxBand（关键词反馈不自行升档；独立/迁移证据才允许 +1 探索）。
  // 未声明带的按目标基础带计（≤ maxBand 恒成立），不惩罚省略。
  const maxBand = Number(ctx.adaptation?.maxBand ?? ctx.band ?? 1)
  gates.bandWithinMax = (pkg.activities ?? []).every((a) => {
    const b = Number(a.complexityBand ?? ctx.band ?? maxBand)
    return Number.isFinite(b) && b >= 1 && b <= maxBand
  })
  // 31 第三批：已审素材绑定门——每个活动必须绑定"audited 且对该目标可用"的素材条目；
  // 未绑定/未知/待审/目标不匹配（34-F5 收窄）一律拒。
  gates.materialsBound = (pkg.activities ?? []).every((a) => materialUsableFor(String(a.materialId ?? ''), ctx.objectiveId))
  // 34-F1 + 36-R1：**引用完整性门（quoteIntegrity）**——只验证"支撑句逐字来自所引段"，
  // **不宣称能保证语义可答**（36 号复现：编造问题+无关真实引用可过此门）。语义层由
  // 内容语义审核（semanticReview）负责，未通过不得发布进学习主线。
  // listen 类素材：正文/转写不下发 → 引用不可查，只要求参考答案；支撑句置空由语义审核接管。
  const normWs = (x) => String(x ?? '').replace(/\s+/g, ' ').trim()
  gates.quoteIntegrity = (pkg.activities ?? []).every((a) => {
    if (typeof a.referenceAnswer !== 'string' || normWs(a.referenceAnswer).length < 8) return false
    const material = loadMaterials().find((m) => m.materialId === String(a.materialId ?? ''))
    if (!material) return false
    if (material.kind !== 'read') return true // listen：引用不可查，语义审核层必经（下方 semanticReview 强制）
    const segIds = a.segmentIds
    if (!Array.isArray(segIds) || !segIds.length) return false
    const texts = segIds.map((sid) => segmentText(material.materialId, String(sid)))
    if (texts.some((t) => t === null)) return false // 段不属于该素材
    const quotes = a.supportingQuotes
    if (!Array.isArray(quotes) || !quotes.length) return false
    return quotes.every((q) => {
      const nq = normWs(q)
      return nq.length >= 12 && texts.some((t) => normWs(t).includes(nq))
    })
  })
  // 34-F2：提示质量门——禁止把标点/位置当判断规则的机械提示进入真实学习记录
  // 只挡已知措辞（36-R2：不堆黑名单宣称解决语言事实）；换措辞绕过由语义审核层负责
  const HINT_BLACKLIST = ['加逗号的那部分', '只要看到逗号', '有逗号就是', '多半在缩小范围', '一定是在缩小范围', '逗号后的信息一定是', '一定是限制', '一定是主张', '前面是主张', '后面是限制', '逗号后就是']
  gates.hintQuality = (pkg.activities ?? []).every((a) =>
    !(a.hints ?? []).some((h) => HINT_BLACKLIST.some((b) => String(h).includes(b))))
    && !HINT_BLACKLIST.some((b) => String(pkg.teachingNote ?? '').includes(b))
  gates.truncated = false // chatJson 解析失败根本到不了这里；截断=reject 上游
  gates.allPassed = ['schemaComplete', 'answersConsistent', 'sourcesUsable', 'explanationClean', 'familyFresh', 'holdoutIsolated', 'bandWithinMax', 'materialsBound', 'quoteIntegrity', 'hintQuality']
    .every((k) => gates[k])
  return gates
}

function rejectReasons(gates) {
  return Object.entries(gates).filter(([k, v]) => !v && k !== 'allPassed' && k !== 'truncated')
    .map(([k]) => `${k} 未过`)
}

// ---------------------------------------------------------------- 任务

const COOLDOWN_MS = 10 * 60 * 1000 // 失败后 10 分钟内不为同目标重射任务（防 GET 反复烧钱；§7 撤出候选）

export function startGenerationJob(accountId, { objectiveId, strategyId, chat = chatWithMeta, semanticJudge = null, await: awaitIt = false, force = false, userConfirmed = false } = {}) {
  // F8：统一开关判定——字符串 '0'/'false' 不算开启；直接接口与窗口同受控。
  // 例外：**用户单次明确点击**（userConfirmed，前端在按钮上明示"调用真实模型、按次计费"）
  // 可以越过全局开关——这是"内容准备中"死等的正解：等的内容由学习者本人一键触发按需生成。
  // 冷却/去重/质量门对这条路径**同样生效**，不会因确认而绕过任何安全检查。
  if (!userConfirmed && !['1', 'true'].includes(String(process.env.ENGLISHFORGE_V4_GENERATION ?? ''))) {
    throw new ApiError(409, 'GENERATION_DISABLED: 设 ENGLISHFORGE_V4_GENERATION=1 显式开启按需生成（防误计费）')
  }
  const conn = ensureV3Schema()
  const dup = conn.prepare("SELECT job_id,input_spec FROM generation_jobs WHERE account_id = ? AND objective_id = ? AND status IN ('queued','running')")
    .get(accountId, objectiveId)
  const dupSpec = dup ? JSON.parse(dup.input_spec) : null
  if (dup && generationSnapshotCurrent(conn, accountId, dupSpec.learnerEvidence, dupSpec.contentSignature)) return { jobId: dup.job_id, reused: true }
  if (dup) conn.prepare("UPDATE generation_jobs SET status='superseded',reject_reasons=?,finished_at=? WHERE job_id=?").run(JSON.stringify(['LEARNING_FEEDBACK_CHANGED']),Date.now(),dup.job_id)
  // 重试耗尽后的冷却：§7「仍失败则撤出候选」——冷却期内窗口槽位如实显示，不再自动起新 job；
  // force=true 是操作者的显式重试，不受冷却限制
  const recentFail = conn.prepare(
    "SELECT job_id, status, finished_at FROM generation_jobs WHERE account_id = ? AND objective_id = ? AND status IN ('failed','rejected') ORDER BY finished_at DESC LIMIT 1")
    .get(accountId, objectiveId)
  if (!force && recentFail && Date.now() - (recentFail.finished_at ?? 0) < COOLDOWN_MS) {
    return { jobId: recentFail.job_id, cooledDown: true, status: recentFail.status,
      note: '这一课刚才没做成，过几分钟再试一次就行' }
  }
  const obj = conn.prepare('SELECT * FROM objective_versions WHERE objective_id = ? ORDER BY version DESC').get(objectiveId)
  if (!obj) throw new ApiError(404, 'OBJECTIVE_NOT_FOUND: ' + objectiveId)
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  // F8：输入带个人学习证据——证据版本、该目标当前状态/根因、最近错误样本与家族
  const states = conn.prepare('SELECT * FROM learner_states WHERE account_id = ? AND objective_id = ?').all(accountId, objectiveId)
  const failSamples = conn.prepare(
    `SELECT task_family_id, response FROM learner_attempts_v3
     WHERE account_id = ? AND json_extract(evaluation, '$.pass') = 0 ORDER BY created_at DESC LIMIT 3`).all(accountId)
  // 教学适配读取练习细节；这些记录不等同于能力认证或已确定根因。
  const feedbackRows = conn.prepare(`SELECT activity_id, task_family_id, objective_ids, conditions, evaluation, evaluation_status, created_at
    FROM learner_attempts_v3 WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`).all(accountId)
    .filter(r => JSON.parse(r.objective_ids || '[]').includes(objectiveId)).slice(0, 6)
  const recentPracticeFeedback = feedbackRows.map(r => {
    const e = JSON.parse(r.evaluation || '{}'), c = JSON.parse(r.conditions || '{}')
    return { activityId:r.activity_id, taskFamilyId:r.task_family_id, createdAt:r.created_at,
      evaluationStatus:r.evaluation_status, practiceOnly:e.keywordOnly === true, pass:e.pass ?? null,
      conditions:c, dimensions:(e.relations ?? []).map(d=>({id:d.id,label:d.label,hit:d.hit,required:d.required})) }
  })
  const lastDiag = conn.prepare("SELECT tentative FROM diagnostic_sessions WHERE account_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1").get(accountId)
  const evRow = conn.prepare('SELECT value FROM v3_counters WHERE account_id = ? AND name = ?').get(accountId, 'evidence')
  conn.prepare(
    `INSERT INTO generation_jobs (account_id, job_id, objective_id, strategy_id, input_spec, contract_version,
       status, created_at) VALUES (?,?,?,?,?,?, 'queued', ?)`,
  ).run(accountId, jobId, objectiveId, strategyId ?? null,
    JSON.stringify({
      objective: rowToObjective(obj), contract: GEN_CONTRACT_V1.version,
      // 31 第三批：内容版本签名——地图/来源命题变化 ⇒ 在途与未分发任务按失效处理
      contentSignature: contentSignature(),
      // 学习者单次明确确认的生成：完成后按 dev_only 开发样本直接可用（27 §5 暂无人审时
      // 先交付非正式可用体验），签审仍挂账、签署后转正
      userConfirmed,
      learnerEvidence: {
        evidenceVersion: evRow?.value ?? 0,
        practiceRevision: conn.prepare('SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id = ?').get(accountId).n,
        recentPracticeFeedback,
        states: states.map((x) => ({ skill: x.skill, complexity: x.complexity, state: x.state, flags: JSON.parse(x.flags || '[]') })),
        rootHypotheses: lastDiag?.tentative ? (JSON.parse(lastDiag.tentative).hypotheses ?? []) : [],
        recentFailSamples: failSamples.map((r) => ({ taskFamilyId: r.task_family_id, text: String(r.response || '').slice(0, 200) })),
      },
    }),
    GEN_CONTRACT_V1.version, Date.now())
  const p = Promise.resolve(runJob(jobId, { chat, semanticJudge }))
  if (!awaitIt) p.catch((e) => console.error('[v3gen] job', jobId, 'crashed:', e.message))
  return awaitIt ? p : { jobId }
}

async function runJob(jobId, { chat = chatWithMeta, semanticJudge = null } = {}) {
  const conn = ensureV3Schema()
  const job = () => conn.prepare('SELECT * FROM generation_jobs WHERE job_id = ?').get(jobId)
  conn.prepare("UPDATE generation_jobs SET status = 'running', attempts = attempts + 1 WHERE job_id = ?").run(jobId)
  const started = Date.now()
  const spec = JSON.parse(job().input_spec)
  const objective = spec.objective

  // C4：该账户最近 50 次作答的家族标签 + 内容指纹（改名换皮在这里现形）
  const recentRows = conn.prepare('SELECT task_family_id, activity_id FROM learner_attempts_v3 WHERE account_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(job().account_id)
  const groupRow = conn.prepare('SELECT g.complexity_band AS band FROM coverage_groups g WHERE g.group_id = ?')
    .get(objective.parentGroup)
  const learnerEvidence = spec.learnerEvidence ?? {}
  const ctx = {
    recentFamilies: [...new Set([...(learnerEvidence.recentFamilies ?? []), ...recentRows.map((r) => r.task_family_id).filter(Boolean)])],
    recentFingerprints: [...new Set(recentRows.map((r) => {
      const act = r.activity_id ? activityById(r.activity_id) : null
      return act ? activityFingerprint(act) : null
    }).filter(Boolean))],
    // F8：来源可用性按目标声明过的来源核验（标签≠事实核验，但不许越出已核范围）
    allowedSourceCodes: ['G1', 'G2', 'G3', 'G4', 'G5', 'C1', 'T'],
    objectiveDeclaredSources: [...new Set((objective.sourceRefs ?? []).map((r) => String(typeof r === 'string' ? r : (r.ref ?? '')).split(':')[0]).filter(Boolean))],
    sourceLedger: sourceLedger(),
    // F8：术语门带感知——band≤3 基础组禁术语；band≥5 高级组允许精确术语
    band: Number(groupRow?.band ?? 1),
    learnerEvidence,
    adaptation: teachingAdaptation(learnerEvidence.recentPracticeFeedback, {states:learnerEvidence.states,band:Number(groupRow?.band ?? 1)}),
    // 声音/口述目标的文本课不能记听力/口语证据（15 §5 技能不互升）——这类目标强制人审
    audioOralDependent: primarySkill(objective) !== 'reading' && primarySkill(objective) !== 'writing'
      || (Array.isArray(objective.flags) ? objective.flags : JSON.parse(objective.flags || '[]')).includes('needs_audio'),
    objectiveId: objective.objectiveId,
    // 38-S1：审核者要判"目标对齐"，必须拿到目标行为与边界（不是只有 ID）
    objectiveBehavior: objective.behavior ?? null,
    objectiveBoundary: objective.boundary ?? null,
  }

  let lastReasons = []
  let totalTokens = 0
  for (let attempt = 1; attempt <= 1 + MAX_RETRIES; attempt++) {
    try {
      const prompt = [
        GEN_CONTRACT_V1.system,
        `
目标：${objective.objectiveId} ${objective.name}
行为：${objective.behavior}
边界：${objective.boundary}`,
        `可用来源代号：${ctx.allowedSourceCodes.join('、')}`,
        `最近用过的任务家族（不得重复）：${ctx.recentFamilies.join('、') || '（无）'}`,
        `该目标声明过的来源（生成的 sourceRefs 只能从中选）：${ctx.objectiveDeclaredSources.join('、') || '（无）'}`,
        // 24 号补充：把账本里每个来源的**具体命题与边界**给模型——claim 要写账本里这条命题
        // 在本材料中的实际体现，不得转述成别的命题挂同一个代号（人审抓的就是这个）
        Object.entries(ctx.sourceLedger ?? {})
          .filter(([code]) => ctx.objectiveDeclaredSources.includes(code))
          .map(([code, s]) => `${code} 的命题：${s.claim}${s.limit ? `（边界：${s.limit}）` : ''}`)
          .join('\n') || '',
        // 术语规则与质量门一致：复杂度 <5 禁语法术语；≥5 允许精确术语（但"从句"仍要用白话解释到位）
        ctx.band >= 5 ? '允许精确语法术语，但术语旁必须跟白话解释。' : '禁止任何语法术语，全部用白话描述。',
        `本课教学调整约束（必须落实在任务和提示，不只改标题；复杂度不得越过 maxBand）：${JSON.stringify(ctx.adaptation)}`,
        // 31 第三批：已审素材池——每个活动必须设 materialId 绑定下列已审素材；待审素材不得绑定
        (() => {
          const m = materialsForPrompt(ctx.objectiveId)
          return [
            // 34-F1：生成器必须读到素材正文再出题——每段带 segmentId 原文
            `可用已审素材（含正文；每个活动的 materialId+segmentIds 必须从这里选）：${JSON.stringify(m.audited)}`,
            m.pendingReview.length ? `待审素材（不得绑定）：${JSON.stringify(m.pendingReview)}` : '',
            [
              '硬性要求（违反 → 整课拒收）：',
              '① 每个活动对象必须有：materialId、segmentIds（本题依据的段，从所选素材里选）、referenceAnswer（参考答案，≥8 字，必须是读懂正文才能写出的答案）、supportingQuotes（支撑句，≥1 条，逐字摘自所引 segmentIds 的正文，不得改写）。',
              '② 问题、参考答案、提示只能考正文里实际存在的信息；正文没有的信息一律不问（如正文没提未来计划就不能问未来计划）。',
              '③ 提示只能解释正文内容或 hintGuidance 里说的判断方法；禁止把标点/位置当判断规则（如"加逗号的多半在缩小范围"），禁止"前面是主张后面是限制"式固定位置规则。',
              '④ 各活动只测本目标边界内的能力，不得混入其他目标的题型（限定/非限定归 O-K115-01/02，不进对照与限制目标）。',
              '示例：{"taskFamilyId":"fam_x","materialId":"mat_g3_contrast_texts","segmentIds":["mat_g3_rehearsal"],"referenceAnswer":"团队保留了手势控制，但把语音控制推迟到展厅实测之后——限制是先在展厅验证，不是永久放弃。","supportingQuotes":["We kept the gesture controls, but we delayed voice control until we could test it with visitors in the exhibition hall."],"prompt":"…","hints":[…],"relations":[…]}',
            ].join('\n'),
          ].filter(Boolean).join('\n')
        })(),
        ctx.learnerEvidence.recentPracticeFeedback?.length ? `本目标近期练习反馈（关键词反馈只用于教学假设，不能视为能力认证；结合支持条件选择下一步）：${JSON.stringify(ctx.learnerEvidence.recentPracticeFeedback)}` : '',
        ctx.learnerEvidence.states?.length ? `学习者当前状态：${JSON.stringify(ctx.learnerEvidence.states)}` : '',
        ctx.learnerEvidence.rootHypotheses?.length ? `根因假设：${ctx.learnerEvidence.rootHypotheses.join('、')}` : '',
        ctx.learnerEvidence.recentFailSamples?.length ? `最近错误样本（据此选难度与策略，不得复读原句）：${JSON.stringify(ctx.learnerEvidence.recentFailSamples).slice(0, 500)}` : '',
      ].join('\n')
      // chat 统一返回 {text, finishReason, usage}；测试注入的纯字符串在这里归一化
      let raw, finishReason = 'stop'
      try {
        const out = await chat([{ role: 'user', content: prompt }], { maxTokens: 2000 })
        raw = typeof out === 'string' ? out : out.text
        finishReason = typeof out === 'string' ? (out.length >= 1950 ? 'length' : 'stop') : (out.finishReason ?? 'stop')
        totalTokens += (typeof out === 'object' && out?.usage?.total_tokens) || 0
      } catch (e) {
        // 传输/配置失败：明确 failed，不进重试循环（重试留给内容质量问题）
        conn.prepare("UPDATE generation_jobs SET status = 'failed', cost_tokens = ?, reject_reasons = ?, latency_ms = ?, finished_at = ? WHERE job_id = ?")
          .run(totalTokens, JSON.stringify(['模型服务失败: ' + String(e.message).slice(0, 120)]), Date.now() - started, Date.now(), jobId)
        return { jobId, status: 'failed' }
      }
      // 模型响应等待期间可能已产生新反馈；旧快照不能发布为当前个体课程。
      // 内容签名同样在此复核：比对**启动时落库的签名**与当前实时签名（行是启动事实，
      // 内存副本不是）；地图/来源命题变化 → 任务作废（31 第三批失效规则）。
      let storedSig
      try { storedSig = JSON.parse(job().input_spec).contentSignature } catch { storedSig = undefined }
      if (job().status === 'superseded'
        || !generationSnapshotCurrent(conn, job().account_id, learnerEvidence, storedSig)) {
        conn.prepare("UPDATE generation_jobs SET status='superseded',cost_tokens=?,reject_reasons=?,latency_ms=?,finished_at=? WHERE job_id=?")
          .run(totalTokens,JSON.stringify(['LEARNING_FEEDBACK_OR_CONTENT_CHANGED']),Date.now()-started,Date.now(),jobId)
        return {jobId,status:'superseded',published:false,reasons:['LEARNING_FEEDBACK_OR_CONTENT_CHANGED']}
      }
      let pkg
      try {
        pkg = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch {
        // 截断/坏 JSON：内容质量问题，走重试（llm.mjs 的 chatJson 对生产路径抛 LlmError，也落到外层 catch → 这里对 finishReason=length 单独归类）
        lastReasons = [`输出不是合法 JSON（疑似截断，finishReason=${finishReason}）`]
        continue
      }
      const gates = validateGeneratedPackage(pkg, ctx)
      if (!gates.allPassed) {
        lastReasons = rejectReasons(gates)
        if (finishReason === 'length') lastReasons.push('输出被截断（finishReason=length）：预算不足')
        continue
      }
      // 拒收通过 → 落活动 + 建课包。声音/口述目标的文本课：证据降级 + 强制人审
      const audioOral = ctx.audioOralDependent
      const activityIds = registerGeneratedActivities(jobId, pkg.activities.map((a) => ({
        ...a, objectiveIds: [objective.objectiveId],
        skillByObjective: { [objective.objectiveId]: primarySkill(objective) },
        role: 'practice', complexityBand: ctx.band,
        // 听力目标：默认视为已看稿 → 证据记 reading 不记 listening；口述目标：口语证据 W5 前不升
        ...(primarySkill(objective) === 'listening' ? { transcriptShownByDefault: true } : {}),
        ...(audioOral && primarySkill(objective) !== 'listening' ? { oralEvidenceDeferred: true } : {}),
      })))
      const lessonId = `gen-${objective.objectiveId.toLowerCase()}-v${Date.now().toString(36)}`
      const lessonSeed = {
        lessonId, version: 1, title: pkg.title, whyNow: pkg.whyNow, teachingNote: pkg.teachingNote,
        strategyId: spec.strategyId ?? 'short_explain',
        objectiveIds: [objective.objectiveId],
        difficultyDims: objective.complexityDims ?? [],
        activities: activityIds.map((id, i) => ({ activityId: id, role: 'practice', hintStages: (pkg.activities[i]?.hints ?? []).slice(1) })),
        nextCandidates: [], sourceRefs: pkg.sourceRefs.map((s) => typeof s === 'string'
          ? { ref: s, claim: null }
          : { ref: s.ref, claim: s.claim ?? null }), holdoutRef: null,
      }
      const lg = runQualityGates(lessonSeed, conn)
      if (!lg.allPassed) { lastReasons = rejectReasons(lg); continue }
      // C4（F3 残留）：个体内容按账户落 scope，不进 global——别人的定制课不该被第二个账户收到；
      // 公共化必须显式人审并另行提升通道，不走"生成即共享"
      insertGeneratedLesson(conn, lessonSeed, { jobId, gates: lg, accountScope: job().account_id })
      // 发布边界（§5）：目标未核验、模型自报新解释、或声音/口述依赖目标 → 一律只到 ready 等人审。
      // 已知局限：explanationKind 是模型自报，机器无法验证"是否新解释"——所以生成的课永远带
      // human_review=pending + dev_only + 抽检标记，通过 sampling 队列待人工抽样（见 validation.samplingQueued）。
      const needsSign = objective.verification !== 'claim_checked' || pkg.explanationKind === 'new' || audioOral
      // 36-R1：**内容语义审核**——机器门全绿不够（无关真实引用可绕过 quoteIntegrity）。
      // 审核对象绑定内容签名+审核对象哈希；结论记录进 validation。verdict：
      //   supported   = 完整审核输入 + 逐题四维度全部成立
      //   unsupported = 审核判定存在无依据问题/答案 → 不发布
      //   pending     = 输入缺依据/维度不全/无审核/审核失败 → 不发布（宁可不学，不给错误教材）
      const review = await runSemanticReview({ pkg, ctx, chat, judge: semanticJudge })
      // 38-S2：**审核返回后的发布前最终核对**——审核模型等待期间，学习证据可能前进、任务可能被
      // superseded、内容依赖可能变化。旧课程不得借迟到的好评发布。三项全过才进入发布：
      //   ① 任务状态仍 running（外部 supersede 不被覆盖——下面的写全部带 WHERE status='running'）
      //   ② 学习证据快照仍当前（审核期间的新作答 ⇒ 不发布）
      //   ③ 内容签名仍一致（审核期间素材/合同/来源变化 ⇒ 旧审核不给新内容背书）
      const finalCheckOk = job().status === 'running'
        && generationSnapshotCurrent(conn, job().account_id, learnerEvidence, storedSig)
        && review.contentSignature === contentSignature()
      if (!finalCheckOk) {
        // 带状态条件写：只有仍 running 的行才标记 superseded；已被外部 supersede 的行保持原状（可追溯）
        const r = conn.prepare("UPDATE generation_jobs SET status='superseded',cost_tokens=?,reject_reasons=?,latency_ms=?,finished_at=? WHERE job_id=? AND status='running'")
          .run(totalTokens, JSON.stringify(['INVALIDATED_DURING_REVIEW']), Date.now() - started, Date.now(), jobId)
        if (r.changes === 0) return { jobId, status: 'superseded', published: false, reasons: ['SUPERSEDED_DURING_REVIEW'] }
        return { jobId, status: 'superseded', published: false, reasons: ['INVALIDATED_DURING_REVIEW'] }
      }
      if (review.verdict !== 'supported') {
        conn.prepare("UPDATE generation_jobs SET status = 'succeeded', cost_tokens = ?, output_lesson_id = ?, output_version = 1, validation = ?, latency_ms = ?, finished_at = ? WHERE job_id = ? AND status = 'running'")
          .run(totalTokens, lessonId, JSON.stringify({ gates: lg, published: false, pending: 'content_semantic_review', semanticReview: review, samplingQueued: true }), Date.now() - started, Date.now(), jobId)
        return { jobId, status: 'succeeded', lessonId, published: false, pending: 'content_semantic_review', reasons: review.reasons ? [review.reasons] : [] }
      }
      if (needsSign && !spec.userConfirmed) {
        conn.prepare("UPDATE generation_jobs SET status = 'succeeded', cost_tokens = ?, output_lesson_id = ?, output_version = 1, validation = ?, latency_ms = ?, finished_at = ? WHERE job_id = ? AND status = 'running'")
          .run(totalTokens, lessonId, JSON.stringify({ gates: lg, published: false, pending: 'human_sign', semanticReview: review, samplingQueued: true }), Date.now() - started, Date.now(), jobId)
        return { jobId, status: 'succeeded', lessonId, published: false }
      }
      // 学习者确认（或无需签审）+ 语义审核通过 → dev_only **内容试验预览**可学：
      // 签审要求不消失（pending human_sign 照记），签署后升 mainline
      const { publishLesson } = await import('./v3lessons.mjs')
      publishLesson(lessonId, { acknowledgeUnreviewed: true, by: 'generator:' + (spec.userConfirmed ? 'userConfirmed:' : '') + jobId })
      // 38-S3：内容试验预览标记写进课包质量门记录——课程/推荐/恢复三处 UI 都从这里读同一事实
      conn.prepare('UPDATE lesson_versions SET quality_gates = ? WHERE lesson_id = ?')
        .run(JSON.stringify({ ...lg, contentPreview: true, humanSignPending: true }), lessonId)
      conn.prepare("UPDATE generation_jobs SET status = 'succeeded', cost_tokens = ?, output_lesson_id = ?, output_version = 1, validation = ?, latency_ms = ?, finished_at = ? WHERE job_id = ? AND status = 'running'")
        .run(totalTokens, lessonId, JSON.stringify({ gates: lg, published: true, channel: 'dev_only', contentPreview: true, pending: needsSign ? 'human_sign' : null, semanticReview: review, samplingQueued: true, explanationKindSelfReported: !spec.userConfirmed }), Date.now() - started, Date.now(), jobId)
      return { jobId, status: 'succeeded', lessonId, published: true, devSample: true, contentPreview: true }
    } catch (e) {
      // 解析类失败（生产 chatJson 式包装抛 LlmError）按内容质量问题重试；其余按管线异常也重试（有上限）
      lastReasons = ['管线异常: ' + String(e?.message).slice(0, 160) + (e instanceof LlmError ? '（解析/接口类，计入重试）' : '')]
    }
  }
  conn.prepare("UPDATE generation_jobs SET status = 'rejected', cost_tokens = ?, reject_reasons = ?, latency_ms = ?, finished_at = ? WHERE job_id = ?")
    .run(totalTokens, JSON.stringify(lastReasons), Date.now() - started, Date.now(), jobId)
  return { jobId, status: 'rejected', reasons: lastReasons }
}

function insertGeneratedLesson(conn, seed, { jobId, gates, accountScope }) { // 已由 runJob 校验并通过质量门
  conn.prepare(
    `INSERT INTO lesson_versions (account_scope, lesson_id, version, title, why_now, teaching_note, strategy_id,
       objective_ids, difficulty_dims, activity_refs, next_candidates, source_refs, holdout_ref, quality_gates,
       human_review, release_channel, content_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','dev_only','ready',?)`,
  ).run(
    accountScope ?? 'global', seed.lessonId, seed.version, seed.title, seed.whyNow, seed.teachingNote, seed.strategyId,
    JSON.stringify(seed.objectiveIds), JSON.stringify(seed.difficultyDims), JSON.stringify(seed.activities),
    JSON.stringify(seed.nextCandidates), JSON.stringify(seed.sourceRefs), seed.holdoutRef,
    JSON.stringify({ ...gates, generated: { jobId, contract: GEN_CONTRACT_V1.version } }), Date.now(),
  )
}

function primarySkill(objRow) {
  const skills = typeof objRow.skills === 'string' ? JSON.parse(objRow.skills || '{}') : (objRow.skills ?? {})
  return Object.keys(skills).find((k) => skills[k] === 'primary') ?? 'reading'
}

// ---------------------------------------------------------------- 课窗（2 完整课 + ≤4 候选）

/**
 * 每课后重估：目标位有已发布课 → 缓存；没有 → 起生成任务（同目标不重复排队）。
 * 返回窗口摘要（给前端"后继已备/正在准备"的诚实状态）。
 */
export function ensureWindow(accountId, { chat = chatWithMeta } = {}) {
  const conn = ensureV3Schema()
  reestimateWindow(accountId, 'window_read')
  const objectives = conn.prepare("SELECT * FROM objective_versions WHERE status != 'retired' ORDER BY objective_id").all().map(rowToObjective)
  const snapshot = buildLiteSnapshot(conn, accountId)
  const decision = decide(objectives, readStates(conn, accountId), snapshot)
  // F3：窗口只消费 eligibleRankedCandidates（notChosen/免修/缺前置不进生成队列）
  const order = [decision.primaryGoal, ...snap(decision.eligibleRankedCandidates ?? [])]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, WINDOW_LESSONS + WINDOW_CANDIDATES)

  const slots = []
  order.forEach((oid, slot) => {
    const wantLesson = slot < WINDOW_LESSONS
    const cached = conn.prepare("SELECT * FROM lesson_cache WHERE account_id = ? AND objective_id = ? AND status = 'ready'")
      .get(accountId, oid)
    const cachedLesson = cached && getLesson(cached.lesson_id)
    const cacheUsable = cachedLesson && lessonApplicable(accountId,cachedLesson) && cachedLesson.contentStatus === 'published'
      && cachedLesson.version === cached.version && cachedLesson.objectiveIds.includes(oid)
      && (!cachedLesson.accountScope || cachedLesson.accountScope === 'global' || cachedLesson.accountScope === accountId)
      && !conn.prepare("SELECT 1 FROM plan_decisions WHERE account_id = ? AND served_lesson_id = ? AND status = 'completed'").get(accountId, cached.lesson_id)
    if (cached && !cacheUsable) conn.prepare("UPDATE lesson_cache SET status = 'invalidated', invalidated_reason = 'lesson_unavailable_or_changed' WHERE account_id = ? AND objective_id = ? AND lesson_id = ? AND status = 'ready'").run(accountId, oid, cached.lesson_id)
    if (cacheUsable) {
      slots.push({ slot, objectiveId: oid, lessonId: cached.lesson_id, status: 'ready', kind: wantLesson ? 'lesson' : 'candidate' })
      return
    }
    const obj = objectives.find((o) => o.objectiveId === oid)
    // F3：课程按主目标匹配（真实版本）；R2：策略兜底必须含该目标——不借别的目标的课
    const existing = lessonForObjective(oid, { excludeCompletedFor: accountId })
      ?? (slot === 0 && snapshot.diagnostic?.strategyId
        && lessonForStrategy(snapshot.diagnostic.strategyId, { excludeCompletedFor: accountId, mustIncludeObjective: oid }) || null)
    if (existing?.lessonId) {
      cacheLesson(accountId, oid, existing.lessonId, existing.version ?? 1, slot)
      slots.push({ slot, objectiveId: oid, lessonId: existing.lessonId, status: 'ready', kind: wantLesson ? 'lesson' : 'candidate' })
      return
    }
    if (!wantLesson) { slots.push({ slot, objectiveId: oid, status: 'candidate_position_only' }); return }
    try {
      const job = startGenerationJob(accountId, { objectiveId: oid, strategyId: obj?.strategies?.[0], chat })
      slots.push({ slot, objectiveId: oid, jobId: job.jobId, jobReused: !!job.reused, cooledDown: !!job.cooledDown, status: job.cooledDown ? 'generation_cooldown' : 'generating' })
    } catch (e) {
      if (String(e.message).startsWith('GENERATION_DISABLED')) {
        slots.push({ slot, objectiveId: oid, status: 'generation_disabled', note: '设 ENGLISHFORGE_V4_GENERATION=1 开启按需生成' })
      } else if (String(e.message).startsWith('GENERATION_COOLDOWN')) {
        slots.push({ slot, objectiveId: oid, status: 'generation_cooldown', note: '刚做过一次没成功，稍等几分钟再试' })
      } else throw e
    }
  })
  return { accountId, windowVersion: getMeta(accountId, 'window_version') ?? 0, slots, stock: generationStock(accountId) }
}

function snap(arr) { return Array.isArray(arr) ? arr : [] }

function readStates(conn, accountId) {
  const map = new Map()
  // 只读 base 聚合行（跨带最弱合并）；band 行是展示/审计粒度，不直接进决策
  for (const s of conn.prepare("SELECT * FROM learner_states WHERE account_id = ? AND complexity = 'base'").all(accountId)) {
    map.set(`${s.objective_id}|${s.skill}`, { objectiveId: s.objective_id, skill: s.skill, state: s.state, flags: JSON.parse(s.flags || '[]') })
  }
  return map
}

function buildLiteSnapshot(conn, accountId) {
  const recent = conn.prepare('SELECT activity_id, task_family_id, role, objective_ids, evaluation, created_at FROM learner_attempts_v3 WHERE account_id = ? ORDER BY created_at DESC LIMIT 10').all(accountId)
    .map((r) => ({ activityId: r.activity_id, taskFamilyId: r.task_family_id, role: r.role, objectiveIds: JSON.parse(r.objective_ids || '[]'), pass: JSON.parse(r.evaluation || '{}')?.pass ?? null, createdAt: r.created_at }))
  const lastDiag = conn.prepare("SELECT tentative FROM diagnostic_sessions WHERE account_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1").get(accountId)
  return {
    mapVersion: 'map-v1', evidenceVersion: evVersion(conn, accountId), states: [...readStates(conn, accountId).values()],
    recentAttempts: recent, diagnostic: lastDiag?.tentative ? JSON.parse(lastDiag.tentative) : null,
    disputedActivities: JSON.parse(getMeta(accountId, 'disputed_activities') || '[]'),
    waivers: [...readStates(conn, accountId).values()].filter((s) => s.flags.includes('waived_by_user')).map((s) => ({ objectiveId: s.objectiveId, skill: s.skill })),
    objectiveCount: 0,
  }
}

function generationSnapshotCurrent(conn, accountId, snapshot, storedContentSignature) {
  const feedbackCurrent = snapshot && snapshot.evidenceVersion === evVersion(conn,accountId)
    && snapshot.practiceRevision === conn.prepare('SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id=?').get(accountId).n
  // 31 第三批：内容签名失效——地图/来源命题变化 ⇒ 旧签名任务不再算当前（历史无签名不追溯）
  const contentCurrent = storedContentSignature === undefined || storedContentSignature === contentSignature()
  return feedbackCurrent && contentCurrent
}

function evVersion(conn, accountId) {
  const row = conn.prepare('SELECT value FROM v3_counters WHERE account_id = ? AND name = ?').get(accountId, 'evidence')
  return row ? row.value : 0
}

export function cacheLesson(accountId, objectiveId, lessonId, version, slot) {
  const conn = ensureV3Schema()
  const revision = conn.prepare('SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id=?').get(accountId).n
  conn.prepare(`INSERT INTO lesson_cache (account_id, objective_id, lesson_id, version, slot, status, created_at, practice_revision)
    VALUES (?,?,?,?,?,'ready',?,?)
    ON CONFLICT(account_id,objective_id,lesson_id) DO UPDATE SET version=excluded.version,slot=excluded.slot,
      status='ready',created_at=excluded.created_at,practice_revision=excluded.practice_revision,invalidated_reason=NULL
    WHERE lesson_cache.status != 'ready' OR lesson_cache.version != excluded.version`)
    .run(accountId, objectiveId, lessonId, version, slot, Date.now(), revision)
}

/**
 * T6：新证据作废缓存。每课后（或显式触发）比对证据版本：缓存建立时的证据版本
 * 已过期 → invalidated + 原因；作废计数进指标。
 */
export function reestimateWindow(accountId, trigger = 'manual') {
  const conn = ensureV3Schema()
  const currentVersion = evVersion(conn, accountId)
  const rows = conn.prepare("SELECT rowid, objective_id, lesson_id, slot, created_at, practice_revision FROM lesson_cache WHERE account_id = ? AND status = 'ready'").all(accountId)
  let invalidated = 0
  for (const r of rows) {
    // 缓存建立后若证据前进（任何新尝试/事件），旧缓存课必须重估（可保留也可作废；v1 从严：一律作废重算）
    const eventsAfter = conn.prepare('SELECT COUNT(*) AS n FROM evidence_events WHERE account_id = ? AND created_at > ?')
      .get(accountId, r.created_at).n
    const practiceAfter = r.practice_revision == null
      ? conn.prepare('SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id = ? AND created_at > ?').get(accountId, r.created_at).n
      : Math.max(0,conn.prepare('SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id = ?').get(accountId).n - r.practice_revision)
    if (eventsAfter > 0 || practiceAfter > 0) {
      conn.prepare("UPDATE lesson_cache SET status = 'invalidated', invalidated_reason = ? WHERE rowid = ?")
        .run(`learning_feedback_changed:evidence=${currentVersion}:practice=${practiceAfter}:trigger=${trigger}`, r.rowid)
      invalidated++
    }
  }
  const v = (getMeta(accountId, 'window_version') ?? 0) + (invalidated > 0 ? 1 : 0)
  setMeta(accountId, 'window_version', v)
  return { windowVersion: v, invalidated, currentVersion }
}

// ---------------------------------------------------------------- 指标（§7：时延/费用/拒收/弃用）

export function generationMetrics(accountId) {
  const conn = ensureV3Schema()
  const one = (sql, ...a) => conn.prepare(sql).get(...a)
  const jobs = one(`SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ?`, accountId).n
  const ok = one(`SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ? AND status = 'succeeded'`, accountId).n
  const rejected = one(`SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ? AND status = 'rejected'`, accountId).n
  const failed = one(`SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ? AND status = 'failed'`, accountId).n
  const lat = one(`SELECT AVG(latency_ms) AS v, SUM(cost_tokens) AS t FROM generation_jobs WHERE account_id = ? AND finished_at IS NOT NULL`, accountId)
  const inv = one(`SELECT COUNT(*) AS n FROM lesson_cache WHERE account_id = ? AND status = 'invalidated'`, accountId).n
  const running = conn.prepare(`SELECT job_id, objective_id, status FROM generation_jobs WHERE account_id = ? AND status IN ('queued','running')`).all(accountId)
  return {
    jobs, succeeded: ok, rejected, failed,
    superseded: one("SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id=? AND status='superseded'",accountId).n,
    rejectionRate: jobs ? +(rejected / jobs).toFixed(2) : 0,
    avgLatencyMs: Math.round(lat.v ?? 0),
    totalCostTokens: lat.t ?? 0,
    invalidatedCache: inv,
    inFlight: running,
    note: '时延/拒收率/弃用计数/在途已实现；费用=token 数（真实调用写入，fixture 为 0）。未实现：撤回率与生成课的关联、用户等待时间（§7 差距，如实标注）',
  }
}

/** 31 第三批：个体生成库存（只读计数，无副作用）——页面诚实显示"能学/待人审/失败冷却/未开启"。
 * ready=已发布未完成的个体生成课；pendingReview=生成成功但等人审签署；failedCooldown=冷却期内失败。 */
export function generationStock(accountId) {
  const conn = ensureV3Schema()
  const genPrefix = 'gen-%'
  const done = conn.prepare("SELECT COUNT(*) AS n FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id LIKE ?")
    .get(accountId, genPrefix).n
  const published = conn.prepare("SELECT COUNT(*) AS n FROM lesson_versions WHERE account_scope = ? AND content_status = 'published' AND lesson_id LIKE ?")
    .get(accountId, genPrefix).n
  const pendingReview = conn.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ? AND status = 'succeeded' AND output_lesson_id IS NOT NULL AND validation LIKE '%human_sign%'")
    .get(accountId).n
  const failedCooldown = conn.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ? AND status IN ('failed','rejected') AND finished_at > ?")
    .get(accountId, Date.now() - COOLDOWN_MS).n
  return {
    disabled: !['1', 'true'].includes(String(process.env.ENGLISHFORGE_V4_GENERATION ?? '')),
    ready: Math.max(0, published - done),
    pendingReview,
    failedCooldown,
  }
}

export function listJobs(accountId, limit = 20) {
  // 38-S3：validation 解析出 published/pending/semanticVerdict——前端恢复页不用再解析 JSON 串，
  // "succeeded 但没课"（审核未过）有明确字段可判，不再当成成功却无课
  return ensureV3Schema().prepare('SELECT job_id, objective_id, strategy_id, status, attempts, output_lesson_id, validation, reject_reasons, latency_ms, cost_tokens, created_at, finished_at FROM generation_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(accountId, limit).map((j) => {
      let v = null
      try { v = JSON.parse(j.validation || 'null') } catch { v = null }
      return { ...j, published: v?.published ?? null, pending: v?.pending ?? null, semanticVerdict: v?.semanticReview?.verdict ?? null }
    })
}

