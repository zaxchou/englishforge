// 系统自带的模型通道（服务端）。
//
// 为什么必须放在服务端而不是离线脚本：用户的原话是「**这个管线是系统本身的 AI 进行的纠正，
// 而不是你 agent**，这样我做完错题，系统就能自我修复」—— 靠我离线跑一遍脚本，是一次性的人工
// 修补；放进系统里，它才能在用户答题过程中自己补内容、自己去重、自己长。
//
// **密钥不复制、不落库、不进仓库**：按优先级读，第一处命中即用
//   1) 环境变量 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_TEXT_MODEL
//   2) <zcode>/molin-wiki/backend/.env          （原地读，避免多一份密钥副本）
//   3) <zcode>/vgallery/.env.local
// 本仓库是公开仓库：任何情况下都不要把密钥写进仓库内文件，也不要打印出来。
import { readFileSync } from 'node:fs'
import { getSetting } from './db.mjs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const JUNENGLISH = resolve(HERE, '..', '..')        // .../JunEnglish
const ZCODE = resolve(JUNENGLISH, '..')             // .../zcode

/** 换模型后要让缓存失效 */
export function invalidateLlmConfig() { cached = null }

const ENV_FILES = [
  resolve(ZCODE, 'molin-wiki', 'backend', '.env'),
  resolve(ZCODE, 'vgallery', '.env.local'),
]

/** 错因标签词表：给模型的规定动作（它只能从这里面挑），
 *  与前端 src/learning/errorTags.ts 的 TAG_LABEL 必须一致（有测试比对）。 */
export const ERROR_TAGS = {
  'role-reversed': '把"做动作的"和"挨动作的"弄反了',
  'case-form-subject': '该用挨动作的形式，却用了做动作的形式（he/she/they）',
  'case-form-possessive': '该说这个人，却说成了"他的（东西）"',
  'case-form-reflexive': '把动作绕回自己身上（-self）',
  'pron-before-noun': '把"他的"这类限定词当成能单独站着的词',
  'det-without-noun': '后面没有名词，却用了"这/那/我的"这类限定词',
  'verb-form-third': '三单该加 -s 却没加（或加错）',
  'verb-form-base': '不该加 -s 却加了，或用了原形',
  'plural-missing': '该用复数形式，却用了单数',
  'plural-double': '已经是复数了，又在上面加了一次复数',
  'plural-spelling': '复数的拼写规则用错（发音决定怎么写）',
  'agreement-be': 'be 动词的形式与主语不匹配（is/are/am）',
  'tense-form': '时态/时间记号用错',
  'word-class': '词性用错（该修饰名词却用了副词，或反过来）',
  'other': '上面都不合适',
}
export const ERROR_TAG_KEYS = Object.keys(ERROR_TAGS)

function readEnvFile(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const out = {}
    for (const m of text.matchAll(/^([A-Z0-9_]+)\s*=\s*(.*)$/gm)) {
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    return out
  } catch {
    return {}
  }
}

/** 默认模型：用户说 deepseek-flash 是他们最新的 */
export const DEFAULT_MODEL = 'deepseek-flash'

/**
 * 多 provider：**"审核员"和"出题人"不该是同一家模型** —— 同一个模型自查等于自说自话。
 * 密钥一律运行时从环境变量或仓库外的 .env 读，绝不入库、绝不打印。
 */
export const PROVIDERS = {
  // 出题 / 补内容
  deepseek: {
    label: 'DeepSeek',
    key: ['DEEPSEEK_API_KEY'], base: ['DEEPSEEK_BASE_URL'], model: ['DEEPSEEK_TEXT_MODEL'],
    defaultBase: 'https://api.deepseek.com', defaultModel: 'deepseek-flash',
  },
  // 审核：小米 MiMo。密钥沿用 molin-wiki 的"通用 OpenAI 兼容槽位"（AI_API_KEY / AI_BASE_URL / AI_MODEL）
  mimo: {
    label: 'MiMo（小米）',
    key: ['MIMO_API_KEY', 'AI_API_KEY'],
    base: ['MIMO_API_BASE', 'AI_BASE_URL'],
    model: ['MIMO_MODEL', 'AI_MODEL'],
    defaultBase: 'https://api.xiaomimimo.com/v1', defaultModel: 'mimo-v2.6-flash',
  },
}
export const PROVIDER_NAMES = Object.keys(PROVIDERS)
/** 默认审核员：用户指定用 MiMo（另一个模型家族），不要用 qwen / 智谱 */
export const DEFAULT_REVIEWER = 'mimo'

/** 读某个 provider 的凭据；env 优先，其次仓库外的 .env 文件 */
function resolveProvider(name) {
  const spec = PROVIDERS[name]
  if (!spec) return null
  const pick = (keys, env) => keys.map((k) => env[k]).find(Boolean) || ''
  let key = pick(spec.key, process.env)
  let base = pick(spec.base, process.env)
  let model = pick(spec.model, process.env)
  if (!key) {
    for (const file of ENV_FILES) {
      const env = readEnvFile(file)
      const k = pick(spec.key, env)
      if (k) {
        key = k
        base = base || pick(spec.base, env)
        model = model || pick(spec.model, env)
        break
      }
    }
  }
  if (!key) return null
  return { provider: name, label: spec.label, key, baseUrl: (base || spec.defaultBase).replace(/\/+$/, ''), model: model || spec.defaultModel }
}

/** 哪些 provider 有密钥可用（只回报名字，不回报密钥） */
export function availableProviders() {
  return PROVIDER_NAMES.filter((n) => !!resolveProvider(n)).map((n) => ({ name: n, label: PROVIDERS[n].label }))
}

let cached = null

/** 模型名是从哪来的（如实回报，别把"界面设置"说成 .env） */
function sourceLabel(providerName) {
  const envNames = PROVIDERS[providerName]?.key ?? []
  return envNames.some((n) => process.env[n]) ? '环境变量' : '项目 .env（仓库外）'
}

/**
 * 解析某个角色该用哪家模型：
 *   role='generate' → 出题 / 补逐项纠正；role='review' → 审核别人出的题。
 * 优先级：环境变量 > 界面设置（存库）> .env 的值 > 默认。
 * 审核员默认**自动挑一家和出题人不同的 provider**（没有别的可用时才退回同一家，并如实标注"自查"）。
 */
export function llmConfig(role = 'generate', { refresh = false } = {}) {
  if (cached && !refresh) return cached[role] ?? cached.generate
  const read = (k) => { try { return getSetting(k) } catch { return null } }
  const envFor = (r, field) => process.env[`ENGLISHFORGE_${r.toUpperCase()}_${field.toUpperCase()}`] || ''

  const genProvider = envFor('generate', 'provider') || read('ai_provider') || 'deepseek'
  const gen = resolveProvider(genProvider) ?? resolveProvider('deepseek')

  // 审核员默认 MiMo（用户指定）；只有它没配好时才退回与出题人同一家，并在界面上标"自查"
  const revProvider = envFor('review', 'provider') || read('ai_review_provider') || DEFAULT_REVIEWER
  const rev = resolveProvider(revProvider) ?? gen

  const modelOf = (r, fallback) => envFor(r, 'model') || read(r === 'review' ? 'ai_review_model' : 'ai_model') || fallback
  // 模型名是从哪来的，也要如实回报（用户会问"我改了到底生效没有"）
  const modelOrigin = (role) => {
    if (envFor(role, 'model')) return '环境变量'
    if (read(role === 'review' ? 'ai_review_model' : 'ai_model')) return '界面设置'
    return '项目 .env（仓库外）'
  }
  const mk = (resolved, role) => resolved
    ? {
      configured: true, ...resolved,
      model: modelOf(role, resolved.model),
      modelSource: modelOrigin(role),
      source: sourceLabel(resolved.provider),      // 密钥是哪来的
    }
    : { configured: false, key: '', baseUrl: '', model: '', source: '', modelSource: '' }

  cached = { generate: mk(gen, 'generate'), review: mk(rev, 'review') }
  return cached[role] ?? cached.generate
}

/** 状态查询：**只回报有没有配好、用的哪家模型、从哪读的**，绝不回报密钥本身 */
export function llmStatus() {
  const mk = (c) => ({
    configured: c.configured,
    provider: c.provider ?? null,
    providerLabel: c.label ?? null,
    model: c.configured ? c.model : null,
    source: c.configured ? c.source : null,
    modelSource: c.configured ? c.modelSource : null,
  })
  const g = llmConfig('generate')
  const r = llmConfig('review')
  return {
    ...mk(g),
    defaultModel: g.model || DEFAULT_MODEL,
    envLocked: !!(process.env.ENGLISHFORGE_GENERATE_MODEL || process.env.ENGLISHFORGE_GENERATE_PROVIDER),
    review: mk(r),
    /** 出题人与审核员是不是不同一家。同一家只能算"自查"，界面要如实说明 */
    independentReview: !!(g.provider && r.provider && g.provider !== r.provider),
    available: availableProviders(),
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])
const TIMEOUT_MS = 120_000

export class LlmError extends Error {
  constructor(message, status = 0) { super(message); this.status = status }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 一次对话补全，连**结束原因**一起返回。
 * 为什么要 finishReason：max_tokens 太小会让模型把 JSON 写到一半就被切断，
 * 那时文本看起来"就是坏的 JSON"，很容易误判成"模型不听话"（我上一版就误判了，
 * 报错文案还甩锅给模型）。看到 `length` 就该知道是**输出预算不够**，正确反应是
 * 把这一批拆小重试，而不是报告"模型没返回可解析的 JSON"。
 */
export async function chatWithMeta(messages, { maxTokens = 2000, temperature = 0.2, tries = 3, role = 'generate' } = {}) {
  const cfg = llmConfig(role)
  if (!cfg.configured) throw new LlmError('模型未配置：在 molin-wiki/backend/.env 里放对应 provider 的 API KEY（或设环境变量）')
  let last = null
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        // thinking: disabled —— 关掉推理模式的思考过程，免得 max_tokens 被 reasoning 吃光
        body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, temperature, thinking: { type: 'disabled' } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300)
        if (RETRYABLE.has(res.status) && i < tries - 1) { last = new LlmError(`HTTP ${res.status}`, res.status); await sleep(800 * (i + 1)); continue }
        throw new LlmError(`模型接口 ${res.status}：${body}`, res.status)
      }
      const json = await res.json()
      const text = json?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) {
        if (i < tries - 1) { last = new LlmError('模型返回空内容'); await sleep(800 * (i + 1)); continue }
        throw new LlmError('模型返回空内容')
      }
      return { text, finishReason: json?.choices?.[0]?.finish_reason ?? 'stop', usage: json?.usage ?? null }
    } catch (err) {
      if (err instanceof LlmError && err.status && err.status < 500 && err.status !== 429) throw err
      last = err
      if (i < tries - 1) { await sleep(800 * (i + 1)); continue }
      throw err instanceof LlmError ? err : new LlmError('模型请求失败：' + (err?.message ?? err))
    }
  }
  throw last ?? new LlmError('模型请求失败')
}

/** 宽松 JSON 解析：模型常把 JSON 包在 ```json 里，或前后带一句解释 */
export function parseJsonLoose(text) {
  const trimmed = String(text).trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : trimmed
  try { return JSON.parse(body) } catch { /* 继续尝试截取 */ }
  const start = body.search(/[[{]/)
  if (start >= 0) {
    const open = body[start]
    const close = open === '{' ? '}' : ']'
    const end = body.lastIndexOf(close)
    if (end > start) {
      try { return JSON.parse(body.slice(start, end + 1)) } catch { /* ignore */ }
    }
  }
  throw new LlmError('模型没有返回可解析的 JSON：' + body.slice(0, 160))
}

export async function chatJson(messages, opts) {
  return parseJsonLoose(await chat(messages, opts))
}

/** 只要文本的便捷版本（大多数场景用这个就够） */
export async function chat(messages, opts) {
  return (await chatWithMeta(messages, opts)).text
}

/**
 * 从**被截断**的 JSON 里抢救出已写完整的对象。
 *
 * 做法：对每一个 `{` 起点都试着找出配对的 `}`（字符串内的括号不算），能 `JSON.parse` 成功就收下。
 * 这样即使最外层的包裹对象没闭合（截断），里面已经写完整的一道题也能救回来。
 * 每个对象的字段后面还要各自过闸门（选项必须真实存在、标签必须在词表里），所以抢救是安全的。
 */
export function salvageObjects(text) {
  // 用字符码而不是字面量：反斜杠与引号在这个文件里被 shell/转义折腾过好几次了
  const BACKSLASH = String.fromCharCode(92)
  const QUOTE = String.fromCharCode(34)
  const out = []
  const seen = new Set()
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (esc) { esc = false; continue }
      if (c === BACKSLASH) { esc = true; continue }
      if (c === QUOTE) { inStr = !inStr; continue }
      if (inStr) continue
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) continue
    const slice = text.slice(start, end + 1)
    if (seen.has(slice)) continue
    try {
      const obj = JSON.parse(slice)
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'i' in obj) {
        seen.add(slice)
        out.push(obj)
      }
    } catch { /* 这个片段不完整，继续往后找 */ }
  }
  return out
}
