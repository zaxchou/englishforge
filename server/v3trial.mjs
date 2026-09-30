// W6：本人试学工具包（docs/curriculum-v4/13 §9 A10/T9、15 §10 T9、00 §4 P6）。
//
// 核心纪律：**先预注册，后施测**——基线/后测任务与评分维度在试学前冻结（13 §9：
// 不能试完后才选指标）；对比只认"同条件陌生材料"的作答（熟题提速不算达标，A10）；
// 原始作品与支持条件全程保留；本模块只做机制与记录，**不宣称任何学习效果**——
// 效果结论等真人两周试学后由人工判定。
import { randomBytes } from 'node:crypto'
import { ApiError } from './db.mjs'
import { ensureV3Schema } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'

// 试学注册表：trial_registrations（先于任何基线作答创建，注册后不可改任务定义）
function ensureTrialSchema(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS trial_registrations (
      account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      trial_id        TEXT NOT NULL,
      label           TEXT NOT NULL,
      skill           TEXT NOT NULL,
      baseline_task   TEXT NOT NULL,   -- JSON：{taskFamilyId, materialRef, dimensions, passRule}
      post_task       TEXT NOT NULL,   -- JSON：同规格陌生材料（不同讲者/内容/措辞）
      delay_task      TEXT,            -- JSON：数周后另一场景任务（可选）
      registered_at   INTEGER NOT NULL,
      PRIMARY KEY (account_id, trial_id)
    );
    CREATE TABLE IF NOT EXISTS trial_observations (
      account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      trial_id     TEXT NOT NULL,
      phase        TEXT NOT NULL,    -- baseline | post | delay
      attempt_id   TEXT NOT NULL,
      material_was_novel INTEGER NOT NULL DEFAULT 1, -- 非陌生材料的观察不计入对比
      support_snapshot TEXT NOT NULL,  -- JSON：字幕/提示/查词/播放次数（同条件判定的根据）
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (account_id, trial_id, phase)
    );
  `)
  return conn
}

/** 预注册：试学前冻结任务对（基线/后测/延迟）与评分维度 */
export function registerTrial(accountId, { label, skill, baselineTask, postTask, delayTask } = {}) {
  requireAccount(accountId)
  for (const [name, t] of [['baselineTask', baselineTask], ['postTask', postTask]]) {
    if (!t?.taskFamilyId || !t?.materialRef || !Array.isArray(t.dimensions) || !t.dimensions.length) {
      throw new ApiError(400, `TRIAL_REGISTRATION_INCOMPLETE: ${name} 需要 taskFamilyId/materialRef/dimensions`)
    }
  }
  if (baselineTask.taskFamilyId === postTask.taskFamilyId) {
    throw new ApiError(400, 'TRIAL_TASKS_MUST_DIFFER: 前后测不得同任务家族（陌生性要求）')
  }
  const conn = ensureTrialSchema(ensureV3Schema())
  const trialId = `trial_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
  conn.prepare(
    `INSERT INTO trial_registrations (account_id, trial_id, label, skill, baseline_task, post_task, delay_task, registered_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(accountId, trialId, String(label || '未命名试学'), skill,
    JSON.stringify(baselineTask), JSON.stringify(postTask), delayTask ? JSON.stringify(delayTask) : null, Date.now())
  return { trialId, label, skill, registeredAt: Date.now(), note: '任务与量表已冻结（13 §9：不能试完后才选指标）' }
}

/** 记录观察：绑定 attempt（陌生材料才计入对比；support 快照用于同条件判定） */
export function recordObservation(accountId, { trialId, phase, attemptId, materialWasNovel = true, support = {} } = {}) {
  requireAccount(accountId)
  if (!['baseline', 'post', 'delay'].includes(phase)) throw new ApiError(400, 'TRIAL_PHASE_INVALID')
  const conn = ensureTrialSchema(ensureV3Schema())
  const reg = conn.prepare('SELECT * FROM trial_registrations WHERE account_id = ? AND trial_id = ?').get(accountId, trialId)
  if (!reg) throw new ApiError(404, 'TRIAL_NOT_FOUND: ' + trialId)
  const attempt = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)
  if (!attempt) throw new ApiError(404, 'ATTEMPT_NOT_FOUND: ' + attemptId)
  // 陌生性核对：attempt 的任务家族必须与该 phase 预注册任务一致
  const task = JSON.parse(reg[phase === 'baseline' ? 'baseline_task' : phase === 'post' ? 'post_task' : 'delay_task'] || '{}')
  if (task.taskFamilyId && attempt.task_family_id !== task.taskFamilyId) {
    throw new ApiError(400, 'TRIAL_TASK_FAMILY_MISMATCH: 该 attempt 不是预注册的任务家族')
  }
  conn.prepare(
    `INSERT OR REPLACE INTO trial_observations (account_id, trial_id, phase, attempt_id, material_was_novel, support_snapshot, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(accountId, trialId, phase, attemptId, materialWasNovel ? 1 : 0, JSON.stringify(support), Date.now())
  return { ok: true, trialId, phase, counted: !!materialWasNovel }
}

/** 对比：同条件陌生材料前后测并排（原始作品 + 支持条件 + 分维度结论留白给人工） */
export function compareTrial(accountId, trialId) {
  requireAccount(accountId)
  const conn = ensureTrialSchema(ensureV3Schema())
  const reg = conn.prepare('SELECT * FROM trial_registrations WHERE account_id = ? AND trial_id = ?').get(accountId, trialId)
  if (!reg) throw new ApiError(404, 'TRIAL_NOT_FOUND: ' + trialId)
  const obs = conn.prepare('SELECT * FROM trial_observations WHERE account_id = ? AND trial_id = ?').all(accountId, trialId)
  const pick = (phase) => {
    const o = obs.find((x) => x.phase === phase)
    if (!o) return null
    const a = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, o.attempt_id)
    return a ? {
      attemptId: a.attempt_id, activityId: a.activity_id, response: JSON.parse(a.response || '{}'),
      conditions: JSON.parse(a.conditions || '{}'), evaluation: JSON.parse(a.evaluation || 'null'),
      counted: !!o.material_was_novel, support: JSON.parse(o.support_snapshot || '{}'),
    } : null
  }
  return {
    trialId, label: reg.label, skill: reg.skill,
    registration: { baseline: JSON.parse(reg.baseline_task), post: JSON.parse(reg.post_task), delay: reg.delay_task ? JSON.parse(reg.delay_task) : null },
    baseline: pick('baseline'), post: pick('post'), delay: pick('delay'),
    verdict: null,
    note: '机制只负责并排原始作品与条件；效果结论由人工按预注册量表判定——熟题提速不算达标（A10），N=1 只验证本人',
  }
}

export function listTrials(accountId) {
  requireAccount(accountId)
  const conn = ensureTrialSchema(ensureV3Schema())
  return conn.prepare('SELECT trial_id, label, skill, registered_at FROM trial_registrations WHERE account_id = ? ORDER BY registered_at DESC').all(accountId)
}
