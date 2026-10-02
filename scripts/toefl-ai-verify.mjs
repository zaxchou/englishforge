// 59 号 S2 真实 AI 验收（H3）：隔离临时库 + 隔离账户，四科各一次真实老师反馈 + 一次 TTS。
// 运行：ENGLISHFORGE_DB=$(mktemp -d)/toefl-ai-verify.db node scripts/toefl-ai-verify.mjs
// 输出样本（可含作答文本，属测试数据）写入 docs/curriculum-v4/toefl-ai-verify-sample.json。
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ef-toefl-ai-'))
process.env.ENGLISHFORGE_DB = join(dir, 'verify.db')

const api = (await import('../server/api.mjs')).handleApi
const db = (await import('../server/db.mjs'))
const teacher = await import('../server/toefl/teacher.mjs')
const call = async (p, body, method = 'GET') => (await api({ pathname: p, body, method, query: new URLSearchParams() }))
const id = (await call('/api/accounts', { name: 'toefl-ai-verify' }, 'POST')).json.account.id
console.log('隔离账户:', id, '库:', process.env.ENGLISHFORGE_DB)

const llmStatus = (await import('../server/llm.mjs')).llmStatus
console.log('模型通道:', JSON.stringify(llmStatus()))

const samples = { date: new Date().toISOString(), account: id, subjects: {} }
const save = () => writeFileSync(new URL('../docs/curriculum-v4/toefl-ai-verify-sample.json', import.meta.url), JSON.stringify(samples, null, 1) + '\n')

async function verifySubject(part, taskId, payload, label) {
  const t0 = Date.now()
  let r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'ai-' + part, taskId, submit: true, ...payload }, 'POST')
  if (r.status !== 200) throw new Error(part + ' 提交失败: ' + JSON.stringify(r.json))
  const attemptId = r.json.attempt.attemptId
  r = await call(`/api/toefl/accounts/${id}/attempts/${attemptId}/feedback`, { note: payload.note }, 'POST')
  if (r.status !== 200) throw new Error(part + ' 反馈失败: ' + JSON.stringify(r.json).slice(0, 300))
  const fb = r.json.feedback
  const out = fb.output
  const ok = out && out.observation && out.one_fix && Array.isArray(out.evidence)
  console.log(`✓ ${label}: ${Date.now() - t0}ms | 观察: ${out.observation?.slice(0, 60)}…`)
  console.log(`  证据 ${out.evidence?.length} 条 | 修复: ${out.one_fix?.slice(0, 60)}`)
  samples.subjects[part] = { attemptId, feedbackId: fb.feedbackId, version: fb.version, model: fb.model, output: out, latencyMs: Date.now() - t0, structureOk: !!ok }
  save()
  return fb
}

// 1) 阅读：真实错答（r11 选 A——把预约日期当活动日期）
await verifySubject('reading', 'tg-reading-s01-email',
  { answers: { r11: 0, r12: 3 }, note: '我看到 September 10th 就选了，没细看问的是哪个事件。' }, '阅读（真实错答）')

// 2) 听力：真实错答（l9 选 B）
await verifySubject('listening', 'tg-listening-s01-conversation',
  { answers: { l9: 1, l10: 0 }, note: '对话有点快，tomorrow 那句没反应过来。' }, '听力（真实错答）')

// 3) 写作：真实第一稿
await verifySubject('writing', 'tg-writing-s01-email',
  {
    draft: 'Dear Editor,\n\nI uploaded my essay to your submission system last Friday, but the website shows a format error. I tried Chrome and Edge and it still does not work. Please check my file or tell me how to resubmit it.\n\nThank you,\nZhang Wei',
    note: '我觉得请求已经算清楚了，想知道还差什么。',
  }, '写作（真实第一稿）')

// 4) 口语：真实自录转写（模拟 user_typed；正式录音上传走浏览器）
await verifySubject('speaking', 'tg-speaking-s01-interview',
  {
    transcript: 'I prefer to study in the morning because my mind is fresh. For example, yesterday I reviewed vocabulary at 7 am and I remembered more words than at night.',
    transcriptOrigin: 'user_typed',
    note: null,
  }, '口语（自录转写）')

// 5) TTS：写作反馈合成语音（Qwen3-TTS，同 94581ac 凭据）
const wf = samples.subjects.writing
const ttsText = [wf.output.observation, ...wf.output.evidence ?? [], wf.output.one_fix].join('\n')
const t0 = Date.now()
const audio = await teacher.synthesizeFeedbackAudio(ttsText)
const bytes = (await import('node:fs')).statSync(audio.file).size
console.log(`✓ TTS: ${Date.now() - t0}ms ${bytes}B cached=${audio.cached}`)
samples.tts = { sha256: audio.sha256, bytes, latencyMs: Date.now() - t0, cached: audio.cached, textSample: ttsText.slice(0, 80) }
save()

// 完整性：错题本应有 2 条 first_wrong（阅读 r11/r12）+ listening 2 条
const errs = (await call(`/api/toefl/accounts/${id}/errors`)).json.errors
console.log('错题登记:', errs.map((e) => `${e.part}/${e.kind}`).join(', '))
samples.errorEntries = errs.map((e) => ({ part: e.part, kind: e.kind, tag: e.tag, status: e.status }))
save()

db.closeDb()
console.log('\n样本 → docs/curriculum-v4/toefl-ai-verify-sample.json')
