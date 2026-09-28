// EnglishForge 进度数据库（node:sqlite，零依赖）
//
// 为什么要有这一层：进度原本只存在浏览器 localStorage 里，清一次浏览器数据、
// 换一次浏览器、或者开发者想看一眼实际练习情况，都无能为力。落库之后进度是
// 可查询、可备份、不会丢的；账户表为将来多人共用一个库留好了位置。
//
// 数据文件放在仓库之外（JunEnglish/data/englishforge/），与 课稿-校对版/、corpus/
// 同一纪律：englishforge 是公开仓库，用户数据永远不会进 git。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const DB_PATH = process.env.ENGLISHFORGE_DB
  ? resolve(process.env.ENGLISHFORGE_DB)
  : resolve(HERE, '..', '..', 'data', 'englishforge', 'englishforge.db')

/** 客户端一次最多带回多少条作答事件（库里全量保留，客户端只吃最近这些） */
export const ATTEMPT_PAGE = 5000
/** 保留多少份快照（每次覆盖/清空/导入前自动留一份） */
export const SNAPSHOT_KEEP = 30

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  note         TEXT
);

-- 每个账户一行：XP / 连续天数 / 状态版本号
CREATE TABLE IF NOT EXISTS meta (
  account_id       TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  xp               INTEGER NOT NULL DEFAULT 0,
  streak           INTEGER NOT NULL DEFAULT 0,
  last_active_date TEXT NOT NULL DEFAULT '',
  combo_best       INTEGER NOT NULL DEFAULT 0,
  revision         INTEGER NOT NULL DEFAULT 0,   -- 服务端单调递增：每次接受一次写入 +1
  client_revision  INTEGER NOT NULL DEFAULT 0,   -- 客户端自称的版本（诊断多端分叉用）
  updated_at       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_progress (
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  skill_id     TEXT NOT NULL,
  concept_seen INTEGER NOT NULL DEFAULT 0,
  box          INTEGER NOT NULL DEFAULT 0,
  due          INTEGER NOT NULL DEFAULT 0,
  correct      INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, skill_id)
);

-- 题级复习状态（scheduler 的 dueAt / stage 就存在这里）
CREATE TABLE IF NOT EXISTS question_states (
  account_id                 TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  qid                        TEXT NOT NULL,
  stage                      INTEGER NOT NULL DEFAULT 0,
  due_at                     INTEGER NOT NULL DEFAULT 0,
  correct                    INTEGER NOT NULL DEFAULT 0,
  total                      INTEGER NOT NULL DEFAULT 0,
  last_independent_success_at INTEGER,
  last_failure_at            INTEGER,
  legacy                     INTEGER,
  speak_status               TEXT,
  speak_at                   INTEGER,
  PRIMARY KEY (account_id, qid)
);

-- 作答事件：只追加、按 attempt_id 幂等。这是库里最有价值的原始记录，
-- 任何聚合（正确率 / 间隔保持 / 错因分布）都能从这里重算。
CREATE TABLE IF NOT EXISTS attempts (
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attempt_id       TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  question_id      TEXT NOT NULL,
  objective_id     TEXT NOT NULL,
  variant_group_id TEXT NOT NULL,
  local_date       TEXT NOT NULL,
  timestamp        INTEGER NOT NULL,
  answer           TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  evaluator        TEXT NOT NULL,
  mode             TEXT NOT NULL,
  first_attempt    INTEGER NOT NULL,
  support_used     INTEGER NOT NULL,
  content_version  INTEGER NOT NULL,
  is_due_review    INTEGER NOT NULL DEFAULT 0,
  is_variant_drill INTEGER NOT NULL DEFAULT 0,
  error_tags       TEXT,          -- JSON 数组
  response_ms      INTEGER,
  PRIMARY KEY (account_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS ix_attempts_q    ON attempts(account_id, question_id);
CREATE INDEX IF NOT EXISTS ix_attempts_obj  ON attempts(account_id, objective_id);
CREATE INDEX IF NOT EXISTS ix_attempts_time ON attempts(account_id, timestamp);

CREATE TABLE IF NOT EXISTS practice_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  label      TEXT NOT NULL,
  lesson_no  TEXT NOT NULL,
  acc        INTEGER NOT NULL,
  xp         INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  first_try  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_time ON practice_sessions(account_id, ts);

CREATE TABLE IF NOT EXISTS daily_xp (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  xp         INTEGER NOT NULL,
  PRIMARY KEY (account_id, local_date)
);

-- 未完成会话的断点（含冻结队列与 runtime），刷新/重启后可继续
CREATE TABLE IF NOT EXISTS active_sessions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 内容审核标记：也是用户的工作成果，同样不能只躺在浏览器里
CREATE TABLE IF NOT EXISTS content_reviews (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  note        TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, question_id)
);

-- 题库：**属于账户的内容**，不是进度。
-- 为什么放库不放仓库：语料派生的题来自 CC BY 语料，进公开仓库要处理署名；
-- 而且"定制的题"本来就该跟着账户走（谁练谁的），还能被查询、对照、逐题定版。
CREATE TABLE IF NOT EXISTS item_batches (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  skill        TEXT,
  objective_id TEXT,
  source       TEXT NOT NULL,     -- corpus(语料派生) / generated(模型即时生成) / imported / manual
  generator    TEXT,              -- 生成方式：脚本名、批次标签或模型名
  note         TEXT,
  item_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL,
  skill           TEXT NOT NULL,
  objective_id    TEXT NOT NULL,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,   -- 整道题（与前端 Question 契约同形）
  source          TEXT NOT NULL,
  generator       TEXT,
  batch_id        TEXT,
  source_ref      TEXT,            -- 逐题出处（可追溯、可署名）
  content_version INTEGER NOT NULL DEFAULT 1,
  review_status   TEXT NOT NULL DEFAULT 'draft',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_items_skill  ON items(account_id, skill);
CREATE INDEX IF NOT EXISTS ix_items_status ON items(account_id, review_status);

CREATE VIEW IF NOT EXISTS v_item_stats AS
SELECT account_id, skill, source, review_status, COUNT(*) AS n
FROM items GROUP BY account_id, skill, source, review_status;

-- 整份存档快照：覆盖 / 清空 / 导入前自动留一份，出问题能回捞
CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  payload    TEXT NOT NULL
);

-- 查询视图：让"直接开 sqlite 看进度"这件事不用每次现写聚合
CREATE VIEW IF NOT EXISTS v_objective_stats AS
SELECT account_id, objective_id,
       COUNT(*)                                                          AS attempts,
       SUM(CASE WHEN first_attempt = 1 THEN 1 ELSE 0 END)                 AS first_attempts,
       SUM(CASE WHEN first_attempt = 1 AND outcome = 'correct' THEN 1 ELSE 0 END) AS first_correct,
       COUNT(DISTINCT local_date)                                        AS days,
       COUNT(DISTINCT variant_group_id)                                  AS variant_groups,
       COUNT(DISTINCT question_id)                                       AS questions,
       MIN(timestamp)                                                    AS first_at,
       MAX(timestamp)                                                    AS last_at
FROM attempts GROUP BY account_id, objective_id;

CREATE VIEW IF NOT EXISTS v_daily AS
SELECT account_id, local_date,
       COUNT(*)                                            AS attempts,
       SUM(CASE WHEN first_attempt = 1 THEN 1 ELSE 0 END)   AS first_attempts,
       SUM(CASE WHEN first_attempt = 1 AND outcome = 'correct' THEN 1 ELSE 0 END) AS first_correct,
       COUNT(DISTINCT question_id)                         AS questions
FROM attempts GROUP BY account_id, local_date;
`

// ---------------------------------------------------------------- 连接

let db = null

export function openDb(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const conn = new DatabaseSync(path)
  conn.exec(SCHEMA)
  return conn
}

export function getDb() {
  if (!db) db = openDb()
  return db
}

export function closeDb() {
  if (db) { db.close(); db = null }
}

// ---------------------------------------------------------------- 绑定与序列化

function bool(v) {
  return v === null || v === undefined ? undefined : !!v
}

function int(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback
}

function parseJson(v) {
  if (typeof v !== 'string' || !v) return undefined
  try { return JSON.parse(v) } catch { return undefined }
}

function nowMs() { return Date.now() }

function newId() {
  return 'acc_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
}

// ---------------------------------------------------------------- 账户

export function listAccounts() {
  return getDb().prepare(
    `SELECT a.id, a.name, a.created_at, a.last_seen_at, a.note,
            COALESCE(m.xp, 0) AS xp, COALESCE(m.streak, 0) AS streak, COALESCE(m.revision, 0) AS revision,
            COALESCE(m.updated_at, 0) AS updated_at,
            (SELECT COUNT(*) FROM attempts t WHERE t.account_id = a.id) AS attempts,
            (SELECT COUNT(*) FROM items i WHERE i.account_id = a.id) AS items
     FROM accounts a LEFT JOIN meta m ON m.account_id = a.id
     ORDER BY a.created_at ASC`,
  ).all().map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    note: r.note ?? null,
    xp: r.xp,
    streak: r.streak,
    revision: r.revision,
    updatedAt: r.updated_at,
    attempts: r.attempts,
    items: r.items,
  }))
}

export function getAccount(id) {
  return listAccounts().find((a) => a.id === id) ?? null
}

export function createAccount(name = '默认账户') {
  const db = getDb()
  const id = newId()
  const ts = nowMs()
  db.prepare('INSERT INTO accounts (id, name, created_at, last_seen_at) VALUES (?,?,?,?)')
    .run(id, String(name).slice(0, 60) || '默认账户', ts, ts)
  db.prepare('INSERT INTO meta (account_id, updated_at) VALUES (?,?)').run(id, ts)
  return getAccount(id)
}

/** 首次使用：库里还没有账户就建一个（用户要求"默认先做第一个账户"） */
export function ensureDefaultAccount(name = '默认账户') {
  const all = listAccounts()
  if (all.length) return all[0]
  return createAccount(name)
}

export function renameAccount(id, name) {
  const clean = String(name ?? '').trim().slice(0, 60)
  if (!clean) throw new ApiError(400, '账户名不能为空')
  const res = getDb().prepare('UPDATE accounts SET name = ? WHERE id = ?').run(clean, id)
  if (!res.changes) throw new ApiError(404, '账户不存在')
  return getAccount(id)
}

export function touchAccount(id, ts = nowMs()) {
  getDb().prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?').run(ts, id)
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

// ---------------------------------------------------------------- 读存档

/** 组装一份与前端 ProgressV2 完全同形的存档（客户端可以整份接管） */
export function loadProgress(accountId) {
  const db = getDb()
  const acc = db.prepare('SELECT m.* FROM meta m WHERE m.account_id = ?').get(accountId)
  if (!acc) throw new ApiError(404, '账户不存在：' + accountId)

  const skills = {}
  for (const r of db.prepare('SELECT * FROM skill_progress WHERE account_id = ?').all(accountId)) {
    skills[r.skill_id] = {
      conceptSeen: !!r.concept_seen, box: r.box, due: r.due, correct: r.correct, total: r.total,
    }
  }

  const questionStates = {}
  for (const r of db.prepare('SELECT * FROM question_states WHERE account_id = ?').all(accountId)) {
    const st = {
      stage: r.stage, dueAt: r.due_at, correct: r.correct, total: r.total,
    }
    if (r.last_independent_success_at != null) st.lastIndependentSuccessAt = r.last_independent_success_at
    if (r.last_failure_at != null) st.lastFailureAt = r.last_failure_at
    if (r.legacy != null) st.legacy = !!r.legacy
    if (r.speak_status) st.speak = { status: r.speak_status, at: int(r.speak_at) }
    questionStates[r.qid] = st
  }

  // 库里保留全量事件；返回最近 ATTEMPT_PAGE 条（客户端本就有 5000 上限）
  const attempts = db.prepare(
    `SELECT * FROM (
       SELECT * FROM attempts WHERE account_id = ?
       ORDER BY timestamp DESC, attempt_id DESC LIMIT ?
     ) ORDER BY timestamp ASC, attempt_id ASC`,
  ).all(accountId, ATTEMPT_PAGE).map(rowToAttempt)

  const sessions = db.prepare(
    `SELECT * FROM (
       SELECT * FROM practice_sessions WHERE account_id = ?
       ORDER BY ts DESC, id DESC LIMIT 60
     ) ORDER BY ts DESC, id DESC`,
  ).all(accountId).map((r) => ({
    ts: r.ts, label: r.label, lessonNo: r.lesson_no, acc: r.acc, xp: r.xp, total: r.total, firstTry: r.first_try,
  }))

  const dailyXp = {}
  for (const r of db.prepare('SELECT * FROM daily_xp WHERE account_id = ?').all(accountId)) {
    dailyXp[r.local_date] = r.xp
  }

  const active = db.prepare('SELECT payload FROM active_sessions WHERE account_id = ?').get(accountId)
  const reviews = {}
  for (const r of db.prepare('SELECT * FROM content_reviews WHERE account_id = ?').all(accountId)) {
    reviews[r.question_id] = { verdict: r.verdict, ...(r.note ? { note: r.note } : {}), at: r.updated_at }
  }

  return {
    progress: {
      schemaVersion: 2,
      xp: acc.xp, streak: acc.streak, lastActiveDate: acc.last_active_date, comboBest: acc.combo_best,
      skills, dailyXp, sessions, questionStates, attempts,
      activeSession: parseJson(active?.payload) ?? null,
    },
    revision: acc.revision,
    updatedAt: acc.updated_at,
    reviews,
  }
}

function rowToAttempt(r) {
  const a = {
    attemptId: r.attempt_id,
    sessionId: r.session_id,
    questionId: r.question_id,
    contentVersion: r.content_version,
    objectiveId: r.objective_id,
    variantGroupId: r.variant_group_id,
    mode: r.mode,
    timestamp: r.timestamp,
    localDate: r.local_date,
    firstAttempt: !!r.first_attempt,
    supportUsed: r.support_used,
    answer: r.answer,
    outcome: r.outcome,
    evaluator: r.evaluator,
    isDueReview: !!r.is_due_review,
    isVariantDrill: !!r.is_variant_drill,
  }
  const tags = parseJson(r.error_tags)
  if (Array.isArray(tags) && tags.length) a.errorTags = tags
  if (r.response_ms != null) a.responseMs = r.response_ms
  return a
}

/** 校验一条作答事件是否值得入库（前端历史数据可能有缺字段的旧事件） */
function attemptRow(accountId, a) {
  if (!a || typeof a !== 'object') return null
  const attemptId = str(a.attemptId)
  if (!attemptId) return null
  return [
    accountId,
    attemptId,
    str(a.sessionId, 'unknown'),
    str(a.questionId, 'unknown'),
    str(a.objectiveId, 'unknown'),
    str(a.variantGroupId, 'unknown'),
    str(a.localDate, ''),
    int(a.timestamp, nowMs()),
    str(a.answer, '').slice(0, 200),
    str(a.outcome, 'incorrect'),
    str(a.evaluator, 'deterministic'),
    str(a.mode, 'recognition'),
    a.firstAttempt ? 1 : 0,
    int(a.supportUsed),
    int(a.contentVersion, 1),
    a.isDueReview ? 1 : 0,
    a.isVariantDrill ? 1 : 0,
    Array.isArray(a.errorTags) && a.errorTags.length ? JSON.stringify(a.errorTags) : null,
    typeof a.responseMs === 'number' ? a.responseMs : null,
  ]
}

const ATTEMPT_INSERT = `INSERT OR IGNORE INTO attempts (
  account_id, attempt_id, session_id, question_id, objective_id, variant_group_id,
  local_date, timestamp, answer, outcome, evaluator, mode, first_attempt,
  support_used, content_version, is_due_review, is_variant_drill, error_tags, response_ms
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

// ---------------------------------------------------------------- 写存档

function writeState(db, accountId, state, revision, ts) {
  if (!state || typeof state !== 'object') return
  const meta = {
    xp: int(state.xp), streak: int(state.streak),
    lastActiveDate: str(state.lastActiveDate), comboBest: int(state.comboBest),
  }
  db.prepare(
    `INSERT INTO meta (account_id, xp, streak, last_active_date, combo_best, revision, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET
       xp = excluded.xp, streak = excluded.streak, last_active_date = excluded.last_active_date,
       combo_best = excluded.combo_best, revision = excluded.revision, updated_at = excluded.updated_at`,
  ).run(accountId, meta.xp, meta.streak, meta.lastActiveDate, meta.comboBest, revision, ts)

  db.prepare('DELETE FROM skill_progress WHERE account_id = ?').run(accountId)
  const insSkill = db.prepare(`INSERT OR REPLACE INTO skill_progress
    (account_id, skill_id, concept_seen, box, due, correct, total) VALUES (?,?,?,?,?,?,?)`)
  for (const [sid, s] of Object.entries(state.skills ?? {})) {
    if (!sid || !s) continue
    insSkill.run(accountId, sid, s.conceptSeen ? 1 : 0, int(s.box), int(s.due), int(s.correct), int(s.total))
  }

  db.prepare('DELETE FROM question_states WHERE account_id = ?').run(accountId)
  const insState = db.prepare(`INSERT OR REPLACE INTO question_states
    (account_id, qid, stage, due_at, correct, total, last_independent_success_at, last_failure_at, legacy, speak_status, speak_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  for (const [qid, st] of Object.entries(state.questionStates ?? {})) {
    if (!qid || !st) continue
    insState.run(
      accountId, qid, int(st.stage), int(st.dueAt), int(st.correct), int(st.total),
      st.lastIndependentSuccessAt == null ? null : int(st.lastIndependentSuccessAt),
      st.lastFailureAt == null ? null : int(st.lastFailureAt),
      st.legacy == null ? null : (st.legacy ? 1 : 0),
      st.speak?.status ? String(st.speak.status) : null,
      st.speak?.at == null ? null : int(st.speak.at),
    )
  }

  db.prepare('DELETE FROM practice_sessions WHERE account_id = ?').run(accountId)
  const insSession = db.prepare(`INSERT INTO practice_sessions
    (account_id, ts, label, lesson_no, acc, xp, total, first_try) VALUES (?,?,?,?,?,?,?,?)`)
  for (const s of state.sessions ?? []) {
    if (!s) continue
    insSession.run(accountId, int(s.ts, ts), str(s.label), str(s.lessonNo), int(s.acc), int(s.xp), int(s.total), int(s.firstTry))
  }

  db.prepare('DELETE FROM daily_xp WHERE account_id = ?').run(accountId)
  const insXp = db.prepare('INSERT OR REPLACE INTO daily_xp (account_id, local_date, xp) VALUES (?,?,?)')
  for (const [d, xp] of Object.entries(state.dailyXp ?? {})) {
    if (!d) continue
    insXp.run(accountId, d, int(xp))
  }

  db.prepare('DELETE FROM active_sessions WHERE account_id = ?').run(accountId)
  if (state.activeSession) {
    db.prepare('INSERT INTO active_sessions (account_id, payload, updated_at) VALUES (?,?,?)')
      .run(accountId, JSON.stringify(state.activeSession), ts)
  }
}

function writeReviews(db, accountId, reviews, ts) {
  if (!reviews || typeof reviews !== 'object') return 0
  const ins = db.prepare(`INSERT INTO content_reviews (account_id, question_id, verdict, note, updated_at)
    VALUES (?,?,?,?,?) ON CONFLICT(account_id, question_id) DO UPDATE SET
      verdict = excluded.verdict, note = excluded.note, updated_at = excluded.updated_at`)
  let n = 0
  for (const [qid, m] of Object.entries(reviews)) {
    if (!qid || !m || !m.verdict) continue
    ins.run(accountId, qid, String(m.verdict), m.note ? String(m.note).slice(0, 500) : null, int(m.at, ts))
    n++
  }
  return n
}

/**
 * 增量同步：作答事件按 attemptId 取并集（只增不改，永远不会丢），
 * 其余状态整份覆盖（单用户单设备，最后写入者为准，revision 只作诊断）。
 */
export function syncAccount(accountId, { clientRevision = 0, state = null, attempts = [], reviews = null, reason = 'save' } = {}) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  const ts = nowMs()
  const cur = db.prepare('SELECT revision FROM meta WHERE account_id = ?').get(accountId)
  const nextRev = int(cur?.revision) + 1

  db.exec('BEGIN')
  try {
    let inserted = 0
    const ins = db.prepare(ATTEMPT_INSERT)
    for (const a of attempts) {
      const row = attemptRow(accountId, a)
      if (!row) continue
      if (ins.run(...row).changes) inserted++
    }
    if (state) writeState(db, accountId, state, nextRev, ts)
    else db.prepare('UPDATE meta SET revision = ?, updated_at = ? WHERE account_id = ?').run(nextRev, ts, accountId)
    db.prepare('UPDATE meta SET client_revision = ? WHERE account_id = ?').run(int(clientRevision), accountId)
    const reviewsWritten = writeReviews(db, accountId, reviews, ts)
    touchAccount(accountId, ts)
    db.exec('COMMIT')
    return { revision: nextRev, attemptsInserted: inserted, reviewsWritten, reason }
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}

/** 整份替换（导入存档 / 首次把浏览器里的进度搬进库）。先留快照，出事能回捞。 */
export function replaceState(accountId, { state = null, attempts = [], reviews = null, clientRevision = 0, reason = 'replace' } = {}) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  const ts = nowMs()
  const snapshotId = writeSnapshot(db, accountId, reason, ts)

  const cur = db.prepare('SELECT revision FROM meta WHERE account_id = ?').get(accountId)
  const nextRev = int(cur?.revision) + 1
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM attempts WHERE account_id = ?').run(accountId)
    db.prepare('DELETE FROM content_reviews WHERE account_id = ?').run(accountId)
    let inserted = 0
    const ins = db.prepare(ATTEMPT_INSERT)
    for (const a of attempts) {
      const row = attemptRow(accountId, a)
      if (!row) continue
      if (ins.run(...row).changes) inserted++
    }
    writeState(db, accountId, state ?? {}, nextRev, ts)
    const reviewsWritten = writeReviews(db, accountId, reviews, ts)
    db.prepare('UPDATE meta SET client_revision = ? WHERE account_id = ?').run(int(clientRevision), accountId)
    touchAccount(accountId, ts)
    db.exec('COMMIT')
    return { revision: nextRev, attemptsInserted: inserted, reviewsWritten, snapshotId, reason }
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}

/** 清空账户进度（保留账户本体）。清空前强制留快照。 */
export function resetAccount(accountId, { reason = 'reset' } = {}) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  const ts = nowMs()
  const snapshotId = writeSnapshot(db, accountId, reason, ts)
  const cur = db.prepare('SELECT revision FROM meta WHERE account_id = ?').get(accountId)
  const nextRev = int(cur?.revision) + 1
  db.exec('BEGIN')
  try {
    // 只清进度：题库（items）与审核结论（content_reviews）属于"内容"，不该被清进度带走
    for (const t of ['attempts', 'skill_progress', 'question_states', 'practice_sessions', 'daily_xp', 'active_sessions']) {
      db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(accountId)
    }
    writeState(db, accountId, {}, nextRev, ts)
    db.prepare('UPDATE meta SET revision = ?, client_revision = 0, updated_at = ? WHERE account_id = ?').run(nextRev, ts, accountId)
    db.exec('COMMIT')
    return { revision: nextRev, snapshotId, reason }
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}

// ---------------------------------------------------------------- 题库（账户内容）

/** 题库读出来就是前端 Question 的对象：客户端直接并进抽题池，不需要第二套契约 */
export function listItems(accountId, { skill = null, source = null, status = null, limit = 20000 } = {}) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  const where = ['account_id = ?']
  const params = [accountId]
  if (skill) { where.push('skill = ?'); params.push(skill) }
  if (source) { where.push('source = ?'); params.push(source) }
  if (status) { where.push('review_status = ?'); params.push(status) }
  params.push(Math.max(1, Math.min(50000, int(limit, 20000))))
  return db.prepare(
    `SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY skill, item_id LIMIT ?`,
  ).all(...params).map(rowToItem)
}

function rowToItem(r) {
  const question = parseJson(r.payload) ?? {}
  return {
    itemId: r.item_id,
    skill: r.skill,
    objectiveId: r.objective_id,
    type: r.type,
    source: r.source,
    generator: r.generator ?? null,
    batchId: r.batch_id ?? null,
    sourceRef: r.source_ref ?? null,
    contentVersion: r.content_version,
    reviewStatus: r.review_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // 库里存的是权威版本：题面字段以 payload 为准
    question: { ...question, id: r.item_id, skill: r.skill, objectiveId: r.objective_id, reviewStatus: r.review_status, contentVersion: r.content_version },
  }
}

/**
 * 写入题（幂等）：同一 item_id 重复导入只更新，不产生副本。
 * 这是"题库可以反复生成、对照、替换"的前提。
 */
export function addItems(accountId, { items = [], batch = {} } = {}) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  const ts = nowMs()
  const batchId = batch.id || ('b_' + Math.random().toString(36).slice(2, 8) + ts.toString(36).slice(-4))
  const ins = db.prepare(`INSERT INTO items
    (account_id, item_id, skill, objective_id, type, payload, source, generator, batch_id,
     source_ref, content_version, review_status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id, item_id) DO UPDATE SET
      skill = excluded.skill, objective_id = excluded.objective_id, type = excluded.type,
      payload = excluded.payload, source = excluded.source, generator = excluded.generator,
      batch_id = excluded.batch_id, source_ref = excluded.source_ref,
      content_version = excluded.content_version, updated_at = excluded.updated_at`)
  let inserted = 0, updated = 0, skipped = 0
  const skills = new Set()
  db.exec('BEGIN')
  try {
    for (const it of items) {
      const q = it?.question ?? it
      const itemId = str(it?.itemId ?? q?.id)
      const skill = str(it?.skill ?? q?.skill)
      if (!itemId || !skill) { skipped++; continue }
      const exists = db.prepare('SELECT 1 FROM items WHERE account_id = ? AND item_id = ?').get(accountId, itemId)
      const row = [
        accountId, itemId, skill, str(it?.objectiveId ?? q?.objectiveId, skill), str(it?.type ?? q?.type, 'choice'),
        JSON.stringify({ ...q, id: itemId, skill }),
        str(it?.source, 'imported'), it?.generator ?? null, batchId,
        it?.sourceRef ?? q?.sourceRef ?? null,
        int(it?.contentVersion ?? q?.contentVersion, 1),
        str(it?.reviewStatus ?? q?.reviewStatus, 'draft'),
        ts, ts,
      ]
      ins.run(...row)
      if (exists) updated++; else inserted++
      skills.add(skill)
    }
    db.prepare(`INSERT INTO item_batches (id, account_id, created_at, skill, objective_id, source, generator, note, item_count)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(batchId, accountId, ts, batch.skill ?? (skills.size === 1 ? [...skills][0] : null), batch.objectiveId ?? null,
        str(batch.source, 'imported'), batch.generator ?? null, batch.note ?? null, inserted + updated)
    touchAccount(accountId, ts)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
  return { batchId, inserted, updated, skipped, total: items.length }
}

const VERDICT_STATUS = { ok: 'reviewed', fix: 'draft', kill: 'quarantined' }

/** 逐题定版（审核结论直接落在题库里，这样换浏览器也不丢） */
export function setItemReview(accountId, itemId, verdict, note = null) {
  const status = VERDICT_STATUS[verdict]
  if (!status) throw new ApiError(400, 'verdict 只能是 ok / fix / kill')
  const res = getDb().prepare('UPDATE items SET review_status = ?, updated_at = ? WHERE account_id = ? AND item_id = ?')
    .run(status, nowMs(), accountId, itemId)
  if (!res.changes) throw new ApiError(404, '账户里没有这道题：' + itemId)
  return { itemId, reviewStatus: status, note }
}

export function deleteItem(accountId, itemId) {
  const res = getDb().prepare('DELETE FROM items WHERE account_id = ? AND item_id = ?').run(accountId, itemId)
  if (!res.changes) throw new ApiError(404, '账户里没有这道题：' + itemId)
  return { deleted: 1 }
}

export function listBatches(accountId) {
  return getDb().prepare('SELECT * FROM item_batches WHERE account_id = ? ORDER BY created_at DESC')
    .all(accountId).map((r) => ({
      id: r.id, createdAt: r.created_at, skill: r.skill ?? null, objectiveId: r.objective_id ?? null,
      source: r.source, generator: r.generator ?? null, note: r.note ?? null, itemCount: r.item_count,
    }))
}

/** 题库统计：按思维点/来源/信任级别聚合（"定制的、可对照的"就靠这个看） */
export function itemStats(accountId) {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM v_item_stats WHERE account_id = ? ORDER BY skill, source, review_status').all(accountId)
  const bySkill = {}
  for (const r of rows) {
    const s = bySkill[r.skill] ?? (bySkill[r.skill] = { skill: r.skill, total: 0, reviewed: 0, draft: 0, quarantined: 0, sources: {} })
    s.total += r.n
    s[r.review_status] += r.n
    s.sources[r.source] = (s.sources[r.source] ?? 0) + r.n
  }
  return {
    total: rows.reduce((n, r) => n + r.n, 0),
    bySkill: Object.values(bySkill).sort((a, b) => a.skill.localeCompare(b.skill)),
    batches: listBatches(accountId).length,
  }
}

// ---------------------------------------------------------------- 快照

export function writeSnapshot(db, accountId, reason, ts = nowMs()) {
  const doc = loadProgress(accountId)
  const payload = JSON.stringify({ progress: doc.progress, reviews: doc.reviews, revision: doc.revision })
  const res = db.prepare('INSERT INTO snapshots (account_id, created_at, reason, revision, payload) VALUES (?,?,?,?,?)')
    .run(accountId, ts, String(reason).slice(0, 60), doc.revision, payload)
  db.prepare(`DELETE FROM snapshots WHERE account_id = ? AND id NOT IN (
      SELECT id FROM snapshots WHERE account_id = ? ORDER BY id DESC LIMIT ?
    )`).run(accountId, accountId, SNAPSHOT_KEEP)
  return Number(res.lastInsertRowid)
}

export function listSnapshots(accountId, withPayload = false) {
  const rows = getDb().prepare(
    withPayload
      ? 'SELECT * FROM snapshots WHERE account_id = ? ORDER BY id DESC'
      : 'SELECT id, account_id, created_at, reason, revision, LENGTH(payload) AS bytes FROM snapshots WHERE account_id = ? ORDER BY id DESC',
  ).all(accountId)
  return rows.map((r) => ({
    id: r.id, accountId: r.account_id, createdAt: r.created_at, reason: r.reason,
    revision: r.revision, bytes: r.bytes ?? r.payload?.length ?? 0,
    ...(withPayload ? { payload: parseJson(r.payload) } : {}),
  }))
}

/** 从快照恢复（先给当前状态再留一份快照，来回都不丢） */
export function restoreSnapshot(snapshotId) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId)
  if (!row) throw new ApiError(404, '快照不存在：' + snapshotId)
  const doc = parseJson(row.payload)
  if (!doc?.progress) throw new ApiError(500, '快照内容无法解析')
  return replaceState(row.account_id, {
    state: doc.progress, attempts: doc.progress.attempts ?? [], reviews: doc.reviews ?? {},
    reason: 'restore-snapshot-' + snapshotId,
  })
}

// ---------------------------------------------------------------- 查询

export function stats(accountId) {
  const db = getDb()
  const one = (sql, ...p) => int(db.prepare(sql).get(accountId, ...p)?.n)
  const withState = db.prepare('SELECT COUNT(*) AS n FROM question_states WHERE account_id = ? AND total > 0').get(accountId)
  const due = db.prepare('SELECT COUNT(*) AS n FROM question_states WHERE account_id = ? AND due_at <= ?').get(accountId, nowMs())
  const meta = db.prepare('SELECT * FROM meta WHERE account_id = ?').get(accountId)
  if (!meta) throw new ApiError(404, '账户不存在：' + accountId)
  return {
    accountId,
    xp: meta.xp, streak: meta.streak, comboBest: meta.combo_best, lastActiveDate: meta.last_active_date,
    revision: meta.revision, updatedAt: meta.updated_at,
    attempts: one('SELECT COUNT(*) AS n FROM attempts WHERE account_id = ?'),
    attemptsFirst: one('SELECT COUNT(*) AS n FROM attempts WHERE account_id = ? AND first_attempt = 1'),
    attemptsCorrectFirst: one('SELECT COUNT(*) AS n FROM attempts WHERE account_id = ? AND first_attempt = 1 AND outcome = \'correct\''),
    questionStates: one('SELECT COUNT(*) AS n FROM question_states WHERE account_id = ?'),
    questionsPracticed: int(withState?.n),
    skills: one('SELECT COUNT(*) AS n FROM skill_progress WHERE account_id = ?'),
    sessions: one('SELECT COUNT(*) AS n FROM practice_sessions WHERE account_id = ?'),
    dailyXpDays: one('SELECT COUNT(*) AS n FROM daily_xp WHERE account_id = ?'),
    reviews: one('SELECT COUNT(*) AS n FROM content_reviews WHERE account_id = ?'),
    snapshots: one('SELECT COUNT(*) AS n FROM snapshots WHERE account_id = ?'),
    dueNow: int(due?.n),
    hasActiveSession: !!db.prepare('SELECT 1 FROM active_sessions WHERE account_id = ?').get(accountId),
    objectives: db.prepare('SELECT * FROM v_objective_stats WHERE account_id = ? ORDER BY attempts DESC').all(accountId),
    errorTags: errorTagCounts(accountId),
  }
}

/** 错因分布：把 attempts.error_tags 这个 JSON 数组炸开统计 */
export function errorTagCounts(accountId, limit = 50) {
  const rows = getDb().prepare(
    "SELECT error_tags, COUNT(*) AS n FROM attempts WHERE account_id = ? AND error_tags IS NOT NULL GROUP BY error_tags",
  ).all(accountId)
  const tally = new Map()
  for (const r of rows) {
    const tags = parseJson(r.error_tags)
    if (!Array.isArray(tags)) continue
    for (const t of tags) tally.set(t, (tally.get(t) ?? 0) + r.n)
  }
  return [...tally.entries()]
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => b.n - a.n || String(a.tag).localeCompare(String(b.tag)))
    .slice(0, limit)
}

export function queryAttempts(accountId, { limit = 200, objective = null, since = null, question = null } = {}) {
  const db = getDb()
  const where = ['account_id = ?']
  const params = [accountId]
  if (objective) { where.push('objective_id = ?'); params.push(objective) }
  if (question) { where.push('question_id = ?'); params.push(question) }
  if (since) { where.push('timestamp >= ?'); params.push(int(since)) }
  params.push(Math.max(1, Math.min(20000, int(limit, 200))))
  return db.prepare(
    `SELECT * FROM attempts WHERE ${where.join(' AND ')} ORDER BY timestamp DESC, attempt_id DESC LIMIT ?`,
  ).all(...params).map(rowToAttempt)
}

export function dbInfo() {
  const db = getDb()
  const size = (() => {
    try { return db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size }
    catch { return null }
  })()
  return { path: DB_PATH, accounts: listAccounts().length, bytes: size, sqlite: 'node:sqlite / Node ' + process.version }
}

export { bool }
