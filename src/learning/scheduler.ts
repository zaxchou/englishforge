// 题级复习调度（PLAN-v2 §5.3 规则、§5.4 今日队列优先级、§3.3 错误处理）
import type {
  AdaptedQuestion, ProgressV2, QueueItem, QuestionState, SessionKind,
} from '../types'
import { INTERVALS } from '../types'
import { seededShuffle, localDateStr } from '../store/progress'

const DAY = 24 * 60 * 60 * 1000
export const QUEUE_SIZE = 10

/** 抽题池：隔离 quarantined / 保留题不进普通抽题（§8.2、§4.1） */
export function eligible(questions: AdaptedQuestion[]): AdaptedQuestion[] {
  return questions.filter((q) => q.reviewStatus !== 'quarantined' && q.assessmentRole !== 'holdout')
}

/** 情境/表达任务判定（配对/分类/听力/跟读） */
export function isSituational(q: AdaptedQuestion): boolean {
  return q.type === 'match' || q.type === 'sort' || q.type === 'speak' || !!q.autoTTS
}

function isSpecial(q: AdaptedQuestion): boolean {
  return isSituational(q) || q.type === 'speak'
}

/** 题级 SRS 抽题分（新题 > 到期 > 未毕业 > 已毕业降权） */
export function srsScore(p: ProgressV2, now = Date.now()): (q: AdaptedQuestion) => number {
  return (q) => {
    const st = p.questionStates[q.id]
    if (!st || st.total === 0) return 100
    if (st.stage >= 5 && st.dueAt > now) return 5
    if (st.dueAt <= now) return 80
    return 25
  }
}

/** 生成冻结队列条目：选项顺序按 (sessionId+qid) 种子随机，刷新恢复不变序 */
export function makeQueueItem(q: AdaptedQuestion, sessionId: string, opts?: Partial<QueueItem>): QueueItem {
  const seed = `${sessionId}:${q.id}`
  const item: QueueItem = { qid: q.id, ...opts }
  if (q.type === 'choice' && (q.options?.length ?? 0) > 1) {
    item.optionOrder = seededShuffle(q.optionIds, seed)
  }
  if (q.type === 'match' && q.pairs?.length) {
    item.rightOrder = seededShuffle(q.pairs.map((x) => x[1]), seed + ':r')
  }
  return item
}

// ============ §5.3 单题复习规则 ============

export interface ReviewInput {
  firstAttempt: boolean
  outcome: 'correct' | 'incorrect' | 'uncertain' | 'skipped'
  /** 首次独立正确（非重试、非依赖提示） */
  independent: boolean
  /** 作答前是否已到期 */
  wasDue: boolean
  now?: number
}

/**
 * 应用单题复习规则：
 * - 首次独立正确：新题/重置 → 阶段 1，次日复习；已到期 → 最多 +1 阶段，按新阶段排下次到期
 * - 未到期答对：记录但阶段不提升、到期不后推（防同日刷题升级）
 * - 首次错误或依赖提示：阶段重置，次日复习
 * - 重试/补练：不提升记忆阶段
 * - 最高阶段仍按到期复习，不永久降权
 * 注意：自评/语音等非确定性判定由调用方跳过本函数。
 */
export function applyQuestionReview(p: ProgressV2, qid: string, ev: ReviewInput): QuestionState {
  const now = ev.now ?? Date.now()
  const cur: QuestionState = p.questionStates[qid] ?? { stage: 0, dueAt: 0, correct: 0, total: 0 }
  const next: QuestionState = { ...cur, total: cur.total + 1 }

  if (!ev.firstAttempt) {
    // 补练/立即重试：只记练习量，阶段与到期不动
    if (ev.outcome === 'correct') next.correct = cur.correct + 1
    p.questionStates[qid] = next
    return next
  }

  if (ev.outcome === 'incorrect') {
    next.stage = 0
    next.dueAt = now + DAY          // 次日复习
    next.lastFailureAt = now
    p.questionStates[qid] = next
    return next
  }

  if (ev.outcome === 'skipped') {
    // 跳过/识别失败：不一概判对错（用例 8），阶段到期保持原样
    p.questionStates[qid] = next
    return next
  }

  // outcome correct（objective 的确定判定；uncertain 只会出现在语音，调用方已拦截）
  if (ev.independent && ev.outcome === 'correct') {
    next.correct = cur.correct + 1
    if (ev.wasDue) {
      // 新题(dueAt=0 视为到期) → 阶段 1；已到期 → 最多 +1；按新阶段排下次到期
      next.stage = Math.min(5, cur.stage + 1)
      next.dueAt = now + INTERVALS[next.stage] * DAY
    }
    // 未到期答对：阶段不提升、到期不后推（防同日反复刷题升级）
    next.lastIndependentSuccessAt = now
  }
  p.questionStates[qid] = next
  return next
}

/** 口语状态单独记录（不与客观证据混算，§5.2） */
export function recordSpeak(
  p: ProgressV2,
  qid: string,
  status: 'prompted' | 'independent-self' | 'independent-ai',
  independent: boolean,
) {
  const cur = p.questionStates[qid] ?? { stage: 0, dueAt: 0, correct: 0, total: 0 }
  if (!independent) {
    cur.speak = { status: 'prompted', at: Date.now() }   // 有提示完成（对照原句/自评完成由调用方定级）
  } else {
    cur.speak = { status, at: Date.now() }
  }
  p.questionStates[qid] = cur
}

// ============ §5.4 到期与队列 ============

/** 到期题：优先未处理的关键错误，再按逾期程度降序，跨知识点打散 */
export function dueQuestions(
  p: ProgressV2,
  pool: AdaptedQuestion[],
  now = Date.now(),
  criticalQids: Set<string> = new Set(),
): AdaptedQuestion[] {
  const byId = new Map(pool.map((q) => [q.id, q]))
  const due: { q: AdaptedQuestion; overdue: number; critical: boolean }[] = []
  for (const [qid, st] of Object.entries(p.questionStates)) {
    if (st.total === 0 || st.dueAt > now) continue
    const q = byId.get(qid)
    if (!q) continue
    due.push({ q, overdue: now - st.dueAt, critical: criticalQids.has(qid) })
  }
  due.sort((a, b) => Number(b.critical) - Number(a.critical) || b.overdue - a.overdue)
  // 跨知识点打散：同优先级内按技能轮转
  const out: AdaptedQuestion[] = []
  const groups = new Map<string, typeof due>()
  for (const d of due) {
    const g = groups.get(d.q.skill) ?? []
    g.push(d)
    groups.set(d.q.skill, g)
  }
  const queues = [...groups.values()]
  let i = 0
  while (out.length < due.length) {
    const g = queues[i % queues.length]
    const item = g.shift()
    if (item) out.push(item.q)
    i++
    if (i > due.length * 4) break
  }
  return out
}

/** 推荐"当前知识点"：最近有活动、未毕业的技能；否则课程顺序里第一个有新题的技能 */
export function recommendSkill(
  p: ProgressV2,
  pool: AdaptedQuestion[],
  skillOrder: string[],
): string | null {
  const lastActivity = new Map<string, number>()
  const qidToSkill = new Map(pool.map((q) => [q.id, q.skill]))
  for (const [qid, st] of Object.entries(p.questionStates)) {
    const skill = qidToSkill.get(qid)
    if (!skill) continue
    const t = Math.max(st.lastFailureAt ?? 0, st.lastIndependentSuccessAt ?? 0)
    if ((st.stage > 0 && st.stage < 5) || st.lastFailureAt) {
      lastActivity.set(skill, Math.max(lastActivity.get(skill) ?? 0, t))
    }
  }
  let best: string | null = null
  let bestT = 0
  for (const [skill, t] of lastActivity) {
    if (t > bestT) { bestT = t; best = skill }
  }
  if (best) return best
  for (const skill of skillOrder) {
    if (pool.some((q) => q.skill === skill && (p.questionStates[q.id]?.total ?? 0) === 0)) return skill
  }
  return skillOrder[0] ?? null
}

/**
 * 今日队列（10 任务）：4 到期 + 4 当前知识点 + 2 情境/表达；
 * 无复习 → 空位给当前知识点与变式；无新内容 → 全部复习；
 * 积压 → 最多 7 个到期，保留 3 个有变化的任务。生成后冻结。
 */
export function buildTodayQueue(
  p: ProgressV2,
  pool: AdaptedQuestion[],
  sessionId: string,
  opts?: { skillOrder?: string[]; criticalQids?: Set<string> },
): QueueItem[] {
  const now = Date.now()
  const used = new Set<string>()
  const items: QueueItem[] = []
  const score = srsScore(p, now)

  // 1. 到期（最多 7，保留 3 个变化位）
  const due = dueQuestions(p, pool, now, opts?.criticalQids)
  const dueTake = due.length <= 4 ? due.length : Math.min(due.length, 7)
  for (const q of due.slice(0, dueTake)) {
    items.push(makeQueueItem(q, sessionId, { isDueReview: true }))
    used.add(q.id)
  }

  const remain = () => QUEUE_SIZE - items.length

  // 2. 当前知识点
  const skillOrder = opts?.skillOrder ?? [...new Set(pool.map((q) => q.skill))]
  const skill = recommendSkill(p, pool, skillOrder)
  const curPool = (skill ? pool.filter((q) => q.skill === skill) : [])
    .filter((q) => !used.has(q.id))
    .sort((a, b) => score(b) - score(a))

  // 3. 情境/表达任务（优先当前技能，不足再从全池补）
  const situCandidates = [
    ...curPool.filter(isSituational),
    ...pool.filter((q) => !used.has(q.id) && isSituational(q) && q.skill !== skill),
  ]
  const situTake = Math.min(2, remain(), situCandidates.length)
  for (const q of situCandidates.slice(0, situTake)) {
    items.push(makeQueueItem(q, sessionId))
    used.add(q.id)
  }

  // 4. 当前知识点任务（新题优先，其次未到期已练变式）
  for (const q of curPool) {
    if (remain() <= 0) break
    items.push(makeQueueItem(q, sessionId))
    used.add(q.id)
  }

  // 5. 没有新内容/本技能抽完：全池补足（含未到期已练题当变式；都空则全部复习）
  if (remain() > 0) {
    const rest = pool
      .filter((q) => !used.has(q.id))
      .sort((a, b) => score(b) - score(a))
    for (const q of rest) {
      if (remain() <= 0) break
      items.push(makeQueueItem(q, sessionId))
      used.add(q.id)
    }
  }
  if (remain() > 0 && due.length > dueTake) {
    for (const q of due.slice(dueTake)) {
      if (remain() <= 0) break
      items.push(makeQueueItem(q, sessionId, { isDueReview: true }))
      used.add(q.id)
    }
  }

  return items
}

/** 课程内单技能练习队列（保留原配比：特殊题保底 + 难度混搭 + 破惯性保底） */
export function buildSkillQueue(
  p: ProgressV2,
  skillQuestions: AdaptedQuestion[],
  sessionId: string,
  skillBox: number,
): QueueItem[] {
  const now = Date.now()
  const pool = eligible(skillQuestions)
  const score = srsScore(p, now)
  const specials = pool.filter(isSpecial).sort((a, b) => score(b) - score(a))
  const core = pool.filter((q) => !isSpecial(q)).sort((a, b) => score(b) - score(a))
  const advCore = core.filter((q) => (q.diff ?? 1) >= 2)
  const baseCore = core.filter((q) => (q.diff ?? 1) < 2)
  const advanced = skillBox >= 2
  const take: AdaptedQuestion[] = [
    ...specials.slice(0, advanced ? 3 : 2),
    ...advCore.slice(0, advanced ? 6 : 3),
    ...baseCore.slice(0, advanced ? 3 : 7),
  ].slice(0, 12)
  if (!take.some((q) => q.myth)) {
    const m = core.find((q) => q.myth)
    if (m && take.length > 0) take[take.length - 1] = m
  }
  const used = new Set(take.map((q) => q.id))
  // 保底不足时补足
  for (const q of core) {
    if (take.length >= 12) break
    if (!used.has(q.id)) { take.push(q); used.add(q.id) }
  }
  return take.map((q) => makeQueueItem(q, sessionId))
}

/** 复习队列：全部来自题级到期数据（不从技能总 box 推断，§5.4.2） */
export function buildReviewQueue(
  p: ProgressV2,
  pool: AdaptedQuestion[],
  sessionId: string,
  criticalQids: Set<string> = new Set(),
): QueueItem[] {
  const due = dueQuestions(p, pool, Date.now(), criticalQids).slice(0, 12)
  return due.map((q) => makeQueueItem(q, sessionId, { isDueReview: true }))
}

/**
 * §3.3 首次答错后：过至少两个其他任务，插入一道同技能、不同表面的变式。
 * 无合适变式则不插（留到次日，不假装是新题）。返回是否插入。
 */
export function insertVariantDrill(
  queue: QueueItem[],
  cursor: number,
  failedQid: string,
  pool: AdaptedQuestion[],
  sessionId: string,
): boolean {
  const failed = pool.find((q) => q.id === failedQid)
  if (!failed) return false
  // 本轮已有待做的变式补练 → 不重复插
  if (queue.slice(cursor).some((it) => it.isVariantDrill && it.qid !== failedQid)) return false
  const inQueue = new Set(queue.map((it) => it.qid))
  // "同类不同表面"：优先同变式家族的另一道题（P1 题包）；
  // 旧题家族=题 id，退化为同技能、不同题即可
  const candidates = pool.filter((q) =>
    q.id !== failedQid &&
    q.skill === failed.skill &&
    !inQueue.has(q.id),
  )
  if (candidates.length === 0) return false
  candidates.sort((a, b) =>
    Number(b.variantGroupId === failed.variantGroupId) - Number(a.variantGroupId === failed.variantGroupId) ||
    Number(b.type === failed.type) - Number(a.type === failed.type) ||
    (a.diff ?? 1) - (b.diff ?? 1))
  const insertAt = Math.min(queue.length, cursor + 2)   // 过至少两个其他任务
  queue.splice(insertAt, 0, makeQueueItem(candidates[0], sessionId, { isVariantDrill: true }))
  return true
}

/**
 * §3.3 同一技能连续三次首次答错：停止加难——把队列剩余的该技能高难题
 * 换成更简单的同技能题（找不到就移除该题，不降格充当新题）。返回替换数。
 */
export function softenQueue(
  queue: QueueItem[],
  cursor: number,
  skillId: string,
  pool: AdaptedQuestion[],
  sessionId: string,
): number {
  const inQueue = new Set(queue.map((it) => it.qid))
  const easy = pool.filter((q) =>
    q.skill === skillId &&
    !inQueue.has(q.id) &&
    (q.diff ?? 1) <= 1 &&
    !isSituational(q),
  )
  let ei = 0
  let changed = 0
  for (let i = cursor; i < queue.length; i++) {
    const q = pool.find((x) => x.id === queue[i].qid)
    if (!q || q.skill !== skillId || (q.diff ?? 1) < 3) continue
    if (ei < easy.length) {
      queue[i] = makeQueueItem(easy[ei++], sessionId)
      changed++
    } else {
      queue.splice(i, 1)
      i--
      changed++
    }
  }
  return changed
}

export type { SessionKind }
export { localDateStr }
