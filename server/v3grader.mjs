// 46 号（用户直接反馈）：机械词表规则降级为「参考」，开放题与口述题由 AI 担任主要批改。
// 用户原话：机械规则有时准有时太死板；个人用 AI 核对答案消耗不大；口述转写的词表判定经常不准。
//
// 诚实边界（不变）：
// · AI 批改仍是**练习层反馈**——open/oral 答案本来就不写掌握事件（keywordOnly / 口述 defer），
//   AI 不改变这个语义；真正的成绩来自封闭槽位题与老师确认（46 号前后的合同一致）。
// · AI 不可用/未开启 → 无缝回落机械规则（界面注明），不阻塞作答。
// · 密钥走 llm.mjs 原有通道（运行时读 molin-wiki 槽位），不落库不打印。
// · 开关：ENGLISHFORGE_V4_AI_GRADER='0' 关闭（默认开启；用户已明确授权按次消耗）。
import { chatWithMeta } from './llm.mjs'

export function aiGraderEnabled() {
  return String(process.env.ENGLISHFORGE_V4_AI_GRADER ?? '1') !== '0'
}

let chatOverride = null // 测试注入点
export function __setGraderChat(fn) { chatOverride = fn }

/** AI 批改一次开放题/口述回答。返回 null = 本次没有 AI 结论（关闭/失败/不值得批）。
 * mechanical = 机械规则结果（relations 命中情况），只作为参考给 AI。 */
export async function gradeOpenAnswer({ activity, responseText, mechanical, segments = [] }) {
  if (!aiGraderEnabled()) return null
  const text = String(responseText ?? '').trim()
  if (text.length < 2) return null
  if (activity?.evaluationContract?.slots) return null // 封闭题是确定性判分，不需要 AI
  if (activity?.role === 'diagnostic' || activity?.holdout) return null
  const chat = chatOverride ?? ((msgs, opts) => chatWithMeta(msgs, { ...opts, role: 'generate' }))
  const prompt = [
    '你是英语老师，正在批改学生的回答。判断标准：**意思对就算对**——',
    '· 用词和参考答案不同、说法不同，只要意思一致就算对；',
    '· 学生答案里没有参考答案的原词，不代表错——看意思有没有说到；',
    '· 意思说错、漏了关键内容、答非所问，才判不对；',
    '· 口语转写稿可能有听写错误（比如同音词），明显的转写问题不要扣分。',
    '',
    '题目：' + String(activity?.prompt ?? '').slice(0, 500),
    activity?.referenceAnswer ? '参考答案：' + activity.referenceAnswer : '',
    segments.length ? '材料原文（学生的回答应该基于它）：' + segments.map((s) => s.text).join(' ').slice(0, 1200) : '',
    mechanical ? `机器词表对照（只是参考，它经常太死板）：${JSON.stringify(mechanical)}` : '',
    '学生的回答：' + text.slice(0, 1500),
    '',
    '只输出 JSON：{"verdict":"correct|partial|incorrect|off_topic","feedback":"用中文给学生的反馈，20-50 字，先说结论（对/部分对/还不对），再具体说哪里好或哪里要补","agreesWithMechanical":true或false}',
  ].filter(Boolean).join('\n')
  try {
    const out = await chat([{ role: 'user', content: prompt }], { maxTokens: 400, temperature: 0.1, tries: 1 })
    const raw = typeof out === 'string' ? out : out.text
    const parsed = JSON.parse(raw)
    const verdict = ['correct', 'partial', 'incorrect', 'off_topic'].includes(parsed?.verdict) ? parsed.verdict : null
    if (!verdict) return null
    return {
      verdict,
      feedback: String(parsed.feedback ?? '').slice(0, 300),
      agreesWithMechanical: parsed.agreesWithMechanical !== false,
      gradedBy: 'ai:' + String(parsed.model ?? 'chat').slice(0, 40),
      at: Date.now(),
    }
  } catch {
    return null // AI 不可用：无缝回落机械规则，不阻塞作答
  }
}
