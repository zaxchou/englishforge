// 深度阶梯（档位解锁）的回归测试
// 关注三件事：老题库完全不受影响、档位必须连续解锁、队列只放行已解锁的档。
import { describe, it, expect } from 'vitest'
import { LADDER_STEPS, levelStatuses, ladderLevels, hasLadder, unlockedLevel, ladderFilter, needOf } from './ladder'
import { buildTodayQueue, buildSkillQueue } from './scheduler'
import { adaptAll } from '../content/adapt'
import { validateQuestions, errorsOf } from '../content/validation'
import { defaultProgressV2 } from '../store/migrations'
import { ladderDemoQuestions } from '../data/ladder-demo'
import { allQuestions } from '../data/course'
import type { AdaptedQuestion, Attempt } from '../types'

let seq = 0
function mkq(over: Partial<AdaptedQuestion> = {}): AdaptedQuestion {
  const id = over.id ?? `q${++seq}`
  const skill = over.skill ?? 'skA'
  return {
    id, skill, type: 'choice', prompt: 'p', explain: 'e',
    options: ['A1', 'B1'], answer: 'A1',
    optionIds: [`${id}#0`, `${id}#1`],
    tokens2: [], orderIds: [], answerId: `${id}#0`,
    mode: 'recognition', variantGroupId: id, objectiveId: skill,
    contentVersion: 1, reviewStatus: 'reviewed', assessmentRole: 'practice',
    diff: 1, level: 1,
    ...over,
  }
}

let aseq = 0
function att(questionId: string, over: Partial<Attempt> = {}): Attempt {
  const n = ++aseq
  return {
    attemptId: `a${n}`, sessionId: 's1', questionId,
    contentVersion: 1, objectiveId: 'skB', variantGroupId: questionId,
    mode: 'recognition', timestamp: 1_800_000_000_000 + n * 1000, localDate: '2026-09-27',
    firstAttempt: true, supportUsed: 0, answer: 'A1', outcome: 'correct',
    evaluator: 'deterministic', responseMs: 900, isDueReview: false,
    ...over,
  }
}

/** 3 档阶梯（每档 3 题）的测试题池 */
function ladderPool(): AdaptedQuestion[] {
  const out: AdaptedQuestion[] = []
  for (let lv = 1; lv <= 3; lv++) {
    for (let i = 1; i <= 3; i++) out.push(mkq({ id: `b${lv}-${i}`, skill: 'skB', level: lv as 1 | 2 | 3 }))
  }
  return out
}

describe('样板题结构：6 档 × 3 题、结构校验无 error', () => {
  it('档位齐全且每档 3 道', () => {
    expect(ladderDemoQuestions).toHaveLength(18)
    const byLevel = new Map<number, number>()
    for (const q of ladderDemoQuestions) byLevel.set(q.level ?? 1, (byLevel.get(q.level ?? 1) ?? 0) + 1)
    expect([...byLevel.entries()].sort()).toEqual([[1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3]])
    expect(LADDER_STEPS).toHaveLength(6)
  })

  it('全部题目结构合法（干扰词块只应是 warn，不能是 error）', () => {
    const adapted = adaptAll(ladderDemoQuestions)
    const errs = errorsOf(validateQuestions(adapted))
    expect(errs.map((e) => `${e.qid}: ${e.msg}`)).toEqual([])
  })

  it('六档确实带来能力维度的推进：1 档只识别、4 档必须有产出/口语', () => {
    const a = adaptAll(ladderDemoQuestions)
    const modes = (lv: number) => new Set(a.filter((q) => q.level === lv).map((q) => q.mode))
    expect(modes(1).has('recognition')).toBe(true)
    expect(modes(2).has('construction')).toBe(true)     // 拼句产出
    expect(modes(4).has('oral')).toBe(true)             // 无脚手架说出来
    expect(modes(6).has('comprehension')).toBe(true)    // 反向解释
  })
})

describe('无阶梯的老题库：行为完全不变', () => {
  it('纯 level=1 的池子不算阶梯，ladderFilter 原样返回', () => {
    const pool = [mkq({ skill: 'skA' }), mkq({ skill: 'skA' }), mkq({ skill: 'skC' })]
    const p = defaultProgressV2()
    expect(ladderLevels(pool, 'skA')).toEqual([])
    expect(hasLadder(pool, 'skA')).toBe(false)
    expect(unlockedLevel(pool, p, 'skA')).toBe(6)
    expect(ladderFilter(pool, p)).toHaveLength(3)
  })
})

describe('档位必须连续解锁', () => {
  it('初始只开第 1 档', () => {
    const pool = ladderPool()
    const p = defaultProgressV2()
    expect(unlockedLevel(pool, p, 'skB')).toBe(1)
    expect(ladderFilter(pool, p).map((q) => q.id).sort()).toEqual(['b1-1', 'b1-2', 'b1-3'])
  })

  it('第 1 档做满且首发达标 → 开第 2 档；没做满不开', () => {
    const pool = ladderPool()
    const p = defaultProgressV2()
    p.attempts = [att('b1-1'), att('b1-2')]                      // 只做了 2/3
    expect(unlockedLevel(pool, p, 'skB')).toBe(1)
    p.attempts.push(att('b1-3'))                                 // 做满 3/3，首发全对（need=2）
    expect(levelStatuses(pool, p, 'skB')[0].passed).toBe(true)
    expect(unlockedLevel(pool, p, 'skB')).toBe(2)
    // 第 3 档仍然锁着（不允许跳档）
    expect(unlockedLevel(pool, p, 'skB')).toBeLessThan(3)
    expect(ladderFilter(pool, p).some((q) => q.level === 3)).toBe(false)
  })

  it('第 1 档首发答不够（3 题只对 1，门槛要 2）→ 卡住，第 2 档不开', () => {
    const pool = ladderPool()
    const p = defaultProgressV2()
    p.attempts = [att('b1-1'), att('b1-2', { outcome: 'incorrect' }), att('b1-3', { outcome: 'incorrect' })]
    const st = levelStatuses(pool, p, 'skB')[0]
    expect(st.need).toBe(2)
    expect(st.passed).toBe(false)
    expect(st.gap).toMatch(/首发答对/)
    expect(unlockedLevel(pool, p, 'skB')).toBe(1)
  })

  it('防卡死：本档累计首发达到 题数×3 仍不达标也放行（档位不能变成永久牢房）', () => {
    const pool = ladderPool()
    const p = defaultProgressV2()
    for (let i = 0; i < 3; i++) {
      for (const qid of ['b1-1', 'b1-2', 'b1-3']) p.attempts.push(att(qid, { outcome: 'incorrect' }))
    }
    const st = levelStatuses(pool, p, 'skB')[0]
    expect(st.attempts).toBeGreaterThanOrEqual(9)
    expect(st.passed).toBe(true)
    expect(unlockedLevel(pool, p, 'skB')).toBe(2)
  })

  it('needOf：3 题要 2 题、1 题至少要 1 题', () => {
    expect(needOf(3)).toBe(2)
    expect(needOf(1)).toBe(1)
    expect(needOf(0)).toBe(0)
  })
})

describe('队列只放行已解锁的档', () => {
  it('buildTodayQueue 不会把未解锁档的题塞进来', () => {
    const pool = ladderPool()
    const p = defaultProgressV2()
    const items = buildTodayQueue(p, pool, 'sess-l', { skillOrder: ['skB'] })
    const ids = new Set(items.map((i) => i.qid))
    expect([...ids].some((id) => id.startsWith('b2-') || id.startsWith('b3-'))).toBe(false)
    expect(ids.has('b1-1')).toBe(true)
    expect(items.length).toBeGreaterThan(0)
  })

  it('通过第 1 档后，下一档进入队列', () => {
    const pool = ladderPool()
    const p = defaultProgressV2()
    p.attempts = [att('b1-1'), att('b1-2'), att('b1-3')]
    const items = buildTodayQueue(p, pool, 'sess-l', { skillOrder: ['skB'] })
    expect(items.some((i) => i.qid.startsWith('b2-'))).toBe(true)
    expect(items.some((i) => i.qid.startsWith('b3-'))).toBe(false)
  })

  it('单技能练习（点路径上的点）同样按档过滤', () => {
    const pool = ladderPool()
    const p = defaultProgressV2()
    const items = buildSkillQueue(p, pool, 'sess-s', 0)
    expect(items.every((i) => i.qid.startsWith('b1-'))).toBe(true)
  })

  it('阶梯没走完时不拿别的技能新题凑数（否则队列就变成"3 新 + 7 老"）', () => {
    const other = Array.from({ length: 10 }, (_, i) => mkq({ id: `o${i}`, skill: 'skA' }))
    const pool = [...ladderPool(), ...other]
    const p = defaultProgressV2()
    const items = buildTodayQueue(p, pool, 'sess-x', { skillOrder: ['skB'] })
    expect(items.length).toBeGreaterThan(0)
    // 全部来自阶梯技能（skB），没有 skA 的题
    expect(items.every((i) => !i.qid.startsWith('o'))).toBe(true)
    // 只有第 1 档的 3 道（后面不补老题，队列就到这 3 条）
    expect(items).toHaveLength(3)
    expect(items.every((i) => i.qid.startsWith('b1-'))).toBe(true)
  })

  it('整条阶梯走完后回到全池补足（队列不会只剩一两条）', () => {
    const other = Array.from({ length: 10 }, (_, i) => mkq({ id: `f${i}`, skill: 'skA' }))
    const pool = [...ladderPool(), ...other]
    const p = defaultProgressV2()
    for (const lv of [1, 2, 3]) for (let i = 1; i <= 3; i++) p.attempts.push(att(`b${lv}-${i}`))
    const items = buildTodayQueue(p, pool, 'sess-y', { skillOrder: ['skB'] })
    expect(items).toHaveLength(10)
    expect(items.some((i) => i.qid.startsWith('b'))).toBe(true)
    expect(items.some((i) => i.qid.startsWith('f'))).toBe(true)
  })

  it('真实样板：打开应用时 current 档是第 1 档，队列里只有 1 档的题', () => {
    const p = defaultProgressV2()
    const ldd = allQuestions.filter((q) => q.skill === 'ldd1')
    expect(ldd).toHaveLength(18)
    expect(unlockedLevel(allQuestions, p, 'ldd1')).toBe(1)
    const items = buildTodayQueue(p, allQuestions, 'sess-r', { skillOrder: ['ldd1'] })
    const qById = new Map(allQuestions.map((q) => [q.id, q]))
    expect(items.length).toBeGreaterThan(0)
    for (const it of items) expect(qById.get(it.qid)?.level ?? 1).toBeLessThanOrEqual(1)
  })
})
