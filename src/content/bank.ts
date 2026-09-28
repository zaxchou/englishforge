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
