import { getLesson } from './v3lessons.mjs'
// Server-issued activity identity. Old attempts stay readable; new media evidence is task-scoped.
import { randomUUID, createHash } from 'node:crypto'
import { ApiError } from './db.mjs'
import { ensureV3Schema, ensureV3Columns } from './v3db.mjs'
import { activityById } from './v3evidence.mjs'
import { readLessonAudio } from './v3audio.mjs'

function db() {
  const c = ensureV3Schema()
  c.exec(`CREATE TABLE IF NOT EXISTS issued_tasks (
    task_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    activity_id TEXT NOT NULL, activity_version INTEGER NOT NULL, session_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_media_deliveries (
    delivery_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES issued_tasks(task_id),
    media_id TEXT NOT NULL, media_version INTEGER NOT NULL, sha256 TEXT NOT NULL, delivered_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_play_events (
    task_id TEXT NOT NULL REFERENCES issued_tasks(task_id), event_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(task_id,event_id));`)
  ensureV3Columns(c, 'issued_tasks', [['trial_id','TEXT'],['trial_phase','TEXT'],['definition_hash','TEXT'],['lesson_id','TEXT'],['lesson_version','INTEGER'],['context_key','TEXT'],['definition_snapshot','TEXT']])
  return c
}
export function issueTask(accountId, activityId, sessionId = '', trial = null, lesson = null) {
  const act = activityById(activityId)
  if (!act) throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED')
  const scoped = db().prepare('SELECT j.account_id FROM generated_activities a JOIN generation_jobs j ON j.job_id=a.job_id WHERE a.activity_id=?').get(activityId)
  if (scoped && scoped.account_id !== accountId) throw new ApiError(404,'ACTIVITY_NOT_PUBLISHED')
  const contextKey = lesson?.sessionKey ?? ''
  const definitionHash = createHash('sha256').update(JSON.stringify(act)).digest('hex')
  const c = db(), now = Date.now(), taskId = randomUUID()
  const prior = c.prepare("SELECT * FROM issued_tasks WHERE account_id=? AND activity_id=? AND activity_version=? AND session_id=? AND COALESCE(trial_id,'')=? AND COALESCE(trial_phase,'')=? AND COALESCE(lesson_id,'')=? AND COALESCE(context_key,'')=? AND COALESCE(lesson_version,0)=? AND definition_hash=? AND expires_at>? ORDER BY issued_at DESC LIMIT 1").get(accountId,activityId,act.version,sessionId,trial?.trialId ?? '',trial?.phase ?? '',lesson?.lessonId ?? '',contextKey,lesson?.version ?? 0,definitionHash,now)
  if (prior) return taskView(prior)
  c.prepare('INSERT INTO issued_tasks (task_id,account_id,activity_id,activity_version,session_id,issued_at,expires_at,trial_id,trial_phase,definition_hash,lesson_id,lesson_version,context_key,definition_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(taskId,accountId,activityId,act.version,sessionId,now,now+86400000,trial?.trialId ?? null,trial?.phase ?? null,definitionHash,lesson?.lessonId ?? null,lesson?.version ?? null,contextKey,JSON.stringify(act))
  return taskView(c.prepare('SELECT * FROM issued_tasks WHERE task_id=?').get(taskId))
}
function taskView(task) {
  const attempts = db().prepare('SELECT attempt_id FROM learner_attempts_v3 WHERE account_id=? AND issued_task_id=?').all(task.account_id,task.task_id)
  const nextTake = Math.max(attempts.length,...attempts.map(a=>Number(a.attempt_id.match(/-t(\d+)$/)?.[1] ?? 1))) + 1
  return {taskId:task.task_id,activityId:task.activity_id,activityVersion:task.activity_version,sessionId:task.session_id,issuedAt:task.issued_at,expiresAt:task.expires_at,nextTake}
}
export function requireTask(accountId, taskId, activityId = null) {
  if (typeof taskId !== 'string' || !taskId) throw new ApiError(400,'ISSUED_TASK_REQUIRED')
  const task = db().prepare('SELECT * FROM issued_tasks WHERE task_id=? AND account_id=?').get(taskId,accountId)
  if (!task) throw new ApiError(400, 'ISSUED_TASK_REQUIRED')
  if (task.expires_at <= Date.now()) throw new ApiError(409, 'ISSUED_TASK_EXPIRED')
  const act = activityById(task.activity_id)
  if (!act || act.version !== task.activity_version) throw new ApiError(409, 'ISSUED_TASK_VERSION_CHANGED')
  if (task.definition_hash !== createHash('sha256').update(JSON.stringify(act)).digest('hex')) throw new ApiError(409,'ISSUED_TASK_CONTENT_CHANGED')
  if (task.lesson_id) {
    const lesson = getLesson(task.lesson_id)
    if (!lesson || lesson.contentStatus !== 'published' || lesson.version !== task.lesson_version) throw new ApiError(409,'ISSUED_LESSON_CHANGED')
  }
  if (activityId && activityId !== task.activity_id) throw new ApiError(400, 'ISSUED_TASK_ACTIVITY_MISMATCH')
  return task
}
export function deliverTaskAudio(accountId, taskId, mediaId) {
  const task = requireTask(accountId,taskId), act = activityById(task.activity_id)
  if (act.audioRef !== mediaId) throw new ApiError(400, 'MEDIA_ACTIVITY_MISMATCH')
  const {entry,buf,mime} = readLessonAudio(mediaId)
  const deliveryId = randomUUID()
  db().prepare('INSERT INTO task_media_deliveries VALUES (?,?,?,?,?,?)').run(deliveryId,taskId,mediaId,entry.version ?? 1,entry.sha256,Date.now())
  return {audioBase64:buf.toString('base64'),mime,deliveryId}
}
export function recordTaskPlay(accountId,{taskId,deliveryId,eventId,activityId,mediaId}={}) {
  const task = requireTask(accountId,taskId,activityId), c = db()
  if (typeof deliveryId !== 'string' || !deliveryId) throw new ApiError(400,'AUDIO_DELIVERY_REQUIRED')
  const delivery = c.prepare('SELECT * FROM task_media_deliveries WHERE delivery_id=? AND task_id=?').get(deliveryId,taskId)
  if (!delivery || delivery.media_id !== mediaId) throw new ApiError(400,'AUDIO_DELIVERY_REQUIRED')
  // Revalidate bytes and version; a previously delivered broken or replaced file grants nothing.
  const {entry} = readLessonAudio(mediaId)
  if (entry.sha256 !== delivery.sha256 || (entry.version ?? 1) !== delivery.media_version) throw new ApiError(409,'AUDIO_VERSION_CHANGED')
  if (typeof eventId !== 'string' || !eventId || eventId.length > 128) throw new ApiError(400,'PLAY_EVENT_ID_REQUIRED')
  c.prepare('INSERT OR IGNORE INTO task_play_events VALUES (?,?,?,?)').run(task.task_id,eventId,deliveryId,Date.now())
  return {ok:true,playCount:taskPlayCount(taskId)}
}
export function taskPlayCount(taskId) { return db().prepare('SELECT COUNT(*) AS n FROM task_play_events WHERE task_id=?').get(taskId).n }
export function taskForAttempt(accountId,taskId,activityId) { return requireTask(accountId,taskId,activityId) }

/** Historical observation reads the issued contract, not today's expiry or mutable definition. */
export function taskForRecordedAttempt(accountId, attempt) {
  const task = db().prepare('SELECT * FROM issued_tasks WHERE account_id=? AND task_id=?').get(accountId,attempt.issued_task_id)
  if (!task || task.activity_id !== attempt.activity_id) throw new ApiError(400,'ISSUED_TASK_REQUIRED')
  if (attempt.created_at < task.issued_at || attempt.created_at >= task.expires_at) throw new ApiError(400,'ATTEMPT_OUTSIDE_TASK_WINDOW')
  if (!task.definition_snapshot) throw new ApiError(409,'HISTORICAL_TASK_SNAPSHOT_REQUIRED')
  const definition = JSON.parse(task.definition_snapshot)
  if (createHash('sha256').update(JSON.stringify(definition)).digest('hex') !== task.definition_hash
    || definition.version !== attempt.activity_version) throw new ApiError(409,'HISTORICAL_TASK_SNAPSHOT_INVALID')
  return {...task,definition}
}
