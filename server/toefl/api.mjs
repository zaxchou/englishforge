// 托福产品层路由（59 号 S1/S2）。挂进 server/api.mjs 的 ROUTES；
// 媒体 Range 分发不走 JSON 通道，由 apiMiddleware 先行调用 serveToeflMediaRaw。
//
// 诚实边界：
// · 封闭题核验答案/解析不随首做下发，提交后才随复盘返回（55 §11）；
// · 开放题提交=保存，反馈必须显式请求老师分析，失败可重试且不覆盖旧反馈；
// · 独立检查（timed_check）模式目前没有已核验的未见题池——目录里 newQuestionCheck 如实写
//   unavailable_no_verified_unseen_pool，不伪造"验证通过"。
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAccount } from '../db.mjs'
import { ApiError } from '../db.mjs'
import {
  ensureToeflSchema,
} from './db.mjs'
import {
  toeflCatalog, toeflTask, toeflChapter, publishedChapters, mediaEntry, mediaRoot,
  computeProgress, partName, toeflResources,
} from './content.mjs'
import { runTeacher, synthesizeFeedbackAudio, feedbackSpeechText } from './teacher.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ATTEMPT_AUDIO_DIR = resolve(HERE, '..', 'assets', 'toefl-attempts')
const FEEDBACK_AUDIO_DIR = resolve(HERE, '..', 'assets', 'toefl-tts')

const PARTS = ['listening', 'reading', 'writing', 'speaking']
const ERROR_STATUSES = ['pending_review', 'reviewed', 'awaiting_new_check', 'verified', 'disputed', 'analyze_failed']

function conn(accountId) {
  const db = ensureToeflSchema()
  if (!getAccount(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  return db
}
const j = (s) => { try { return JSON.parse(s || 'null') } catch { return null } }
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '')

function event(db, accountId, kind, payload = {}) {
  db.prepare('INSERT INTO toefl_events (account_id, kind, payload, created_at) VALUES (?,?,?,?)')
    .run(accountId, kind, JSON.stringify(payload), Date.now())
}

// ---- 首页聚合（57：聚合由事件和版本生成，一处口径） ----

function dashboard(accountId) {
  const db = conn(accountId)
  const attemptRows = db.prepare('SELECT * FROM toefl_attempts WHERE account_id = ?').all(accountId)
  const eventRows = db.prepare("SELECT kind, payload FROM toefl_events WHERE account_id = ? AND kind IN ('method_done','review_done')").all(accountId)
  const progress = computeProgress(db, accountId, { attemptRows, eventRows })
  const resume = db.prepare('SELECT * FROM toefl_resume WHERE account_id = ?').all(accountId)
    .reduce((m, r) => (m[r.part] = { chapterId: r.chapter_id, activity: r.activity, mediaId: r.media_id, lastPosition: r.last_position, updatedAt: r.updated_at }, m), {})
  const errorRows = db.prepare('SELECT * FROM toefl_errors WHERE account_id = ? ORDER BY created_at DESC').all(accountId)
  const errorsByStatus = errorRows.reduce((m, e) => (m[e.status] = (m[e.status] ?? 0) + 1, m), {})
  // 最近一次有反馈的分析（回溯到原作答；没有就不造）
  const latestFeedback = db.prepare(`
    SELECT f.*, a.task_id, a.part, a.attempt_id FROM toefl_feedback f
    JOIN toefl_attempts a ON a.attempt_id = f.attempt_id
    WHERE a.account_id = ? AND f.status = 'done'
    ORDER BY f.created_at DESC LIMIT 1`).get(accountId) ?? null
  const profile = getProfileRow(db, accountId)
  const eventsRecent = db.prepare('SELECT kind, payload, created_at FROM toefl_events WHERE account_id = ? ORDER BY id DESC LIMIT 8').all(accountId)
  return {
    progress,
    resume,
    errors: {
      total: errorRows.length,
      byStatus: errorsByStatus,
      recent: errorRows.slice(0, 3).map(errorRowPublic),
    },
    latestTeacherAnalysis: latestFeedback ? {
      feedbackId: latestFeedback.feedback_id,
      attemptId: latestFeedback.attempt_id,
      part: latestFeedback.part,
      taskId: latestFeedback.task_id,
      output: j(latestFeedback.output),
      version: latestFeedback.version,
      createdAt: latestFeedback.created_at,
    } : null,
    profile,
    recentEvents: eventsRecent.map((e) => ({ kind: e.kind, ...j(e.payload), at: e.created_at })),
    planNotice: '分母=当前目录版本已发布章的必需活动（方法/配套题/复盘各一）；不是能力分数，不是托福预测。',
  }
}

function getProfileRow(db, accountId) {
  const row = db.prepare('SELECT * FROM toefl_profile WHERE account_id = ?').get(accountId)
  return { fields: j(row?.fields) ?? {}, updatedAt: row?.updated_at ?? null }
}

function errorRowPublic(e) {
  return {
    errorId: e.error_id, part: e.part, partName: partName(e.part), chapterId: e.chapter_id, taskId: e.task_id,
    questionFamilyId: e.question_family_id, kind: e.kind, title: e.title, detail: e.detail,
    tag: e.tag, status: e.status, retries: e.retries, hypothesis: j(e.hypothesis),
    userResponse: e.user_response, createdAt: e.created_at, updatedAt: e.updated_at,
  }
}

// ---- 作答 ----

function submitAttempt(accountId, body) {
  const db = conn(accountId)
  const task = toeflTask(str(body.taskId, 100))
  const chapter = toeflChapter(task.chapterId)
  if (!chapter || chapter.publicationStatus !== 'published') throw new ApiError(409, 'TOEFL_CHAPTER_NOT_PUBLISHED')
  const idem = str(body.idempotencyKey, 100)
  if (!idem) throw new ApiError(400, '缺少 idempotencyKey（提交幂等）')

  const existing = db.prepare('SELECT * FROM toefl_attempts WHERE account_id = ? AND idempotency_key = ?').get(accountId, idem)
  const submit = body.submit === true
  if (existing) {
    // 幂等语义（55 §12：重复请求返回同记录）：
    // · 同键已提交 → 原样返回，不重复入库、不重复判分；
    // · 同键 saved → submit = 一次性升级为提交（自动保存后点提交的正常路径），仍同一条记录；
    // · 同键 saved → 再保存 = 更新草稿内容（自动保存），不新建
    if (submit && existing.status === 'saved') {
      const answers = task.kind === 'mc_group' ? sanitizeAnswers(body.answers) : null
      const draft = task.kind !== 'mc_group' ? str(body.draft, 20000) : null
      db.prepare(`UPDATE toefl_attempts SET status='submitted', answers=?, draft=?, draft_transcript=?, transcript_origin=?, submitted_at=? WHERE attempt_id=?`)
        .run(answers ? JSON.stringify(answers) : existing.answers, draft ?? existing.draft,
          str(body.transcript, 8000) || existing.draft_transcript,
          ['user_typed', 'asr'].includes(body.transcriptOrigin) ? body.transcriptOrigin : existing.transcript_origin,
          Date.now(), existing.attempt_id)
      event(db, accountId, 'submit', { attemptId: existing.attempt_id, taskId: task.taskId, part: task.part, mode: existing.mode })
      applyClosedGrading(db, accountId, task, { answers: answers ?? j(existing.answers), guessed: body.guessedQuestionIds })
      return { attempt: attemptPublic(db.prepare('SELECT * FROM toefl_attempts WHERE attempt_id = ?').get(existing.attempt_id)), replayed: false }
    }
    if (!submit && existing.status === 'saved') {
      const answers = task.kind === 'mc_group' ? sanitizeAnswers(body.answers) : null
      const draft = task.kind !== 'mc_group' ? str(body.draft, 20000) : null
      db.prepare('UPDATE toefl_attempts SET answers=?, draft=? WHERE attempt_id=?')
        .run(answers ? JSON.stringify(answers) : existing.answers, draft ?? existing.draft, existing.attempt_id)
      return { attempt: attemptPublic(db.prepare('SELECT * FROM toefl_attempts WHERE attempt_id = ?').get(existing.attempt_id)), replayed: false }
    }
    return { attempt: attemptPublic(existing), replayed: true }
  }

  const mode = ['course_first', 'retry', 'timed_check'].includes(body.mode) ? body.mode : 'course_first'
  if (mode === 'timed_check') throw new ApiError(409, 'TOEFL_NO_VERIFIED_UNSEEN_POOL: 独立限时检查还没有已核验的未见题池，样板题已曝光，不能当未见测试')
  const attemptId = 'ta_' + randomUUID().slice(0, 12)
  const answers = task.kind === 'mc_group' ? sanitizeAnswers(body.answers) : null
  const draft = task.kind !== 'mc_group' ? str(body.draft, 20000) : null
  db.prepare(`INSERT INTO toefl_attempts
    (attempt_id, account_id, idempotency_key, part, chapter_id, task_id, mode, status, answers, draft, draft_transcript, transcript_origin, created_at, submitted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(attemptId, accountId, idem, task.part, task.chapterId, task.taskId, mode,
      submit ? 'submitted' : 'saved',
      answers ? JSON.stringify(answers) : null, draft,
      str(body.transcript, 8000) || null,
      ['user_typed', 'asr'].includes(body.transcriptOrigin) ? body.transcriptOrigin : (body.transcript ? 'user_typed' : null),
      Date.now(), submit ? Date.now() : null)
  event(db, accountId, submit ? 'submit' : 'save', { attemptId, taskId: task.taskId, part: task.part, mode })
  if (submit) applyClosedGrading(db, accountId, task, { answers, guessed: body.guessedQuestionIds })
  const row = db.prepare('SELECT * FROM toefl_attempts WHERE attempt_id = ?').get(attemptId)
  return { attempt: attemptPublic(row), replayed: false }
}

function sanitizeAnswers(raw) {
  const out = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && k.length <= 40 && Number.isInteger(v) && v >= 0 && v < 8) out[k] = v
    }
  }
  return out
}

/** 封闭题判分 + 错题登记（56 §4：错误入错题本、错因先标假设；猜对可另记） */
function applyClosedGrading(db, accountId, task, { answers, guessed: guessedRaw }) {
  if (task.kind !== 'mc_group') return // 开放题没有核验答案，不判分（55 §11）
  const guessed = new Set(Array.isArray(guessedRaw) ? guessedRaw.filter((x) => typeof x === 'string') : [])
  for (const q of task.questions) {
    const chosen = answers?.[q.id]
    const isGuessed = guessed.has(q.id)
    if (chosen === undefined) continue
    if (chosen !== q.key) {
      upsertError(db, accountId, {
        familyId: q.familyId, part: task.part, chapterId: task.chapterId, taskId: task.taskId,
        kind: 'first_wrong', title: q.prompt, tag: q.tag,
        detail: `你的选择：${String.fromCharCode(65 + chosen)} · ${q.options[chosen]}`,
        firstAnswer: chosen, hypothesis: null,
      })
    } else if (isGuessed) {
      upsertError(db, accountId, {
        familyId: q.familyId, part: task.part, chapterId: task.chapterId, taskId: task.taskId,
        kind: 'guessed', title: q.prompt, tag: q.tag,
        detail: '选对但自报猜测/犹豫——按疑点记录，不当掌握。',
        firstAnswer: chosen, hypothesis: null,
      })
    }
  }
}

function upsertError(db, accountId, { familyId, part, chapterId, taskId, kind, title, detail, tag, firstAnswer, hypothesis }) {
  const existing = db.prepare('SELECT * FROM toefl_errors WHERE account_id = ? AND question_family_id = ?').get(accountId, familyId)
  if (existing) {
    db.prepare('UPDATE toefl_errors SET retries = retries + 1, updated_at = ? WHERE error_id = ?')
      .run(Date.now(), existing.error_id)
    return existing.error_id
  }
  const errorId = 'te_' + randomUUID().slice(0, 12)
  db.prepare(`INSERT INTO toefl_errors
    (error_id, account_id, question_family_id, part, chapter_id, task_id, kind, title, detail, first_answer, tag, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(errorId, accountId, familyId, part, chapterId, taskId, kind, title, detail,
      firstAnswer === null ? null : JSON.stringify(firstAnswer), tag, 'pending_review', Date.now(), Date.now())
  return errorId
}

function attemptPublic(a) {
  const task = toeflTask(a.task_id)
  const isClosed = task.kind === 'mc_group'
  return {
    attemptId: a.attempt_id, part: a.part, chapterId: a.chapter_id, taskId: a.task_id,
    mode: a.mode, status: a.status,
    answers: j(a.answers), draft: a.draft,
    audioAvailable: !!a.audio_media, transcript: a.draft_transcript, transcriptOrigin: a.transcript_origin,
    createdAt: a.created_at, submittedAt: a.submitted_at,
    task: {
      taskId: a.task_id, kind: task.kind, title: task.title,
      // 首做不下发答案与解析：提交后状态才带 results
      questions: isClosed ? task.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options })) : undefined,
      material: task.material,
      source: task.source,
    },
  }
}

/** 判分结果（提交后）：每题对错+原文引用+解析；开放题只回显已保存 */
function attemptResults(attempt) {
  const task = toeflTask(attempt.task_id)
  if (task.kind !== 'mc_group') {
    return { kind: 'open', saved: true, note: task.feedbackScale ?? '开放题：老师反馈是辅助意见，没有唯一答案。' }
  }
  const answers = j(attempt.answers) ?? {}
  return {
    kind: 'closed',
    results: task.questions.map((q) => ({
      questionId: q.id, prompt: q.prompt,
      chosen: answers[q.id] ?? null, chosenText: answers[q.id] != null ? q.options[answers[q.id]] : null,
      key: q.key, keyText: q.options[q.key], correct: answers[q.id] === q.key,
      quote: q.quote, why: q.why, tag: q.tag,
    })),
  }
}

// ---- 老师反馈（H3） ----

async function requestFeedback(accountId, attemptId, body) {
  const db = conn(accountId)
  const attempt = db.prepare('SELECT * FROM toefl_attempts WHERE attempt_id = ? AND account_id = ?').get(attemptId, accountId)
  if (!attempt) throw new ApiError(404, '作答不存在：' + attemptId)
  if (attempt.status === 'saved') throw new ApiError(409, 'TOEFL_ATTEMPT_NOT_SUBMITTED: 先提交作答，老师才有依据')
  const task = toeflTask(attempt.task_id)
  const note = str(body?.note, 2000) || null

  const prev = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM toefl_feedback WHERE attempt_id = ?').get(attemptId).v
  const version = prev + 1
  const feedbackId = 'tf_' + randomUUID().slice(0, 12)
  db.prepare('INSERT INTO toefl_feedback (feedback_id, attempt_id, version, status, created_at) VALUES (?,?,?,?,?)')
    .run(feedbackId, attemptId, version, 'pending', Date.now())
  db.prepare("UPDATE toefl_attempts SET status = 'analyzing' WHERE attempt_id = ?").run(attemptId)
  try {
    const output = await runTeacher({ task, attempt, errorsNote: note })
    db.prepare("UPDATE toefl_feedback SET status='done', model=?, output=? WHERE feedback_id=?")
      .run(output._meta?.model ?? 'server-llm', JSON.stringify(output), feedbackId)
    db.prepare("UPDATE toefl_attempts SET status = 'analyzed' WHERE attempt_id = ?").run(attemptId)
  } catch (err) {
    db.prepare("UPDATE toefl_feedback SET status='failed', error=? WHERE feedback_id=?")
      .run(String(err?.message ?? err).slice(0, 500), feedbackId)
    db.prepare("UPDATE toefl_attempts SET status = 'failed' WHERE attempt_id = ?").run(attemptId)
    // 失败不改作答、不生成假分析（55 §8）；错题留待人工或稍后重试
    throw new ApiError(502, 'TOEFL_FEEDBACK_FAILED: ' + String(err?.message ?? err))
  }
  const row = db.prepare('SELECT * FROM toefl_feedback WHERE feedback_id = ?').get(feedbackId)
  event(db, accountId, 'feedback', { attemptId, feedbackId, version })
  return { feedback: feedbackPublic(row), results: attemptResults(attempt) }
}

function feedbackPublic(f) {
  return {
    feedbackId: f.feedback_id, attemptId: f.attempt_id, version: f.version,
    status: f.status, model: f.model, output: j(f.output), error: f.error, createdAt: f.created_at,
  }
}

// ---- 媒体（Range 由 apiMiddleware 的 raw 分支处理；这里是 JSON 侧的登记） ----

function mediaProgress(accountId, body) {
  const db = conn(accountId)
  const mediaId = str(body.mediaId, 120)
  if (!mediaEntry(mediaId)) throw new ApiError(404, 'TOEFL_MEDIA_NOT_FOUND: ' + mediaId)
  const pos = Number(body.position)
  if (!Number.isFinite(pos) || pos < 0) throw new ApiError(400, 'position 无效')
  db.prepare(`INSERT INTO toefl_media_progress (account_id, media_id, last_position, speed, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(account_id, media_id) DO UPDATE SET last_position=excluded.last_position, speed=excluded.speed, updated_at=excluded.updated_at`)
    .run(accountId, mediaId, Math.min(pos, 86400 * 4), Number(body.speed) > 0 ? Number(body.speed) : 1, Date.now())
  if (Array.isArray(body.interval) && body.interval.length === 2) {
    const [s, e] = body.interval.map(Number)
    if (Number.isFinite(s) && Number.isFinite(e) && e > s && e - s <= 5) {
      // 只收 ≤5s 的正向小段（与原型同口径：拖动不算观看）
      db.prepare('INSERT INTO toefl_viewing (account_id, part, media_id, start_s, end_s, created_at) VALUES (?,?,?,?,?,?)')
        .run(accountId, str(body.part, 20) || 'x', mediaId, s, e, Date.now())
    }
  }
  return { ok: true }
}

function resume(accountId, body) {
  const db = conn(accountId)
  const part = str(body.part, 20)
  if (!PARTS.includes(part)) throw new ApiError(400, 'part 无效：' + part)
  const chapterId = str(body.chapterId, 100) || null
  if (chapterId && !toeflChapter(chapterId)) throw new ApiError(404, '章不存在：' + chapterId)
  db.prepare(`INSERT INTO toefl_resume (account_id, part, chapter_id, activity, media_id, last_position, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(account_id, part) DO UPDATE SET chapter_id=excluded.chapter_id, activity=excluded.activity,
      media_id=excluded.media_id, last_position=excluded.last_position, updated_at=excluded.updated_at`)
    .run(accountId, part, chapterId, str(body.activity, 20) || null, str(body.mediaId, 120) || null,
      Number(body.position) || 0, Date.now())
  event(db, accountId, 'resume', { part, chapterId, activity: body.activity ?? null, source: str(body.source, 40) || 'app' })
  return { ok: true }
}

// ---- 错题状态机（55 §9 / 57 错题状态机） ----
// pending_review → reviewed → awaiting_new_check → verified；verified 只能由新题验证达成

function errorStatus(accountId, errorId, body) {
  const db = conn(accountId)
  const row = db.prepare('SELECT * FROM toefl_errors WHERE error_id = ? AND account_id = ?').get(errorId, accountId)
  if (!row) throw new ApiError(404, '错题不存在：' + errorId)
  const next = str(body.status, 40)
  if (!ERROR_STATUSES.includes(next)) throw new ApiError(400, '未知状态：' + next)
  const allowed = {
    pending_review: ['reviewed', 'disputed', 'analyze_failed'],
    reviewed: ['awaiting_new_check', 'disputed'],
    awaiting_new_check: ['awaiting_new_check', 'verified', 'reviewed'],
    verified: [],
    disputed: ['pending_review', 'reviewed'],
    analyze_failed: ['pending_review', 'reviewed'],
  }
  if (!allowed[row.status]?.includes(next)) {
    throw new ApiError(409, `TOEFL_ERROR_STATE_ILLEGAL: ${row.status} → ${next} 不允许；verified 只能由新题检验达成`)
  }
  const hypothesis = body.hypothesis ? JSON.stringify({ statement: str(body.hypothesis.statement ?? '', 500), confidence: str(body.hypothesis.confidence ?? 'low', 10) }) : row.hypothesis
  db.prepare('UPDATE toefl_errors SET status=?, hypothesis=?, user_response=?, updated_at=? WHERE error_id=?')
    .run(next, hypothesis, ['confirmed', 'disputed'].includes(body.userResponse) ? body.userResponse : row.user_response, Date.now(), errorId)
  if (next === 'verified') {
    db.prepare('INSERT INTO toefl_verifications (account_id, error_id, result, detail, created_at) VALUES (?,?,?,?,?)')
      .run(accountId, errorId, 'passed', str(body.detail, 500) || '新题验证通过', Date.now())
  }
  event(db, accountId, 'error_status', { errorId, from: row.status, to: next })
  return { error: errorRowPublic(db.prepare('SELECT * FROM toefl_errors WHERE error_id = ?').get(errorId)) }
}

// ---- 口语录音（对齐 v3oral：字节落 server/assets/toefl-attempts/，可回放可取回） ----

function saveAttemptAudio(accountId, attemptId, buf) {
  const db = conn(accountId)
  const attempt = db.prepare('SELECT * FROM toefl_attempts WHERE attempt_id = ? AND account_id = ?').get(attemptId, accountId)
  if (!attempt) throw new ApiError(404, '作答不存在：' + attemptId)
  if (!buf?.length) throw new ApiError(400, '空录音')
  if (buf.length > 12 * 1024 * 1024) throw new ApiError(413, '录音过大（>12MB）')
  const name = `${attemptId}_${Date.now()}.webm`
  mkdirSync(ATTEMPT_AUDIO_DIR, { recursive: true })
  writeFileSync(join(ATTEMPT_AUDIO_DIR, name), buf)
  db.prepare('UPDATE toefl_attempts SET audio_media = ? WHERE attempt_id = ?').run(name, attemptId)
  return { ok: true, audioAvailable: true }
}

function readAttemptAudio(attemptId) {
  const db = ensureToeflSchema()
  const a = db.prepare('SELECT * FROM toefl_attempts WHERE attempt_id = ?').get(attemptId)
  if (!a?.audio_media) throw new ApiError(404, 'TOEFL_AUDIO_NOT_FOUND')
  const p = join(ATTEMPT_AUDIO_DIR, a.audio_media)
  if (!existsSync(p)) throw new ApiError(404, 'TOEFL_AUDIO_FILE_MISSING')
  return { buf: readFileSync(p), mime: 'audio/webm' }
}

/** 反馈朗读音频（文字反馈已落库才允许合成） */
async function feedbackTTS(accountId, feedbackId) {
  const db = conn(accountId)
  const f = db.prepare(`SELECT f.* FROM toefl_feedback f JOIN toefl_attempts a ON a.attempt_id = f.attempt_id
    WHERE f.feedback_id = ? AND a.account_id = ?`).get(feedbackId, accountId)
  if (!f) throw new ApiError(404, '反馈不存在：' + feedbackId)
  if (f.status !== 'done' || !f.output) throw new ApiError(409, 'TOEFL_FEEDBACK_NOT_READY: 文字反馈完成后才合成语音')
  const text = feedbackSpeechText(f.output)
  const { file, sha256 } = await synthesizeFeedbackAudio(text)
  return { ok: true, audioUrl: `/api/toefl/feedback-audio/${sha256}`, feedbackId, version: f.version }
}

function readFeedbackAudio(sha) {
  if (!/^[0-9a-f]{16,64}$/.test(sha)) throw new ApiError(400, '坏哈希')
  const p = join(FEEDBACK_AUDIO_DIR, `${sha}.wav`)
  if (!existsSync(p)) throw new ApiError(404, 'TOEFL_TTS_NOT_FOUND')
  return { buf: readFileSync(p), mime: 'audio/wav' }
}

// ---- 媒体 raw 分发（Range；只按白名单 ID，绝不拼路径） ----

export function serveToeflFile(req, res, pathname) {
  try {
    if (pathname.startsWith('/api/toefl/media/')) {
      const mediaId = decodeURIComponent(pathname.slice('/api/toefl/media/'.length))
      const entry = mediaEntry(mediaId)
      if (!entry) return plain(res, 404, 'TOEFL_MEDIA_NOT_FOUND')
      const file = join(mediaRoot(entry), entry.file)
      if (!existsSync(file)) return plain(res, 404, 'TOEFL_MEDIA_FILE_MISSING: 教材文件不在本机（TOEFL_NOTES_ROOT 未配置或未同步）')
      return streamFile(res, req, file, entry.mime)
    }
    if (pathname.startsWith('/api/toefl/feedback-audio/')) {
      const out = readFeedbackAudio(decodeURIComponent(pathname.slice('/api/toefl/feedback-audio/'.length)))
      return streamBuffer(res, req, out.buf, out.mime)
    }
    return false
  } catch (err) {
    return plain(res, err.status ?? 500, String(err?.message ?? err))
  }
}

function streamFile(res, req, file, mime) {
  const size = statSync(file).size
  const range = req.headers.range
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    const start = m?.[1] ? parseInt(m[1]) : 0
    let end = m?.[2] ? parseInt(m[2]) : size - 1
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.statusCode = 416; res.setHeader('content-range', `bytes */${size}`); res.end(); return true
    }
    end = Math.min(end, size - 1)
    res.statusCode = 206
    res.setHeader('content-type', mime)
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
    res.setHeader('accept-ranges', 'bytes')
    res.setHeader('content-length', end - start + 1)
    if (req.method === 'HEAD') { res.end(); return true }
    createReadStream(file, { start, end }).pipe(res)
    return true
  }
  res.statusCode = 200
  res.setHeader('content-type', mime)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('content-length', size)
  if (req.method === 'HEAD') { res.end(); return true }
  createReadStream(file).pipe(res)
  return true
}
function streamBuffer(res, req, buf, mime) {
  res.statusCode = 200
  res.setHeader('content-type', mime)
  res.setHeader('content-length', buf.length)
  res.setHeader('accept-ranges', 'none')
  res.end(req.method === 'HEAD' ? undefined : buf)
  return true
}
function plain(res, status, msg) {
  if (!res) return status
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: msg }))
  return true
}

// ---- 章节状态 ----

function chapterState(accountId, chapterId) {
  const db = conn(accountId)
  const chapter = toeflChapter(chapterId)
  if (!chapter) throw new ApiError(404, '章不存在：' + chapterId)
  const attemptRows = db.prepare('SELECT * FROM toefl_attempts WHERE account_id = ? AND chapter_id = ? ORDER BY created_at').all(accountId, chapterId)
  const eventRows = db.prepare("SELECT kind, payload FROM toefl_events WHERE account_id = ? AND kind IN ('method_done','review_done')").all(accountId)
  const methodDone = eventRows.some((e) => e.kind === 'method_done' && j(e.payload).chapterId === chapterId)
  const reviewDone = eventRows.some((e) => e.kind === 'review_done' && j(e.payload).chapterId === chapterId)
  const note = db.prepare('SELECT body FROM toefl_notes WHERE account_id = ? AND chapter_id = ?').get(accountId, chapterId)?.body ?? ''
  const latestAttempts = {}
  for (const a of attemptRows) latestAttempts[a.task_id] = a
  const feedbacks = {}
  for (const a of attemptRows) {
    const f = db.prepare("SELECT * FROM toefl_feedback WHERE attempt_id = ? AND status='done' ORDER BY version DESC LIMIT 1").get(a.attempt_id)
    if (f) feedbacks[a.task_id] = feedbackPublic(f)
  }
  const task = toeflTask(chapter.practiceTaskId)
  return {
    chapter: { ...chapter, partName: partName(chapter.part) },
    taskDef: {
      taskId: chapter.practiceTaskId, kind: task.kind, title: task.title,
      material: task.material, source: task.source,
      // 首做不下发核验答案（55 §11）
      questions: task.kind === 'mc_group' ? task.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options })) : undefined,
    },
    activities: {
      method: { done: methodDone },
      practice: { done: !!latestAttempts[chapter.practiceTaskId]?.submitted_at, taskId: chapter.practiceTaskId },
      review: { done: reviewDone },
    },
    attempts: attemptRows.map(attemptPublic),
    latestAttempt: attemptRows.at(-1) ? attemptPublic(attemptRows.at(-1)) : null,
    results: attemptRows.at(-1) && attemptRows.at(-1).submitted_at ? attemptResults(attemptRows.at(-1)) : null,
    feedbacks,
    note,
    newQuestionCheck: chapter.newQuestionCheck,
  }
}

// ---- 路由表 ----

export const TOEFL_ROUTES = [
  ['GET', '/api/toefl/catalog', () => {
    const c = toeflCatalog()
    return { ...c, partNames: Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, v.name])), resources: toeflResources() }
  }],

  ['GET', '/api/toefl/accounts/:id/dashboard', (ctx) => dashboard(ctx.params.id)],
  ['GET', '/api/toefl/accounts/:id/chapter/:chapterId', (ctx) => chapterState(ctx.params.id, ctx.params.chapterId)],

  ['GET', '/api/toefl/accounts/:id/profile', (ctx) => ({ profile: getProfileRow(conn(ctx.params.id), ctx.params.id) })],
  ['PUT', '/api/toefl/accounts/:id/profile', (ctx) => {
    const db = conn(ctx.params.id)
    const fields = ctx.body?.fields
    if (!fields || typeof fields !== 'object') throw new ApiError(400, 'fields 必须是对象')
    db.prepare(`INSERT INTO toefl_profile (account_id, fields, updated_at) VALUES (?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET fields=excluded.fields, updated_at=excluded.updated_at`)
      .run(ctx.params.id, JSON.stringify(fields), Date.now())
    event(db, ctx.params.id, 'profile_update', {})
    return { profile: getProfileRow(db, ctx.params.id) }
  }],

  ['POST', '/api/toefl/accounts/:id/attempts', (ctx) => submitAttempt(ctx.params.id, ctx.body ?? {})],
  ['GET', '/api/toefl/accounts/:id/attempts/:attemptId', (ctx) => {
    const db = conn(ctx.params.id)
    const a = db.prepare('SELECT * FROM toefl_attempts WHERE attempt_id = ? AND account_id = ?').get(ctx.params.attemptId, ctx.params.id)
    if (!a) throw new ApiError(404, '作答不存在')
    return { attempt: attemptPublic(a), results: a.submitted_at ? attemptResults(a) : null }
  }],
  ['POST', '/api/toefl/accounts/:id/attempts/:attemptId/support', (ctx) => {
    const db = conn(ctx.params.id)
    const kinds = ['replay', 'dictionary', 'hint', 'transcript_shown']
    if (!kinds.includes(ctx.body?.kind)) throw new ApiError(400, '未知支持类型')
    const a = db.prepare('SELECT attempt_id FROM toefl_attempts WHERE attempt_id = ? AND account_id = ?').get(ctx.params.attemptId, ctx.params.id)
    if (!a) throw new ApiError(404, '作答不存在')
    db.prepare('INSERT INTO toefl_support_events (account_id, attempt_id, kind, at) VALUES (?,?,?,?)')
      .run(ctx.params.id, ctx.params.attemptId, ctx.body.kind, Date.now())
    return { ok: true }
  }],
  ['POST', '/api/toefl/accounts/:id/attempts/:attemptId/feedback', async (ctx) => requestFeedback(ctx.params.id, ctx.params.attemptId, ctx.body ?? {})],
  ['POST', '/api/toefl/accounts/:id/feedback/:feedbackId/tts', async (ctx) => feedbackTTS(ctx.params.id, ctx.params.feedbackId)],

  ['POST', '/api/toefl/accounts/:id/resume', (ctx) => resume(ctx.params.id, ctx.body ?? {})],
  ['POST', '/api/toefl/accounts/:id/media-progress', (ctx) => mediaProgress(ctx.params.id, ctx.body ?? {})],

  ['GET', '/api/toefl/accounts/:id/errors', (ctx) => {
    const rows = conn(ctx.params.id).prepare('SELECT * FROM toefl_errors WHERE account_id = ? ORDER BY created_at DESC').all(ctx.params.id)
    return { errors: rows.map(errorRowPublic) }
  }],
  ['POST', '/api/toefl/accounts/:id/errors', (ctx) => {
    const db = conn(ctx.params.id)
    const b = ctx.body ?? {}
    const kind = ['self_noted', 'guessed'].includes(b.kind) ? b.kind : 'self_noted'
    const errorId = upsertError(db, ctx.params.id, {
      familyId: str(b.questionFamilyId, 120) || 'self_' + randomUUID().slice(0, 8),
      part: PARTS.includes(b.part) ? b.part : 'reading',
      chapterId: str(b.chapterId, 100) || null, taskId: str(b.taskId, 100) || null,
      kind, title: str(b.title, 300) || '主动记录的疑点', detail: str(b.detail, 2000), tag: str(b.tag, 40) || '待归类',
      firstAnswer: null, hypothesis: null,
    })
    event(db, ctx.params.id, 'self_note', { errorId })
    return { error: errorRowPublic(db.prepare('SELECT * FROM toefl_errors WHERE error_id = ?').get(errorId)) }
  }],
  ['POST', '/api/toefl/accounts/:id/errors/:errorId/status', (ctx) => errorStatus(ctx.params.id, ctx.params.errorId, ctx.body ?? {})],

  ['POST', '/api/toefl/accounts/:id/notes', (ctx) => {
    const db = conn(ctx.params.id)
    const chapterId = str(ctx.body?.chapterId, 100)
    if (!toeflChapter(chapterId)) throw new ApiError(404, '章不存在')
    db.prepare(`INSERT INTO toefl_notes (account_id, chapter_id, body, created_at, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(account_id, chapter_id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`)
      .run(ctx.params.id, chapterId, str(ctx.body?.body, 8000), Date.now(), Date.now())
    return { ok: true }
  }],

  ['POST', '/api/toefl/accounts/:id/events', (ctx) => {
    const db = conn(ctx.params.id)
    const kinds = ['method_done', 'review_done']
    const kind = ctx.body?.kind
    if (!kinds.includes(kind)) throw new ApiError(400, '未知活动事件')
    const chapterId = str(ctx.body?.chapterId, 100)
    const chapter = toeflChapter(chapterId)
    if (!chapter || chapter.publicationStatus !== 'published') throw new ApiError(404, '章不存在或未发布')
    event(db, ctx.params.id, kind, { chapterId, path: str(ctx.body?.path, 20) || null })
    return { ok: true }
  }],
]
