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
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const JUNENGLISH = resolve(HERE, '..', '..')        // .../JunEnglish
const ZCODE = resolve(JUNENGLISH, '..')             // .../zcode

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

let cached = null

/** 解析出 { key, baseUrl, model, source }；没有可用密钥时返回 { configured: false } */
export function llmConfig({ refresh = false } = {}) {
  if (cached && !refresh) return cached
  let key = process.env.DEEPSEEK_API_KEY || ''
  let base = process.env.DEEPSEEK_BASE_URL || ''
  let model = process.env.DEEPSEEK_TEXT_MODEL || ''
  let source = key ? 'env' : ''
  if (!key) {
    for (const file of ENV_FILES) {
      const env = readEnvFile(file)
      if (env.DEEPSEEK_API_KEY) {
        key = env.DEEPSEEK_API_KEY
        base = base || env.DEEPSEEK_BASE_URL || ''
        model = model || env.DEEPSEEK_TEXT_MODEL || ''
        source = file
        break
      }
    }
  }
  cached = key
    ? { configured: true, key, baseUrl: (base || 'https://api.deepseek.com').replace(/\/+$/, ''), model: model || 'deepseek-chat', source }
    : { configured: false, key: '', baseUrl: '', model: '', source: '' }
  return cached
}

/** 状态查询：**只回报有没有配好、用的哪个模型、从哪读的**，绝不回报密钥本身 */
export function llmStatus() {
  const c = llmConfig()
  return {
    configured: c.configured,
    model: c.configured ? c.model : null,
    source: c.configured ? (c.source === 'env' ? '环境变量' : '项目 .env（仓库外）') : null,
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])
const TIMEOUT_MS = 120_000

export class LlmError extends Error {
  constructor(message, status = 0) { super(message); this.status = status }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一次对话补全。仅 429/5xx/网络错误重试；4xx 立即失败（重试也没用）。 */
export async function chat(messages, { maxTokens = 2000, temperature = 0.2, tries = 3 } = {}) {
  const cfg = llmConfig()
  if (!cfg.configured) throw new LlmError('模型未配置：在 molin-wiki/backend/.env 里放 DEEPSEEK_API_KEY（或设环境变量）')
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
      return text
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
