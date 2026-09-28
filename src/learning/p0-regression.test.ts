// P0 回归测试（PLAN-v2 §11 防回归用例的确定性部分）
// 浏览器级交互恢复（用例 4）在 Playwright 验收中单独覆盖
import { describe, it, expect } from 'vitest'
import {
  applyQuestionReview, buildTodayQueue, buildSkillQueue, buildReviewQueue,
  makeQueueItem, insertVariantDrill, softenQueue, eligible, dueQuestions, recordSpeak,
} from './scheduler'
import { buildEvidence } from './evidence'
import { gradeChoice, gradeSequence, gradeTap } from './grading'
import { adaptQuestion } from '../content/adapt'
import { validateQuestions, errorsOf } from '../content/validation'
import { defaultProgressV2 } from '../store/migrations'
import { allQuestions } from '../data/course'
import type { AdaptedQuestion, Attempt, Question, QueueItem } from '../types'
import { INTERVALS } from '../types'

const DAY = 24 * 60 * 60 * 1000

// ---------- 工厂 ----------

let seq = 0
function mkq(over: Partial<AdaptedQuestion> = {}): AdaptedQuestion {
  const id = over.id ?? `q${++seq}`
  const skill = over.skill ?? 'skA'
  return {
    id, skill, type: 'choice', prompt: 'p', explain: 'e',
    options: ['A1', 'B1', 'C1'], answer: 'A1',
    optionIds: [`${id}#0`, `${id}#1`, `${id}#2`],
    tokens2: [], orderIds: [], answerId: `${id}#0`,
    mode: 'recognition', variantGroupId: id, objectiveId: skill,
    contentVersion: 1, reviewStatus: 'reviewed', assessmentRole: 'practice',
    diff: 1,
    ...over,
  }
}

let aseq = 0
function mkAttempt(over: Partial<Attempt> = {}): Attempt {
  const questionId = over.questionId ?? 'q1'
  const n = ++aseq
  return {
    attemptId: `ev${n}`, sessionId: 'sess-1', questionId,
    contentVersion: 1, objectiveId: 'skA', variantGroupId: questionId,   // 变式家族跟题走（与适配器默认一致）
    mode: 'recognition', timestamp: 1_800_000_000_000 + n * 1000, localDate: '2026-09-27',
    firstAttempt: true, supportUsed: 3, answer: 'A1', outcome: 'correct',
    evaluator: 'deterministic', responseMs: 1500, isDueReview: false,
    ...over,
  }
}

// ---------- §11 用例 1/2/3/8：题级复习规则 ----------

describe('用例 1：答错 A 后答对同技能其他五题，A 的到期不受影响', () => {
  it('A 保持自己的重置状态与次日到期', () => {
    const p = defaultProgressV2()
    const now = Date.now()
    applyQuestionReview(p, 'A', { firstAttempt: true, outcome: 'incorrect', independent: false, wasDue: true, now })
    const dueAfterFail = p.questionStates['A'].dueAt
    expect(p.questionStates['A'].stage).toBe(0)
    expect(dueAfterFail).toBe(now + DAY)

    for (let i = 0; i < 5; i++) {
      applyQuestionReview(p, `other${i}`, { firstAttempt: true, outcome: 'correct', independent: true, wasDue: true, now: now + (i + 1) * 1000 })
    }
    expect(p.questionStates['A'].dueAt).toBe(dueAfterFail)
    expect(p.questionStates['A'].stage).toBe(0)
    expect(p.questionStates['A'].total).toBe(1)   // 其他题不给 A 加量
  })
})

describe('用例 2：同日反复刷同一题不能无限升级/推延', () => {
  it('未到期答对：阶段与到期时间都不变', () => {
    const p = defaultProgressV2()
    const now = Date.now()
    applyQuestionReview(p, 'q1', { firstAttempt: true, outcome: 'correct', independent: true, wasDue: true, now })
    expect(p.questionStates.q1.stage).toBe(1)
    const due = p.questionStates.q1.dueAt
    for (let i = 1; i <= 5; i++) {
      applyQuestionReview(p, 'q1', { firstAttempt: true, outcome: 'correct', independent: true, wasDue: false, now: now + i * 1000 })
    }
    expect(p.questionStates.q1.stage).toBe(1)          // 没被刷到 5
    expect(p.questionStates.q1.dueAt).toBe(due)        // 到期没有后推
  })

  it('到期答对最多 +1 阶段；到顶(5)仍按到期复习不永久毕业', () => {
    const p = defaultProgressV2()
    const now = Date.now()
    p.questionStates.q1 = { stage: 5, dueAt: now - 1000, correct: 20, total: 20 }
    applyQuestionReview(p, 'q1', { firstAttempt: true, outcome: 'correct', independent: true, wasDue: true, now })
    expect(p.questionStates.q1.stage).toBe(5)
    expect(p.questionStates.q1.dueAt).toBe(now + 15 * DAY)   // 到期仍返回（INTERVALS[5]=15）
  })
})

describe('用例 3：同轮首错、立即重试对——保留首次错误', () => {
  it('重试成功不提升阶段、不当独立掌握', () => {
    const p = defaultProgressV2()
    const now = Date.now()
    applyQuestionReview(p, 'q1', { firstAttempt: true, outcome: 'incorrect', independent: false, wasDue: true, now })
    const dueAfterFail = p.questionStates['q1'].dueAt
    applyQuestionReview(p, 'q1', { firstAttempt: false, outcome: 'correct', independent: false, wasDue: true, now: now + 60_000 })
    const st = p.questionStates['q1']
    expect(st.stage).toBe(0)                          // 没被重试拉起来
    expect(st.dueAt).toBe(dueAfterFail)               // 没被重试推延
    expect(st.lastIndependentSuccessAt).toBeUndefined()
    expect(st.lastFailureAt).toBe(now)                // 首次错误保留
    expect(st.total).toBe(2)
    expect(st.correct).toBe(1)                        // 练习记录记下，但不当独立证据
  })
})

describe('用例 8：跳过/识别失败分别记录，不一概判对错', () => {
  it('outcome=skipped：阶段与到期保持原样', () => {
    const p = defaultProgressV2()
    const now = Date.now()
    p.questionStates.q1 = { stage: 2, dueAt: now + DAY, correct: 3, total: 5 }
    applyQuestionReview(p, 'q1', { firstAttempt: true, outcome: 'skipped', independent: false, wasDue: false, now })
    expect(p.questionStates.q1.stage).toBe(2)
    expect(p.questionStates.q1.dueAt).toBe(now + DAY)
    expect(p.questionStates.q1.total).toBe(6)         // 只多一条作答记录
    expect(p.questionStates.q1.lastFailureAt).toBeUndefined()  // 不算失败
  })
})

// ---------- 用例 6/7：按 ID 判定 ----------

describe('用例 6：判定按稳定 ID，不依赖选项原下标', () => {
  const q = adaptQuestion({ id: 'c1', skill: 's', type: 'choice', prompt: 'p', options: ['right', 'wrong1', 'wrong2'], answer: 'right', explain: 'e' } as Question)
  it('适配器生成与 options 平行的稳定 ID', () => {
    expect(q.optionIds).toEqual(['c1#0', 'c1#1', 'c1#2'])
    expect(q.answerId).toBe('c1#0')
  })
  it('同一会话选项顺序可复现且是完整排列', () => {
    const a = makeQueueItem(q, 'sess')
    const b = makeQueueItem(q, 'sess')
    expect(a.optionOrder).toEqual(b.optionOrder)
    expect([...(a.optionOrder ?? [])].sort()).toEqual([...q.optionIds].sort())
    const c = makeQueueItem(q, 'other-session')
    expect(c.optionOrder).toBeDefined()
  })
  it('无论顺序如何，正确项按 ID 命中', () => {
    const item = makeQueueItem(q, 'sess')
    const correct = (item.optionOrder ?? []).filter((id) => gradeChoice(q, id))
    expect(correct).toEqual(['c1#0'])
    expect(gradeChoice(q, 'c1#1')).toBe(false)
  })
  it('tap 按 token ID 判定', () => {
    const t = adaptQuestion({ id: 'c2', skill: 's', type: 'tap', prompt: 'p', tokens: ['I', 'don\'t', 'know'], answer: "don't", fix: "didn't", explain: 'e' } as Question)
    expect(gradeTap(t, t.answerId)).toBe(true)
    expect(gradeTap(t, t.tokens2[0].id)).toBe(false)
  })
})

describe('用例 7：词块包含相同文字——两个词块都可用可撤回', () => {
  const q = adaptQuestion({
    id: 'c3', skill: 's', type: 'tiles', prompt: 'p',
    tokens: ['the', 'book', 'the', 'pen'], order: ['the', 'book'], explain: 'e',
  } as Question)
  it('四个词块各有独立 ID', () => {
    expect(new Set(q.tokens2.map((t) => t.id)).size).toBe(4)
    expect(q.tokens2[0].text).toBe(q.tokens2[2].text)
  })
  it('拿哪个 "the" 判定都对（文本互换）；多拿/错序判错', () => {
    expect(gradeSequence(q, ['c3#t0', 'c3#t1'])).toBe(true)
    expect(gradeSequence(q, ['c3#t2', 'c3#t1'])).toBe(true)   // 第二个 the 也有效
    expect(gradeSequence(q, ['c3#t0'])).toBe(false)            // 没拿全
    expect(gradeSequence(q, ['c3#t1', 'c3#t0'])).toBe(false)   // 语序错
    expect(gradeSequence(q, ['c3#t0', 'c3#t1', 'c3#t2'])).toBe(false)  // 多拿
  })
})

// ---------- 队列：冻结 / 到期配额 / 隔离 ----------

describe('队列生成（§5.4）', () => {
  const pool = eligible(allQuestions)

  it('题库有效：ID 唯一、答案存在、无重复选项、元数据齐全（结构校验零错误）', () => {
    expect(errorsOf(validateQuestions(allQuestions))).toEqual([])
  })

  it('quarantined / 保留题不进普通抽题', () => {
    const a = mkq({ id: 'ok1' })
    const b = mkq({ id: 'q1', reviewStatus: 'quarantined' })
    const c = mkq({ id: 'h1', assessmentRole: 'holdout' })
    expect(eligible([a, b, c]).map((q) => q.id)).toEqual(['ok1'])
  })

  it('今日队列 = 10 任务、无重复、同会话可复现（生成后冻结，用例 4 的基础）', () => {
    const p = defaultProgressV2()
    const q1 = buildTodayQueue(p, pool, 'sess-A')
    const q2 = buildTodayQueue(p, pool, 'sess-A')
    expect(q1).toHaveLength(10)
    expect(new Set(q1.map((i) => i.qid)).size).toBe(10)
    expect(q2).toEqual(q1)                          // 同 seed 同队列：刷新恢复不漂移
    // 冻结的选项顺序逐题一致（同 session 同题 → 同顺序）
    for (const it of q1) {
      const q = allQuestions.find((x) => x.id === it.qid)!
      expect(it.optionOrder).toEqual(makeQueueItem(q, 'sess-A').optionOrder)
    }
  })

  it('复习积压：最多 7 个到期任务，保留至少 3 个变化位', () => {
    const p = defaultProgressV2()
    const now = Date.now()
    const seedQueue = buildTodayQueue(p, pool, 'sess-S')
    for (const it of seedQueue.slice(0, 9)) {
      p.questionStates[it.qid] = { stage: 2, dueAt: now - (9 - seedQueue.indexOf(it)) * 1000, correct: 3, total: 5 }
    }
    const q = buildTodayQueue(p, pool, 'sess-B')
    expect(q).toHaveLength(10)
    expect(q.filter((i) => i.isDueReview).length).toBeLessThanOrEqual(7)
  })

  it('到期题跨技能打散 + 逾期久的优先', () => {
    const p = defaultProgressV2()
    const now = Date.now()
    const skills = [...new Set(pool.map((q) => q.skill))].slice(0, 3)
    const qs = skills.map((s) => pool.find((q) => q.skill === s)!)
    p.questionStates[qs[0].id] = { stage: 1, dueAt: now - 5 * DAY, correct: 1, total: 2 }   // 逾期 5 天
    p.questionStates[qs[1].id] = { stage: 1, dueAt: now - 1 * DAY, correct: 1, total: 2 }
    p.questionStates[qs[2].id] = { stage: 1, dueAt: now - 3 * DAY, correct: 1, total: 2 }
    const due = dueQuestions(p, pool, now)
    expect(due[0].id).toBe(qs[0].id)                // 逾期最久排最前
    expect(new Set(due.map((d) => d.skill)).size).toBeGreaterThanOrEqual(3)
  })

  it('技能队列不超过 12 题且全部来自该技能', () => {
    const p = defaultProgressV2()
    const sid = 't10s5'
    const q = buildSkillQueue(p, allQuestions.filter((x) => x.skill === sid), 'sess', 0)
    expect(q.length).toBeGreaterThan(0)
    expect(q.length).toBeLessThanOrEqual(12)
    expect(q.every((i) => allQuestions.find((x) => x.id === i.qid)?.skill === sid)).toBe(true)
  })

  it('复习队列全部来自题级到期数据（不从技能 box 推断）', () => {
    const p = defaultProgressV2()
    expect(buildReviewQueue(p, pool, 's')).toHaveLength(0)   // 没有任何题级到期 → 空
    const qid = pool[0].id
    p.questionStates[qid] = { stage: 2, dueAt: Date.now() - 1000, correct: 2, total: 3 }
    const q = buildReviewQueue(p, pool, 's')
    expect(q.map((i) => i.qid)).toEqual([qid])
    expect(q[0].isDueReview).toBe(true)
  })
})

describe('§3.3 错误处理：变式补练与降难', () => {
  it('首错后过至少两个任务插入同技能变式（不重复、不假装新题）', () => {
    const failed = mkq({ id: 'f1', skill: 'sA', type: 'choice' })
    const variant = mkq({ id: 'v1', skill: 'sA', type: 'choice', diff: 2 })
    const otherSkill = mkq({ id: 'o1', skill: 'sB', type: 'choice' })
    const queue: QueueItem[] = [{ qid: 'f1' }, { qid: 'x1' }, { qid: 'x2' }]
    const inserted = insertVariantDrill(queue, 1, 'f1', [failed, variant, otherSkill, mkq({ id: 'x1', skill: 'sA' }), mkq({ id: 'x2', skill: 'sA' })], 'sess')
    expect(inserted).toBe(true)
    expect(queue).toHaveLength(4)
    expect(queue[3].qid).toBe('v1')                 // 过了两个任务（x1、x2）之后
    expect(queue[3].isVariantDrill).toBe(true)
    // 已有待做变式 → 不重复插
    expect(insertVariantDrill(queue, 4, 'f1', [failed, variant], 'sess')).toBe(false)
    // 无候选（都已在队列里）→ 不插
    const q2 = [{ qid: 'f1' }]
    expect(insertVariantDrill(q2, 1, 'f1', [failed], 'sess')).toBe(false)
    expect(q2).toHaveLength(1)
  })

  it('连续三次首错：剩余高难题被换成更基础题（停止加难）', () => {
    const hard = mkq({ id: 'h1', skill: 'sA', diff: 3 })
    const easy = mkq({ id: 'e1', skill: 'sA', diff: 1 })
    const queue = [{ qid: 'h1' }, { qid: 'h1' }]
    const changed = softenQueue(queue, 1, 'sA', [hard, easy], 'sess')
    expect(changed).toBe(1)
    expect(queue[1].qid).toBe('e1')
  })
})

// ---------- 证据与状态（P0-04） ----------

describe('能力证据：四状态与分项（§5.2）', () => {
  function scenario() {
    const rec = mkq({ id: 'r1', skill: 'skX', mode: 'recognition' })
    const comp = mkq({ id: 'c1', skill: 'skX', mode: 'comprehension' })
    const con = mkq({ id: 'n1', skill: 'skX', mode: 'construction' })
    const rec2 = mkq({ id: 'r2', skill: 'skX', mode: 'recognition' })
    return { pool: [rec, comp, con, rec2] as AdaptedQuestion[], p: defaultProgressV2() }
  }
  const day1 = '2026-09-20'
  const day2 = '2026-09-21'

  it('历史 box 不当新证据：只有 v1 记录 → 未练习（legacyOnly）', () => {
    const { pool, p } = scenario()
    p.questionStates.r1 = { stage: 5, dueAt: Date.now() + DAY, correct: 9, total: 9, legacy: true }
    const rep = buildEvidence(p, pool)
    expect(rep.bySkill.skX.state).toBe('unseen')
    expect(rep.bySkill.skX.legacyOnly).toBe(true)
  })

  it('同日连对五题不能显示稳定掌握（需 ≥2 训练日 + ≥3 变式组 + 三类证据）', () => {
    const { pool, p } = scenario()
    p.attempts.push(
      mkAttempt({ questionId: 'r1', localDate: day1 }),
      mkAttempt({ questionId: 'c1', localDate: day1, mode: 'comprehension' }),
      mkAttempt({ questionId: 'n1', localDate: day1, mode: 'construction' }),
      mkAttempt({ questionId: 'r2', localDate: day1 }),
    )
    const rep = buildEvidence(p, pool)
    expect(rep.bySkill.skX.state).toBe('building')   // 只有 1 天
  })

  it('跨 2 日且至少十次合格证据 → 初步稳定', () => {
    const { pool, p } = scenario()
    p.attempts.push(
      mkAttempt({ questionId: 'r1', localDate: day1 }),
      mkAttempt({ questionId: 'c1', localDate: day1, mode: 'comprehension' }),
      mkAttempt({ questionId: 'n1', localDate: day1, mode: 'construction' }),
      mkAttempt({ questionId: 'r2', localDate: day2, sessionId: 'sess-2' }),
    )
    expect(buildEvidence(p, pool).bySkill.skX.state).toBe('building')
    for (let i = 0; i < 6; i++) p.attempts.push(mkAttempt({ questionId: pool[i % 4].id, mode: pool[i % 4].mode, localDate: day2, sessionId: `extra-${i}` }))
    const rep = buildEvidence(p, pool)
    expect(rep.bySkill.skX.state).toBe('early-stable')
    expect(rep.bySkill.skX.last10).toEqual({ correct: 10, total: 10 })
    expect(rep.dueSuccesses).toBe(0)
  })

  it('未处理的关键错误阻止稳定：需"后续不同变式独立完成 + 一次延迟检索"', () => {
    const { pool, p } = scenario()
    p.attempts.push(
      mkAttempt({ questionId: 'c1', localDate: day1, mode: 'comprehension', outcome: 'incorrect' }),
      mkAttempt({ questionId: 'r1', localDate: day1 }),
      mkAttempt({ questionId: 'n1', localDate: day1, mode: 'construction' }),
      mkAttempt({ questionId: 'r2', localDate: day2, sessionId: 'sess-2' }),
      mkAttempt({ questionId: 'c1', localDate: day2, sessionId: 'sess-2', mode: 'comprehension' }),   // 不同变式后续独立对
    )
    let rep = buildEvidence(p, pool)
    expect(rep.bySkill.skX.state).toBe('building')            // 还缺延迟检索
    expect(rep.openErrorQids.has('c1')).toBe(true)
    // 第二天对 c1 做一次到期检索（isDueReview）→ 错误处理完
    p.attempts.push(
      mkAttempt({ questionId: 'c1', localDate: '2026-09-24', sessionId: 'sess-3', mode: 'comprehension', isDueReview: true }),
    )
    for (let i = 0; i < 4; i++) p.attempts.push(mkAttempt({ questionId: pool[i].id, mode: pool[i].mode, localDate: day2, sessionId: `extra-${i}` }))
    rep = buildEvidence(p, pool)
    expect(rep.openErrorQids.has('c1')).toBe(false)
    expect(rep.bySkill.skX.state).toBe('early-stable')
  })

  it('同一会话同一变式组只贡献一次覆盖（换名刷覆盖无效）', () => {
    const { pool, p } = scenario()
    for (let i = 0; i < 5; i++) {
      p.attempts.push(mkAttempt({ questionId: 'r1', localDate: day1 }))   // 同会话同组 5 次
    }
    const rep = buildEvidence(p, pool)
    expect(rep.bySkill.skX.last10.total).toBe(1)   // 只算 1 次覆盖
  })

  it('题目修订（contentVersion 变化）后旧证据要求重检（用例 10）', () => {
    const { pool, p } = scenario()
    p.attempts.push(
      mkAttempt({ questionId: 'r1', localDate: day1, contentVersion: 1 }),
      mkAttempt({ questionId: 'c1', localDate: day1, mode: 'comprehension', contentVersion: 1 }),
    )
    const bumped = pool.map((q) => (q.id === 'r1' ? { ...q, contentVersion: 2 } : q))
    const rep = buildEvidence(p, bumped)
    expect(rep.bySkill.skX.last10.total).toBe(1)   // r1 的旧证据被排除，只剩 c1
  })

  it('口头表达与客观证据分开显示', () => {
    const { pool, p } = scenario()
    const oralQ = mkq({ id: 'sp1', skill: 'skX', mode: 'oral', type: 'speak' })
    pool.push(oralQ)
    p.questionStates.sp1 = { stage: 0, dueAt: 0, correct: 0, total: 0, speak: { status: 'prompted', at: Date.now() } }
    p.attempts.push(
      mkAttempt({ questionId: 'r1', localDate: day1 }),
      mkAttempt({ questionId: 'sp1', localDate: day1, mode: 'oral', evaluator: 'transcriptMatch', outcome: 'correct', supportUsed: 3 }),
    )
    const rep = buildEvidence(p, pool)
    expect(rep.oral.prompted).toBe(1)
    expect(rep.bySkill.skX.last10.total).toBe(1)   // 口语不进客观窗口
    expect(rep.dims.find((d) => d.mode === 'recognition')?.total).toBe(1)
  })
})


describe('Review fixes: scheduling edge cases', () => {
  it('today queue has no duplicate IDs when special tasks also appear in the current skill', () => {
    const p = defaultProgressV2()
    const pool = Array.from({length: 15}, (_, i) => mkq({id:`unique-${i}`, skill:'same', type:i < 2 ? 'speak' : 'choice'}))
    const queue = buildTodayQueue(p, pool, 'no-duplicate', {skillOrder:['same']})
    expect(queue).toHaveLength(10)
    expect(new Set(queue.map(q => q.qid)).size).toBe(10)
  })
  it('returns all overdue items even with highly unbalanced skill counts', () => {
    const p = defaultProgressV2()
    const pool = Array.from({length: 40}, (_, i) => mkq({id:`due-${i}`,skill:i < 30 ? 'large' : `single-${i}`}))
    pool.forEach(q => {p.questionStates[q.id] = {stage:1,dueAt:1,correct:1,total:1}})
    expect(dueQuestions(p,pool,100).length).toBe(40)
  })
  it('skill practice flags due reviews and drills never upgrade memory', () => {
    const p = defaultProgressV2(); const q = mkq({id:'due-skill'})
    p.questionStates[q.id] = {stage:2,dueAt:1,correct:2,total:2}
    expect(buildSkillQueue(p,[q],'skill',1)[0].isDueReview).toBe(true)
    applyQuestionReview(p,q.id,{firstAttempt:true,outcome:'correct',independent:true,wasDue:true,isVariantDrill:true,now:100})
    expect(p.questionStates[q.id].stage).toBe(2)
    expect(p.questionStates[q.id].dueAt).toBe(1)
  })
  it('does not insert an immediate variant without two intervening tasks', () => {
    const a = mkq({id:'a'}), b = mkq({id:'b'})
    const queue = [makeQueueItem(a,'s')]
    expect(insertVariantDrill(queue,1,'a',[a,b],'s')).toBe(false)
  })
  it('draft content and remediation attempts do not establish competence', () => {
    const p = defaultProgressV2()
    const draft = mkq({id:'draft',reviewStatus:'draft'}), drill = mkq({id:'drill'})
    p.attempts = [mkAttempt({questionId:'draft'}),mkAttempt({questionId:'drill',isVariantDrill:true})]
    expect(buildEvidence(p,[draft,drill]).dims.every(d => d.total === 0)).toBe(true)
  })
})

describe('口语题排程（回归：反复出现且清不掉）', () => {
  // 现象：口语题「黑板看起来很干净。」反复出现在巩固复习里，练完也不消失。
  // 原因：口语题不走 applyQuestionReview，而 recordSpeak 只写 speak 子状态、不推进 dueAt，
  //       于是任何带历史记录的口语题（如 v1 迁移来的 total>0 + 过去的 dueAt）永久到期。
  const speakQ = () => mkq({ id: 'v2q10', type: 'speak', mode: 'oral', target: 'The blackboard looks clean.', tts: 'The blackboard looks clean.' })

  it('迁移来的历史口语题在完成后必须离开到期队列', () => {
    const p = defaultProgressV2()
    const q = speakQ()
    p.questionStates[q.id] = { stage: 2, dueAt: Date.now() - DAY * 30, correct: 2, total: 2, legacy: true }
    expect(dueQuestions(p, [q]).map((x) => x.id)).toEqual([q.id])   // 一进来就是到期的
    recordSpeak(p, q.id, 'independent-self', true)
    expect(dueQuestions(p, [q])).toHaveLength(0)                   // 完成后不得再出现在到期队列
    expect(p.questionStates[q.id].dueAt).toBeGreaterThan(Date.now())
  })

  it('独立完成升一阶并按新阶段排下次到期；依赖提示则次日再来', () => {
    const p = defaultProgressV2()
    const q = speakQ()
    recordSpeak(p, q.id, 'independent-self', true, 1000)
    expect(p.questionStates[q.id].stage).toBe(1)
    expect(p.questionStates[q.id].dueAt).toBe(1000 + INTERVALS[1] * DAY)
    expect(p.questionStates[q.id].speak?.status).toBe('independent-self')

    recordSpeak(p, q.id, 'independent-self', false, 2000)
    expect(p.questionStates[q.id].stage).toBe(0)
    expect(p.questionStates[q.id].dueAt).toBe(2000 + DAY)
    expect(p.questionStates[q.id].speak?.status).toBe('prompted')   // 依赖提示一律记为 prompted
  })

  it('练习量照常累计，但口语题不进确定性判定路径', () => {
    const p = defaultProgressV2()
    const q = speakQ()
    recordSpeak(p, q.id, 'independent-self', true, 1000)
    expect(p.questionStates[q.id].total).toBe(1)
    expect(p.questionStates[q.id].correct).toBe(1)
  })
})
