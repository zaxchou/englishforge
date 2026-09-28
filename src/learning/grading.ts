// 客观题判定与语音结果适配（PLAN-v2 §2、§5.1）
// 判定一律基于稳定 ID：不依赖选项原下标、不依赖文本相等
import type { AdaptedQuestion, Outcome } from '../types'

/** choice / listen：选中项 ID 是否正确（含 acceptedAnswers 多答案） */
export function gradeChoice(q: AdaptedQuestion, selectedId: string): boolean {
  if (q.acceptedAnswers?.length) {
    return selectedId === q.answerId || q.acceptedAnswers.includes(selectedId)
  }
  return selectedId === q.answerId
}

/** tiles：按文本序列判定——两个相同文字的词块可互换使用（用例 7）；
 *  ID 只负责"选中/撤回"互不干扰，判定本身比较文本语序 */
export function gradeSequence(q: AdaptedQuestion, selectedIds: string[]): boolean {
  if (q.acceptedAnswers?.length && q.acceptedAnswers.includes(selectedIds.join(' '))) return true
  const text = (id: string) => q.tokens2.find((t) => t.id === id)?.text ?? ''
  const pickedTexts = selectedIds.map(text)
  const order = q.order ?? []
  if (pickedTexts.length !== order.length) return false
  return order.every((t, i) => pickedTexts[i] === t)
}

/** tap：点中的 token ID 是否是目标错误词 */
export function gradeTap(q: AdaptedQuestion, tappedId: string): boolean {
  return tappedId === q.answerId
}

/** 跟读：编辑距离相似度（0~1） */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  const m = a.length, n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - prev[n] / Math.max(m, n)
}

export function normText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** 跟读结果分档：ok / close / bad（宽松判定，非发音评价） */
export function tierOfSpeak(ratio: number): 'ok' | 'close' | 'bad' {
  if (ratio >= 0.82) return 'ok'
  if (ratio >= 0.55) return 'close'
  return 'bad'
}

/** 分档 → 事件 outcome（close 记 uncertain，不强行判对错） */
export function outcomeOfTier(tier: 'ok' | 'close' | 'bad'): Outcome {
  if (tier === 'ok') return 'correct'
  if (tier === 'close') return 'uncertain'
  return 'incorrect'
}
