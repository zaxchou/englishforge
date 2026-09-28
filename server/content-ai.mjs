// 系统自带的"内容修复"AI：给缺逐项纠正的题补上「你选的这条等于在说什么意思」+ 错因标签。
//
// 这是用户明确要求的形态：「这个管线是系统本身的 AI 进行的纠正，而不是你 agent，
// 这样我做完错题，系统就能自我修复」——所以它跑在服务端、由界面上的按钮触发、结果写进账户。
//
// 质量闸门（照 offline 管线的教训）：
//   · 只对**错误选项**要纠正，正确项不要；
//   · 错因标签只能从固定词表里挑（server/llm.mjs 的 ERROR_TAGS），越界的丢弃；
//   · 返回的选项必须真的是这道题的选项，编出来的丢弃；
//   · 缺失/不合规都算 rejected，宁缺勿错 —— 错答案键会直接教错。
//
// 健壮性（踩过坑）：
//   · 一次要 8 道题的逐项纠正，输出会很长 → max_tokens 给小了会被**从中间截断**，
//     看起来像"模型返回了坏 JSON"，其实是输出预算不够（我上一版就这么误判过，
//     还把原始文本原样甩到界面上）。现在：检测 finish_reason === 'length' →
//     **把这一批拆成两半重试**（递归到单题为止），而不是整批丢掉；
//   · 被截断的文本仍先尝试**抢救**其中已写完整的对象（每个对象后面还要各自过闸门，所以安全）。
import { ERROR_TAGS, ERROR_TAG_KEYS, chatWithMeta, parseJsonLoose, salvageObjects, LlmError, llmConfig } from './llm.mjs'

/** 一次喂给模型多少道题。**别调大**：8 道就会把输出撑到上限附近，6 道更稳。 */
export const CHUNK = 6
/** 输出预算：逐项纠正很长，给足；配合拆半重试，宁可多花几次调用也不丢内容 */
const MAX_TOKENS = 8000
/** 递归拆半的最大深度（6 → 3 → 1） */
const MAX_SPLIT = 3

const SYSTEM = [
  '你在给一套中国学生用的英语练习册补"逐项纠正"。作者的教学主张是：英语是直线型思维，',
  '含义决定形式 —— 一个含义对应一个形式，形式变了是因为含义变了，不是因为"规则要求"。',
  '',
  '对每一道题、每一个**错误选项**，写一句话说清楚：选了它，等于在表达什么意思（为什么与题干要表达的含义不符）。',
  '要求：',
  '· 只说含义，不说术语：不出现"主格/宾格/物主代词/形容词性/三单规则"这类名词。用"做动作的/挨动作的/他的（东西）"来讲。',
  '· 每条 12~25 个汉字，一句话，不要分点，不要客套，不要复述题干或正确项。',
  '· 同时从下面的标签表里给这条错因挑**一个**标签（只能从表里挑，不许自创）：',
  ...Object.entries(ERROR_TAGS).map(([k, v]) => `    ${k} = ${v}`),
  '',
  '只输出 JSON，不要任何解释或 markdown 包装。格式：',
  '{"items":[{"i":<题目序号>,"optionFixes":{"<错误选项原文>":"<一句话>"},"optionTags":{"<错误选项原文>":["<标签>"]}}]}',
].join('\n')

let llm = chatWithMeta   // 测试可注入替身（返回 { text, finishReason }）

/** 仅用于测试：替换模型调用 */
export function __setChatJson(fn) { llm = fn ?? chatWithMeta }
export function __resetChatJson() { llm = chatWithMeta }

function buildUser(items) {
  const payload = items.map((it, i) => ({ i, prompt: it.prompt, answer: it.answer, options: it.options }))
  return `共 ${payload.length} 道题：\n` + JSON.stringify(payload, null, 1)
}

/** 把模型输出里的一道题过闸门；不合格返回 null（该题这条内容丢弃） */
function acceptItem(row, q) {
  if (!row || typeof row !== 'object') return null
  const wrong = new Set((q.options ?? []).filter((o) => o !== q.answer))
  const fixes = {}
  const tags = {}
  for (const [opt, text] of Object.entries(row.optionFixes ?? {})) {
    if (!wrong.has(opt)) continue                       // 编出来的选项：丢
    const clean = String(text ?? '').trim().slice(0, 120)
    if (clean.length < 6) continue
    fixes[opt] = clean
  }
  for (const [opt, list] of Object.entries(row.optionTags ?? {})) {
    if (!wrong.has(opt)) continue
    const picked = (Array.isArray(list) ? list : [list]).filter((t) => ERROR_TAG_KEYS.includes(t))
    if (picked.length) tags[opt] = picked
  }
  return Object.keys(fixes).length ? { optionFixes: fixes, optionTags: tags } : null
}

/**
 * 跑一批题（内部会拆半重试）。结果累加进 results。
 * 返回 { rejected, truncated, error }：error 只记第一条，供界面提示。
 */
async function runChunk(chunk, depth, results, notes) {
  if (!chunk.length) return
  let raw
  try {
    raw = await llm([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildUser(chunk) },
    ], { maxTokens: MAX_TOKENS, temperature: 0.2 })
  } catch (err) {
    notes.error = notes.error ?? String(err?.message ?? err)
    return
  }
  const text = raw?.text ?? ''
  const finish = raw?.finishReason ?? 'stop'
  let list = null
  if (finish === 'length') {
    // 输出被截断：先抢救完整对象，再决定要不要拆小重试
    notes.truncated++
    const saved = salvageObjects(text)
    list = saved.length ? saved : null
  } else {
    try {
      const parsed = parseJsonLoose(text)
      list = Array.isArray(parsed) ? parsed : (parsed?.items ?? null)
    } catch (err) {
      notes.error = notes.error ?? '模型输出无法解析（' + String(err?.message ?? err).slice(0, 80) + '）'
    }
  }

  let accepted = 0
  if (Array.isArray(list)) {
    for (const row of list) {
      const idx = Number(row?.i)
      const q = Number.isInteger(idx) ? chunk[idx] : null
      if (!q) { notes.rejected++; continue }
      const ok = acceptItem(row, q)
      if (ok) { results[q.id] = ok; accepted++ } else notes.rejected++
    }
  }

  // 有题没拿到结果，且还能再拆 → 拆成两半重试（宁可多花调用，也别整批丢）
  const missing = chunk.filter((q) => !results[q.id])
  if (missing.length && missing.length < chunk.length && depth < MAX_SPLIT) {
    const mid = Math.ceil(missing.length / 2)
    await runChunk(missing.slice(0, mid), depth + 1, results, notes)
    await runChunk(missing.slice(mid), depth + 1, results, notes)
  } else if (missing.length === chunk.length && chunk.length > 1 && depth < MAX_SPLIT) {
    // 整批都没拿到（截断得太早 / 解析失败）→ 拆半重试
    const mid = Math.ceil(chunk.length / 2)
    await runChunk(chunk.slice(0, mid), depth + 1, results, notes)
    await runChunk(chunk.slice(mid), depth + 1, results, notes)
  } else if (accepted === 0) {
    notes.rejected += missing.length
  }
}

/**
 * 给一批题生成逐项纠正。返回 { results: {qid: {optionFixes, optionTags}}, rejected, truncated, error, model }
 * 任何一道题不合格都只影响它自己。
 */
export async function enrichCauses(questions) {
  if (!questions.length) return { results: {}, rejected: 0, truncated: 0, model: null, error: null }
  if (!llmConfig().configured) throw new LlmError('模型未配置：系统 AI 不可用')
  const model = llmConfig().model
  const results = {}
  const notes = { rejected: 0, truncated: 0, error: null }
  for (let start = 0; start < questions.length; start += CHUNK) {
    await runChunk(questions.slice(start, start + CHUNK), 0, results, notes)
  }
  return { results, ...notes, model }
}
