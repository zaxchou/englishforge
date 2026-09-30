// curriculum-v4 新域数据库（W0–W2 实施合同，见 docs/curriculum-v4/15 §4）
//
// 铁律（15 §1/§4/§13）：
// · 新域建**新表**，绝不原地改写旧题、旧 attempts、旧 ProgressV2 —— 旧系统照常运转；
// · 旧数据只做**只读映射**（候选诊断线索），永远不自动换算成新能力认证；
// · 发布过的目标版本不可静默覆盖（trigger 强制）：改目标 = 插入新版本；
// · 所有新表都带 account_id，读写都限定账户范围。
import { getDb } from './db.mjs'

const V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS coverage_groups (
  group_id               TEXT PRIMARY KEY,      -- K001
  unit_id                TEXT NOT NULL,         -- U01
  title                  TEXT NOT NULL,
  complexity_band        TEXT,
  reference_scope        TEXT,                  -- JSON 数组：CGEL-1;…
  transcript_anchors     TEXT,                  -- JSON 数组：C01;…
  unit_exit_task         TEXT,
  priority               TEXT,                  -- full_scope | first_path
  atomization_status     TEXT,                  -- pending | partial_draft | decomposed | verified
  atomic_target_ids      TEXT,                  -- JSON 数组
  leaf_source_refs       TEXT,                  -- JSON 数组
  fact_review_status     TEXT,                  -- pending | partial_claim_checked | claim_checked
  teaching_contract_status TEXT,
  skill_exit_status      TEXT,
  work_package           TEXT,
  notes                  TEXT,
  owner                  TEXT NOT NULL DEFAULT 'zcode',
  updated_at             INTEGER
);

CREATE TABLE IF NOT EXISTS objective_versions (
  objective_id   TEXT NOT NULL,
  version        INTEGER NOT NULL,
  parent_group   TEXT NOT NULL,
  unit_id        TEXT,
  layer          TEXT NOT NULL,                -- structure | sound | lexicon_chunks | discourse | interaction
  name           TEXT NOT NULL,
  behavior       TEXT NOT NULL,                -- 可观察行为 + 条件（判分口径在边界里）
  boundary       TEXT NOT NULL,                -- 形式—意义—使用边界：能判什么、不能判什么
  prerequisites  TEXT NOT NULL DEFAULT '[]',   -- JSON：目标 ID 数组（不许只写单元号）
  prereq_notes   TEXT,                         -- 前置还没有原子目标时的诚实说明
  misconceptions TEXT NOT NULL DEFAULT '[]',   -- JSON：可区分的常见错误
  task_families  TEXT NOT NULL DEFAULT '[]',   -- JSON
  skills         TEXT NOT NULL DEFAULT '{}',   -- JSON：四技能出口 {reading:'primary',…}
  skill_not_applicable TEXT,                   -- 技能不适用说明（防止跨技能升级）
  complexity_dims TEXT NOT NULL DEFAULT '[]',  -- JSON
  strategies     TEXT NOT NULL DEFAULT '[]',   -- JSON：教学策略候选
  source_refs    TEXT NOT NULL DEFAULT '[]',   -- JSON：[{ref,kind,claim,status,url?}]
  verification   TEXT NOT NULL DEFAULT 'design_rationale',
                 -- claim_checked | design_rationale（| fact_verified 仅在逐条核验后）
  flags          TEXT NOT NULL DEFAULT '[]',   -- JSON：needs_audio / design_rationale / scoring_needs_human_trial
  status         TEXT NOT NULL DEFAULT 'draft',-- draft | published（published 不可改，只能出新版本）
  owner          TEXT NOT NULL DEFAULT 'zcode',
  first_path     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (objective_id, version)
);

-- 发布过的版本是历史证据的锚：旧 evidence 绑定原版本，改目标只能开新版本
CREATE TRIGGER IF NOT EXISTS trg_objective_versions_published_immutable
BEFORE UPDATE ON objective_versions
WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'OBJECTIVE_VERSION_PUBLISHED_IMMUTABLE: 发布过的目标版本不可覆盖，请新增版本');
END;

CREATE TABLE IF NOT EXISTS learner_attempts_v3 (
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attempt_id        TEXT NOT NULL,
  session_id        TEXT,                      -- diagnosticId / 课程会话
  activity_id       TEXT NOT NULL,
  activity_version  INTEGER NOT NULL,
  objective_ids     TEXT NOT NULL,             -- JSON 数组
  task_family_id    TEXT,
  role              TEXT NOT NULL,             -- practice | diagnostic | transfer | holdout
  response_kind     TEXT NOT NULL DEFAULT 'text',
  response          TEXT,                      -- JSON/文本（录音只存引用，不进这列）
  conditions        TEXT NOT NULL,             -- JSON：首见/提示/字幕/播放次数/查词/作答方式
  evaluation_status TEXT NOT NULL DEFAULT 'pending', -- pending | evaluated | disputed
  evaluation        TEXT,                      -- JSON：维度结果、依据、评估者、置信
  disputed_reason   TEXT,
  body_hash         TEXT NOT NULL,             -- 幂等：同 ID 同正文重放返回首次结果，同 ID 异正文 409
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (account_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS ix_v3attempts_time ON learner_attempts_v3(account_id, created_at);

CREATE TABLE IF NOT EXISTS evidence_events (
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  evidence_id  TEXT NOT NULL,
  attempt_id   TEXT,                           -- 派生型事件（撤销复核等）可以为空
  objective_id TEXT NOT NULL,
  skill        TEXT NOT NULL,                  -- listening | speaking | reading | writing | interaction
  complexity   TEXT NOT NULL DEFAULT 'base',
  kind         TEXT NOT NULL,                  -- observed | dispute | dispute_cleared | waive | repair
  condition    TEXT NOT NULL DEFAULT 'unknown',-- first_independent | hinted | transcript_shown | …
  pass         INTEGER,                        -- observed 事件才有
  basis        TEXT,                           -- 评估者/模型版本/依据
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS ix_ee_obj ON evidence_events(account_id, objective_id, skill);

CREATE TABLE IF NOT EXISTS learner_states (
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  objective_id     TEXT NOT NULL,
  skill            TEXT NOT NULL,
  complexity       TEXT NOT NULL DEFAULT 'base',
  state            TEXT NOT NULL DEFAULT 'unmeasured',
                   -- unmeasured|tentative|trained|independent|transferred|retained
  flags            TEXT NOT NULL DEFAULT '[]', -- JSON：waived_by_user | disputed | needs_repair
  evidence_version INTEGER NOT NULL DEFAULT 0, -- 可从 evidence_events 重建；这里只做快照序号
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (account_id, objective_id, skill, complexity)
);

CREATE TABLE IF NOT EXISTS plan_decisions (
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  decision_id      TEXT NOT NULL,
  request_id       TEXT,                       -- 同 requestId 重放返回同一决策
  trigger_event    TEXT,
  map_version      TEXT,
  evidence_version INTEGER NOT NULL DEFAULT 0,
  snapshot         TEXT NOT NULL,              -- JSON：证据快照（决策可回放的根据）
  candidates       TEXT NOT NULL DEFAULT '[]', -- JSON：[{objectiveId, reason}]（含被排除者及理由）
  primary_goal     TEXT,
  strategy_id      TEXT,
  reason           TEXT,
  hypotheses       TEXT NOT NULL DEFAULT '[]', -- JSON
  uncertain_areas  TEXT NOT NULL DEFAULT '[]', -- JSON
  lesson_ref       TEXT,                       -- JSON：{activityId,version,role,status}；holdout 永不出现在这
  served_lesson_id TEXT,                       -- 结构化课号（避免在 JSON 上 LIKE 匹配）
  status           TEXT NOT NULL DEFAULT 'ready', -- candidate|ready|served|completed|skipped|invalidated
  invalidated_reason TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (account_id, decision_id)
);
CREATE INDEX IF NOT EXISTS ix_pd_req ON plan_decisions(account_id, request_id);

-- W3：课程包版本（15 §4/§5）。修订从新版本 draft 开始；published 版本与作答保留可回看
CREATE TABLE IF NOT EXISTS lesson_versions (
  account_scope  TEXT NOT NULL DEFAULT 'global', -- 课程是全局内容，不挂账户；保留列以备未来定制课
  lesson_id      TEXT NOT NULL,
  version        INTEGER NOT NULL,
  title          TEXT NOT NULL,
  why_now        TEXT NOT NULL,                -- 为什么现在学这个
  teaching_note  TEXT,                         -- 精华讲解/教学要点（15 §7 课包必含）
  strategy_id    TEXT,
  objective_ids  TEXT NOT NULL DEFAULT '[]',   -- JSON：版本化目标引用
  difficulty_dims TEXT NOT NULL DEFAULT '[]',  -- JSON
  activity_refs  TEXT NOT NULL DEFAULT '[]',   -- JSON：[{activityId, version, role, hintStages, unlockAfter}]
  next_candidates TEXT NOT NULL DEFAULT '[]',  -- JSON：下一课候选（纯 ID）
  source_refs    TEXT NOT NULL DEFAULT '[]',   -- JSON
  holdout_ref    TEXT,                         -- 独立保留任务引用（答案永不下发）
  quality_gates  TEXT NOT NULL DEFAULT '{}',   -- JSON：各质量门结果
  human_review   TEXT NOT NULL DEFAULT 'pending', -- pending | signed（人审签署；签署只此一个方向）
  release_channel TEXT NOT NULL DEFAULT 'dev_only', -- dev_only（开发样本）| mainline（人审签署后）
  content_status TEXT NOT NULL DEFAULT 'draft',
                 -- draft→checking→review_needed/ready→published→withdrawn（15 §5）
  withdrawn_reason TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (lesson_id, version)
);

-- published 课程包的内容字段是作答历史的锚：任何内容改动一律 ABORT（合法撤回只动状态两列）
CREATE TRIGGER IF NOT EXISTS trg_lesson_versions_published_immutable
BEFORE UPDATE ON lesson_versions
WHEN OLD.content_status = 'published'
  AND (NEW.title != OLD.title OR NEW.why_now != OLD.why_now OR NEW.teaching_note != OLD.teaching_note
       OR NEW.activity_refs != OLD.activity_refs OR NEW.objective_ids != OLD.objective_ids
       OR NEW.next_candidates != OLD.next_candidates OR NEW.source_refs != OLD.source_refs
       OR NEW.holdout_ref != OLD.holdout_ref OR NEW.strategy_id != OLD.strategy_id
       OR NEW.difficulty_dims != OLD.difficulty_dims)
BEGIN
  SELECT RAISE(ABORT, 'LESSON_VERSION_PUBLISHED_IMMUTABLE: 发布过的课程包内容不可改写，请新增版本');
END;

-- withdrawn 不可复活成 published：修订从新版本 draft 开始（15 §5）
CREATE TRIGGER IF NOT EXISTS trg_lesson_versions_withdrawn_terminal
BEFORE UPDATE ON lesson_versions
WHEN OLD.content_status = 'withdrawn' AND NEW.content_status IN ('published', 'ready', 'checking', 'draft')
BEGIN
  SELECT RAISE(ABORT, 'LESSON_WITHDRAWN_TERMINAL: 已撤回版本不可重新发布，请新增版本');
END;

-- 提示/字幕揭示记录：服务端据此覆盖客户端自报的支持条件（15 §12 不信任自报）
CREATE TABLE IF NOT EXISTS activity_support_events (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  kind        TEXT NOT NULL,                   -- hint | transcript
  level       INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, activity_id, kind, level)
);

CREATE TABLE IF NOT EXISTS diagnostic_sessions (
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  diagnostic_id TEXT NOT NULL,
  request_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | completed
  steps         TEXT NOT NULL DEFAULT '[]',    -- JSON：[{step,activityId,attemptId,pass,conditions}]
  tentative     TEXT,                          -- JSON：强项/根因假设/未测区域（D4 说明）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, diagnostic_id)
);

-- 账户级计数器（证据版本号等）
CREATE TABLE IF NOT EXISTS v3_counters (
  account_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, name)
);

-- 账户级小状态（holdout 隔离名单等）
CREATE TABLE IF NOT EXISTS v3_meta (
  account_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  PRIMARY KEY (account_id, key)
);
`

let ensured = false

/** 幂等建表：在旧库旁边加新表，不碰任何旧对象。首次调用后进程内不再重复执行 */
export function ensureV3Schema(conn = getDb()) {
  if (ensured) return conn
  conn.exec(V3_SCHEMA)
  // v3 表自己的补列迁移：CREATE TABLE IF NOT EXISTS 不会给**已存在**的表加列
  ensureV3Columns(conn, 'lesson_versions', [
    ['teaching_note', 'TEXT'],
    ['release_channel', "TEXT NOT NULL DEFAULT 'dev_only'"],
  ])
  ensureV3Columns(conn, 'plan_decisions', [['served_lesson_id', 'TEXT']])
  ensured = true
  return conn
}

function ensureV3Columns(conn, table, spec) {
  const have = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name))
  for (const [name, type] of spec) {
    if (!have.has(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
  }
}

export function nextCounter(accountId, name) {
  const conn = ensureV3Schema()
  conn.prepare(
    `INSERT INTO v3_counters (account_id, name, value) VALUES (?,?,1)
     ON CONFLICT(account_id, name) DO UPDATE SET value = value + 1`,
  ).run(accountId, name)
  return conn.prepare('SELECT value FROM v3_counters WHERE account_id = ? AND name = ?').get(accountId, name).value
}

export function getCounter(accountId, name) {
  const conn = ensureV3Schema()
  const row = conn.prepare('SELECT value FROM v3_counters WHERE account_id = ? AND name = ?').get(accountId, name)
  return row ? row.value : 0
}

export function setMeta(accountId, key, value) {
  ensureV3Schema().prepare(
    `INSERT INTO v3_meta (account_id, key, value) VALUES (?,?,?)
     ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value`,
  ).run(accountId, key, value)
}

export function getMeta(accountId, key) {
  const row = ensureV3Schema().prepare('SELECT value FROM v3_meta WHERE account_id = ? AND key = ?').get(accountId, key)
  return row ? row.value : null
}

// ---------------------------------------------------------------- W0：旧数据只读映射

/**
 * 旧记录 → 新系统的**候选线索**清单（15 §13 的迁移判定表）。
 * 只读：不写 learner_states、不发 evidence 事件 —— 旧 XP/box/ladder/reviewed
 * 永远不自动换算成新能力认证；它们只能提示"可以从哪里开始测"。
 */
export function oldRecordMap(accountId) {
  const conn = getDb()
  const acc = conn.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId)
  if (!acc) return null
  const one = (sql, ...args) => conn.prepare(sql).get(...args)

  const oldAttempts = one('SELECT COUNT(*) AS n FROM attempts WHERE account_id = ?', accountId).n
  const oldFirstDeterministic = one(
    `SELECT COUNT(*) AS n FROM attempts WHERE account_id = ? AND first_attempt = 1
       AND outcome = 'correct' AND evaluator = 'deterministic'`, accountId).n
  const oldSpeak = one(
    `SELECT COUNT(*) AS n FROM attempts WHERE account_id = ? AND mode = 'speak'`, accountId).n
  const oldSessions = one('SELECT COUNT(*) AS n FROM practice_sessions WHERE account_id = ?', accountId).n
  const oldKilled = one(
    `SELECT COUNT(*) AS n FROM content_reviews WHERE account_id = ? AND verdict = 'kill'`, accountId).n
  const oldItems = one(
    `SELECT COUNT(*) AS n FROM items WHERE account_id = ? AND review_status = 'reviewed'`, accountId).n
  const snapshots = one('SELECT COUNT(*) AS n FROM snapshots WHERE account_id = ?', accountId).n

  return {
    accountId,
    generatedAt: Date.now(),
    readOnly: true,
    oldCounts: {
      attempts: oldAttempts,
      firstTryDeterministicCorrect: oldFirstDeterministic,
      speakAttempts: oldSpeak,
      practiceSessions: oldSessions,
      reviewedItems: oldItems,
      killedItems: oldKilled,
      snapshots,
    },
    hints: {
      // 只能提示入口诊断从哪层开始测，不构成任何新目标的状态
      candidateDiagnosticHints: oldFirstDeterministic > 0
        ? ['旧题首次确定性答对较多 → 入口诊断允许快速跨过最低层（仍须新任务证实）']
        : ['无显著旧证据 → 入口诊断从 D1 文字关系开始'],
      speakEntryHint: oldSpeak > 0
        ? '曾做过跟读/目标句复述 → 口语入口可从短述开始尝试（不等于已有自主表达证据）'
        : '无跟读记录 → 口语从首次录音任务开始',
    },
    forbidden: [
      '旧 reviewed / 首次答对不得认证听力、自由口语或跨场景保持',
      '旧 XP、题量、box、ladder 层级不得转换为新目标完成比例',
      '旧被 kill/fix/争议题不得因曾做对而放行相关目标',
    ],
  }
}
