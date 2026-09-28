// 启动接管决策的测试。
//
// 这是整个同步里唯一"猜错了就会丢进度"的地方，所以它必须是纯函数且被覆盖：
// 老用户第一次跑要整份搬进库、换浏览器要能接管库里的、两边都练过要取并集而不是覆盖。
import { describe, expect, it } from 'vitest'
import { decideBoot, isEmptyProgress, unionProgress } from './db'
import type { Attempt, ProgressV2 } from '../types'

function attempt(id: string, over: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: id, sessionId: 's', questionId: 'q1', contentVersion: 1,
    objectiveId: 'o1', variantGroupId: 'v1', mode: 'recognition',
    timestamp: 1000, localDate: '2026-09-28', firstAttempt: true, supportUsed: 0,
    answer: 'x', outcome: 'correct', evaluator: 'deterministic', isDueReview: false,
    ...over,
  }
}

function progress(over: Partial<ProgressV2> = {}): ProgressV2 {
  return {
    schemaVersion: 2, xp: 0, streak: 0, lastActiveDate: '', comboBest: 0,
    skills: {}, dailyXp: {}, sessions: [], questionStates: {}, attempts: [],
    activeSession: null, ...over,
  }
}

const pulled = (p: ProgressV2) => ({ progress: p, revision: 3, reviews: {}, updatedAt: 0 })

describe('isEmptyProgress', () => {
  it('全空才算空', () => {
    expect(isEmptyProgress(progress())).toBe(true)
    expect(isEmptyProgress(progress({ attempts: [attempt('a')] }))).toBe(false)
    expect(isEmptyProgress(progress({ questionStates: { q1: { stage: 1, dueAt: 0, correct: 1, total: 1 } } }))).toBe(false)
    expect(isEmptyProgress(progress({ xp: 10 }))).toBe(false)
    expect(isEmptyProgress(progress({ sessions: [{ ts: 1, label: '', lessonNo: '', acc: 0, xp: 0, total: 0, firstTry: 0 }] }))).toBe(false)
  })
})

describe('decideBoot', () => {
  it('数据库连不上：有本地进度就等着搬，没进度就全新开始', () => {
    expect(decideBoot(progress(), null).kind).toBe('fresh')
    expect(decideBoot(progress({ xp: 50 }), null).kind).toBe('upload-local')
  })

  it('老用户第一次跑：本地有、库里空 → 整份搬进库', () => {
    expect(decideBoot(progress({ attempts: [attempt('a')] }), pulled(progress())).kind).toBe('upload-local')
  })

  it('换浏览器：本地空、库里有 → 接管库里的进度', () => {
    const d = decideBoot(progress(), pulled(progress({ xp: 88 })))
    expect(d.kind).toBe('adopt-remote')
  })

  it('两边都空 → 全新开始', () => {
    expect(decideBoot(progress(), pulled(progress())).kind).toBe('fresh')
  })

  it('两边都有 → 以本地为准并取并集，绝不整份覆盖', () => {
    const d = decideBoot(progress({ xp: 10 }), pulled(progress({ xp: 99 })))
    expect(d.kind).toBe('merge')
  })

  it('库被清空过（本地有进度、库里空）→ 仍然整份补回去', () => {
    expect(decideBoot(progress({ attempts: [attempt('a')] }), pulled(progress())).kind).toBe('upload-local')
  })
})

describe('unionProgress', () => {
  it('把库里多出来的事件并进来，本地的状态不动', () => {
    const local = progress({ xp: 10, attempts: [attempt('a', { timestamp: 1 })] })
    const remote = progress({ xp: 999, attempts: [attempt('a', { timestamp: 1 }), attempt('b', { timestamp: 2 })] })
    const { progress: merged, added } = unionProgress(local, remote)
    expect(added).toBe(1)
    expect(merged.xp).toBe(10)                                   // 状态以本地（最新）为准
    expect(merged.attempts.map((a) => a.attemptId)).toEqual(['a', 'b'])
  })

  it('没有新事件时原样返回（引用不变，避免多余写盘）', () => {
    const local = progress({ attempts: [attempt('a')] })
    const { progress: merged, added } = unionProgress(local, progress({ attempts: [attempt('a')] }))
    expect(added).toBe(0)
    expect(merged).toBe(local)
  })

  it('并集按时间排序（事件上限从头部裁时不会误删最近的）', () => {
    const local = progress({ attempts: [attempt('c', { timestamp: 30 }), attempt('a', { timestamp: 10 })] })
    const remote = progress({ attempts: [attempt('b', { timestamp: 20 })] })
    const { progress: merged } = unionProgress(local, remote)
    expect(merged.attempts.map((a) => a.attemptId)).toEqual(['a', 'b', 'c'])
  })
})
