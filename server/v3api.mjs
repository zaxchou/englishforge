// /api/v1 新域路由（curriculum-v4 实施合同 15 §8）。
//
// 与旧 /api/accounts/:id/sync 完全并行：旧契约一个字都不动，新域新表新语义。
// 错误码沿用 handleApi 的 {status, json:{error}}；合同错误码写在 message 前缀里，
// 例如 'REQUEST_ID_REUSED_WITH_DIFFERENT_BODY: …'。
import { ApiError, getAccount } from './db.mjs'
import { ensureV3Schema, oldRecordMap } from './v3db.mjs'
import { mapIndex, rowToObjective } from './v3map.mjs'
import { recordAttempt, evidenceSummary, waive, reportContent } from './v3evidence.mjs'
import { startDiagnostic, getDiagnostic, advanceDiagnostic } from './v3diag.mjs'
import { getPlan, recomputePlan } from './v3plan.mjs'
import { serveLesson, revealHint, completeLesson, listLessons, seedLessons, withdrawLesson, publishLesson, signLesson } from './v3lessons.mjs'

export const V3_ROUTES = [
  ['GET', '/api/v1/health', () => {
    ensureV3Schema()
    return { ok: true, domain: 'curriculum-v4', stage: 'W0-W2', time: Date.now() }
  }],

  // W1：能力目标与来源账本（R01）。未核验的组/目标明示状态，绝不显示“已覆盖”
  ['GET', '/api/v1/map', (ctx) => {
    return mapIndex({
      group: ctx.query.get('group') || undefined,
      status: ctx.query.get('status') || undefined,
    })
  }],
  ['GET', '/api/v1/map/objectives/:objectiveId', (ctx) => {
    mapIndex() // 触发种子幂等落库
    const rows = ensureV3Schema().prepare('SELECT * FROM objective_versions WHERE objective_id = ? ORDER BY version DESC')
      .all(ctx.params.objectiveId)
    if (!rows.length) throw new ApiError(404, 'OBJECTIVE_NOT_FOUND: ' + ctx.params.objectiveId)
    return { objective: rowToObjective(rows[0]), allVersions: rows.map((r) => r.version) }
  }],

  // W0：旧数据只读映射 —— 迁移判定的透明化，不写任何新状态（15 §13）
  ['GET', '/api/v1/accounts/:id/legacy-map', (ctx) => {
    requireAccount(ctx.params.id)
    const map = oldRecordMap(ctx.params.id)
    if (!map) throw new ApiError(404, 'ACCOUNT_NOT_FOUND: ' + ctx.params.id)
    return map
  }],

  // ---------------------------------------------------------------- W2：诊断 / 尝试 / 证据 / 决策

  ['POST', '/api/v1/accounts/:id/diagnostics', (ctx) => {
    return startDiagnostic(ctx.params.id, {
      requestId: ctx.body?.requestId,
      note: ctx.body?.note,
    })
  }],
  ['GET', '/api/v1/accounts/:id/diagnostics/:diagnosticId', (ctx) => getDiagnostic(ctx.params.id, ctx.params.diagnosticId)],

  // 新尝试：服务端持有答案与角色；重复 attemptId 幂等，同 ID 异正文 409
  ['POST', '/api/v1/accounts/:id/attempts', (ctx) => {
    const result = recordAttempt(ctx.params.id, ctx.body ?? {})
    const sessionId = ctx.body?.sessionId
    const diag = sessionId
      ? advanceDiagnostic(ctx.params.id, sessionId, {
        activityId: ctx.body?.activityId,
        pass: result.pass === true,
        evaluationStatus: result.evaluationStatus,
      })
      : null
    return { ...result, diagnostic: diag }
  }],

  // 当前推荐（无副作用）与重算（requestId 幂等，触发事件可追溯）
  ['GET', '/api/v1/accounts/:id/plan', (ctx) => getPlan(ctx.params.id)],
  ['POST', '/api/v1/accounts/:id/plan/recompute', (ctx) => ({
    decision: recomputePlan(ctx.params.id, {
      requestId: ctx.body?.requestId,
      triggerEvent: ctx.body?.triggerEventId,
    }),
  })],

  ['GET', '/api/v1/accounts/:id/evidence', (ctx) => evidenceSummary(ctx.params.id, {
    objective: ctx.query.get('objective') || undefined,
    skill: ctx.query.get('skill') || undefined,
  })],

  // 用户免修：waived_by_user 标志，不等于认证（R03）
  ['POST', '/api/v1/accounts/:id/waivers', (ctx) => waive(ctx.params.id, ctx.body ?? {})],

  // 内容争议：坏题/坏转写 → 争议+暂停，不降级用户（A6）
  ['POST', '/api/v1/accounts/:id/content-reports', (ctx) => reportContent(ctx.params.id, ctx.body ?? {})],

  // W3：课程包 —— 学习者只拿 published 课包；无 holdout 答案；提示逐层揭晓
  ['GET', '/api/v1/lessons', () => {
    seedLessons()
    return { lessons: listLessons().map((l) => ({ lessonId: l.lessonId, version: l.version, title: l.title,
      strategyId: l.strategyId, objectiveIds: l.objectiveIds, contentStatus: l.contentStatus,
      humanReview: l.humanReview })) }
  }],
  ['GET', '/api/v1/accounts/:id/lessons/:lessonId', (ctx) => {
    const pkg = serveLesson(ctx.params.id, ctx.params.lessonId)
    // 取课即把指向它的 ready 计划置为 served（15 §5：candidate→ready→served→completed）
    ensureV3Schema().prepare(
      "UPDATE plan_decisions SET status = 'served' WHERE account_id = ? AND status = 'ready' AND served_lesson_id = ?")
      .run(ctx.params.id, ctx.params.lessonId)
    return pkg
  }],
  ['POST', '/api/v1/accounts/:id/lessons/:lessonId/hints', (ctx) => revealHint(
    ctx.params.id, ctx.params.lessonId, body_str(ctx, 'activityId'), num(ctx.body?.level, 1))],
  ['POST', '/api/v1/accounts/:id/lessons/:lessonId/complete', (ctx) => completeLesson(ctx.params.id, ctx.params.lessonId)],
  ['POST', '/api/v1/lessons/:lessonId/publish', (ctx) => publishLesson(ctx.params.lessonId, {
    acknowledgeUnreviewed: !!ctx.body?.acknowledgeUnreviewed,
    by: body_str(ctx, 'by') || 'operator',
  })],
  ['POST', '/api/v1/lessons/:lessonId/sign', (ctx) => signLesson(ctx.params.lessonId, {
    reviewer: body_str(ctx, 'reviewer'), note: body_str(ctx, 'note'),
  })],
  ['POST', '/api/v1/lessons/:lessonId/withdraw', (ctx) => withdrawLesson(
    ctx.params.lessonId, body_str(ctx, 'reason'), body_str(ctx, 'confirm'))],

  // 诚实的未实现状态：录音在 W5 接入，不伪装
  ['POST', '/api/v1/accounts/:id/oral', () => {
    throw new ApiError(501, 'ORAL_NOT_READY: 站内录音在 W5 接入；先按 16 号合同打通浏览器录音链路')
  }],
]

export function requireAccount(id) {
  const a = getAccount(id)
  if (!a) throw new ApiError(404, 'ACCOUNT_NOT_FOUND: ' + id)
  return a
}

function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function body_str(ctx, key) {
  const v = ctx.body?.[key]
  return typeof v === 'string' ? v : ''
}
