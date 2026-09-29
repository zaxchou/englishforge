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
  verdict     TEXT NOT NULL,      -- ok / fix / kill
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'human',   -- 谁定的：human / ai
  model       TEXT,               -- 若是 AI 定的：哪家模型
  reasons     TEXT,               -- JSON 数组：AI 给的逐条理由（人工可据此复核）
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

-- 全局设置（模型名等）。放库里而不是 .env：用户能在界面上改，不用碰别的项目的配置文件。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 后台维护日志：流水线/补纠正每次执行的留痕（何时、动了谁、错在哪、耗时多久）。
-- 自动化必须有可回查的执行记录 —— 否则出了问题就是黑箱。
CREATE TABLE IF NOT EXISTS run_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT,                        -- 可空：系统级事件
  kind        TEXT NOT NULL,               -- pipeline / enrich / …
  summary     TEXT,                        -- JSON：计数、模型、耗时、动的题目 id
  error       TEXT,                        -- 过程中的非致命错误（单批坏输出等）
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_run_log_acct ON run_log(account_id, created_at);

-- 题库目录：仓库里自带的那批题（随代码发布）的**元数据镜像**。
-- 为什么要有它：系统要能自己检查自己的内容（查重、找缺逐项纠正的题、让模型补全），
-- 而题面原本只存在于前端编译产物里，服务端看不见。客户端启动时把目录推上来（幂等 upsert）。
-- 注意：这不是"用户的题"，只是"这道题长什么样"；信任级别仍按账户存在 content_reviews / items 里。
CREATE TABLE IF NOT EXISTS questions (
  id                TEXT PRIMARY KEY,
  skill             TEXT NOT NULL,
  mode              TEXT,
  type              TEXT,
  variant_group_id  TEXT,
  prompt            TEXT NOT NULL,
  answer            TEXT,
  options           TEXT,                          -- JSON 数组（模型补逐项纠正时要用）
  explain           TEXT,                          -- 解析（审核员要据此查"有没有用术语/自不自洽"）
  aux               TEXT,                          -- JSON：tokens/order/target/fix（拼句/点词/跟读题的句子）
  tts               TEXT,
  content_version   INTEGER NOT NULL DEFAULT 1,
  content_key       TEXT,                          -- 题型+题干+句子（归一化）：查重的依据
  has_cause         INTEGER NOT NULL DEFAULT 0,   -- 题面自带逐项纠正了吗
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_questions_skill ON questions(skill);

-- 系统 AI 给题目补的内容（逐项纠正 / 错因标签 / 释义…），按账户存：
-- 补出来的东西是"这个账户的内容"，写回后练习与结算页立刻能用上。
CREATE TABLE IF NOT EXISTS enrichments (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- causes（逐项纠正 + 错因标签）/ glossary / …
  payload     TEXT NOT NULL,      -- JSON
  model       TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, question_id, kind)
);

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
  // WAL + synchronous=NORMAL：NAS 的数据卷在同步盘上（fsync 很贵），回滚日志模式下一次
  // 396 行的目录推送要 1~2 秒 —— 而 node:sqlite 是**同步**的，整段时间服务进程被堵住，
  // 连读接口都在排队（实测：慢请求全是写操作且互相拖累）。WAL 把 fsync 降到 ~1 次/事务。
  // busy_timeout：多连接（脚本/维护任务）偶发锁竞争时等一会儿，别直接报忙。
  try {
    conn.exec('PRAGMA journal_mode = WAL')
    conn.exec('PRAGMA synchronous = NORMAL')
    conn.exec('PRAGMA busy_timeout = 5000')
  } catch { /* :memory: 等场景不支持 WAL，忽略 */ }
  // 老库的补列迁移：CREATE TABLE IF NOT EXISTS 不会给**已存在**的表加列
  ensureColumns(conn, 'content_reviews')
  ensureColumns(conn, 'questions')
  return conn
}

/** 缺列就补上。表名与列名都是本文件里的常量，不接受外部输入 */
function ensureColumns(conn, table) {
  const have = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name))
  const spec = {
    content_reviews: [['source', "TEXT NOT NULL DEFAULT 'human'"], ['model', 'TEXT'], ['reasons', 'TEXT']],
    questions: [['explain', 'TEXT'], ['aux', 'TEXT']],
  }
  for (const [name, type] of spec[table] ?? []) {
    if (!have.has(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
  }
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
    reviews[r.question_id] = {
      verdict: r.verdict,
      ...(r.note ? { note: r.note } : {}),
      ...(r.source && r.source !== 'human' ? { source: r.source } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(parseJson(r.reasons) ? { reasons: parseJson(r.reasons) } : {}),
      at: r.updated_at,
    }
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
  const ins = db.prepare(`INSERT INTO content_reviews (account_id, question_id, verdict, note, source, model, reasons, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id, question_id) DO UPDATE SET
      verdict = excluded.verdict, note = excluded.note, updated_at = excluded.updated_at,
      -- 结论没变时**保留原来的来源与理由**：否则把人机协作的记录抹平了
      -- （AI 判的题被客户端回推一次就变成"人工定的"，后面就没法复核了）
      source = CASE WHEN content_reviews.verdict = excluded.verdict THEN content_reviews.source ELSE excluded.source END,
      model = CASE WHEN content_reviews.verdict = excluded.verdict THEN content_reviews.model ELSE excluded.model END,
      reasons = CASE WHEN content_reviews.verdict = excluded.verdict THEN content_reviews.reasons ELSE excluded.reasons END`)
  let n = 0
  for (const [qid, m] of Object.entries(reviews)) {
    if (!qid || !m || !m.verdict) continue
    ins.run(accountId, qid, String(m.verdict),
      m.note ? String(m.note).slice(0, 500) : null,
      m.source === 'ai' ? 'ai' : m.source === 'bulk' ? 'bulk' : 'human',
      m.model ? String(m.model).slice(0, 80) : null,
      Array.isArray(m.reasons) && m.reasons.length ? JSON.stringify(m.reasons.slice(0, 4)) : null,
      int(m.at, ts))
    n++
  }
  return n
}

/** 写入一条 AI 审核结论（供 /ai-review 用；人工之后改它，source 会变 human） */
/**
 * 写入一条 AI 审核结论（供 /ai-pipeline 用；人工之后改它，source 会变 human）。
 * 两道写入层保护（队列层已排除 kill，这里是防"审核请求进行中"的竞态，复核报告 #3）：
 *   · 人工判毙**永久生效**：AI 不许把它复活；
 *   · 请求发出（since）之后有人工操作 → 这轮结论已过期，不写，下一轮自然会重审。
 */
export function saveAiReview(accountId, questionId, verdict, reasons, model, { since = 0 } = {}) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  const cur = db.prepare('SELECT verdict, source, updated_at FROM content_reviews WHERE account_id = ? AND question_id = ?')
    .get(accountId, questionId)
  if (cur?.source === 'human') {
    if (cur.verdict === 'kill' && verdict !== 'kill') return { ok: true, saved: false, skipped: 'human-kill' }
    if (since && cur.updated_at > since) return { ok: true, saved: false, skipped: 'human-newer' }
  }
  db.prepare(`INSERT INTO content_reviews (account_id, question_id, verdict, note, source, model, reasons, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id, question_id) DO UPDATE SET
      verdict = excluded.verdict, source = 'ai', model = excluded.model,
      reasons = excluded.reasons, updated_at = excluded.updated_at`)
    .run(accountId, questionId, verdict, null, 'ai', model ?? null,
      Array.isArray(reasons) && reasons.length ? JSON.stringify(reasons.slice(0, 4)) : null, nowMs())
  return { ok: true, saved: true }
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

// ---------------------------------------------------------------- 设置

export function getSetting(key) {
  const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return r?.value ?? null
}

export function setSetting(key, value) {
  getDb().prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(String(key), String(value), nowMs())
  return { key, value }
}

export function allSettings() {
  const out = {}
  for (const r of getDb().prepare('SELECT * FROM settings').all()) out[r.key] = r.value
  return out
}

// ---------------------------------------------------------------- 题库目录与系统自检

/** 客户端把仓库题库的目录推上来（幂等）：服务端从此"看得见"自己的内容 */
export function upsertCatalog(rows = []) {
  const db = getDb()
  const ts = nowMs()
  const ins = db.prepare(`INSERT INTO questions
    (id, skill, mode, type, variant_group_id, prompt, answer, options, explain, aux, tts, content_version, content_key, has_cause, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      skill = excluded.skill, mode = excluded.mode, type = excluded.type,
      variant_group_id = excluded.variant_group_id, prompt = excluded.prompt,
      answer = excluded.answer, options = excluded.options, explain = excluded.explain,
      aux = excluded.aux, tts = excluded.tts, content_version = excluded.content_version,
      content_key = excluded.content_key,
      has_cause = excluded.has_cause, updated_at = excluded.updated_at`)
  let inserted = 0, updated = 0, skipped = 0
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const id = str(r?.id)
      const skill = str(r?.skill)
      if (!id || !skill) { skipped++; continue }
      const exists = db.prepare('SELECT 1 FROM questions WHERE id = ?').get(id)
      // 镜像 = 仓库基准题面（客户端推什么存什么）。AI 改写只在 enrichments（按账户），
      // 由复审/练习端派生叠加 —— 全局镜像里混入某账户的改稿会串给别的账户（复核报告 #2）。
      const options = Array.isArray(r.options) ? JSON.stringify(r.options.map((o) => String(o).slice(0, 200))) : null
      ins.run(id, skill, r.mode ?? null, r.type ?? null, r.variantGroupId ?? null,
        str(r.prompt).slice(0, 500), r.answer ?? null, options,
        r.explain ? String(r.explain).slice(0, 600) : null,
        r.aux ? JSON.stringify(r.aux).slice(0, 2000) : null, r.tts ?? null,
        int(r.contentVersion, 1), r.contentKey ? String(r.contentKey).slice(0, 600) : null, r.hasCause ? 1 : 0, ts)
      if (exists) updated++; else inserted++
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
  return { inserted, updated, skipped, total: db.prepare('SELECT COUNT(*) AS n FROM questions').get().n }
}

/** 归一化：查重只看"实质内容"，忽略大小写、空白与标点（中英标点都算） */
export function normText(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[.,!?;:'"“”‘’()（）[\]{}<>《》、。，！？；：…—~`|/*#&+^%$@=_·•]/g, '')
}

/** 系统自检：重复题、互相打架的题、缺逐项纠正的题。
 *  这些都是"系统能自己发现"的内容缺陷，不需要人肉通读 356 道题。 */
export function audit(accountId) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  // 已经毙掉的题**不再计入自检**：否则用户点完「自动毙掉多余的」，数字一动不动，
  // 看起来就像"点了没用"（实测就是这个观感）。毙掉的题也不该再花 AI 调用去补纠正。
  const killed = new Set([
    ...db.prepare("SELECT question_id FROM content_reviews WHERE account_id = ? AND verdict = 'kill'")
      .all(accountId).map((r) => r.question_id),
    ...db.prepare("SELECT item_id FROM items WHERE account_id = ? AND review_status = 'quarantined'")
      .all(accountId).map((r) => r.item_id),
  ])
  const rows = db.prepare('SELECT * FROM questions ORDER BY skill, id').all().filter((r) => !killed.has(r.id))

  // 分组的依据是 content_key（题型+题干+句子）。**不能只用题干**：听力题题干统一是
  // 「🎧 听一听」，跟读题的 answer 是占位符 'speak' —— 只用题干会把 25 道听力题算成打架（实测过）。
  const identity = (r) => r.content_key || (normText(r.prompt) + '|' + normText(r.tts))
  const bySig = new Map()      // 身份 + 答案 + 选项 全同 → 纯重复
  const byIdent = new Map()    // 身份相同但答案不同 → 互相打架
  for (const r of rows) {
    const key = identity(r)
    const sig = key + '|' + normText(r.answer) + '|' + normText(r.options ?? '')
    if (bySig.has(sig)) bySig.get(sig).push(r); else bySig.set(sig, [r])
    if (byIdent.has(key)) byIdent.get(key).push(r); else byIdent.set(key, [r])
  }
  const slim = (r) => ({ id: r.id, skill: r.skill, prompt: r.prompt, answer: r.answer, type: r.type })
  const withOptions = (r) => ({ ...slim(r), options: parseJson(r.options) ?? [], tts: r.tts ?? null })

  const duplicates = [...bySig.values()].filter((g) => g.length > 1)
    .map((g) => ({ keep: slim(g[0]), extras: g.slice(1).map(slim), count: g.length }))

  // 跟读题的 answer 是占位符（'speak'），它的答案在 target 里，不参与"打架"判定
  const conflicts = [...byIdent.values()]
    .filter((g) => g.length > 1 && g.every((r) => r.type !== 'speak')
      && new Set(g.map((r) => normText(r.answer))).size > 1)
    .map((g) => ({ variants: g.map(slim), count: g.length }))

  const reviewRows = db.prepare('SELECT question_id, verdict, source, reasons FROM content_reviews WHERE account_id = ?').all(accountId)
  const verdictOf = new Map(reviewRows.map((r) => [r.question_id, r]))
  const live = rows.filter((r) => !killed.has(r.id))
  // "还没审过" = 没有结论，或结论只是批量通过（bulk 不算审过 —— 用户自己说那种是"看都不看"）
  const unreviewed = live.filter((r) => {
    const v = verdictOf.get(r.id)
    return !v || v.source === 'bulk'
  }).length
  const bulkCount = live.filter((r) => verdictOf.get(r.id)?.source === 'bulk').length

  // 同一个句子被几道题反复考（用户拍板：最多 2 次）。身份去掉题型前缀 → 剩下的就是"题干+句子"
  const sentenceKeyOf = (r) => (r.content_key ? r.content_key.split('|').slice(1).join('|') : normText(r.prompt) + '|' + normText(r.tts))
  const bySentence = new Map()
  for (const r of live) {
    const k = r.skill + '::' + sentenceKeyOf(r)
    if (bySentence.has(k)) bySentence.get(k).push(r); else bySentence.set(k, [r])
  }
  const over = [...bySentence.values()].filter((g) => g.length > 2)
  const SENTENCE_CAP = 2
  const sentenceReuse = {
    cap: SENTENCE_CAP,
    groupsOver: over.length,
    /** 上限 2 之后会从抽题池里少掉多少道 */
    dropIfCapped: over.reduce((n, g) => n + (g.length - SENTENCE_CAP), 0),
  }
  const aiRows = reviewRows.filter((r) => r.source === 'ai')
  const flagged = live.filter((r) => {
    const v = verdictOf.get(r.id)?.verdict
    return v === 'fix' || v === 'kill'
  })
  // 自动流水线还剩多少道要机器过手（与 pipelineQueue 同一判据）：
  // 人工/批量的结论机器也复核 —— 用户原话「完全不需要我审核」；kill 不进队列（人毙的不复活）
  const pipelinePending = live.filter((r) => {
    const v = verdictOf.get(r.id)
    return !v || v.verdict === 'fix' || v.source === 'bulk' || v.source === 'human'
  }).length

  // 逐项纠正的完成度**按当前有效题面的错误选项逐个算**（复核报告 #6）：
  // 三个错项只补了一个 = 还没补完；选项被改写后旧纠正按文本失配 = 缺口自动重新出现。
  const fixedByQ = new Map()
  for (const r of db.prepare("SELECT question_id, payload FROM enrichments WHERE account_id = ? AND kind = 'causes'").all(accountId)) {
    fixedByQ.set(r.question_id, new Set(Object.keys(parseJson(r.payload)?.optionFixes ?? {})))
  }
  const missingCause = rows.filter((r) => {
    if (r.has_cause) return false
    const opts = parseJson(r.options) ?? []
    if (opts.length < 2) return false            // 只有选择题才有"逐项纠正"这回事
    const wrong = opts.filter((o) => o !== r.answer)
    const fixed = fixedByQ.get(r.id) ?? new Set()
    return wrong.some((o) => !fixed.has(o))
  })
  const missingCauseList = missingCause.map(withOptions)

  return {
    catalog: rows.length,
    /** 这个账户已经毙掉的题数（已从上面各项里排除） */
    quarantined: killed.size,
    /** 还没真审过的题数（没有结论，或结论只是"批量通过"）—— 这就是"要机器去审"的队列 */
    unreviewed,
    /** 其中"批量通过"待重审的条数 */
    bulkPending: bulkCount,
    /** 自动流水线的待办（含人工结论复核与 fix 复审）；归零 = 机器这边全处理完了 */
    pipelinePending,
    /** 同一个句子被 2 道以上题目反复考的情况（上限 2） */
    sentenceReuse,
    /** AI 定过版的题数、以及现在处于"要改/已毙"的题数（这些才需要人过目） */
    aiReviewed: aiRows.length,
    flagged: { count: flagged.length, sample: flagged.slice(0, 30).map(slim) },
    duplicates,
    conflicts,
    missingCause: { count: missingCause.length, sample: missingCauseList.slice(0, 30) },
    missingCauseAll: missingCauseList,
    enrichedCount: fixedByQ.size,
    duplicateCount: duplicates.reduce((n, g) => n + g.extras.length, 0),
  }
}

/** 本账户已定版的题（谁定的、什么结论、AI 给的理由） */
export function listReviews(accountId) {
  return getDb().prepare('SELECT * FROM content_reviews WHERE account_id = ?').all(accountId).map((r) => ({
    questionId: r.question_id,
    verdict: r.verdict,
    note: r.note ?? null,
    source: r.source ?? 'human',
    model: r.model ?? null,
    reasons: parseJson(r.reasons) ?? [],
    at: r.updated_at,
  }))
}

/**
 * 取一批题给审核员。**「待审」的定义**：
 *   · 还没有任何结论的；或
 *   · 结论来源是 `bulk`（批量通过 —— 用户自己说过这种"看都不看"，不该当成已审）；
 *   · 已有 `ai` 结论的、以及用户**故意单点**的 `human` 结论，都不再送审。
 */
export function reviewQueue(accountId) {
  const db = getDb()
  const rows = db.prepare('SELECT question_id, verdict, source FROM content_reviews WHERE account_id = ?').all(accountId)
  const solid = new Set(rows.filter((r) => r.source === 'ai' || r.source === 'human').map((r) => r.question_id))
  const bulk = rows.filter((r) => r.source === 'bulk').length
  return { solid, bulk }
}

/** 把"批量通过"的结论降级为待审（用户要求：那批盲通过的应该重新让 AI 审） */
export function reopenBulk(accountId, { includeHumanOk = true } = {}) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  const where = includeHumanOk
    ? "account_id = ? AND verdict = 'ok' AND (source = 'bulk' OR source = 'human')"
    : "account_id = ? AND verdict = 'ok' AND source = 'bulk'"
  const res = db.prepare(`UPDATE content_reviews SET source = 'bulk' WHERE ${where}`).run(accountId)
  return { reopened: res.changes }
}

/**
 * 作废"输入数据不完整时下的" AI 结论：拼句/点词/跟读题需要 `aux`（句子词序）才能判断答案，
 * 而第一轮审核时这些数据没推上来 —— 实测因此误杀了 4 道好题（说"答案不在句子里"，其实在）。
 * 把它们的来源降级为 bulk，就会重新进待审队列、带着完整数据再审一遍。
 */
export function reopenIncompleteAi(accountId) {
  const db = getDb()
  const rows = db.prepare(
    `SELECT r.question_id FROM content_reviews r JOIN questions q ON q.id = r.question_id
     WHERE r.account_id = ? AND r.source = 'ai' AND q.type <> 'choice'`).all(accountId)
  const upd = db.prepare("UPDATE content_reviews SET source = 'bulk' WHERE account_id = ? AND question_id = ?")
  let n = 0
  for (const r of rows) n += upd.run(accountId, r.question_id).changes
  return { reopened: n }
}

/**
 * 后台维护日志：自动化每跑一次留一条（计数/动了谁/错在哪/耗时）。
 * summary 是结构化 JSON，查询端（db.py log、自检面板）负责拼成人话。
 */
export function writeRunLog(accountId, kind, summary = {}, error = null) {
  const db = getDb()
  db.prepare('INSERT INTO run_log (account_id, kind, summary, error, created_at) VALUES (?,?,?,?,?)')
    .run(accountId ?? null, String(kind).slice(0, 40), JSON.stringify(summary ?? {}),
      error ? String(error).slice(0, 500) : null, nowMs())
  // 日志是诊断用的，不是数据：只留最近 500 条，防无限膨胀
  db.prepare('DELETE FROM run_log WHERE id NOT IN (SELECT id FROM run_log ORDER BY id DESC LIMIT 500)').run()
  return { ok: true }
}

/** 最近的后台维护日志（新的在前）；含系统级条目（account_id 为空） */
export function listRunLog(accountId, limit = 30) {
  const rows = getDb()
    .prepare('SELECT * FROM run_log WHERE account_id = ? OR account_id IS NULL ORDER BY id DESC LIMIT ?')
    .all(accountId, Math.max(1, Math.min(200, limit)))
  return rows.map((r) => ({
    id: r.id, accountId: r.account_id, kind: r.kind,
    summary: parseJson(r.summary) ?? {}, error: r.error, at: r.created_at,
  }))
}

/** 已经出局的题：人毙的、机器毙的、账户题库里隔离的 —— 一律不再进任何送审队列 */
function killedQuestionIds(db, accountId) {
  return new Set([
    ...db.prepare("SELECT question_id FROM content_reviews WHERE account_id = ? AND verdict = 'kill'").all(accountId).map((r) => r.question_id),
    ...db.prepare("SELECT item_id FROM items WHERE account_id = ? AND review_status = 'quarantined'").all(accountId).map((r) => r.item_id),
  ])
}

/** 题库镜像行 → 审核/改稿要看的题目视图（各种题型都送审：非选择题的解析同样要查有没有用术语） */
function reviewItemOf(r) {
  const options = Array.isArray(parseJson(r.options)) ? parseJson(r.options) : []
  const aux = parseJson(r.aux) ?? {}
  return {
    id: r.id, skill: r.skill, type: r.type, prompt: r.prompt, options, answer: r.answer,
    explain: r.explain ?? null, tts: r.tts ?? null,
    // 拼句/点词/跟读题的句子在这里，不给它审核员就没法判断答案对不对
    tokens: aux.tokens ?? null, order: aux.order ?? null, target: aux.target ?? null, fix: aux.fix ?? null,
  }
}

/**
 * 该账户自己的改写过（练习端正在用的那份）：**复审必须看到与学员相同的内容**。
 * 不改这个的话，A 账户改的稿会通过全局镜像串给 B 的复审，而 B 的学员看到的还是原稿
 * —— 审过的内容和发下去的内容可能不是同一份（复核报告 #2）。
 */
function accountRewriteMap(db, accountId) {
  const out = new Map()
  for (const row of db.prepare("SELECT question_id, payload FROM enrichments WHERE account_id = ? AND kind = 'rewrite'").all(accountId)) {
    out.set(row.question_id, parseJson(row.payload) ?? {})
  }
  return out
}

/** 把该账户的改写叠加到送审题目上（与客户端 applyEnrichments 同一套覆盖规则） */
function applyRewriteToItem(item, rw) {
  if (!rw) return item
  return {
    ...item,
    prompt: rw.prompt ?? item.prompt,
    options: Array.isArray(rw.options) ? rw.options : item.options,
    explain: rw.explain ?? item.explain,
  }
}

/** 取一批"还没定过版"的题给审核员（目录里有什么就审什么，含仓库题与账户题） */
export function catalogForReview(accountId, { skipReviewed = new Set(), limit = 60 } = {}) {
  const db = getDb()
  const killed = killedQuestionIds(db, accountId)
  const rewrites = accountRewriteMap(db, accountId)
  const out = []
  for (const r of db.prepare('SELECT * FROM questions ORDER BY skill, id').all()) {
    if (killed.has(r.id) || skipReviewed.has(r.id)) continue
    out.push(applyRewriteToItem(reviewItemOf(r), rewrites.get(r.id)))
    if (out.length >= limit) break
  }
  return out
}

/**
 * 自动流水线的待办（用户拍板：「完全不需要我审核」——**人工的结论机器也复核**）。
 * 进队列：没结论的 / 只是 bulk 盲批量的 / source=human 的（单点的也复核，AI 复核不亏）/ 已经是 fix 的（改完要复审）。
 * 不进：AI 定过的 ok（不重复花钱）；任何 kill（人毙的不复活，机器毙的已出池）。
 */
export function pipelineQueue(accountId, { limit = 60 } = {}) {
  const db = getDb()
  const killed = killedQuestionIds(db, accountId)
  const rewrites = accountRewriteMap(db, accountId)
  const reviews = new Map(
    db.prepare('SELECT question_id, verdict, source FROM content_reviews WHERE account_id = ?').all(accountId)
      .map((r) => [r.question_id, r]),
  )
  const out = []
  for (const r of db.prepare('SELECT * FROM questions ORDER BY skill, id').all()) {
    if (killed.has(r.id)) continue
    const v = reviews.get(r.id)
    const needs = !v || v.verdict === 'fix' || v.source === 'bulk' || v.source === 'human'
    if (!needs) continue
    out.push(applyRewriteToItem(reviewItemOf(r), rewrites.get(r.id)))
    if (out.length >= limit) break
  }
  return out
}

export function saveEnrichment(accountId, questionId, kind, payload, model = null) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  // causes（逐项纠正）分批补时**字段级合并**：后一批不许把前一批补好的选项挤掉
  // （模型每批只看得到题面，看不到已补的内容；缺口是逐项算的，所以合并才是对的 —— 复核报告 #6）
  let toSave = payload
  if (kind === 'causes') {
    const prev = parseJson(db.prepare('SELECT payload FROM enrichments WHERE account_id = ? AND question_id = ? AND kind = ?')
      .get(accountId, questionId, kind)?.payload) ?? {}
    toSave = {
      ...prev,
      ...payload,
      optionFixes: { ...(prev.optionFixes ?? {}), ...(payload?.optionFixes ?? {}) },
      optionTags: { ...(prev.optionTags ?? {}), ...(payload?.optionTags ?? {}) },
    }
  }
  db.prepare(`INSERT INTO enrichments (account_id, question_id, kind, payload, model, created_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(account_id, question_id, kind) DO UPDATE SET
      payload = excluded.payload, model = excluded.model, created_at = excluded.created_at`)
    .run(accountId, questionId, kind, JSON.stringify(toSave), model, nowMs())
  return { ok: true }
}

/**
 * 采纳 AI 按审核意见改好的稿（解析/干扰项/释义）。**只写 enrichments（按账户）**：
 *   · 练习端（applyEnrichments）与复审端（pipelineQueue/catalogForReview 的账户级叠加）
 *     各自派生"基准题面 + 本账户改写"，两边看到的必然是同一份；
 *   · questions 镜像是**全局**的仓库基准题面 —— 改写不许写进去，否则 A 账户的改稿会串给
 *     B 账户的复审、而 B 的学员看到的还是原稿（复核报告 #2，实测复现）。
 */
export function saveRewrite(accountId, questionId, payload, model = null, { since = 0 } = {}) {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  // 过期防护（二次审查 R1）：改稿模型返回后才落库，这期间可能已有人工新结论 ——
  // 这份基于旧审核意见的改稿就作废，不许覆盖期间发生的人工判断
  if (since) {
    const rv = db.prepare('SELECT source, updated_at FROM content_reviews WHERE account_id = ? AND question_id = ?')
      .get(accountId, questionId)
    if (rv && rv.source === 'human' && rv.updated_at > since) return { saved: false, skipped: 'stale' }
  }
  const fresh = {}
  if (typeof payload?.explain === 'string' && payload.explain.trim()) fresh.explain = payload.explain.trim().slice(0, 600)
  if (Array.isArray(payload?.options)) fresh.options = payload.options.map((o) => String(o).slice(0, 200))
  if (typeof payload?.prompt === 'string' && payload.prompt.trim()) fresh.prompt = payload.prompt.trim().slice(0, 500)
  if (!Object.keys(fresh).length) return { saved: false }
  // 字段级合并：这轮只改了题干，不能把上一轮改好的解析从权威层挤掉
  const prevRow = db.prepare("SELECT payload FROM enrichments WHERE account_id = ? AND question_id = ? AND kind = 'rewrite'")
    .get(accountId, questionId)
  const prev = parseJson(prevRow?.payload) ?? {}
  const merged = { ...prev, ...fresh }
  // 改题干/选项是**影响判分的修订**：必须升内容版本，否则修订前的旧作答仍会被
  // evidence 当成有效证据（它按 contentVersion 等值过滤，见复核报告 #4）。
  // 版本比较的对象 = **上一个有效题面（基准+已有改写）与下一个有效题面**，
  // 不是拿基准比 —— 二次审查 R2 实测：拿基准比会"同稿重存升版、改回基准不升版"。
  const qrow = db.prepare('SELECT prompt, options, content_version FROM questions WHERE id = ?').get(questionId)
  if (qrow) {
    const baseOpts = parseJson(qrow.options) ?? null
    const prevOpts = Array.isArray(prev.options) ? prev.options : baseOpts
    const nextOpts = fresh.options !== undefined ? fresh.options : prevOpts
    const prevPrompt = typeof prev.prompt === 'string' ? prev.prompt : qrow.prompt
    const nextPrompt = fresh.prompt !== undefined ? fresh.prompt : prevPrompt
    const contentChanged = JSON.stringify(prevOpts) !== JSON.stringify(nextOpts) || prevPrompt !== nextPrompt
    if (contentChanged) {
      merged.contentVersion = int(prev.contentVersion, int(qrow.content_version, 1)) + 1
    }
  }
  db.prepare(`INSERT INTO enrichments (account_id, question_id, kind, payload, model, created_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(account_id, question_id, kind) DO UPDATE SET
      payload = excluded.payload, model = excluded.model, created_at = excluded.created_at`)
    .run(accountId, questionId, 'rewrite', JSON.stringify(merged), model, nowMs())
  return { saved: true }
}

export function listEnrichments(accountId, kind = null) {
  const db = getDb()
  const rows = kind
    ? db.prepare('SELECT * FROM enrichments WHERE account_id = ? AND kind = ?').all(accountId, kind)
    : db.prepare('SELECT * FROM enrichments WHERE account_id = ?').all(accountId)
  const out = {}
  for (const r of rows) {
    out[r.question_id] = { ...(out[r.question_id] ?? {}), [r.kind]: parseJson(r.payload) ?? {}, model: r.model, at: r.created_at }
  }
  return out
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
