// 后台维护编排的回归测试（三审 T2/T3）：
// T2 = 整条链固定同一账户；T3 = "真进展"判定（同结论/同稿/pending 不动 = 空转）。
// runMaintenanceFlow 与 pipelineProgressed 都是纯回调注入的导出函数，可脱离 React 直接测。
import { describe, expect, it } from 'vitest'
import { pipelineProgressed, runMaintenanceFlow, type MaintenanceEnrich, type MaintenanceReview } from './useDbSync'

const review = (over: Partial<MaintenanceReview> = {}): MaintenanceReview => ({
  reviewed: 5, killed: 0, fixed: 1, rewritten: 1, remaining: 0,
  reviewer: 'mimo/m', independent: true, error: null, ...over,
})
const enrich = (over: Partial<MaintenanceEnrich> = {}): MaintenanceEnrich => ({
  enriched: 2, remaining: 3, gaps: 5, error: null, ...over,
})

describe('runMaintenanceFlow：维护任务从头到尾属于同一个账户（三审 T2）', () => {
  it('时机①审查完成后才切换 → 补纠正一次都不许调', async () => {
    let current = 'A'
    let enrichCalls = 0
    const out = await runMaintenanceFlow({
      isCurrent: () => current === 'A',
      review: async () => { current = 'B'; return review() },   // A 审完的瞬间用户切到 B
      enrichBatch: async () => { enrichCalls++; return enrich() },
      onNote: () => {},
    })
    expect(out.aborted).toBe(true)
    expect(enrichCalls).toBe(0)
  })

  it('时机②补纠正途中切换 → 当前批返回后立刻停，不再发起下一批', async () => {
    let current = 'A'
    let calls = 0
    const notes: string[] = []
    const out = await runMaintenanceFlow({
      isCurrent: () => current === 'A',
      review: async () => review(),
      enrichBatch: async () => { calls++; current = 'B'; return enrich({ remaining: 3, gaps: 4 }) },
      onNote: (s) => notes.push(s),
    })
    expect(calls).toBe(1)                                  // 只有切换前那一批
    expect(notes.join(' ')).toContain('补纠正中止')
    expect(out.enriched).toBe(2)                            // 已完成的那批照实计入
  })

  it('时机③全程未切换（正常路径）→ 审查+补纠正跑到归零，产出回调触发', async () => {
    let n = 0
    let enrichedCb = 0
    let last = ''
    const out = await runMaintenanceFlow({
      isCurrent: () => true,
      review: async () => review(),
      enrichBatch: async () => (++n === 1 ? enrich({ remaining: 3, gaps: 4 }) : enrich({ enriched: 1, remaining: 0, gaps: 0 })),
      onNote: (s) => { last = s },
      onEnriched: (c) => { enrichedCb = c },
    })
    expect(out).toMatchObject({ reviewed: 5, rewritten: 1, enriched: 3, aborted: false })
    expect(enrichedCb).toBe(3)
    expect(last).toContain('流水线完成')
    expect(last).toContain('补了 3 篇')
  })

  it('审查接口没响应 → 如实备注，不编数字；未配置出题模型 → 只审查', async () => {
    let note1 = ''
    const r1 = await runMaintenanceFlow({
      isCurrent: () => true,
      review: async () => null,
      onNote: (s) => { note1 = s },
    })
    expect(note1).toContain('数据库接口没有响应')
    expect(r1).toMatchObject({ reviewed: 0, aborted: false })

    let note2 = ''
    const r2 = await runMaintenanceFlow({
      isCurrent: () => true,
      review: async () => review(),
      onNote: (s) => { note2 = s },
    })
    expect(note2).toContain('流水线完成')
    expect(note2).not.toContain('补了')
    expect(r2.enriched).toBe(0)
  })
})

describe('pipelineProgressed：一轮流水线算不算"真进展"（三审 T3）', () => {
  it('同结论再存一遍 + 同稿不落库 + pending 不动 → 空转，不算', () => {
    expect(pipelineProgressed({ reviewed: 60, reviewedUnchanged: 60, rewritten: 0, pending: 61 }, 61)).toBe(false)
  })
  it('改稿落库 / 结论真变化 / pending 下降 → 都算进展', () => {
    expect(pipelineProgressed({ reviewed: 60, reviewedUnchanged: 60, rewritten: 3, pending: 61 }, 61)).toBe(true)
    expect(pipelineProgressed({ reviewed: 60, reviewedUnchanged: 0, rewritten: 0, pending: 61 }, 61)).toBe(true)
    expect(pipelineProgressed({ reviewed: 0, rewritten: 0, pending: 50 }, 61)).toBe(true)
  })
  it('首轮没有 pending 基准可比时，靠"结论真变化"判定', () => {
    expect(pipelineProgressed({ reviewed: 5, reviewedUnchanged: 0, rewritten: 0, pending: 99 }, -1)).toBe(true)
    expect(pipelineProgressed({ reviewed: 5, reviewedUnchanged: 5, rewritten: 0, pending: 99 }, -1)).toBe(false)
  })
})
