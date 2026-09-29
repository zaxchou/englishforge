// 把系统 AI 补出来的逐项纠正并进题库池。
//
// 为什么要在客户端并：题面本身（题面/选项/解析）来自代码或账户题库，
// 而"逐项纠正"是系统后来补的、按账户存的 —— 练习与结算页读的是并完之后的题，
// 所以补完之后立刻生效，不需要改题面文件。
//
// 合并原则：**已有的内容不覆盖**（人写的、语料管线生成的都优先），只补空缺。
// 例外：`rewrite` —— 系统 AI 按审核意见改的稿是**纠正**，覆盖原题面（否则"审出问题→改稿"永远不生效）。
import type { AdaptedQuestion } from '../types'
import type { EnrichmentMap } from '../store/db'

export function applyEnrichments(questions: AdaptedQuestion[], map: EnrichmentMap): AdaptedQuestion[] {
  const ids = Object.keys(map)
  if (!ids.length) return questions
  return questions.map((q) => {
    const entry = map[q.id]
    if (!entry) return q
    // 先应用改写（纠正，覆盖题面），再在改完的题上补逐项纠正（只补空缺）
    let base = q
    const rw = entry.rewrite
    if (rw) {
      const patch: Partial<AdaptedQuestion> = {}
      if (typeof rw.explain === 'string' && rw.explain && rw.explain !== q.explain) patch.explain = rw.explain
      if (typeof rw.prompt === 'string' && rw.prompt && rw.prompt !== q.prompt) patch.prompt = rw.prompt
      // 选项个数必须与原题一致：optionIds 按位置生成、判分按 ID，改稿闸门保证正确答案原位
      if (Array.isArray(rw.options) && rw.options.length > 1 && rw.options.length === (q.options?.length ?? 0)) {
        patch.options = rw.options
      }
      // 影响判分的修订带内容版本：升版本让修订前的旧作答不再算有效证据（evidence 按版本等值过滤）。
      // 只往上取（>）：若仓库基准后来也升了版，账户覆盖层不许把版本**压回去**（二次审查 R2）
      if (typeof rw.contentVersion === 'number' && rw.contentVersion > q.contentVersion) {
        patch.contentVersion = rw.contentVersion
      }
      if (Object.keys(patch).length) base = { ...q, ...patch }
    }
    const e = entry.causes
    if (!e) return base
    const mergeRecord = <T>(prev: Record<string, T> | undefined, extra: Record<string, T> | undefined) => {
      if (!extra) return prev
      const out: Record<string, T> = { ...(prev ?? {}) }
      let added = false
      for (const [k, v] of Object.entries(extra)) {
        if (out[k] === undefined) { out[k] = v; added = true }
      }
      return added ? out : prev
    }
    const optionFeedback = mergeRecord(base.optionFeedback, e.optionFixes)
    const optionTags = mergeRecord(base.optionTags, e.optionTags)
    if (optionFeedback === base.optionFeedback && optionTags === base.optionTags) return base
    return { ...base, optionFeedback, optionTags }
  })
}
