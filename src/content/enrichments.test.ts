// 改写（rewrite）与逐项纠正（causes）的合并语义测试。
// 关键约束：选项按位置生成 ID、判分按 ID —— rewrite 换干扰项时答案必须原位、个数必须一致，
// 否则 optionIds 与选项文本错位，会出现"选对了判错"的事故。
import { describe, expect, it } from 'vitest'
import { applyEnrichments } from './enrichments'
import type { AdaptedQuestion } from '../types'
import type { EnrichmentMap } from '../store/db'

function q(over: Partial<AdaptedQuestion> = {}): AdaptedQuestion {
  return {
    id: 'q1', skill: 's1', type: 'choice', prompt: '我喜欢 ___。', answer: 'him',
    options: ['him', 'he', 'his', 'her'], explain: '旧解析',
    optionIds: ['q1#0', 'q1#1', 'q1#2', 'q1#3'], tokens2: [], orderIds: [], answerId: 'q1#0',
    mode: 'recognition', variantGroupId: 'q1', objectiveId: 's1',
    contentVersion: 1, reviewStatus: 'draft', assessmentRole: 'practice',
    ...over,
  } as AdaptedQuestion
}

describe('applyEnrichments：rewrite 覆盖题面，causes 只补空缺', () => {
  it('rewrite 覆盖 explain/prompt；选项个数不一致时整组不采纳（防判分错位）', () => {
    const map: EnrichmentMap = {
      q1: { rewrite: { explain: '新解析', prompt: '他喜欢 ___。', options: ['him', 'she'] } },
    }
    const out = applyEnrichments([q()], map)
    expect(out[0].explain).toBe('新解析')
    expect(out[0].prompt).toBe('他喜欢 ___。')
    expect(out[0].options).toEqual(['him', 'he', 'his', 'her'])
  })

  it('rewrite 换干扰项（答案保持原位）后，选项与 answerId 指向的位置仍对齐', () => {
    const map: EnrichmentMap = { q1: { rewrite: { options: ['him', 'he', 'his', 'she'] } } }
    const out = applyEnrichments([q()], map)
    expect(out[0].options).toEqual(['him', 'he', 'his', 'she'])
    // answerId = 'q1#0'（位置 0）→ 那个位置必须还是正确答案 him
    expect(out[0].options![0]).toBe('him')
  })

  it('没有 rewrite 时行为与从前完全一致；causes 依旧只补空缺', () => {
    const map: EnrichmentMap = { q1: { causes: { optionFixes: { he: '说错人了' } } } }
    const out = applyEnrichments([q()], map)
    expect(out[0].explain).toBe('旧解析')
    expect(out[0].prompt).toBe('我喜欢 ___。')
    expect(out[0].optionFeedback).toMatchObject({ he: '说错人了' })
  })

  it('rewrite 与 causes 同时存在：先覆盖题面，再在改完的题上补逐项纠正', () => {
    const map: EnrichmentMap = {
      q1: { rewrite: { explain: '新解析' }, causes: { optionFixes: { he: '说错人了' } } },
    }
    const out = applyEnrichments([q()], map)
    expect(out[0].explain).toBe('新解析')
    expect(out[0].optionFeedback).toMatchObject({ he: '说错人了' })
  })

  it('map 为空时返回原数组（不额外渲染）', () => {
    const list = [q()]
    expect(applyEnrichments(list, {})).toBe(list)
  })

  it('账户改写的内容版本只往上取，不把新基准版本压回去（二次审查 R2）', () => {
    // 改写版本低于/等于基准 → 不动
    expect(applyEnrichments([q()], { q1: { rewrite: { contentVersion: 1 } } })[0].contentVersion).toBe(1)
    expect(applyEnrichments([q()], { q1: { rewrite: { contentVersion: 0 } } })[0].contentVersion).toBe(1)
    // 改写版本高于基准 → 生效（修订前的旧证据随之失效）
    expect(applyEnrichments([q()], { q1: { rewrite: { contentVersion: 3 } } })[0].contentVersion).toBe(3)
  })
})
