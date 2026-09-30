// W5：口语与真实材料（docs/curriculum-v4/15 §8 /oral 合同、13 §6、16 §4）。
//
// 铁律：
// · 录音由用户明确触发；数据库只存引用（路径/时长/校验和），音频文件存仓库外
//   data/oral/<account>/（gitignored），读取校验账户范围；
// · 上传受大小/类型/时长/一次性票据约束（具体数值冻结前为开发初值）；
// · 机器评分（词表匹配式关系检查）只作练习建议并标低置信；口语证据在真人复核前
//   不升级状态（recomputeStates 的 oralDeferred 规则）——人审签署的 oral_reviews
//   才追加可升级的 observed 事件；
// · ASR 转写低置信 → 争议（不降级）；用户可改转写，原版保留（media_assets.transcript_versions）；
// · 真实素材（YouTube 等）：license 未确认 / 不可播放 → MEDIA_UNAVAILABLE，不得进入
//   掌握认证（A7）。YouTube Digest 复用是候选工程，未验证授权前不接（16 §2）。
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError } from './db.mjs'
import { ensureV3Schema } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { recordAttempt, recomputeStates, activityById } from './v3evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ORAL_ROOT = resolve(HERE, '..', 'data', 'oral') // 仓库外：data/ 被 gitignore

// 开发初值；真实设备试产后冻结（15 §8）。上传上限 10MB / 120 秒 / 配额每日 50 条。
const LIMITS = { maxBytes: 10 * 1024 * 1024, maxDurationMs: 120_000, dailyQuota: 50 }
const ALLOWED_MIME = ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg']

// ---------------------------------------------------------------- 上传意图 → 一次性票据

export function createOralIntent(accountId, { activityId, mime, bytes, durationMs } = {}) {
  requireAccount(accountId)
  if (!ALLOWED_MIME.includes(mime)) throw new ApiError(400, 'MEDIA_TYPE_REJECTED: ' + mime)
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > LIMITS.maxBytes) throw new ApiError(400, 'MEDIA_TOO_LARGE')
  if (Number.isFinite(durationMs) && durationMs > LIMITS.maxDurationMs) throw new ApiError(400, 'MEDIA_TOO_LONG')
  const conn = ensureV3Schema()
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  const today = conn.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE account_id = ? AND created_at >= ?')
    .get(accountId, dayStart.getTime()).n
  if (today >= LIMITS.dailyQuota) throw new ApiError(429, 'DAILY_QUOTA_EXCEEDED')
  const mediaId = `m_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
  const token = 'up_' + randomBytes(16).toString('hex')
  conn.prepare(
    `INSERT INTO media_assets (media_id, account_id, kind, mime, bytes, duration_ms, upload_token, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(mediaId, accountId, 'oral_recording', mime, bytes, durationMs ?? null, token, Date.now())
  return { mediaId, uploadUrl: `/api/v1/accounts/${accountId}/oral/${mediaId}`, token, expiresInMs: 10 * 60 * 1000, limits: LIMITS }
}

/** PUT 录音字节：一次性票据（10 分钟过期）；落盘仓库外 + 校验和。开发初值：落盘即 playable=1（真实设备试产后加入最小字节校验与真实时长检测） */
export function storeOralAudio(accountId, mediaId, token, buf) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const row = conn.prepare('SELECT * FROM media_assets WHERE media_id = ? AND account_id = ?').get(mediaId, accountId)
  if (!row || row.kind !== 'oral_recording') throw new ApiError(404, 'MEDIA_NOT_FOUND: ' + mediaId)
  if (!row.upload_token || row.upload_token !== token) throw new ApiError(403, 'UPLOAD_TOKEN_INVALID')
  if (Date.now() - row.created_at > 10 * 60 * 1000) throw new ApiError(403, 'UPLOAD_TOKEN_EXPIRED')
  if (!buf?.length) throw new ApiError(400, 'EMPTY_UPLOAD')
  if (buf.length > LIMITS.maxBytes) throw new ApiError(400, 'MEDIA_TOO_LARGE')
  const dir = join(ORAL_ROOT, accountId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, mediaId + '.' + String(row.mime || 'audio/webm').split('/')[1].split(';')[0])
  writeFileSync(path, buf)
  conn.prepare(
    `UPDATE media_assets SET upload_token = NULL, storage_path = ?, sha256 = ?, playable = 1 WHERE media_id = ?`,
  ).run(path, createHash('sha256').update(buf).digest('hex'), mediaId)
  return { mediaId, playable: true, bytes: buf.length, sha256: conn.prepare('SELECT sha256 FROM media_assets WHERE media_id = ?').get(mediaId).sha256 }
}

/**
 * 录音保留与删除规格（15 §4 / 13 §6 的「语音实现前确定」，开发期口径）：
 * · 归属：录音只属上传账户，DELETE /oral/:mediaId 随时物理删除（DB 行 + 文件）；
 * · 保留期：开发期无自动过期，保留至用户删除；多人版前必须给出可见的保留期设置；
 * · 导出：回放接口即导出（所有者可取回原字节）；未来接真实 ASR/云服务前，须先公告
 *   第三方传输范围并征得同意。
 */
export function deleteOralAudio(accountId, mediaId) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const row = conn.prepare('SELECT * FROM media_assets WHERE media_id = ? AND account_id = ?').get(mediaId, accountId)
  if (!row) throw new ApiError(404, 'MEDIA_NOT_FOUND: ' + mediaId)
  if (row.storage_path && existsSync(row.storage_path)) {
    try { unlinkSync(row.storage_path) } catch { /* 文件已不在：照删记录 */ }
  }
  conn.prepare('DELETE FROM media_assets WHERE media_id = ? AND account_id = ?').run(mediaId, accountId)
  return { deleted: true, mediaId }
}

/** GET 音频回放：只限资产所有者 */
export function readOralAudio(accountId, mediaId) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const row = conn.prepare('SELECT * FROM media_assets WHERE media_id = ? AND account_id = ?').get(mediaId, accountId)
  if (!row || !row.storage_path || !existsSync(row.storage_path)) throw new ApiError(404, 'MEDIA_UNAVAILABLE: ' + mediaId)
  return { buf: readFileSync(row.storage_path), mime: row.mime, bytes: statSync(row.storage_path).size }
}

// ---------------------------------------------------------------- 口语作答（机器建议 + 转写复核）

/**
 * 口语作答：先按 /oral 合同上传音频，再走 attempts（response.kind='audio_ref'）。
 * 机器评估只给练习建议（confidence=low，永不升级口语状态）；转写低置信 → 争议。
 */
export function submitOralAttempt(accountId, payload = {}) {
  const conn = ensureV3Schema()
  const mediaId = String(payload.mediaId || '')
  const media = conn.prepare('SELECT * FROM media_assets WHERE media_id = ? AND account_id = ?').get(mediaId, accountId)
  if (!media || !media.playable) throw new ApiError(404, 'MEDIA_UNAVAILABLE: ' + mediaId)
  const transcript = String(payload.transcript ?? '').slice(0, 4000)
  // 转写版本 0 = ASR 原稿；用户修改另起新版本，原版保留
  const versions = JSON.parse(media.transcript_versions || '[]')
  const origin = ['asr', 'user_typed'].includes(payload.transcriptOrigin) ? payload.transcriptOrigin : 'user_typed'
  versions.push({ text: transcript, origin, at: Date.now() })
  conn.prepare('UPDATE media_assets SET transcript_versions = ?, attempt_id = COALESCE(attempt_id, ?) WHERE media_id = ?')
    .run(JSON.stringify(versions), payload.attemptId ?? null, mediaId)

  const result = recordAttempt(accountId, {
    ...payload,
    response: { kind: 'audio_ref', text: transcript, mediaId },
    conditions: { ...(payload.conditions ?? {}), responseMode: 'oral_recording' },
  })
  // 低置信转写：证据层已标争议；机器建议照给，但明确"不用于认证"
  return {
    ...result,
    mediaId,
    transcriptVersions: versions.map((v, i) => ({ version: i, origin: v.origin, text: v.text })),
    machineFeedback: result.evaluationStatus === 'evaluated'
      ? { note: '机器关系检查只是练习建议（低置信），不用于口语认证；真人复核后才计入证据', relations: result.dimensions ?? null }
      : null,
  }
}

/** 用户纠正转写：追加新版本，原版保留（16 §4：修正转写时保留原版） */
export function correctTranscript(accountId, mediaId, text, { origin = 'user_corrected' } = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const media = conn.prepare('SELECT * FROM media_assets WHERE media_id = ? AND account_id = ?').get(mediaId, accountId)
  if (!media) throw new ApiError(404, 'MEDIA_NOT_FOUND: ' + mediaId)
  const versions = JSON.parse(media.transcript_versions || '[]')
  if (!versions.length) throw new ApiError(400, 'NO_TRANSCRIPT_TO_CORRECT')
  versions.push({ text: String(text).slice(0, 4000), origin, at: Date.now() })
  conn.prepare('UPDATE media_assets SET transcript_versions = ? WHERE media_id = ?').run(JSON.stringify(versions), mediaId)
  return { mediaId, versions: versions.map((v, i) => ({ version: i, origin: v.origin, text: v.text })) }
}

// ---------------------------------------------------------------- 人审（唯一能升级口语状态的通道）

/**
 * 人审签署（F5 硬门）：
 * · 必须绑定真实录音：media 属于该账户、playable、且 attempt 的 response 是 audio_ref 并指向该 media；
 * · attempt 的活动必须是口语任务（oralEvidenceDeferred）；阅读活动永不被口语签署升级；
 * · 内容与任务完成是门槛：「信息与关系」<2 则整体不通过（发音清晰不能覆盖内容错误）；
 * · 只为人审**实际评定**的目标写证据（objectiveResults.met 才升级），机器评估史保留。
 */
export function signOralReview(accountId, { attemptId, mediaId, dimensions, objectiveResults = {}, evidenceRefs = [], evaluator, machineEval = null, disagreement = null, note } = {}) {
  requireAccount(accountId)
  if (!evaluator) throw new ApiError(400, 'SIGN_NEEDS_REVIEWER')
  const dimVals = Object.values(dimensions ?? {}).filter((v) => typeof v === 'number' && v >= 0 && v <= 3)
  if (!dimVals.length) throw new ApiError(400, 'REVIEW_NEEDS_DIMENSIONS: 至少一个 0–3 维度分')
  if (!attemptId || !mediaId) throw new ApiError(400, 'SIGN_NEEDS_ATTEMPT_AND_MEDIA: 口语签署必须绑定具体录音与作答')
  const conn = ensureV3Schema()
  const media = conn.prepare('SELECT * FROM media_assets WHERE media_id = ? AND account_id = ?').get(mediaId, accountId)
  if (!media || !media.playable) throw new ApiError(404, 'MEDIA_UNAVAILABLE: 无可播放录音，不能签署口语')
  const attempt = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)
  if (!attempt) throw new ApiError(404, 'ATTEMPT_NOT_FOUND: ' + attemptId)
  if (media.attempt_id !== attemptId) throw new ApiError(400, 'MEDIA_ATTEMPT_MISMATCH: 录音与作答不绑定')
  const resp = JSON.parse(attempt.response || '{}')
  if (resp.kind !== 'audio_ref' || resp.mediaId !== mediaId) throw new ApiError(400, 'ATTEMPT_NOT_ORAL: 该作答没有真实录音（文字练习不能被口语签署认证）')
  const act = activityById(attempt.activity_id)
  if (!act?.oralEvidenceDeferred) throw new ApiError(400, 'ACTIVITY_NOT_ORAL_TASK: 该活动不是口语任务')
  // 内容门：信息与关系（或内容与任务）必须 ≥2
  const contentKey = Object.keys(dimensions).find((k) => k.includes('信息') || k.includes('内容'))
  const contentScore = contentKey ? dimensions[contentKey] : null
  if (contentScore === null || contentScore < 2) {
    return { signed: false, reason: 'CONTENT_GATE: 内容/任务完成维度未达 2，不产生能力证据（发音清晰不能覆盖内容错误）；可给练习性反馈后重录' }
  }
  // 只为人审实际评定为 met 的目标写证据（21 §5：实际测到的项才可计）
  const toCertify = Object.entries(objectiveResults).filter(([, v]) => v === 'met').map(([k]) => k)
  const overall = dimVals.filter((v) => v >= 2).length >= 2
  const reviewId = `or_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
  conn.prepare(
    `INSERT INTO oral_reviews (review_id, account_id, attempt_id, media_id, transcript_version, dimensions,
       evidence_refs, evaluator, machine_eval, disagreement, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    reviewId, accountId, attemptId, mediaId,
    JSON.parse(media.transcript_versions || '[]').length - 1,
    JSON.stringify(dimensions), JSON.stringify(evidenceRefs), String(evaluator).slice(0, 100),
    machineEval ? JSON.stringify(machineEval) : null, disagreement ? JSON.stringify(disagreement) : null,
    String(note || '').slice(0, 500), Date.now(),
  )
  if (toCertify.length) {
    const cond = JSON.parse(attempt.conditions || '{}')
    const condition = cond.firstExposure && !(cond.hintLevel > 0) ? 'first_independent' : 'supported'
    for (const oid of toCertify) {
      if (!act.objectiveIds.includes(oid)) throw new ApiError(400, 'OBJECTIVE_NOT_IN_ACTIVITY: ' + oid)
      conn.prepare(
        `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
           kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'dispute_cleared','human_review',NULL,?,?)`)
        .run(accountId, `ev_clear_${reviewId}_${oid}`, attemptId, oid,
          activitySkill(attempt.activity_id, oid), 'base', JSON.stringify({ humanReviewId: reviewId }), Date.now())
      conn.prepare(
        `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
           kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'observed',?,?,?,?)`)
        .run(accountId, `ev_human_${reviewId}_${oid}`, attemptId, oid,
          activitySkill(attempt.activity_id, oid), 'base', condition, overall ? 1 : 0,
          JSON.stringify({ role: attempt.role, taskFamilyId: attempt.task_family_id, evaluator: 'human', humanReviewId: reviewId }), Date.now())
    }
    recomputeStates(accountId)
  }
  return { reviewId, signed: true, certifiedObjectives: toCertify,
    note: '开发期签署者为自报身份；多人版前须接入身份鉴权（15 §4 边界）' }
}

function activitySkill(activityId, objectiveId) {
  // F5：静态与生成活动统一查技能（此前生成查到了、静态默认成 speaking）
  return activityById(activityId)?.skillByObjective?.[objectiveId] ?? 'speaking'
}

/** 课包素材可用性检查（A7：不可播/无授权 → 不可用于认证，给可理解的替代状态） */
export function mediaUsableForCertification(mediaId) {
  const row = ensureV3Schema().prepare('SELECT * FROM media_assets WHERE media_id = ?').get(mediaId)
  if (!row) return { usable: false, reason: 'MEDIA_UNAVAILABLE' }
  // 学习者自己的录音：可播放即可用（无第三方授权问题）；真实/课程素材：授权+可播放缺一不可
  if (row.kind === 'oral_recording') return row.playable ? { usable: true } : { usable: false, reason: 'NOT_PLAYABLE' }
  if (row.license_status !== 'confirmed') return { usable: false, reason: 'LICENSE_UNCONFIRMED' }
  if (!row.playable) return { usable: false, reason: 'NOT_PLAYABLE' }
  return { usable: true }
}

