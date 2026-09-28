// R1-02 主宾格种子题：合同合规性测试
// 目标不是证明"内容正确"（那需要人工语义审核），而是保证这批题结构上
// 满足 v2 合同、且不会被误当成已审核内容去充当能力证据。
import { describe, it, expect } from 'vitest'
import { subjectObjectPilot } from '../data/pilots/subject-object'
import { adaptAll } from './adapt'
import { validateQuestions, errorsOf } from './validation'

const adapted = adaptAll(subjectObjectPilot)

describe('主宾格种子题（R1-02）', () => {
  it('通过题库结构校验（无 error 级问题）', () => {
    expect(errorsOf(validateQuestions(adapted))).toEqual([])
  })

  it('v2 元数据齐备', () => {
    for (const q of adapted) {
      expect(q.objectiveId, q.id).toBeTruthy()
      expect(q.variantGroupId, q.id).toBeTruthy()
      expect(q.contentVersion, q.id).toBeGreaterThanOrEqual(1)
      expect(['draft', 'reviewed', 'quarantined'], q.id).toContain(q.reviewStatus)
      expect(q.mode, q.id).toBeTruthy()
      expect(q.answerId, q.id).toBeTruthy()
      // sourceRef 必须带真实语料出处，不能只有课稿锚点——否则溯源是断的
      expect(q.sourceRef, q.id).toMatch(/(tatoeba|ud-en-ewt):/)
    }
  })

  it('一律 draft：未人工审核前不得充当能力证据', () => {
    expect(adapted.every((q) => q.reviewStatus === 'draft')).toBe(true)
  })

  it('每题选项互异、数量为 4，且都带错因标签与逐选项反馈', () => {
    for (const q of adapted) {
      const opts = q.options ?? []
      expect(opts.length, q.id).toBe(4)
      expect(new Set(opts).size, q.id).toBe(opts.length)
      expect((q.errorTags ?? []).length, q.id).toBeGreaterThan(0)
      const fb = Object.keys(q.optionFeedback ?? {})
      expect(fb.length, q.id).toBeGreaterThan(0)
      // 反馈只针对错误选项，不能给正确选项写"错因"
      expect(fb).not.toContain(q.answer)
    }
  })

  it('变式足够分散：多个不同动词、同一变式家族不重复出题', () => {
    const verbs = new Set(adapted.map((q) => q.variantGroupId.split(':')[0]))
    expect(verbs.size).toBeGreaterThanOrEqual(10)
    const groups = adapted.map((q) => q.variantGroupId)
    expect(new Set(groups).size, '变式家族不应重复').toBe(groups.length)
  })

  it('题面同时包含"中文意思题"与"框架填空题"两类', () => {
    const hasBlank = adapted.some((q) => q.prompt.includes('___'))
    const hasGloss = adapted.some((q) => q.prompt.includes('「'))
    expect(hasBlank).toBe(true)
    expect(hasGloss).toBe(true)
  })
})
