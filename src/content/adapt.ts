// 题目适配器：旧题库不重写，加载时补齐 v2 必需字段
// - 选项/词块/词序列一律 ID 化（判定按 ID，不依赖文本与下标）
// - mode / variantGroupId / reviewStatus 等给默认值，正式题包可在题面显式覆盖
import type { AdaptedQuestion, Mode, Question } from '../types'

/** 题型 → 证据维度（默认映射，可在题面用 mode 覆盖） */
export function inferMode(q: Question): Mode {
  if (q.type === 'speak') return 'oral'
  if (q.type === 'tiles') return 'construction'
  if (q.type === 'match' || q.type === 'sort') return 'comprehension'
  if (q.type === 'choice' && q.autoTTS) return 'comprehension'   // 听辨
  return 'recognition'
}

/** 预设支持等级：选项/词块全可见 = 3；拼句给完整词块 = 2；跟读展示原文 = 3；隐藏答案场景说 = 0 */
export function inferSupportLevel(q: Question): number {
  if (q.type === 'tiles') return 2
  if (q.type === 'speak') return 3
  return 3
}

export function adaptQuestion(q: Question): AdaptedQuestion {
  const optionIds = (q.options ?? []).map((_, i) => `${q.id}#${i}`)

  const tokens2 = (q.tokens ?? []).map((text, i) => ({ id: `${q.id}#t${i}`, text }))

  // order（文本序列）→ token ID 序列：贪心匹配未被占用的同文本词块，允许重复文本
  const claimed = new Set<number>()
  const orderIds = (q.order ?? []).map((t) => {
    const idx = tokens2.findIndex((tk, i) => !claimed.has(i) && tk.text === t)
    if (idx >= 0) claimed.add(idx)
    return idx >= 0 ? tokens2[idx].id : `__missing__${t}`
  })

  let answerId = ''
  if (q.type === 'choice') {
    const i = (q.options ?? []).indexOf(q.answer ?? '')
    answerId = i >= 0 ? optionIds[i] : ''
  } else if (q.type === 'tap') {
    const idx = tokens2.findIndex((t) => t.text === q.answer)
    answerId = idx >= 0 ? tokens2[idx].id : ''
  } else if (q.type === 'tiles') {
    answerId = orderIds.join(' ')
  }

  return {
    ...q,
    optionIds,
    tokens2,
    orderIds,
    answerId,
    mode: q.mode ?? inferMode(q),
    variantGroupId: q.variantGroupId ?? q.id,
    objectiveId: q.objectiveId ?? q.skill,
    contentVersion: q.contentVersion ?? 1,
    reviewStatus: q.reviewStatus ?? 'draft',
    assessmentRole: q.assessmentRole ?? 'practice',
  }
}

export function adaptAll(questions: Question[]): AdaptedQuestion[] {
  return questions.map(adaptQuestion)
}
