// 托福私人老师（59 号 S2；55 §8 / 56 §8 / 57 四科分析应有区别）。
//
// 输出结构（固定）：本次观察 → 引用你的哪个回答/句子 → 原材料怎么支持 → 错因假设（带置信） →
// 一个优先修复 → 一个追问。最多一到两个改进点；封闭题按核验答案判，模型不能改答案；
// 开放题反馈是辅助意见，禁止给总分/百分制。AI 失败：作答已保存，feedback status=failed 可重试。
// 语音复盘：文字先到并落库，再合成语音，两者绑定同一 feedbackId+version（56 §8）。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatWithMeta } from '../llm.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TTS_DIR = resolve(HERE, '..', 'assets', 'toefl-tts')
const TTS_MODEL = 'qwen3-tts-flash'
const TTS_VOICE = 'Cherry'

// ---- 测试注入缝（对齐 v3grader 的做法：单测不真调模型） ----
let chatImpl = null
export function __setTeacherChat(fn) { chatImpl = fn }
export function __resetTeacherChat() { chatImpl = null }
async function teacherChat(messages, opts) {
  if (chatImpl) return chatImpl(messages, opts)
  return chatWithMeta(messages, opts)
}

// ---- 四科分科提示词合同 ----

const PART_CONTRACT = {
  listening: {
    focus: '听力复盘：分别检查 声音识别（听得出词吗）、语境词义（认识但现场反应不过来）、句子关系（每句似懂但记不住关系/意图）、话轮与语用（听到内容却选错意图）。引用具体话轮或音频情境；不要假设全文听写是必经路径。',
    openNote: null,
  },
  reading: {
    focus: '阅读复盘：分开解释 定位证据（回原文找哪句）、语境词义、长句关系、推断边界（推断必须受原文支持，不导出必然）。不只判选项对错；要指出他定位的对象和时间是否错位。',
    openNote: null,
  },
  writing: {
    focus: '写作复盘：对照题目要求与读者视角。先看 对象/目的/要求/请求是否清楚（最影响读者行动的一两点），再看组织与语言。必须引用本人原句；建议要本人一次能自己完成；AI 不代写，不把改写稿记成本人进步。',
    openNote: '写作没有唯一答案：反馈是辅助意见，不评分。',
  },
  speaking: {
    focus: '口语复盘：分开看 任务回应（是否先直接回应问题）、具体细节（有没有与自己有关的例子）、组织（听者能否跟上）、可懂度。注意：本系统暂无自动转写与发音声学评价——文字稿由本人补录（origin=user_typed），只能就文字稿内容组织与回应给意见，转写不可靠时请本人核对；不得声称评价了发音。',
    openNote: '口语没有唯一答案：反馈是辅助意见，不评分。',
  },
}

/** 组老师输入（绑定内容版本与本人作答；只发必要内容） */
export function buildTeacherInput({ task, attempt, errorsNote }) {
  const isClosed = task.kind === 'mc_group'
  const questions = isClosed ? task.questions : null
  const answers = attempt.answers ? JSON.parse(attempt.answers) : null
  const lines = []
  lines.push(`任务：${task.title}（科目：${task.part}）`)
  if (task.source) lines.push(`原题来源：${task.source.pack} PDF${task.source.pdfPage} 页。`)
  if (isClosed) {
    lines.push('题目与核验答案：')
    for (const q of questions) {
      const chosen = answers?.[q.id]
      const chosenText = chosen === undefined || chosen === null ? '（未作答）' : `${String.fromCharCode(65 + chosen)}. ${q.options[chosen]}`
      lines.push(`- ${q.prompt}\n  选项：${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(' / ')}\n  核验答案：${String.fromCharCode(65 + q.key)}（原文支持："${q.quote}"）\n  他的选择：${chosenText}`)
    }
    lines.push('判分已按核验答案完成，你不能修改答案或判分；你的工作是解释错因与修复。')
  } else if (task.kind === 'open_writing') {
    lines.push(`任务要求：${task.material.prompt}`)
    lines.push('他的第一稿：')
    lines.push(attempt.draft?.trim() || '（未留下文字稿）')
  } else {
    lines.push(`任务要求：${task.material.prompt}`)
    if (attempt.draft_transcript) lines.push(`他的录音文字稿（本人自录自校，origin=${attempt.transcript_origin ?? 'user_typed'}）：\n${attempt.draft_transcript}`)
    else lines.push('他的录音已保存，但（本系统暂无自动转写）没有文字稿；只能基于任务要求给一般性回应建议，并请他补录文字稿后再做针对性分析。')
  }
  if (errorsNote) lines.push(`他自己的疑问/异议：${errorsNote}`)
  return lines.join('\n')
}

function systemPrompt(part) {
  const c = PART_CONTRACT[part]
  return [
    '你是一位针对学生个人作答的托福老师。只依据给定的题目、原文/任务与他的作答说话，不要泛泛劝学。',
    c.focus,
    '输出严格的 JSON（不要包 markdown 代码块），字段：',
    '{"observation":"本次观察到什么（一两句）","evidence":["引用他的哪个回答/句子/选择，以及原材料怎么支持/反驳"],"hypothesis":"错因假设（带不确定说明，单题不定性）","confidence":"low|medium|high","one_fix":"一个优先修复动作（他一次能自己完成）","followup":"一个追问或下一步小任务"}',
    '语言：中文，引用英文原句保留英文。' + (c.openNote ?? '不开分数、不开百分制。'),
  ].join('\n')
}

/** 真实/注入的老师调用 → 结构化输出。抛错由调用方落 failed。 */
export async function runTeacher({ task, attempt, errorsNote }) {
  const input = buildTeacherInput({ task, attempt, errorsNote })
  const messages = [
    { role: 'system', content: systemPrompt(task.part) },
    { role: 'user', content: input },
  ]
  const { text, usage } = await teacherChat(messages, { maxTokens: 1400, temperature: 0.2, role: 'generate' })
  const parsed = parseTeacherJson(text)
  if (!parsed?.observation) throw new Error('老师输出缺少 observation：' + text.slice(0, 120))
  return { ...parsed, _meta: { model: 'server-llm', usage } }
}

function parseTeacherJson(text) {
  const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(t) } catch { /* 下一招 */ }
  const m = t.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch { /* 放弃 */ } }
  return null
}

// ---- 语音复盘（文字先落库后调用；56 §8） ----

const ttsCredentials = () => {
  const envFromFile = (p) => {
    try {
      return Object.fromEntries(readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
    } catch { return {} }
  }
  const ZCODE = resolve(HERE, '..', '..', '..', '..')
  const env = { ...envFromFile(resolve(ZCODE, 'vgallery', '.env.local')) }
  const key = process.env.QWEN_TTS_API_KEY || env.QWEN_TTS_API_KEY
  const ep = process.env.QWEN_TTS_ENDPOINT || env.QWEN_TTS_ENDPOINT
  if (!key || !ep) throw new Error('TTS 未配置（QWEN_TTS_API_KEY / QWEN_TTS_ENDPOINT）')
  return { key, ep }
}

/** 把老师反馈正文合成语音：返回 {file, bytes, sha256}；段级缓存（对齐 make-tts-audio 的哈希口径）。
 * 文字反馈必须已经落库（调用方保证），这里只做呈现层的 TTS。 */
export async function synthesizeFeedbackAudio(text) {
  const { key, ep } = ttsCredentials()
  const hash = createHash('sha256').update(`${TTS_MODEL}|${TTS_VOICE}|${text}`).digest('hex')
  const out = join(TTS_DIR, `${hash}.wav`)
  if (existsSync(out)) return { file: out, sha256: hash, cached: true }
  const r = await fetch(ep, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, input: { text, voice: TTS_VOICE } }),
  })
  if (!r.ok) throw new Error(`TTS HTTP ${r.status}`)
  const url = (await r.json())?.output?.audio?.url
  if (!url) throw new Error('TTS 响应无 output.audio.url')
  const raw = Buffer.from(await (await fetch(url)).arrayBuffer())
  // 云端 WAV 头 data 长度是占位值——按实际字节重写（教训见 make-tts-audio）
  if (raw.toString('latin1', 0, 4) !== 'RIFF') throw new Error('TTS 返回不是 WAV')
  const fixed = Buffer.from(raw)
  fixed.writeUInt32LE(raw.length - 8, 4)
  fixed.writeUInt32LE(raw.length - 44, 40)
  mkdirSync(TTS_DIR, { recursive: true })
  writeFileSync(out, fixed)
  return { file: out, sha256: hash, cached: false }
}

/** 反馈朗读文本（只读正文，不读 JSON 元字段） */
export function feedbackSpeechText(output) {
  const o = typeof output === 'string' ? JSON.parse(output) : output
  return [o.observation, ...(o.evidence ?? []), o.hypothesis, o.one_fix, o.followup]
    .filter(Boolean).join('\n')
}
