// 题库的身份与自检口径 —— 客户端、服务端、离线脚本必须用**同一套规则**。
//
// 为什么不能只比题干：听力题的题干统一是「🎧 听一听，说的是什么意思？」，跟读题的
// answer 字段是占位符 'speak'，真正的内容在 tts / target / tokens 里。只按题干分组，
// 25 道听力题会被算成"互相打架"，第一次跑就满屏假警报 —— 自检一旦狼来了就没人看了。
//
// 所以一道题的**身份** = 题型 + 题干 + 它真正在考的那个句子（tts / target / tokens / order 里第一个有值的）。
//   · 身份相同 + 答案相同 + 选项相同 → 纯重复（可以毙掉多余的）
//   · 身份相同 + 答案不同 → 真打架（必有一道在教错，要人看）
//   · 身份不同 → 两道不同的题（哪怕题干一字不差）
import type { AdaptedQuestion } from '../types'

const PUNCT = /[.,!?;:()（）[\]{}<>《》、。，！？；：…—~`|/*#&+^%$@=_·•"'“”‘’]/g

/** 归一化：忽略大小写、空白与中英标点 */
export function normalizeText(v: string | undefined | null): string {
  return String(v ?? '').toLowerCase().replace(/\s/g, '').replace(PUNCT, '')
}

/** 这道题真正在考的那个句子 */
export function sentenceOf(q: Pick<AdaptedQuestion, 'tts' | 'target' | 'tokens' | 'order'>): string {
  if (q.tts) return q.tts
  if (q.target) return q.target
  if (q.tokens?.length) return q.tokens.join(' ')
  if (q.order?.length) return q.order.join(' ')
  return ''
}

/** 题目身份：题型 + 题干 + 句子（归一化后拼起来） */
export function contentKeyOf(q: Pick<AdaptedQuestion, 'type' | 'prompt' | 'tts' | 'target' | 'tokens' | 'order'>): string {
  return [q.type, normalizeText(q.prompt), normalizeText(sentenceOf(q))].join('|')
}

/** 题面自带逐项纠正了吗（决定了系统 AI 要不要补） */
export function hasOwnCause(q: Pick<AdaptedQuestion, 'optionFeedback'>): boolean {
  return !!q.optionFeedback && Object.keys(q.optionFeedback).length > 0
}

/** 题型维度的先后（保留"两种不同维度"时按这个顺序挑） */
const MODE_ORDER: Record<string, number> = { recognition: 0, comprehension: 1, construction: 2, oral: 3 }

/**
 * 同一个句子最多保留 `cap` 道题（用户拍板：**最多两次**）。
 *
 * 实测：396 道里有 44 个句子被 2~5 道题反复考（`I was a teacher.` 被选择题×2 + 拼句×2 + 跟读×1
 * 考了 5 遍）——这就是用户感觉"题目重复"的真正来源。一个含义练几遍是刻意的，但同一句换四种题型
 * 再考一遍，做起来就像同一道题做了四遍。
 *
 * 两个细节很重要：
 *  · **挑哪两道**：优先题型/维度**不同**的一对（保住"识别 + 表达"这两类证据），同维度再挑更基础的；
 *  · **已经练过的题一律保留**：题一旦离开抽题池，它的历史作答也会掉出证据窗口
 *    （`objectiveAttempts` 只认池内的题），用户已有的进度会凭空倒退。所以只对没做过的题做取舍。
 */
export function capBySentence<T extends AdaptedQuestion>(
  questions: T[],
  cap = 2,
  keep: Set<string> = new Set(),
): T[] {
  const groups = new Map<string, T[]>()
  for (const q of questions) {
    if (keep.has(q.id)) continue
    const key = q.skill + '::' + normalizeText(sentenceOf(q))
    const g = groups.get(key)
    if (g) g.push(q)
    else groups.set(key, [q])
  }
  const selected = new Set<string>()
  for (const g of groups.values()) {
    if (g.length <= cap) { for (const q of g) selected.add(q.id); continue }
    const sorted = [...g].sort((a, b) =>
      (MODE_ORDER[a.mode] ?? 9) - (MODE_ORDER[b.mode] ?? 9) ||
      (a.diff ?? 2) - (b.diff ?? 2) ||
      a.id.localeCompare(b.id))
    const picked: T[] = []
    const usedModes = new Set<string>()
    for (const q of sorted) {          // 先按"每道题的维度都不同"挑一遍
      if (picked.length >= cap) break
      if (usedModes.has(q.mode)) continue
      usedModes.add(q.mode); picked.push(q)
    }
    for (const q of sorted) {          // 维度不够多时补齐
      if (picked.length >= cap) break
      if (!picked.includes(q)) picked.push(q)
    }
    for (const q of picked) selected.add(q.id)
  }
  return questions.filter((q) => keep.has(q.id) || selected.has(q.id))
}
