import { taskForAttempt, taskPlayCount } from './v3tasks.mjs'
// W2：学习证据合同（docs/curriculum-v4/15 §4–§5、13 §14）。
//
// 核心不变量：
// · 尝试只追加且幂等：同 attemptId 同正文重放返回首次结果；同 ID 异正文 409；
// · 状态可从 evidence_events 重放重建；争议不是删除，而是追加 dispute 事件并暂停更新；
// · 一次正确不认证：首见独立成功只到 trained；≥2 个不同家族才 independent；
//   transfer 角色跨家族成功才 transferred；retained 在 W2 不可达（需要延迟任务）；
// · 不同技能不互升：字幕/校对稿下的表现记 reading，永不升级 listening；
//   口语证据在真录音接入前（W5）保持 unmeasured；
// · holdout 的答案与维度明细永不下发，推荐课永不引用 holdout。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError, getDb } from './db.mjs'
import { ensureV3Schema, getMeta, setMeta, nextCounter, getCounter } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { audioPublicInfo, audioByMediaId } from './v3audio.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ACT_PATH = resolve(HERE, 'data', 'v3-activities.json')

let actCache = null
export function loadActivities() {
  if (!actCache) actCache = JSON.parse(readFileSync(ACT_PATH, 'utf8'))
  return actCache.activities
}
export function activityById(id) {
  const staticHit = loadActivities().find((a) => a.activityId === id)
  if (staticHit) return staticHit
  try { // W4 生成活动落库后与静态注册表同形（静态优先，保证 fixture 稳定）
    const row = ensureV3Schema().prepare('SELECT definition FROM generated_activities WHERE activity_id = ?').get(id)
    return row ? JSON.parse(row.definition) : null
  } catch { return null }
}

/** 学习者可见的活动视图：没有评估合同、没有答案、没有关系清单 */
export function publicActivity(a) {
  if (!a) return null
  const audio = audioPublicInfo(a)
  // D0-1：封闭槽位题只下发槽位结构（slotId/题干/合法选项）；accept（正确答案）绝不下发
  const slots = Array.isArray(a.evaluationContract?.slots)
    ? a.evaluationContract.slots.map((s) => ({ slotId: s.slotId, prompt: s.prompt, options: s.options }))
    : null
  return {
    activityId: a.activityId, version: a.version, role: a.role, taskFamilyId: a.taskFamilyId,
    objectiveIds: a.objectiveIds, responseKind: a.responseKind, prompt: a.prompt, hints: a.hints,
    simulatesAudio: !!a.simulatesAudio, conditionsSpec: a.conditionsSpec,
    oralTask: !!a.oralEvidenceDeferred,
    slots,
    reasonLabel: a.evaluationContract?.reason?.label ?? null,
    audio, // synthetic 合成音频（21 §6.2）：mediaId/声源标注/时长；无音频时为 null
    fixtureNotice: audio ? null
      : (a.simulatesAudio || a.oralEvidenceDeferred || a.locating || a.holdout)
        ? '开发 fixture：仅用于验收，正式材料见 18 号文档的发布检查表' : null,
  }
}

// ---------------------------------------------------------------- 评估（确定性合同）

function norm(s) {
  // 分句标点归一为哨兵 '|'（而不是空格）：否定扫描靠它找分句边界；锚点本身不含标点，匹配不受影响
  return String(s ?? '').toLowerCase().replace(/[，。！？、；：""''（）,.!?;:'"()]/g, '|').replace(/\s+/g, ' ')
}

// 否定判定（21§4）：多字否定词与英文否定在 14 字窗口内都算；中文单字否定词只认锚点前 3 字
// 的紧邻——否则"表现不好 他们想再测试"里的"不"会把远处的"再测试"误标成否定（实测踩过）。
const NEGATION_STRONG = ['并非', '并未', '没有', '不是', '不再', '不会', '不能', '并不是', '并没有', '并不会', '不等于', '不算', '没完全', '未完全', "n't", 'never', 'neither']
const NEGATION_LIGHT = ['不', '没', '未', '无', '别']

/** 锚点前文的否定扫描。返回 {negated, ambiguous}：
 * - 分句边界截断：14 字窗里最后有分句标点则只看边界之后（"…没有空间，团队保留了手势"的
 *   "没有"属上一分句，复审 P2 实测跨句误伤）；
 * - "not only" 是递进不是否定；
 * - 多个否定记号（"并不是不保留"类双否定）机器定不了极性 → ambiguous=true，调用方转争议，
 *   不硬判（20 号 F4：无法可靠判断应 disputed）。 */
/** 窗口内否定记号计数（重叠感知：STRONG 命中的片段不再按 LIGHT 单字重复计数——
 * "没有"=1 个记号，不是"没"+"有"） */
function countNegMarks(window) {
  let marks = 0
  let i = 0
  while (i < window.length) {
    const strong = NEGATION_STRONG.find((n) => window.startsWith(n, i))
    if (strong) { marks++; i += strong.length; continue }
    if (NEGATION_LIGHT.some((n) => window.startsWith(n, i))) { marks++; i += 1; continue }
    i++
  }
  return marks
}

function negationScan(text, at) {
  let window = text.slice(Math.max(0, at - 14), at)
  const cut = window.lastIndexOf('|') // norm 后的分句边界哨兵
  if (cut >= 0) window = window.slice(cut + 1)
  const notOnly = /(^|[^a-z])not only/.test(window)
  const englishNot = !notOnly && /(^|[^a-z])not([^a-z]|$)/.test(window)
  const marks = countNegMarks(window) + (englishNot ? 1 : 0)
  if (marks === 0) {
    const adjacent = text.slice(Math.max(0, at - 3), at)
    return { negated: NEGATION_LIGHT.some((n) => adjacent.includes(n)), ambiguous: false }
  }
  // 单个否定记号=极性明确；两个及以上（"并不是不保留"类双否定）机器定不了 → 争议
  return { negated: true, ambiguous: marks >= 2 }
}

export function evaluateAttempt(activity, response) {
  const c = activity.evaluationContract
  if (!c) return { status: 'pending', evaluation: null }
  const text = norm(typeof response === 'string' ? response : response?.text)
  // R3（24 号）+ D0-1（27 号）：认证级别。'closed'＝结构化槽位题（slotId/options/accept），
  // 答案空间受控、逐槽判，可以写掌握证据；'keyword'＝开放文本词表匹配，**只能给练习反馈**——
  // bag/同义反转词表判不了关系是否成立。默认 keyword：不写掌握正分。
  const certification = c.slots ? 'closed' : (activity.certification ?? 'keyword')

  // 锚点命中扫描（21§4 收尾）：同一锚点可能出现多次，逐次看前置 14 字窗口里的否定词。
  // mode: 'any' 出现即命中 | 'nonNegated' 至少一次非否定出现（关系为真才会说的话）
  // | 'negated' 至少一次否定语境出现（关系本身是"否定了某主张"，如"并未放弃"）
  const anchorHit = (needle, mode) => {
    let from = 0
    let sawNonNeg = false
    let sawNeg = false
    let ambiguous = false
    while (true) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      const scan = negationScan(text, at)
      if (scan.ambiguous) ambiguous = true // 极性定不了的出现：不参与命中，也不算违规
      else if (scan.negated) sawNeg = true
      else sawNonNeg = true
      from = at + needle.length
    }
    const present = sawNonNeg || sawNeg || ambiguous
    if (mode === 'nonNegated') return { hit: sawNonNeg, ambiguous: ambiguous && !sawNonNeg, present }
    if (mode === 'negated') return { hit: sawNeg, ambiguous: ambiguous && !sawNeg, present }
    return { hit: sawNonNeg || sawNeg, ambiguous: ambiguous && !(sawNonNeg || sawNeg), present }
  }
  const modeOf = (r) => (r.polarity === 'negated' ? 'negated' : (r.negationAware ? 'nonNegated' : 'any'))

  // D0-1（27 号）/N1（26 号）：结构化槽位判题——逐槽独立，全选/错序/漏槽/未知选项都过不了；
  // 单个槽正确只影响它归属的目标；理由栏（可选）独立评估，理由有争议 → 整题 disputed，
  // 不能因为选择对就把争议理由也认证掉。文本反匹配（在句子里搜代号）彻底废弃。
  if (c.slots) {
    const answers = (response && typeof response === 'object' && !Array.isArray(response)) ? response.answers : null
    const code = (v) => (typeof v === 'string' ? norm(v).replace(/[^a-z0-9]/g, '') : null)
    const slotResults = c.slots.map((s) => {
      const given = answers ? answers[s.slotId] : undefined
      const g = Array.isArray(given) ? null : code(given)
      const opts = s.options.map(code)
      const status = given === undefined || given === null || given === ''
        ? 'missing'
        : Array.isArray(given) ? 'multiple'
          : !opts.includes(g) ? 'invalid'
            : g === code(s.accept) ? 'correct' : 'wrong'
      return { slotId: s.slotId, prompt: s.prompt, given: Array.isArray(given) ? '[multiple]' : (given ?? null), status }
    })
    const bySlot = Object.fromEntries(slotResults.map((r) => [r.slotId, r]))
    const allCorrect = slotResults.every((r) => r.status === 'correct')

    // 理由栏（可选）：复用关系锚点的否定感知扫描，但结论独立于槽位
    const rc = c.reason ?? null
    const relScansR = (rc?.relations ?? []).map((r) => {
      let hit = false
      let present = 0
      let ambiguousCount = 0
      for (const k of r.anyOf) {
        const one = anchorHit(norm(k), modeOf(r))
        if (!one.present) continue
        present++
        if (one.hit) { hit = true; break }
        if (one.ambiguous) ambiguousCount++
        else break
      }
      return { rel: r, hit, allAmbiguous: present > 0 && ambiguousCount === present }
    })
    const reasonRelations = relScansR.map(({ rel, hit }) => ({
      id: rel.id, label: rel.label, required: !!rel.required, hit,
      objectiveIds: Array.isArray(rel.objectiveIds) ? rel.objectiveIds : null,
    }))
    const mustNotMode = c.mustNotNegationGuard === false ? 'any' : 'nonNegated'
    const reasonViolated = (rc?.mustNot ?? []).filter((m) => m.anyOf.some((k) => anchorHit(norm(k), mustNotMode).hit)).map((m) => m.label)
    const reasonAmbiguous = relScansR.some(({ hit, allAmbiguous }) => !hit && allAmbiguous)
    const reasonReqOk = reasonRelations.filter((r) => r.required).every((r) => r.hit)

    const objectiveResults = {}
    for (const oid of activity.objectiveIds) {
      const mine = c.slots.filter((s) => (s.objectiveIds ?? activity.objectiveIds).includes(oid))
      const slotOk = mine.length > 0 && mine.every((s) => bySlot[s.slotId].status === 'correct')
      const reasonMine = !!rc && (rc.objectiveIds ?? activity.objectiveIds).includes(oid)
      const rViolMine = reasonMine ? reasonViolated.filter((label) =>
        (rc.mustNot ?? []).some((m) => m.label === label && (m.objectiveIds ?? rc.objectiveIds ?? activity.objectiveIds).includes(oid))) : []
      // A1（29 号）：开放理由的语义与冲突词表判不了，不参与 met 认证——
      // 槽位对 = 选择定位成功 → partial（理由/自由表达本次未测，待人审或后续把理由封闭化）；
      // 槽错或踩 mustNot → unmet。无 reason 合同的纯封闭题（如 ct01/ct02）槽全对即 met。
      objectiveResults[oid] = !slotOk || rViolMine.length > 0 ? 'unmet'
        : reasonMine ? 'partial'
          : 'met'
    }

    const evaluation = {
      pass: allCorrect && reasonReqOk && reasonViolated.length === 0,
      dimensions: c.dimensions,
      slotResults,
      relations: reasonRelations,
      mustNotViolations: reasonViolated,
      objectiveResults,
      certification,
      slots: true,
      reasonAssessed: !rc, // false = 该活动的理由栏未参与认证（本次未测理由/自由表达）
      evaluator: 'deterministic-contract-v2',
      evaluatorVersion: 'deterministic-contract-v2',
      confidence: 'fixture',
    }
    // 理由争议：整题转人工复核，不给任何目标写 met（26 号 N1 验收）
    if (reasonAmbiguous) return { status: 'disputed', evaluation: { ...evaluation, reason: 'NEGATION_AMBIGUOUS' } }
    return { status: 'evaluated', evaluation }
  }
  const relScans = c.relations.map((r) => {
    let hit = false
    let present = 0
    let ambiguousCount = 0
    for (const k of r.anyOf) {
      const one = anchorHit(norm(k), modeOf(r))
      if (!one.present) continue // 锚点没出现：不算命中也不算歧义（缺席≠歧义）
      present++
      if (one.hit) { hit = true; break }
      if (one.ambiguous) ambiguousCount++
      else break // 出现且极性明确但未命中 → 干净的未命中
    }
    return { rel: r, hit, allAmbiguous: present > 0 && ambiguousCount === present }
  })
  // R1（24 号）：**保留原始关系的 objectiveIds 归属**——之前只留 id/label/required/hit，
  // 逐目标结果读不到归属、全部回落到活动目标，A/B 两目标的 成绩互相混算
  const relations = relScans.map(({ rel, hit }) => ({
    id: rel.id, label: rel.label, required: !!rel.required, hit,
    objectiveIds: Array.isArray(rel.objectiveIds) ? rel.objectiveIds : null,
  }))
  // 双否定类歧义：某关系的全部锚点出现都定不了极性且未命中 → 整题转争议，不硬判
  const negationAmbiguous = relScans.some(({ hit, allAmbiguous }) => !hit && allAmbiguous)
  // mustNot 否定语境守卫（F4/21§4）：“并未完全放弃”不是“完全放弃”。至少一次非否定出现才算违规；
  // 活动可用 mustNotNegationGuard:false 显式退出守卫（现为所有库内活动的默认开）
  const mustNotMode = c.mustNotNegationGuard === false ? 'any' : 'nonNegated'
  const violated = (c.mustNot ?? []).filter((m) => m.anyOf.some((k) => anchorHit(norm(k), mustNotMode).hit)).map((m) => m.label)
  const requiredOk = relations.filter((r) => r.required).every((r) => r.hit)
  const pass = requiredOk && violated.length === 0
  // 逐目标结果（F4/21§1）：活动级 pass 只控流程；每个目标按其归属关系单独判
  const tagOf = (r) => r.objectiveIds ?? activity.objectiveIds // 未标注的关系保持旧行为（全部归属）
  const objectiveResults = {}
  for (const oid of activity.objectiveIds) {
    const mine = relations.filter((r) => tagOf(r).includes(oid))
    const iViolated = (c.mustNot ?? []).some((m) => (m.objectiveIds ?? activity.objectiveIds).includes(oid) &&
      violated.includes(m.label))
    if (!mine.length || (c.unmeasuredObjectives ?? []).includes(oid)) { objectiveResults[oid] = 'unmeasured'; continue }
    const req = mine.filter((r) => r.required)
    const hits = req.filter((r) => r.hit).length
    if (iViolated) objectiveResults[oid] = 'unmet'
    else if (req.length && hits === req.length) objectiveResults[oid] = 'met'
    else if (hits > 0 || mine.some((r) => r.hit)) objectiveResults[oid] = 'partial'
    else objectiveResults[oid] = 'unmet'
  }
  const evaluation = {
    pass,
    dimensions: c.dimensions,
    relations,
    mustNotViolations: violated,
    objectiveResults,
    certification, // 'keyword'：开放文本词表匹配——练习反馈可以，掌握证据不行（R3）
    keywordOnly: certification === 'keyword',
    evaluator: 'deterministic-contract-v1',
    evaluatorVersion: 'deterministic-contract-v1',
    confidence: 'fixture', // 开发合同，不是校准过的评分器
  }
  // 双否定类歧义：机器定不了极性 → 争议待复核，不硬判对错（也不写正分证据）
  if (negationAmbiguous && !pass) {
    return { status: 'disputed', evaluation: { ...evaluation, reason: 'NEGATION_AMBIGUOUS' } }
  }
  return { status: 'evaluated', evaluation }
}

// ---------------------------------------------------------------- 尝试落库

const STATE_RANK = { unmeasured: 0, tentative: 1, trained: 2, independent: 3, transferred: 4, retained: 5 }

function disputedActivities(accountId) {
  return JSON.parse(getMeta(accountId, 'disputed_activities') || '[]')
}

function bodyHash(payload) {
  return createHash('sha256').update(JSON.stringify({
    task: payload.taskId ?? null, session: payload.sessionId ?? null, a: payload.activityId, r: payload.response ?? null, c: payload.conditions ?? null,
  })).digest('hex')
}

/**
 * POST /api/v1/accounts/:id/attempts 的实现。
 * 先落库再评估；返回里只有结论，没有答案 —— holdout 更是只给 pass/fail。
 */
export function recordAttempt(accountId, payload = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const attemptId = String(payload.attemptId || '')
  if (!attemptId) throw new ApiError(400, 'ATTEMPT_ID_REQUIRED')
  const activity = activityById(String(payload.activityId || ''))
  if (!activity) throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED: ' + payload.activityId)
  // C4 纵深：生成活动是账户私有内容（课已按 scope 隔离，活动本身也要）——他人的生成题
  // 对本账户不可见；查不到所属 job 的孤儿生成活动同样不可见（复审 P3 实测可跨账户直答）
  const genRow = getDb().prepare('SELECT job_id FROM generated_activities WHERE activity_id = ?').get(activity.activityId)
  if (genRow) {
    const job = getDb().prepare('SELECT account_id FROM generation_jobs WHERE job_id = ?').get(genRow.job_id)
    if (!job || job.account_id !== accountId) throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED: ' + payload.activityId)
  }

  // 幂等：同 ID 同正文 → 原样返回首次结果；同 ID 异正文 → **自动分配下一轮 take 落新行**
  //（R5 补丁：学生在课程里答错后刷新页面，客户端 take 计数会归零，再次提交带着同一首轮 ID
  // 但内容不同——老的 409 会把学生永久卡住。每次作答都落新行、历史不覆盖；响应带 attemptIdUsed）
  const issuedTask = payload.taskId ? taskForAttempt(accountId, payload.taskId, activity.activityId) : null
  if (issuedTask && issuedTask.session_id !== String(payload.sessionId || '')) throw new ApiError(400, 'ISSUED_TASK_SESSION_MISMATCH')
  const hash = bodyHash(payload)
  const prev = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)
  let effectiveAttemptId = attemptId
  if (prev && payload.taskId && prev.issued_task_id !== payload.taskId) throw new ApiError(409,'ATTEMPT_TASK_MISMATCH')
  if (prev && payload.taskId && prev.body_hash !== hash) throw new ApiError(409,'NEW_TAKE_ID_REQUIRED')
  if (prev) {
    if (prev.body_hash === hash) {
      // F6：幂等重放返回首次结果且标记 replayed —— 调用方不得再次推进诊断/流程
      return { attemptIdUsed: attemptId, ...attemptResult(conn, accountId, prev, activityById(prev.activity_id)), replayed: true }
    }
    // 29 号 A2 护栏：真正的新作答才 bump。同内容重发在网络重试场景可能已落过 -tN 行——
    // 只看 ID 占用会让"重发相同内容"再落新行（复审实测 Y→t2→Y→t3）。
    // 因此先按内容幂等回查：同账户同活动同正文的行已存在 → 幂等返回那一次。
    const sameBody = conn.prepare(
      'SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND body_hash = ? AND activity_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(accountId, hash, activity.activityId)
    if (sameBody) {
      return { attemptIdUsed: sameBody.attempt_id, ...attemptResult(conn, accountId, sameBody, activity), replayed: true }
    }
    const m = attemptId.match(/^(.*?)-t(\d+)$/)
    const base = m ? m[1] : attemptId
    let n = m ? Math.max(2, Number(m[2]) + 1) : 2
    while (conn.prepare('SELECT 1 FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, `${base}-t${n}`)) n++
    effectiveAttemptId = `${base}-t${n}`
  }

  // F1：声明口语录音作答就必须真的带了录音引用（缺录音不得产生口语证据）
  if (payload.conditions?.responseMode === 'oral_recording' && !payload.response?.mediaId) {
    throw new ApiError(400, 'ORAL_RECORDING_REQUIRED: responseMode=oral_recording 需要 mediaId')
  }
  const conditions = payload.conditions ?? null
  if (!conditions || typeof conditions !== 'object') throw new ApiError(400, 'CONDITIONS_REQUIRED')
  for (const k of activity.conditionsSpec ?? []) {
    if (!(k in conditions)) throw new ApiError(400, 'CONDITIONS_INCOMPLETE: missing ' + k)
  }
  // 服务端覆盖客户端自报（15 §12）：首见看库里有没有作答过；提示层数看揭示记录；
  // 默认给稿的活动 transcriptShown 强制为 true。客户端谎报"无提示首见"换不来独立证据。
  const hintRevealed = conn.prepare(
    'SELECT COALESCE(MAX(level), 0) AS m FROM activity_support_events WHERE account_id = ? AND activity_id = ? AND kind = ?')
    .get(accountId, activity.activityId, 'hint')?.m ?? 0
  const seenBefore = !!conn.prepare('SELECT 1 FROM learner_attempts_v3 WHERE account_id = ? AND activity_id = ?')
    .get(accountId, activity.activityId)
  const effectiveConditions = { ...conditions }
  effectiveConditions.hintLevel = Math.max(Number(conditions.hintLevel ?? 0) || 0, hintRevealed)
  effectiveConditions.transcriptShown = !!conditions.transcriptShown || !!activity.transcriptShownByDefault
  effectiveConditions.firstExposure = !!conditions.firstExposure && !seenBefore
  // 客户端自报不提升证据：角色/家族/目标/版本一律以服务端注册表为准
  const responseText = String(payload.response?.text ?? payload.response ?? '').slice(0, 4000)

  // R4（24 号）：听力任务的作答必须先有**服务端记录的播放事件**——"活动带 audioRef"不等于
  // 听过。UI 点播放会 POST /support/play 落事件；没有播放记录的提交直接拒绝（不给练习分）
  const listensByEar = activity.audioRef
    && Object.values(activity.skillByObjective ?? {}).some((s) => s === 'listening')
  if (listensByEar && !issuedTask) throw new ApiError(400, 'ISSUED_TASK_REQUIRED: 听力作答请重新打开任务')
  if (listensByEar) {
    effectiveConditions.playCount = taskPlayCount(payload.taskId)
    if (effectiveConditions.playCount < 1) {
      throw new ApiError(400, 'LISTENING_PLAYBACK_REQUIRED: 先播放音频再作答（未播放不产生听力证据）')
    }
  }
  // D0-1（27 号/N1）：封闭槽位题只收结构化 answers（slotId→选项代号）。
  // 文本提交在这里拒绝（不入库、不给练习分），不再有"在句子里搜代号"的后门。
  if (activity.evaluationContract?.slots) {
    const ans = payload.response?.answers
    if (!ans || typeof ans !== 'object' || Array.isArray(ans)) {
      throw new ApiError(400, 'CLOSED_STRUCTURED_REQUIRED: 该活动为逐槽封闭题，请按槽提交 answers（slotId→选项代号）')
    }
  }
  const disputedSet = disputedActivities(accountId)

  let evaluation, evalStatus
  if (disputedSet.includes(activity.activityId)) {
    evalStatus = 'disputed'
    evaluation = { reason: 'ACTIVITY_DISPUTED', evaluator: null }
  } else {
    // D0-1：结构化槽位作答要连同 answers 一起进判题器（text 单独传会丢逐槽选择）
    const responseForEval = payload.response && typeof payload.response === 'object'
      ? { text: responseText, answers: payload.response.answers ?? null }
      : responseText
    const r = evaluateAttempt(activity, responseForEval)
    evaluation = r.evaluation
    evalStatus = r.status
    if (conditions.transcriptReliability === 'low') { // 转写低置信：争议，不扣能力（13 §6/A6）
      evalStatus = 'disputed'
      evaluation = { reason: 'TRANSCRIPT_LOW_CONFIDENCE', evaluator: evaluation?.evaluator ?? null }
    }
  }

  const ts = Date.now()
  conn.prepare(
    `INSERT INTO learner_attempts_v3 (account_id, attempt_id, session_id, activity_id, activity_version,
       objective_ids, task_family_id, role, response_kind, response, conditions, evaluation_status,
       evaluation, disputed_reason, body_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    accountId, effectiveAttemptId, String(payload.sessionId || ''), activity.activityId, activity.version,
    JSON.stringify(activity.objectiveIds), activity.taskFamilyId, activity.role, activity.responseKind,
    JSON.stringify({
      kind: payload.response?.kind ?? 'text', text: responseText,
      answers: payload.response?.answers ?? null, // D0-1：结构化槽位作答原样留档（可追溯）
      mediaId: payload.response?.mediaId ?? null,
    }),
    JSON.stringify(effectiveConditions), evalStatus, JSON.stringify(evaluation),
    evalStatus === 'disputed' ? (evaluation?.reason ?? 'DISPUTED') : null, hash, ts,
  )

  if (payload.taskId) conn.prepare('UPDATE learner_attempts_v3 SET issued_task_id=? WHERE account_id=? AND attempt_id=?').run(payload.taskId,accountId,effectiveAttemptId)
  const attemptRow = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, effectiveAttemptId)

  if (evalStatus === 'disputed' && evaluation?.reason === 'TRANSCRIPT_LOW_CONFIDENCE') {
    // 坏转写：追加争议事件（不降级、留待复核），机器不给结论
    for (const oid of activity.objectiveIds) {
      conn.prepare(
        `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
           kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'dispute','transcript_low_confidence',NULL,?,?)`)
        .run(accountId, `ev_dispute_tx_${effectiveAttemptId}_${oid}`, effectiveAttemptId, oid,
          activity.skillByObjective?.[oid] ?? 'reading', 'base',
          JSON.stringify({ reason: 'TRANSCRIPT_LOW_CONFIDENCE' }), ts)
    }
    recomputeStates(accountId)
  }
  if (evalStatus === 'evaluated') {
    appendObservedEvents(conn, accountId, attemptRow, activity, effectiveConditions)
    recomputeStates(accountId)
  }

  return { attemptIdUsed: effectiveAttemptId, ...attemptResult(conn, accountId, attemptRow, activity) }
}

/** F6：幂等重放——attemptId 已存在时返回首次结果（不推进任何流程） */
export function getStoredAttempt(accountId, attemptId, payload = null) {
  const conn = ensureV3Schema()
  const row = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)
  if (!row) return null
  if (payload && row.body_hash !== bodyHash(payload)) throw new ApiError(409, 'ATTEMPT_REPLAY_MISMATCH')
  return { ...attemptResult(conn, accountId, row, activityById(row.activity_id)), replayed: true }
}

function attemptResult(conn, accountId, row, activity) {
  const evaluation = JSON.parse(row.evaluation || 'null')
  const isHoldout = activity?.role === 'holdout'
  return {
    attemptId: row.attempt_id,
    saved: true,
    evaluationStatus: row.evaluation_status,
    // 争议原因（NEGATION_AMBIGUOUS 等）：诊断页要拿它给学习者可执行的指引
    disputedReason: row.disputed_reason ?? null,
    // holdout 只给结论：维度命中会泄露保留题的评分要点
    pass: evaluation ? evaluation.pass : null,
    // F4/21§1：逐目标结果 met/partial/unmet/unmeasured/disputed —— 未问的目标就是 unmeasured
    objectiveResults: isHoldout ? undefined : (evaluation?.objectiveResults ?? undefined),
    dimensions: isHoldout ? undefined : (evaluation?.relations ?? undefined),
    // D0-1：逐槽结果（correct/wrong/missing/multiple/invalid）——holdout 不泄露哪槽对
    slotResults: isHoldout ? undefined : (evaluation?.slotResults ?? undefined),
    mustNotViolations: isHoldout ? undefined : evaluation?.mustNotViolations,
    // R3：keyword-only（开放文本词表）——前端要明示"练习反馈，不计入能力记录"
    practiceOnly: evaluation?.keywordOnly === true,
    evidenceEventIds: conn.prepare('SELECT evidence_id FROM evidence_events WHERE account_id = ? AND attempt_id = ?')
      .all(accountId, row.attempt_id).map((r) => r.evidence_id),
    nextAction: row.evaluation_status === 'disputed' ? 'review_transcript'
      : row.evaluation_status === 'pending' ? 'wait' : 'continue',
  }
}

function appendObservedEvents(conn, accountId, attemptRow, activity, conditions) {
  const evaluation = JSON.parse(attemptRow.evaluation || '{}')
  // Keyword checks record practice feedback only, regardless of input modality.
  const audioSource = activity.audioRef
    ? (audioByMediaId(activity.audioRef)?.sourceType ?? 'audio_ref')
    : null
  const playCount = Number(conditions.playCount ?? 0)
  const listensByEar = Object.values(activity.skillByObjective ?? {}).some((s) => s === 'listening')
  const listeningWithAudio = !!audioSource && listensByEar
  const keywordPracticeOnly = evaluation.keywordOnly === true
  if (keywordPracticeOnly) {
    // R3：开放文本词表=练习反馈，不写 observed 事件。但**免修目标又失败**的 repair 信号
    // 仍要写——那是策略信号（换路），不是掌握证据（24 号 T4 语义在这条路上必须存活）
  }
  const firstIndependent = !!conditions.firstExposure && !(conditions.hintLevel > 0)
    && !conditions.transcriptShown && !conditions.lookupUsed
  const condition = firstIndependent ? 'first_independent'
    : conditions.transcriptShown ? 'transcript_shown'
      : conditions.hintLevel > 0 ? 'hinted' : 'supported'
  for (const oid of activity.objectiveIds) {
    // F4/21§1：未测到的目标不写事件（unmeasured 就是 unmeasured，不搭车）
    const perObj = evaluation.objectiveResults?.[oid]
    if (perObj === 'unmeasured') continue
    let skill = activity.skillByObjective?.[oid] ?? 'reading'
    const basisExtra = {}
    // F1：**没有音频**的文字模拟只可测阅读——listening 证据重定向到 reading，原样可追溯。
    // 有 audioRef 就是真声音任务：listening 证据成立，事件记实际音源类型 + 播放次数可追溯
    if (activity.simulatesAudio && !activity.audioRef && skill === 'listening') {
      skill = 'reading'
      basisExtra.textSimAudioRedirected = true
    }
    if (!keywordPracticeOnly) {
      if (audioSource) {
        basisExtra.audio = audioSource
        basisExtra.playCount = playCount
        basisExtra.playbackVerified = playCount > 0 // 服务端播放事件在 recordAttempt 已强制
      }
      // R3：keyword 内容检查的听力证据 = 受限定——回放时封顶 trained（升不了 independent）
      if (evaluation.keywordOnly && listeningWithAudio) basisExtra.keywordContentCheck = true
      // R6（24 号）：复杂度取**本次活动声明的带**（任务真实负担），活动未声明才回落目标父组带——
      // 同目标的简单题与嵌套题要落不同槽，不能永远挤在父组同一带里
      const complexity = activity.complexityBand ? `band${activity.complexityBand}` : complexityBandFor(conn, oid)
      conn.prepare(
        `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
           kind, condition, pass, basis, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        accountId, `ev_${attemptRow.attempt_id}_${oid}`, attemptRow.attempt_id, oid, skill, complexity,
        'observed', condition,
        // 29 号 A1：closed 槽位题的事件成败按**槽位全对**（=活动级 pass）计——理由未认证把
        // 目标结果压到 partial，但那不是"作答失败"，不得累计连败、也不得抬成 met
        // basis.slotOnly：选择定位成功但理由/自由表达未测 → 状态回放按**中性参与**处理（不升级不计败）
        (perObj === 'met' || (evaluation.slots && evaluation.pass && perObj === 'partial')) ? 1 : 0,
        JSON.stringify({ role: activity.role, taskFamilyId: activity.taskFamilyId, evaluator: evaluation.evaluator ?? null,
          confidence: evaluation.confidence ?? null, oralDeferred: !!activity.oralEvidenceDeferred,
          locating: !!activity.locating, perObjective: perObj,
          slotOnly: evaluation.slots && perObj === 'partial' ? true : undefined,
          reasonAssessed: evaluation.reasonAssessed ?? null, ...basisExtra }),
        Date.now(),
      )
    }
    // 被斩掉的目标又失败 → repair 事件（决策层据此开局部短修复，不批量重刷）。
    // keyword 练习也产生这个信号：它是策略信号，不是掌握证据
    if (perObj === 'unmet' || perObj === 'partial' && evaluation.pass === false) {
      const complexity = activity.complexityBand ? `band${activity.complexityBand}` : complexityBandFor(conn, oid)
      const st = conn.prepare('SELECT flags FROM learner_states WHERE account_id=? AND objective_id=? AND skill=? AND complexity=?')
        .get(accountId, oid, skill, 'base') // 状态聚合槽
      if (st && JSON.parse(st.flags || '[]').includes('waived_by_user')) {
        conn.prepare(
          `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
             kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(accountId, `ev_${attemptRow.attempt_id}_${oid}_repair`, attemptRow.attempt_id, oid, skill, complexity,
          'repair', condition, 0, JSON.stringify({ cause: 'waived_objective_failed' }), Date.now())
      }
    }
  }
}

/** 目标 → 复杂度带（父组定义；查不到回落 'base'）。事件与人审都落真实带槽 */
export function complexityBandFor(conn, objectiveId) {
  const row = conn.prepare('SELECT g.complexity_band AS band FROM objective_versions o JOIN coverage_groups g ON g.group_id = o.parent_group WHERE o.objective_id = ? ORDER BY o.version DESC LIMIT 1')
    .get(objectiveId)
  return row?.band ? `band${row.band}` : 'base'
}

// ---------------------------------------------------------------- 状态回放（evidence_events → learner_states）

/** 从事件流重建该账户全部 learner_states。
 *  争议语义（15 §5）：只追加 dispute、暂停更新、状态冻结在争议前的值 —— 不当场丢证据；
 *  复核结束再更正（dispute_cleared）或撤回（W3+ 的复核结论，追加反向事件）。 */
export function recomputeStates(accountId) {
  const conn = ensureV3Schema()
  const events = conn.prepare('SELECT * FROM evidence_events WHERE account_id = ? ORDER BY created_at, evidence_id').all(accountId)
  // F1 历史重算：事件只追加不改写；重放时按活动**当前定义**纠正模态错位
  // （旧事件把文字模拟音频记成 listening —— 重放归位到 reading，原始事件保留可追溯）
  const activityOf = (() => {
    const m = new Map(
      conn.prepare('SELECT attempt_id, activity_id FROM learner_attempts_v3 WHERE account_id = ?').all(accountId)
        .map((r) => [r.attempt_id, r.activity_id]))
    return (attemptId) => (attemptId && m.get(attemptId) ? activityById(m.get(attemptId)) : null)
  })()

  // 分档槽位（21 §6.1/F1 验收）：每个 目标×技能×复杂度带 一个真实状态行——不同带的表现互不覆盖；
  // base 聚合槽按"最弱带"保守合并（易档通过盖不住嵌套档失败），标志并集——决策层读 base 不回退
  const acc = new Map() // key obj|skill|band → {state, flags:Set, independentFamilies:Set, failStreak}
  const baseAcc = new Map() // key obj|skill → 跨带聚合槽（最弱状态 + 标志并集）
  const slot = (obj, skill, band) => {
    const k = obj + '|' + skill + '|' + (band || 'base')
    if (!acc.has(k)) acc.set(k, {
      objectiveId: obj, skill, band: band || 'base', state: 'unmeasured', flags: new Set(),
      independentFamilies: new Set(), failStreak: 0, hasObserved: false, lastRepairAt: 0, lastPassAt: 0,
    })
    return acc.get(k)
  }
  const baseOf = (obj, skill) => {
    const k = obj + '|' + skill
    if (!baseAcc.has(k)) baseAcc.set(k, { objectiveId: obj, skill, state: 'unmeasured', observedRank: null, flags: new Set() })
    return baseAcc.get(k)
  }
  const addFlag = (obj, skill, band, flag) => {
    slot(obj, skill, band).flags.add(flag)
    baseOf(obj, skill).flags.add(flag)
  }
  const openDisputeAt = new Map() // slot key → 争议提出时间（该时刻后的争议材料事件不再计入）

  for (const e of events) {
    const band = e.complexity || 'base'
    if (e.kind === 'waive_revoked') {
      for (const prior of acc.values()) if (prior.objectiveId===e.objective_id && prior.skill===e.skill) prior.flags.delete('waived_by_user')
      baseOf(e.objective_id,e.skill).flags.delete('waived_by_user')
      continue
    }
    const s = slot(e.objective_id, e.skill, band) // 真实槽位：事件发生在哪个带就记哪个带
    const key = e.objective_id + '|' + e.skill
    if (e.kind === 'waive') { addFlag(e.objective_id, e.skill, band, 'waived_by_user'); continue }
    if (e.kind === 'dispute') { addFlag(e.objective_id, e.skill, band, 'disputed'); if (!openDisputeAt.has(key)) openDisputeAt.set(key, e.created_at); continue }
    if (e.kind === 'dispute_cleared') { s.flags.delete('disputed'); baseOf(e.objective_id, e.skill).flags.delete('disputed'); openDisputeAt.delete(key); continue }
    if (e.kind === 'repair') { s.lastRepairAt = Math.max(s.lastRepairAt, e.created_at); continue } // 是否仍需修复在回放末尾判
    if (e.kind !== 'observed') continue
    const basis = JSON.parse(e.basis || '{}')
    if (basis.keywordContentCheck === true) continue // historical keyword listening is participation, never comprehension certification
    // F1 重算：**无音频**的文字模拟历史 listening 事件 → reading 槽位；带 audioRef 的保持 listening
    let skill = e.skill
    const actDef = activityOf(e.attempt_id)
    if (actDef?.simulatesAudio && !actDef.audioRef && skill === 'listening') skill = 'reading'
    const s2 = slot(e.objective_id, skill, band)
    const frozen = openDisputeAt.has(e.objective_id + '|' + skill) && e.created_at >= (openDisputeAt.get(e.objective_id + '|' + skill) ?? 0)
    if (frozen && basis.evaluator !== 'human') continue // 争议后的事件暂停计入……
    if (frozen && basis.evaluator === 'human') {
      // ……除非这是复核结论（人审）：解除争议冻结并清除争议标志（15 §5 复核结束再更正）
      s2.flags.delete('disputed')
      baseOf(e.objective_id, skill).flags.delete('disputed')
      openDisputeAt.delete(e.objective_id + '|' + skill)
    }
    if (basis.oralDeferred) continue // 口语证据在真录音（W5）前不升级状态
    s2.hasObserved = true

    // 复审 AUTO-000001-A1（29 号 A1）：选择定位成功但理由/自由表达未测 = **中性参与**——
    // 整目标不因未测理由升级（partial≠掌握），也不计失败连败。判定覆盖新旧行：
    // 新事件带 slotOnly=true；修复前的 slots partial 事件按 evaluatorVersion+v2+partial 识别。
    // 事件行原文未改（可追溯），判定规则与本注释及回归测试共同记录。
    if (basis.slotOnly === true || basis.reasonAssessed === false
      || (basis.reasonAssessed === undefined && basis.evaluatorVersion === 'deterministic-contract-v2' && basis.perObjective === 'partial')) continue

    if (e.pass) {
      s2.failStreak = 0
      s2.lastPassAt = Math.max(s2.lastPassAt, e.created_at)
      const rank = STATE_RANK[s2.state]
      if (basis.locating) { if (rank < 1) s2.state = 'tentative'; continue } // 定位题不算掌握证据
      if (e.condition === 'transcript_shown') { if (rank < 2) s2.state = 'trained'; continue } // 看稿成功≤trained，且已重定向到 reading
      if (e.condition === 'hinted' || e.condition === 'supported') { if (rank < 2) s2.state = 'trained'; continue }
      // first_independent
      if (basis.keywordContentCheck) { if (rank < 2) s2.state = 'trained'; continue } // R3：词表内容检查封顶 trained
      s2.independentFamilies.add(basis.taskFamilyId ?? '?')
      if (basis.role === 'transfer' && s2.independentFamilies.size >= 2) s2.state = 'transferred'
      else if (s2.independentFamilies.size >= 2) s2.state = 'independent'
      else if (rank < 2) s2.state = 'trained'
    } else {
      s2.failStreak += 1
      // needs_repair 不在这里挂：标志在回放结束后按**最终**连败判定——再次成功会自然过期，
      // 否则一次历史连败让 short_repair 永远锁住推荐（轨迹走查实测踩过）
    }
  }
  // 回放结束判定换策略建议：最终连败 ≥2，或 repair 事件之后（该槽）再无通过——
  // 修复建议会过期，不永续锁推荐（轨迹走查实测：repair 标志永续导致 short_repair 死循环）
  for (const s of acc.values()) {
    if (s.failStreak >= 2 || (s.lastRepairAt && s.lastRepairAt > s.lastPassAt)) s.flags.add('needs_repair')
  }

  // base 聚合：状态只在**有作答证据**的带里取最弱（免修/争议这类纯标志槽不把状态拖回 unmeasured）；
  // 单次挑战失败的带（未见过成功、也非连败）不参与最弱合并——否则一次高复杂度尝试会把
  // 易档已证的 trained/independent 抹回 unmeasured（复审 P3：推荐抖动）
  for (const s of acc.values()) {
    const b = baseOf(s.objectiveId, s.skill)
    const meaningful = s.hasObserved && (STATE_RANK[s.state] > 0 || s.failStreak >= 2)
    if (meaningful && (b.observedRank === null || STATE_RANK[s.state] < b.observedRank)) {
      b.observedRank = STATE_RANK[s.state]
      b.state = s.state
    }
    for (const f of s.flags) b.flags.add(f)
  }
  for (const [k, b] of baseAcc) {
    if (b.observedRank === null && !b.flags.size) baseAcc.delete(k) // 无证据无标志不落行
  }

  const up = conn.prepare(
    `INSERT INTO learner_states (account_id, objective_id, skill, complexity, state, flags, evidence_version, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id, objective_id, skill, complexity) DO UPDATE SET
       state=excluded.state, flags=excluded.flags, evidence_version=excluded.evidence_version, updated_at=excluded.updated_at`)
  // learner_states 是派生表。仅 upsert 会留下已失去依据的旧 base 正分。
  // 原始作答/事件不删；同一 savepoint 内重建当前账户的派生行。
  conn.exec('SAVEPOINT v3_state_rebuild')
  try {
    const version = nextCounter(accountId, 'evidence')
    conn.prepare('DELETE FROM learner_states WHERE account_id=?').run(accountId)
    for (const s of acc.values()) {
      up.run(accountId, s.objectiveId, s.skill, s.band, s.state, JSON.stringify([...s.flags]), version, Date.now())
    }
    for (const b of baseAcc.values()) {
      up.run(accountId, b.objectiveId, b.skill, 'base', b.state, JSON.stringify([...b.flags]), version, Date.now())
    }
    conn.exec('RELEASE v3_state_rebuild')
    return { evidenceVersion: version, states: acc.size + baseAcc.size }
  } catch (e) {
    conn.exec('ROLLBACK TO v3_state_rebuild')
    conn.exec('RELEASE v3_state_rebuild')
    throw e
  }
}

// ---------------------------------------------------------------- 免修与争议

function requireWaiverTarget(conn,objectiveId,skill) {
  const obj=conn.prepare('SELECT skills FROM objective_versions WHERE objective_id=? ORDER BY version DESC LIMIT 1').get(objectiveId)
  if (!obj || !Object.hasOwn(JSON.parse(obj.skills || '{}'),skill)) throw new ApiError(400,'WAIVER_TARGET_INVALID')
}

/** Undo self-rated exemption; originals remain in the append-only event ledger. */
export function revokeWaiver(accountId,{objectiveId,skill,reason}={}) {
  requireAccount(accountId)
  const conn=ensureV3Schema();requireWaiverTarget(conn,objectiveId,skill)
  conn.prepare(`INSERT INTO evidence_events (account_id,evidence_id,attempt_id,objective_id,skill,complexity,kind,condition,pass,basis,created_at)
    VALUES (?,?,NULL,?,?,'base','waive_revoked','user_waiver',NULL,?,?)`).run(accountId,`ev_unwaive_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,objectiveId,skill,JSON.stringify({reason:String(reason || '').slice(0,500)}),Date.now())
  recomputeStates(accountId)
  return {ok:true,note:'已恢复这项目标的训练，原免修记录保留；原能力证据不删除。'}
}

/** POST /waivers：用户免修 = waived_by_user 标志，状态值不动，永远不会变成 retained */
export function waive(accountId, { objectiveId, skill, complexity, reason } = {}) {
  requireAccount(accountId)
  if (!objectiveId || !skill) throw new ApiError(400, 'WAVIER_NEEDS_OBJECTIVE_AND_SKILL')
  const conn = ensureV3Schema()
  requireWaiverTarget(conn,objectiveId,skill)
  if (complexity && !/^(base|band[1-6])$/.test(complexity)) throw new ApiError(400,'WAIVER_COMPLEXITY_INVALID')
  // 事件带父组复杂度带（审计粒度）；状态聚合槽仍是 'base'（recompute 的聚合口径）
  const bandComplexity = complexity || complexityBandFor(conn, objectiveId)
  complexity = 'base'
  conn.prepare(
    `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
       kind, condition, pass, basis, created_at)
     VALUES (?,?,NULL,?,?,?,'waive','user_waiver',NULL,?,?)`,
  ).run(accountId, `ev_waive_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, objectiveId, skill, bandComplexity,
    JSON.stringify({ reason: String(reason || '').slice(0, 500) }), Date.now())
  recomputeStates(accountId)
  const st = conn.prepare('SELECT * FROM learner_states WHERE account_id=? AND objective_id=? AND skill=? AND complexity=?')
    .get(accountId, objectiveId, skill, complexity)
  return {
    ok: true,
    state: st?.state ?? 'unmeasured',
    flags: JSON.parse(st?.flags || '[]'),
    note: 'waived_by_user 只把同层同质练习移出推荐，不等于 retained，也不是认证',
  }
}

/** POST /content-reports：报告坏题/坏转写 → 追加争议、暂停该材料证据，不降级用户 */
export function reportContent(accountId, { attemptId, activityId, location, description } = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const reportId = `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const targets = []
  if (attemptId) {
    const row = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id=? AND attempt_id=?').get(accountId, attemptId)
    if (!row) throw new ApiError(404, 'ATTEMPT_NOT_FOUND: ' + attemptId)
    targets.push(row)
  } else if (activityId) {
    targets.push(...conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id=? AND activity_id=?').all(accountId, activityId))
  } else throw new ApiError(400, 'REPORT_NEEDS_ATTEMPT_OR_ACTIVITY')

  const insEvent = conn.prepare(
    `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
       kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'dispute','content_report',NULL,?,?)`)
  const note = JSON.stringify({ reportId, location: String(location || '').slice(0, 300), description: String(description || '').slice(0, 500) })

  for (const t of targets) {
    if (t.evaluation_status !== 'disputed') {
      conn.prepare("UPDATE learner_attempts_v3 SET evaluation_status='disputed', disputed_reason=? WHERE account_id=? AND attempt_id=?")
        .run('CONTENT_REPORT: ' + String(description || location || '').slice(0, 300), accountId, t.attempt_id)
    }
    const act = activityById(t.activity_id)
    for (const oid of JSON.parse(t.objective_ids || '[]')) {
      // 争议事件落在目标的真实复杂度带上（和作答事件同槽），不写 'base'——聚合槽只由回放生成
      insEvent.run(accountId, `ev_dispute_${t.attempt_id}_${oid}`, t.attempt_id, oid,
        act?.skillByObjective?.[oid] ?? 'reading', complexityBandFor(conn, oid), note, Date.now())
    }
  }

  // 活动级报告：隔离该材料（含 holdout），之后的尝试自动进 disputed
  if (activityId) {
    const list = JSON.parse(getMeta(accountId, 'disputed_activities') || '[]')
    if (!list.includes(activityId)) list.push(activityId)
    setMeta(accountId, 'disputed_activities', JSON.stringify(list))
    if (!targets.length) { // 没有历史尝试也要挂争议标志
      const act = activityById(activityId)
      for (const oid of act?.objectiveIds ?? []) {
        insEvent.run(accountId, `ev_dispute_act_${reportId}_${oid}`, null, oid,
          act?.skillByObjective?.[oid] ?? 'reading', complexityBandFor(conn, oid), note, Date.now())
      }
    }
  }

  recomputeStates(accountId)
  return { reportId, certificationPaused: true, affectedAttempts: targets.length }
}

export function evidenceSummary(accountId, { objective, skill } = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  // complexity 入排序：同目标同技能的带行/聚合行顺序确定（band1 < band2 < … < base）
  let states = conn.prepare('SELECT * FROM learner_states WHERE account_id = ? ORDER BY objective_id, skill, complexity').all(accountId)
  if (objective) states = states.filter((s) => s.objective_id === objective)
  if (skill) states = states.filter((s) => s.skill === skill)
  const events = conn.prepare('SELECT evidence_id, attempt_id, objective_id, skill, kind, condition, pass, basis, created_at FROM evidence_events WHERE account_id = ? ORDER BY created_at').all(accountId)
  return {
    completedLessons: conn.prepare(`SELECT DISTINCT p.served_lesson_id AS lessonId,
      (SELECT title FROM lesson_versions l WHERE l.lesson_id=p.served_lesson_id ORDER BY version DESC LIMIT 1) AS title
      FROM plan_decisions p WHERE p.account_id=? AND p.status='completed' AND p.served_lesson_id IS NOT NULL
      ORDER BY p.created_at DESC LIMIT 6`).all(accountId),
    evidenceVersion: getCounter(accountId, 'evidence'),
    states: states.map((s) => ({
      objectiveId: s.objective_id, skill: s.skill, complexity: s.complexity, state: s.state,
      flags: JSON.parse(s.flags || '[]'), updatedAt: s.updated_at,
    })),
    disputedAttempts: conn.prepare("SELECT attempt_id, activity_id, disputed_reason FROM learner_attempts_v3 WHERE account_id=? AND evaluation_status='disputed'").all(accountId),
    recentEvents: events.slice(-20).map((e) => ({ ...e, basis: JSON.parse(e.basis || '{}') })),
    note: '状态可由 evidence_events 重放重建；disputed 只暂停更新，不删除历史',
  }
}
