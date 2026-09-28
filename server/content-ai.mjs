// 系统自带的"内容修复"AI：给缺逐项纠正的题补上「你选的这条等于在说什么意思」+ 错因标签。
//
// 这是用户明确要求的形态：「这个管线是系统本身的 AI 进行的纠正，而不是你 agent，
// 这样我做完错题，系统就能自我修复」——所以它跑在服务端、由界面上的按钮触发、结果写进账户，
// 不依赖任何人在仓库外跑脚本。
//
// 质量闸门（照 offline 管线的教训）：
//   · 只对**错误选项**要纠正，正确项不要；
//   · 错因标签只能从固定词表里挑（server/llm.mjs 的 ERROR_TAGS），越界的丢弃；
//   · 返回的选项必须真的是这道题的选项，编出来的丢弃；
//   · 缺失/不合规都算 rejected，宁缺勿错 —— 错答案键会直接教错。
import { ERROR_TAGS, ERROR_TAG_KEYS, chatJson, LlmError, llmConfig } from './llm.mjs'

/** 一次喂给模型多少道题（太多会串味，太少浪费往返） */
export const CHUNK = 8

const SYSTEM = [
  '你在给一套中国学生用的英语练习册补"逐项纠正"。作者的教学主张是：英语是直线型思维，',
  '含义决定形式 —— 一个含义对应一个形式，形式变了是因为含义变了，不是因为"规则要求"。',
  '',
  '对每一道题、每一个**错误选项**，写一句话说清楚：选了它，等于在表达什么意思（为什么与题干要表达的含义不符）。',
  '要求：',
  '· 只说含义，不说术语：不出现"主格/宾格/物主代词/形容词性/三单规则"这类名词。用"做动作的/挨动作的/他的（东西）"来讲。',
  '· 每条 15~30 个汉字，一句话，不要分点，不要客套。',
  '· 不要复述题干，不要复述正确项。',
  '· 同时从下面的标签表里给这条错因挑**一个**标签（只能从表里挑，不许自创）：',
  ...Object.entries(ERROR_TAGS).map(([k, v]) => `    ${k} = ${v}`),
  '',
  '只输出 JSON，不要任何解释或 markdown 包装。格式：',
  '{"items":[{"i":<题目序号>,"optionFixes":{"<错误选项原文>":"<一句话>"},"optionTags":{"<错误选项原文>":["<标签>"]}}]}',
].join('\n')

let llm = chatJson   // 测试可注入替身

/** 仅用于测试：替换模型调用 */
export function __setChatJson(fn) { llm = fn ?? chatJson }
export function __resetChatJson() { llm = chatJson }

function buildUser(items) {
  const payload = items.map((it, i) => ({
    i,
    prompt: it.prompt,
    answer: it.answer,
    options: it.options,
  }))
  return `共 ${payload.length} 道题：\n` + JSON.stringify(payload, null, 1)
}

/**
 * 给一批题生成逐项纠正。返回 { results: {qid: {optionFixes, optionTags}}, rejected, error }
 * 任何一道题不合格都只影响它自己。
 */
export async function enrichCauses(questions) {
  if (!questions.length) return { results: {}, rejected: 0, model: null }
  if (!llmConfig().configured) throw new LlmError('模型未配置：系统 AI 不可用')
  const model = llmConfig().model
  const results = {}
  let rejected = 0

  for (let start = 0; start < questions.length; start += CHUNK) {
    const chunk = questions.slice(start, start + CHUNK)
    let raw
    try {
      raw = await llm([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUser(chunk) },
      ], { maxTokens: 2600, temperature: 0.2 })
    } catch (err) {
      // 单批失败不拖垮整轮：记下错误，已经成功的继续保留
      return { results, rejected, model, error: String(err?.message ?? err) }
    }
    const list = Array.isArray(raw) ? raw : (raw?.items ?? [])
    for (const row of list) {
      if (!row || typeof row !== 'object') { rejected++; continue }
      const idx = Number(row.i)
      const q = Number.isInteger(idx) ? chunk[idx] : null
      if (!q) { rejected++; continue }
      const wrong = new Set((q.options ?? []).filter((o) => o !== q.answer))
      const fixes = {}
      const tags = {}
      for (const [opt, text] of Object.entries(row.optionFixes ?? {})) {
        if (!wrong.has(opt)) continue                       // 编出来的选项：丢
        const clean = String(text ?? '').trim().slice(0, 120)
        if (clean.length < 6) continue
        fixes[opt] = clean
      }
      for (const [opt, list2] of Object.entries(row.optionTags ?? {})) {
        if (!wrong.has(opt)) continue
        const picked = (Array.isArray(list2) ? list2 : [list2]).filter((t) => ERROR_TAG_KEYS.includes(t))
        if (picked.length) tags[opt] = picked
      }
      if (Object.keys(fixes).length) results[q.id] = { optionFixes: fixes, optionTags: tags }
      else rejected++
    }
  }
  return { results, rejected, model }
}
