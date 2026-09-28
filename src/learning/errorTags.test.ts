// 错因汇总：结算页「这一轮你错在哪」的数据来源
import { describe, it, expect } from 'vitest'
import { summarizeTags, tagLabel, TAG_FIX } from './errorTags'

describe('错因汇总', () => {
  it('按出现次数降序，次数相同按标签名稳定排序', () => {
    const out = summarizeTags([
      ['role-reversed'],
      ['case-form-subject', 'role-reversed'],
      ['case-form-object'],
      undefined,                      // 答对的题没有标签
    ])
    expect(out).toEqual([
      { tag: 'role-reversed', n: 2 },
      { tag: 'case-form-object', n: 1 },
      { tag: 'case-form-subject', n: 1 },
    ])
  })

  it('没有错因时返回空（答对不应产生"你错在哪"）', () => {
    expect(summarizeTags([undefined, undefined])).toEqual([])
    expect(summarizeTags([])).toEqual([])
  })

  it('每个标签都有中文名与纠正口径（否则界面会露出英文标签）', () => {
    const tags = Object.keys(TAG_FIX)
    expect(tags.length).toBeGreaterThan(0)
    for (const t of tags) {
      expect(tagLabel(t), t).not.toBe(t)      // 必须有中文名，不能回退成标签本身
      expect(TAG_FIX[t].length, t).toBeGreaterThan(6)
    }
  })
})
