// 启动合并审核结论的回归测试（复核报告 #5）：adopt 与 merge 两条启动分支共用同一套规则。
import { describe, expect, it } from 'vitest'
import { mergeReviewMarks } from './useDbSync'

describe('启动合并审核结论：服务端优先（复核报告 #5）', () => {
  it('同名题以远端为准 —— 本地旧缓存不许把已完成的 AI 判毙重新打开', () => {
    const remote = { q1: { verdict: 'kill' as const, source: 'ai' as const, reasons: ['答案本身不正确'] } }
    const local = { q1: { verdict: 'ok' as const } }   // 旧标签页里的旧通过，没有 source
    const out = mergeReviewMarks(remote, local)
    expect(out.q1.verdict).toBe('kill')
    expect(out.q1.source).toBe('ai')
  })

  it('本地没有 source 的标记一律不带进来（它们是缓存旧值，不是用户新操作）', () => {
    const out = mergeReviewMarks({}, { q2: { verdict: 'ok' }, q3: { verdict: 'fix' } })
    expect(out.q2).toBeUndefined()
    expect(out.q3).toBeUndefined()
  })

  it('远端没有、本地带 source 的新操作保留（断网期间做的标记要能推上去）', () => {
    const remote = { q1: { verdict: 'ok' as const, source: 'ai' as const } }
    const local = {
      q1: { verdict: 'fix' as const, source: 'human' as const }, // 远端有 → 以远端为准
      q9: { verdict: 'kill' as const, source: 'human' as const }, // 远端没有 → 保留
    }
    const out = mergeReviewMarks(remote, local)
    expect(out.q1).toMatchObject({ verdict: 'ok' })
    expect(out.q9).toMatchObject({ verdict: 'kill', source: 'human' })
  })

  it('切账户接管（keepLocal:false）：整份接管远端，上一个账户的标记一个都不带', () => {
    const remoteB = { b1: { verdict: 'ok' as const, source: 'ai' as const } }
    const localFromA = {
      a1: { verdict: 'kill' as const, source: 'ai' as const },   // A 独有的 AI 结论
      b1: { verdict: 'fix' as const, source: 'human' as const }, // 远端 B 有 → 必须以远端为准
    }
    const out = mergeReviewMarks(remoteB, localFromA, { keepLocal: false })
    expect(out).toEqual(remoteB)
    expect(out.a1).toBeUndefined()
  })
})
