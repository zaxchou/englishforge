// 训练日口径的回归测试：「跨 ≥2 个训练日」必须按该知识点全部作答统计。
// 背景：曾按"最近 10 次的 distinct date"算 —— 每天队列 10 道且全来自同一知识点时
// 它恒等于 1，"已掌握"永远判不出来（生产数据 11 个知识点全是"现在 1 天"）。
import { describe, it, expect } from 'vitest'
import { buildEvidence } from './evidence'
import { defaultProgressV2 } from '../store/migrations'
import type { AdaptedQuestion, Attempt, Mode, ProgressV2 } from '../types'

const DAY = 24 * 60 * 60 * 1000
const BASE = 1_800_000_000_000

function poolOf(n: number): AdaptedQuestion[] {
  const modes: Mode[] = ['recognition', 'comprehension', 'construction']
  return Array.from({ length: n }, (_, i) => {
    const id = `q${i + 1}`
    return {
      id, skill: 'sk', type: 'choice', prompt: 'p', explain: 'e',
      options: ['A', 'B'], answer: 'A',
      optionIds: [`${id}#0`, `${id}#1`],
      tokens2: [], orderIds: [], answerId: `${id}#0`,
      mode: modes[i % 3], variantGroupId: id, objectiveId: 'sk',
      contentVersion: 1, reviewStatus: 'reviewed', assessmentRole: 'practice',
      level: 1, diff: 1,
    } as AdaptedQuestion
  })
}

function attempts(questionIds: string[], localDate: string, start: number): Attempt[] {
  return questionIds.map((questionId, i) => ({
    attemptId: `${localDate}-${i}`, sessionId: `${localDate}-s`, questionId,
    contentVersion: 1, objectiveId: 'sk', variantGroupId: questionId,
    mode: 'recognition', timestamp: start + i * 1000, localDate,
    firstAttempt: true, supportUsed: 0, answer: 'A', outcome: 'correct',
    evaluator: 'deterministic', responseMs: 1000, isDueReview: false,
  }))
}

function run(p: ProgressV2, ids: string[]) {
  return buildEvidence(p, poolOf(ids.length)).bySkill.sk
}

describe('「跨 ≥2 个训练日」按全部作答统计', () => {
  it('第二天一整天做完（最近 10 次全在同一天）也能算跨 2 天', () => {
    const p = defaultProgressV2()
    const ids = Array.from({ length: 12 }, (_, i) => `q${i + 1}`)
    // 第一天 12 道、第二天 12 道 —— 最近 10 次**全部**落在第二天
    p.attempts = [...attempts(ids, '2026-09-27', BASE), ...attempts(ids, '2026-09-28', BASE + DAY)]
    const ev = run(p, ids)
    expect(ev.days).toBe(2)
    expect(ev.evidence.some((t) => t.includes('覆盖 2 个训练日'))).toBe(true)
    expect(ev.state).toBe('early-stable')       // 其余条件全满足：率 10/10、变式 10、三维度齐、无遗留错题
  })

  it('只练过一天的仍然不达标（判据没有被放松成"看见过就行"）', () => {
    const p = defaultProgressV2()
    const ids = Array.from({ length: 12 }, (_, i) => `q${i + 1}`)
    p.attempts = attempts(ids, '2026-09-27', BASE)
    const ev = run(p, ids)
    expect(ev.days).toBe(1)
    expect(ev.state).toBe('building')
    expect(ev.evidence.some((t) => t.includes('需跨 2 个训练日'))).toBe(true)
  })

  it('答对率仍看最近 10 次：第二天答对率掉下来就不能达标', () => {
    const p = defaultProgressV2()
    const ids = Array.from({ length: 12 }, (_, i) => `q${i + 1}`)
    p.attempts = attempts(ids, '2026-09-27', BASE)
    const day2 = attempts(ids, '2026-09-28', BASE + DAY)
    for (let i = 0; i < 6; i++) day2[i] = { ...day2[i], outcome: 'incorrect' as const }
    p.attempts = [...p.attempts, ...day2]
    const ev = run(p, ids)
    expect(ev.days).toBe(2)                     // 跨天满足
    expect(ev.state).toBe('building')           // 但最近 10 次答对率 4/10 < 80% → 不给认证
  })
})
