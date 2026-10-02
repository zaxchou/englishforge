// 托福产品层数据库（59 号 S1；合同见 57/56/55）。
//
// 铁律（继承 v3db 的做法，55 §11–12）：
// · 全部新表 toefl_ 前缀，account_id 范围读写；旧应用表（attempts/skill_progress/v3_*）一律不碰；
// · 不把托福进度换算进旧能力状态，也不反向；
// · Attempt 提交幂等：UNIQUE(account_id, idempotency_key)，重复请求返回同一条；
// · Feedback 版本递增不覆盖；错题按 (account, question_family_id) 去重，首错保留。
import { getDb } from '../db.mjs'

let ensured = false

const SCHEMA = `
CREATE TABLE IF NOT EXISTS toefl_profile (
  account_id  TEXT PRIMARY KEY,
  fields      TEXT NOT NULL DEFAULT '{}',   -- {target:{value,source,at}, exam_date:{...}, focus:{...}, background:[{id,label,value,source,at}], habits:{...}}
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS toefl_resume (
  account_id    TEXT NOT NULL,
  part          TEXT NOT NULL,              -- listening|reading|writing|speaking
  chapter_id    TEXT,
  activity      TEXT,                       -- learn|practice|review
  media_id      TEXT,
  last_position REAL NOT NULL DEFAULT 0,
  updated_at    INTEGER,
  PRIMARY KEY (account_id, part)
);

CREATE TABLE IF NOT EXISTS toefl_viewing (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  part       TEXT NOT NULL,
  media_id   TEXT NOT NULL,
  start_s    REAL NOT NULL,
  end_s      REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS toefl_media_progress (
  account_id    TEXT NOT NULL,
  media_id      TEXT NOT NULL,
  last_position REAL NOT NULL DEFAULT 0,
  speed         REAL NOT NULL DEFAULT 1,
  updated_at    INTEGER,
  PRIMARY KEY (account_id, media_id)
);

CREATE TABLE IF NOT EXISTS toefl_attempts (
  attempt_id       TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  part             TEXT NOT NULL,
  chapter_id       TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'course_first',  -- course_first | retry | timed_check
  status           TEXT NOT NULL DEFAULT 'saved',         -- saved|submitted|analyzing|analyzed|failed
  answers          TEXT,                   -- {questionId: optionIndex}（封闭题）
  draft            TEXT,                   -- 开放题文本/写作第一稿
  audio_media      TEXT,                   -- 口语录音存档名（server/assets/toefl-attempts/ 下）
  draft_transcript TEXT,                   -- 口语本人补录文字稿
  transcript_origin TEXT,                  -- user_typed | asr(预留)
  created_at       INTEGER NOT NULL,
  submitted_at     INTEGER,
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS toefl_feedback (
  feedback_id TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed
  output      TEXT,                             -- 老师结构化 JSON
  error       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS toefl_support_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- replay|dictionary|hint|transcript_shown
  at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS toefl_errors (
  error_id           TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL,
  question_family_id TEXT NOT NULL,
  part               TEXT NOT NULL,
  chapter_id         TEXT,
  task_id            TEXT,
  kind               TEXT NOT NULL,        -- first_wrong|guessed|self_noted|open_feedback
  title              TEXT NOT NULL,
  detail             TEXT,
  first_answer       TEXT,
  tag                TEXT,
  status             TEXT NOT NULL DEFAULT 'pending_review',
      -- pending_review → reviewed → awaiting_new_check → verified；旁路：disputed | analyze_failed
  retries            INTEGER NOT NULL DEFAULT 0,   -- 尝试次数单列（55 §9：同题重试不加独立样本）
  hypothesis         TEXT,                 -- {statement,confidence} 错因先标假设
  user_response      TEXT,                 -- confirmed|disputed|null
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER,
  UNIQUE (account_id, question_family_id)
);

CREATE TABLE IF NOT EXISTS toefl_notes (
  account_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  PRIMARY KEY (account_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS toefl_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  kind       TEXT NOT NULL,    -- open|jump|submit|complete|review|verify|method_done|resume|...
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS toefl_verifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  error_id   TEXT NOT NULL,
  result     TEXT NOT NULL,    -- passed|failed|deferred_no_pool
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_toefl_attempts_acc ON toefl_attempts (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_toefl_errors_acc ON toefl_errors (account_id, status);
CREATE INDEX IF NOT EXISTS idx_toefl_events_acc ON toefl_events (account_id, created_at);
`

export function ensureToeflSchema() {
  const db = getDb()
  if (!ensured) {
    db.exec(SCHEMA)
    ensured = true
  }
  return db
}

/** 测试用：换库后重置惰性标记 */
export function __resetToeflSchema() { ensured = false }
