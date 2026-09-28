// 把系统 AI 补出来的逐项纠正并进题库池。
//
// 为什么要在客户端并：题面本身（题面/选项/解析）来自代码或账户题库，
// 而"逐项纠正"是系统后来补的、按账户存的 —— 练习与结算页读的是并完之后的题，
// 所以补完之后立刻生效，不需要改题面文件。
//
// 合并原则：**已有的内容不覆盖**（人写的、语料管线生成的都优先），只补空缺。
import type { AdaptedQuestion } from '../types'
import type { EnrichmentMap } from '../store/db'

export function applyEnrichments(questions: AdaptedQuestion[], map: EnrichmentMap): AdaptedQuestion[] {
  const ids = Object.keys(map)
  if (!ids.length) return questions
  return questions.map((q) => {
    const e = map[q.id]?.causes
    if (!e) return q
    const mergeRecord = <T>(base: Record<string, T> | undefined, extra: Record<string, T> | undefined) => {
      if (!extra) return base
      const out: Record<string, T> = { ...(base ?? {}) }
      let added = false
      for (const [k, v] of Object.entries(extra)) {
        if (out[k] === undefined) { out[k] = v; added = true }
      }
      return added ? out : base
    }
    const optionFeedback = mergeRecord(q.optionFeedback, e.optionFixes)
    const optionTags = mergeRecord(q.optionTags, e.optionTags)
    if (optionFeedback === q.optionFeedback && optionTags === q.optionTags) return q
    return { ...q, optionFeedback, optionTags }
  })
}
