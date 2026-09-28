// 系统自带的两条 AI 流水线：
//   1) `enrichCauses` —— 给缺逐项纠正的题补「你选的这条等于在说什么意思」+ 错因标签（出题人角色）
//   2) `reviewQuestions` —— **审核别人出的题**（审核员角色，默认换一家模型家族）
//
// 为什么要有第 2 条：用户的原话是「**整个审核机制对我来说有点没意义…它应该是完全自动的，
// 而不是再让人工去审核**…你完全可以让第二个 AI 去审核…DeepSeek 生成题，MIMO 来审核」。
// 让人逐题看几百上千道，实际结果就是"看都不看全部通过"——那 `reviewed` 这个信任级别就是假的。
// 所以人工的位置改成：**只看 AI 报出来的例外**（判毙的、要改的、说不清的），外加随机抽检。
//
// 两条流水线共用一套批处理：输出被截断时先抢救完整对象、再拆半重试（见 runBatched）。
import {
  ERROR_TAGS, ERROR_TAG_KEYS, chatWithMeta, parseJsonLoose, salvageObjects, LlmError, llmConfig,
} from './llm.mjs'

/** 一次喂给模型多少道题 */
export const CHUNK = 6
const REVIEW_CHUNK = 10
/** 输出预算：逐项纠正很长，给足；配合拆半重试，宁可多花几次调用也不丢内容 */
const MAX_TOKENS = 8000
const REVIEW_MAX_TOKENS = 3000
/** 递归拆半的最大深度 */
const MAX_SPLIT = 3

let llm = chatWithMeta   // 测试可注入替身（返回 { text, finishReason }）

/** 仅用于测试：替换模型调用 */
export function __setChatJson(fn) { llm = fn ?? chatWithMeta }
export function __resetChatJson() { llm = chatWithMeta }

/**
 * 通用的"分批问模型 + 严格收结果"。
 * · 截断（finish_reason='length'）→ 先抢救已写完整的对象，剩下的拆半重试；
 * · 解析失败 → 拆半重试；
 * · 每一条都要过 `accept`（调用方给的质量闸门），不合格算 rejected，只影响它自己。
 */
async function runBatched({ items, chunkSize, maxTokens, role, system, buildUser, accept, keyOf }) {
  const results = {}
  const notes = { rejected: 0, truncated: 0, error: null }

  async function runChunk(chunk, depth) {
    if (!chunk.length) return
    let raw
    try {
      raw = await llm([
        { role: 'system', content: system },
        { role: 'user', content: buildUser(chunk) },
      ], { maxTokens, temperature: 0.2, role })
    } catch (err) {
      notes.error = notes.error ?? String(err?.message ?? err)
      return
    }
    const text = raw?.text ?? ''
    let list = null
    if (raw?.finishReason === 'length') {
      notes.truncated++
      const saved = salvageObjects(text)
      list = saved.length ? saved : null
    } else {
      try {
        const parsed = parseJsonLoose(text)
        list = Array.isArray(parsed) ? parsed : (parsed?.items ?? null)
      } catch (err) {
        // 有的模型把输出截断了却不报 length：解析失败时也先抢救一遍写完整的对象
        const saved = salvageObjects(text)
        if (saved.length) list = saved
        else notes.error = notes.error ?? '模型输出无法解析（' + String(err?.message ?? err).slice(0, 80) + '）'
      }
    }

    if (Array.isArray(list)) {
      for (const row of list) {
        const idx = Number(row?.i)
        const q = Number.isInteger(idx) ? chunk[idx] : null
        if (!q) { notes.rejected++; continue }
        const ok = accept(row, q)
        if (ok) results[keyOf(q)] = ok
        else notes.rejected++
      }
    }

    const missing = chunk.filter((q) => !results[keyOf(q)])
    if (!missing.length) return
    if (chunk.length === 1) {
      // 单题没拿到：没有"拆半"可走，原样再试两次（偶发坏输出很常见，一次就放弃会让队列永远卡住）
      if (depth < 2) { await runChunk(chunk, depth + 1); return }
      notes.rejected += missing.length
      return
    }
    if (depth >= MAX_SPLIT) {
      notes.rejected += missing.length
      return
    }
    // 整批都没拿到，或者只拿到一部分 → 把没拿到的那部分拆半重试
    const todo = missing.length === chunk.length ? chunk : missing
    const mid = Math.ceil(todo.length / 2)
    await runChunk(todo.slice(0, mid), depth + 1)
    await runChunk(todo.slice(mid), depth + 1)
  }

  for (let start = 0; start < items.length; start += chunkSize) {
    await runChunk(items.slice(start, start + chunkSize), 0)
  }
  return { results, ...notes }
}

// ---------------------------------------------------------------- 1) 补逐项纠正（出题人角色）

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

function acceptCause(row, q) {
  if (!row || typeof row !== 'object') return null
  const wrong = new Set((q.options ?? []).filter((o) => o !== q.answer))
  const fixes = {}
  const tags = {}
  for (const [opt, text] of Object.entries(row.optionFixes ?? {})) {
    if (!wrong.has(opt)) continue
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

/** 给一批题生成逐项纠正（出题人角色） */
export async function enrichCauses(questions) {
  if (!questions.length) return { results: {}, rejected: 0, truncated: 0, model: null, error: null }
  if (!llmConfig('generate').configured) throw new LlmError('模型未配置：系统 AI 不可用')
  const out = await runBatched({
    items: questions, chunkSize: CHUNK, maxTokens: MAX_TOKENS, role: 'generate',
    system: SYSTEM,
    buildUser: (chunk) => `共 ${chunk.length} 道题：\n` + JSON.stringify(
      chunk.map((it, i) => ({ i, prompt: it.prompt, answer: it.answer, options: it.options })), null, 1),
    accept: acceptCause,
    keyOf: (q) => q.id,
  })
  return { ...out, model: llmConfig('generate').model }
}

// ---------------------------------------------------------------- 2) 审核（另一个角色，默认另一家模型）

const REVIEW_SYSTEM = [
  '你是这套英语练习册的**审核员**。你的任务是**找出题目里的问题**，不是确认它没问题。',
  '出题的是另一家模型，不用客气；但也不要无端挑刺 —— 只有你能指出具体错在哪，才算问题。',
  '',
  '【最重要的前提，先读懂】本书作者的教学主张**就是评判标准**，不要拿别的语言学观点去否定它：',
  '  · 含义不同，就是两个不同的词（所以 book 和 books 是两个词，不是"同一个词加了个 s"）；',
  '  · 一个含义对应一个形式；所有词形变化都是为了区分含义；',
  '  · 讲句子时不用语法术语，用"做动作的 / 挨动作的 / 他的（东西）"这种方式说。',
  '**不要**因为"它们其实是同一个词位的屈折形式""这在语言学上不严谨"这类理由判题目有问题 ——',
  '那是另一个学派的事，不是这套教材的错。你要审的是：**在这套讲法内部，这道题自不自洽**。',
  '',
  '对每道题逐项检查，回答 true/false：',
  '1) answerOk：标出的答案，在题干要求的含义下是不是**唯一正确**的？另一个选项也能成立 → false。',
  '2) distractorOk：每个错误选项是不是**确实错**（与题干要求的含义不符），且错得能用"含义"说清楚？有干扰项其实也成立 → false。',
  '    （若这道题**没有选项**（拼句/点词/跟读这类），这一项不适用，填 true。）',
  '    拼句/点词题会给出 `sentence`（题目展示给学生的词序）——判断 answerOk 前**必须先看这个**，',
  '    答案必须是句子里真实存在的那个词/位置；说"答案不在句子里"之前请先确认 sentence 里确实找不到它。',
  '3) glossOk：题干里的中文提示/释义是否准确、不误导？没有中文释义就填 true。',
  '4) explainOk：解析是否自洽、且没有出现"主格/宾格/物主代词/三单规则"这类术语？',
  '',
  '然后给出 verdict：',
  '· "ok"  —— 四项全过；',
  '· "kill" —— answerOk 为 false（答案本身错了，这题会教错人，必须撤下）；',
  '· "fix" —— 其它问题（干扰项也成立 / 释义不准 / 解析用了术语或自相矛盾）。',
  '',
  'reasons 最多 3 条，每条一句话，必须**指出是哪一项、错在哪**，例如：',
  '  "干扰项 his 在「这是他的书」这个含义下也成立，题不唯一"',
  '  "解析用了「三单」这个术语，与本书的讲法不符"',
  '说有问题却给不出理由的，不要给 fix/kill。',
  '',
  '只输出 JSON，不要 markdown 包装：',
  '{"items":[{"i":0,"answerOk":true,"distractorOk":true,"glossOk":true,"explainOk":true,"verdict":"ok","reasons":[]}]}',
].join('\n')

/** 给测试用：这条提示里必须一直保留"以本书主张为标准"的前提（否则审核员会把整套教材判死） */
export const REVIEW_PROMPT = REVIEW_SYSTEM

/**
 * 审核结果的质量闸门（代码层，不信模型的自述）：
 * · 判据说答案不对 → 结论必须 kill（模型说 ok 也改掉）；
 * · 有任一项没过 → 结论不能是 ok（自动降为 fix）；
 * · 说有问题却给不出理由 → 不采信（宁可不审，也不要一条没有依据的结论）。
 */
function acceptReview(row, q) {
  if (!row || typeof row !== 'object') return null
  const hasOptions = Array.isArray(q.options) && q.options.length > 1
  const criteria = {
    answerOk: row.answerOk !== false,
    // 没有选项的题不存在"干扰项"问题，这一项不参与判定（否则会凭空把这类题全判成要改）
    distractorOk: !hasOptions || row.distractorOk !== false,
    glossOk: row.glossOk !== false,
    explainOk: row.explainOk !== false,
  }
  const allOk = Object.values(criteria).every(Boolean)
  let verdict = ['ok', 'fix', 'kill'].includes(row.verdict) ? row.verdict : 'fix'
  const notes = []
  if (!criteria.answerOk && verdict !== 'kill') { verdict = 'kill'; notes.push('依据：答案本身不正确') }
  else if (!allOk && verdict === 'ok') { verdict = 'fix'; notes.push('依据：有检查项未通过，不能算通过') }
  if (verdict === 'ok' && !allOk) verdict = 'fix'

  const reasons = (Array.isArray(row.reasons) ? row.reasons : [])
    .map((r) => String(r ?? '').trim().slice(0, 160)).filter(Boolean).slice(0, 3)
  if (verdict !== 'ok' && !reasons.length) return null   // 说不出问题在哪 → 不采信
  return { verdict, criteria, reasons: [...reasons, ...notes], questionId: q.id }
}

/** 让系统审核一批题（默认用与出题人不同的一家模型） */
export async function reviewQuestions(questions) {
  const cfg = llmConfig('review')
  if (!questions.length) return { results: {}, rejected: 0, truncated: 0, model: null, provider: null, error: null }
  if (!cfg.configured) throw new LlmError('审核模型未配置')
  const out = await runBatched({
    items: questions, chunkSize: REVIEW_CHUNK, maxTokens: REVIEW_MAX_TOKENS, role: 'review',
    system: REVIEW_SYSTEM,
    buildUser: (chunk) => `共 ${chunk.length} 道题：\n` + JSON.stringify(
      chunk.map((it, i) => ({
        i, type: it.type, prompt: it.prompt,
        // 句子在哪：选择题在选项里，拼句/点词/跟读在 tokens/order/target 里
        // （不给句子，审核员会误判"答案不在句子里"—— 实测误杀了 4 道）
        sentence: it.tokens ?? it.order ?? it.target ?? null,
        options: it.options, answer: it.answer, explain: it.explain ?? null,
      })), null, 1),
    accept: acceptReview,
    keyOf: (q) => q.id,
  })
  return { ...out, model: cfg.model, provider: cfg.provider }
}

// ---------------------------------------------------------------- 3) 改稿（出题人角色）

/**
 * 改出来的解析里**不许**再出现这些语法术语 —— 审核员的 explainOk 查的就是它们，
 * 代码层先拦一道，省一轮"改完还是术语"的往返（模型自己说没问题不算数）。
 */
export const BANNED_IN_EXPLAIN = [
  '主格', '宾格', '物主', '三单', '主语', '谓语', '宾语', '表语', '定语', '状语', '补语',
  '从句', '时态', '语态', '语法', '单数', '复数', '比较级', '最高级', '不定式', '动名词',
  '冠词', '代词', '同位语', '虚拟语气', '并列句', '倒装',
]

const REWRITE_SYSTEM = [
  '你在给一套中国学生用的英语练习册**改稿**。另一个模型（审核员）指出了每道题的问题，你按它的意见改好。',
  '',
  '作者的教学主张（这就是标准，改出来的内容必须符合）：',
  '  · 英语是直线型思维，含义决定形式；一个含义对应一个形式，形式变了是因为含义变了；',
  '  · 含义不同，就是两个不同的词（book 和 books 是两个词）；',
  '  · 讲句子不用语法术语，用"做动作的 / 挨动作的 / 他的（东西）"这种方式说。',
  '',
  '你能改的只有三样（审核员没指出的问题**一律不动**，不要整体重写）：',
  '· explain —— 解析用了术语、自相矛盾、或**没让学生能直接核对答案**时重写：一句话说清"为什么这个答案才对"',
  '  （配对题要说清哪两个配哪两个，别只列规则），12~80 个汉字，一句话，不分点、不客套、不复述题干；术语全部换成上面的讲法。',
  '· options —— 只在审核员说"某个干扰项其实也成立 / 选项有问题"时改：',
  '  正确答案**原样保留在原来的位置**，只换掉它指出的那个选项，换成同长度、按题干含义明显错的新选项；选项个数不变。',
  '· prompt —— 审核员指出**题干本身**有问题时改（释义不准、题干里出现了语法术语）：只改它指出的那几个字，',
  '  英文、题型要求、结构一个字都不许动。',
  '  若某题带 `promptMustFix` 字段：这是**硬性要求** —— 这一轮必须输出改好的 prompt，不能只改解析就算完成。',
  '',
  '不许改：题型、正确答案、句子本身（tokens/order/target）。',
  '审核员没提的字段不要输出。',
  '',
  '只输出 JSON，不要任何解释或 markdown 包装。格式：',
  '{"items":[{"i":<题目序号>,"explain":"<重写后的解析>"}]}',
].join('\n')

/** 给测试用：改稿提示里必须一直保留"按本书主张改"的前提 */
export const REWRITE_PROMPT = REWRITE_SYSTEM

/**
 * 改稿结果的代码闸门（不信模型的自述）：
 * · 解析：非空、不短、**不含语法术语**（否则改了等于没改）；
 * · 释义：长度必须与原题干接近（防"重写"顺手把题干换掉）；
 * · 选项：个数不变、正确答案**留在原位**（客户端按位置生成选项 ID，换位会让判分错位）、
 *   且改完不许出现两个重复选项（审核员挑的"d-s8-16"这类问题不能改完还在）。
 */
export function acceptRewrite(row, q) {
  if (!row || typeof row !== 'object') return null
  const out = {}
  if (row.explain !== undefined && row.explain !== null) {
    const s = String(row.explain).trim().slice(0, 600)
    if (s.length < 8) return null
    if (BANNED_IN_EXPLAIN.some((t) => s.includes(t))) return null
    out.explain = s
  }
  if (row.prompt !== undefined && row.prompt !== null) {
    const orig = String(q.prompt ?? '')
    const s = String(row.prompt).trim().slice(0, 500)
    if (!s || s.length < orig.length * 0.5 || s.length > orig.length * 1.5) return null
    out.prompt = s
  }
  if (row.options !== undefined && row.options !== null) {
    if (!Array.isArray(row.options)) return null
    const orig = Array.isArray(q.options) ? q.options : []
    const opts = row.options.map((o) => String(o).trim().slice(0, 200))
    if (opts.length !== orig.length || opts.length < 2) return null
    const answerIdx = orig.indexOf(String(q.answer))
    if (answerIdx < 0 || opts[answerIdx] !== String(q.answer)) return null  // 答案必须原位
    const norm = (s) => String(s).toLowerCase().replace(/[\s.,!?;:'"“”‘’（）()]/g, '')
    if (new Set(opts.map(norm)).size !== opts.length) return null           // 不许留重复选项
    out.options = opts
  }
  return Object.keys(out).length ? out : null
}

/**
 * 按审核意见改一批题（**出题人角色** = 与审核员不同的一家模型）。
 * 改完不直接采信：结果要再过一轮 reviewQuestions（复审），过了才算数。
 */
export async function rewriteQuestions(questions) {
  if (!questions.length) return { results: {}, rejected: 0, truncated: 0, model: null, provider: null, error: null }
  const cfg = llmConfig('generate')
  if (!cfg.configured) throw new LlmError('模型未配置：系统 AI 不可用')
  const out = await runBatched({
    items: questions, chunkSize: CHUNK, maxTokens: MAX_TOKENS, role: 'generate',
    system: REWRITE_SYSTEM,
    buildUser: (chunk) => `共 ${chunk.length} 道题（每条附审核员的意见）：\n` + JSON.stringify(
      chunk.map((it, i) => {
        // 硬指令的两个条件都满足才下：**审核员把矛头指向题干** + 题干确实含术语。
        // 只看术语会误伤"破惯性题"（题干引用的正是要被打碎的错误说法，如「复数就是加个 s」）。
        const reasons = it.reasons ?? []
        const reasonsPointAtPrompt = reasons.some((r) => /题干|题面|提示|释义/.test(String(r)))
        const terms = reasonsPointAtPrompt
          ? BANNED_IN_EXPLAIN.filter((t) => String(it.prompt ?? '').includes(t))
          : []
        return {
          i, type: it.type, prompt: it.prompt, options: it.options, answer: it.answer,
          explain: it.explain ?? null,
          sentence: it.tokens ?? it.order ?? it.target ?? null,
          reasons,
          ...(terms.length ? { promptMustFix: `题干里出现了「${terms.join('」「')}」——必须改题干（只改这几个字），这一轮必须输出 prompt` } : {}),
        }
      }), null, 1),
    accept: acceptRewrite,
    keyOf: (q) => q.id,
  })
  return { ...out, model: cfg.model, provider: cfg.provider }
}
