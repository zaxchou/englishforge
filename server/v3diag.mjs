// W2：入口诊断（docs/curriculum-v4/14 题序 + 15 §6 诊断停止）。
//
// 流程（W2 fixture 版）：D1 文字关系 →（错则）D1b 熟词对照定位 → D2 声音（fixture 模拟）
// →（错则）D2b 校对稿复核 → D3 口述（fixture 打字版，口语证据保持未测）→ D4 停止说明。
// 诊断只决定“近期最值当的一步”，不宣布总等级；requestId 幂等。
import { ApiError } from './db.mjs'
import { ensureV3Schema } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { activityById, publicActivity } from './v3evidence.mjs'
import { computePlan } from './v3plan.mjs'

const STEP_FLOW = {
  D1: { activityId: 'diag_d1_read' },
  D1b: { activityId: 'diag_d1b_contrast' },
  D2: { activityId: 'diag_d2_listen_sim' },
  D2b: { activityId: 'diag_d2b_transcript_recheck' },
  D3: { activityId: 'diag_d3_oral_typed' },
}

/** POST /diagnostics：requestId 幂等开一场入口诊断，返回当前步骤与学习者可见的活动 */
export function startDiagnostic(accountId, { requestId, note } = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  if (requestId) {
    const prev = conn.prepare('SELECT * FROM diagnostic_sessions WHERE account_id = ? AND request_id = ?').get(accountId, requestId)
    if (prev) return sessionView(prev)
  }
  const diagnosticId = `diag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  conn.prepare(
    `INSERT INTO diagnostic_sessions (account_id, diagnostic_id, request_id, status, steps, tentative, created_at, updated_at)
     VALUES (?,?,?,'open','[]',NULL,?,?)`,
  ).run(accountId, diagnosticId, requestId ?? null, now, now)
  const row = conn.prepare('SELECT * FROM diagnostic_sessions WHERE account_id = ? AND diagnostic_id = ?').get(accountId, diagnosticId)
  return sessionView(row, { note })
}

export function getDiagnostic(accountId, diagnosticId) {
  requireAccount(accountId)
  const row = ensureV3Schema().prepare('SELECT * FROM diagnostic_sessions WHERE account_id = ? AND diagnostic_id = ?')
    .get(accountId, diagnosticId)
  if (!row) throw new ApiError(404, 'DIAGNOSTIC_NOT_FOUND: ' + diagnosticId)
  return sessionView(row)
}

/**
 * 尝试落到诊断会话后推进：按 14 号文档的分流表决定下一步；
 * 结束时给 D4 说明（暂定强项/根因假设/未测区域/下一课方向），并触发一次重规划。
 */
export function advanceDiagnostic(accountId, sessionId, { activityId, pass, evaluationStatus }) {
  const conn = ensureV3Schema()
  const row = conn.prepare('SELECT * FROM diagnostic_sessions WHERE account_id = ? AND diagnostic_id = ?').get(accountId, sessionId)
  if (!row || row.status !== 'open') return null
  const session = { steps: JSON.parse(row.steps || '[]') }
  const stepName = Object.entries(STEP_FLOW).find(([, v]) => v.activityId === activityId)?.[0]
  if (!stepName) return null
  session.steps.push({ step: stepName, activityId, attemptId: null, pass: pass === true, evaluationStatus, at: Date.now() })

  const byStep = Object.fromEntries(session.steps.map((s) => [s.step, s]))
  const next = nextStep(stepName, byStep)
  session.steps[session.steps.length - 1].nextStep = next ?? null
  const tentative = next ? null : buildTentative(byStep)

  conn.prepare('UPDATE diagnostic_sessions SET steps = ?, tentative = ?, status = ?, updated_at = ? WHERE account_id = ? AND diagnostic_id = ?')
    .run(JSON.stringify(session.steps), tentative ? JSON.stringify(tentative) : row.tentative,
      next ? 'open' : 'completed', Date.now(), accountId, sessionId)

  let plan = null
  if (!next) plan = computePlan(accountId, { triggerEvent: sessionId }) // D4：证据够选近期课就停止（15 §6）

  const fresh = conn.prepare('SELECT * FROM diagnostic_sessions WHERE account_id = ? AND diagnostic_id = ?').get(accountId, sessionId)
  return sessionView(fresh, { plan })
}

function nextStep(stepName, byStep) {
  if (stepName === 'D1') return byStep.D1.pass ? 'D2' : 'D1b'
  if (stepName === 'D1b') return 'D2'
  if (stepName === 'D2') return byStep.D2.pass ? 'D3' : 'D2b'
  if (stepName === 'D2b') return 'D3'
  return null // D3 结束：够了——能选近期课就停，别拖成长测评（15 §6）
}

function buildTentative(byStep) {
  const hypotheses = []
  if (byStep.D1 && !byStep.D1.pass) {
    hypotheses.push(byStep.D1b?.pass ? 'relation_modifier_or_retention' : 'contrast_or_lexicon')
  }
  if (byStep.D2 && !byStep.D2.pass) {
    hypotheses.push(byStep.D2b?.pass ? 'sound_segmentation_or_realtime' : 'structure_or_lexicon_also_in_audio')
  }
  const readingOk = !!byStep.D1?.pass
  const listeningSimOk = !!byStep.D2?.pass
  const oralTypedOk = !!byStep.D3?.pass

  let route, primaryGoal, strategyId
  if (!readingOk) { route = 'L1'; primaryGoal = 'O-K115-01'; strategyId = 'short_explain' }
  else if (!listeningSimOk) { route = 'L2'; primaryGoal = 'O-K007-02'; strategyId = 'sound_segmentation' }
  else if (!oralTypedOk) { route = 'L3'; primaryGoal = 'O-K190-01'; strategyId = 'oral_retrieval' }
  else { route = 'challenge_first'; primaryGoal = 'O-K184-03'; strategyId = 'challenge_first' }

  return {
    strongPoints: [
      ...(readingOk ? ['O-K115 组文字关系（D1）'] : []),
      ...(listeningSimOk ? ['讲授主张与限制（D2 模拟音频）'] : []),
    ],
    hypotheses,
    // fixture 之外的诚实声明：真实原声、自由口述、写作都还没测（16：W5 前无原声）
    unmeasured: ['listening_real_audio', 'speaking_free_oral', 'writing', 'spontaneous_interaction'],
    route, primaryGoal, strategyId,
    stopReason: '已足够选择近期课程；后续每课继续测未测项（D4）',
  }
}

function sessionView(row, extra = {}) {
  const steps = JSON.parse(row.steps || '[]')
  const current = row.status === 'open' ? (steps[steps.length - 1]?.nextStep ?? 'D1') : null
  const nextStepName = current ?? null
  return {
    diagnosticId: row.diagnostic_id,
    status: row.status,
    steps: steps.map((s) => ({ step: s.step, activityId: s.activityId, pass: s.pass, evaluationStatus: s.evaluationStatus })),
    step: nextStepName,
    activity: nextStepName ? publicActivity(activityById(STEP_FLOW[nextStepName].activityId)) : null,
    measured: [...new Set(steps.filter((s) => s.pass).map((s) => s.step))],
    unmeasured: row.status === 'completed'
      ? (JSON.parse(row.tentative || '{}').unmeasured ?? [])
      : ['listening_real_audio', 'speaking_free_oral', 'writing'],
    tentative: row.tentative ? JSON.parse(row.tentative) : null,
    ...extra,
  }
}
