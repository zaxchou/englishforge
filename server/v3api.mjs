// /api/v1 新域路由（curriculum-v4 实施合同 15 §8）。
//
// 与旧 /api/accounts/:id/sync 完全并行：旧契约一个字都不动，新域新表新语义。
// 错误码沿用 handleApi 的 {status, json:{error}}；合同错误码写在 message 前缀里，
// 例如 'REQUEST_ID_REUSED_WITH_DIFFERENT_BODY: …'。
import { ApiError, getAccount } from './db.mjs'
import { ensureV3Schema, oldRecordMap } from './v3db.mjs'
import { mapIndex, rowToObjective } from './v3map.mjs'
import { recordAttempt, evidenceSummary, waive, reportContent, getStoredAttempt } from './v3evidence.mjs'
import { startDiagnostic, getDiagnostic, advanceDiagnostic, expectedActivityFor } from './v3diag.mjs'
import { getPlan, recomputePlan } from './v3plan.mjs'
import { serveLesson, revealHint, completeLesson, listLessons, seedLessons, withdrawLesson, publishLesson, signLesson } from './v3lessons.mjs'
import { ensureWindow, reestimateWindow, generationMetrics, listJobs, startGenerationJob } from './v3gen.mjs'
import { createOralIntent, storeOralAudio, readOralAudio, deleteOralAudio, submitOralAttempt, correctTranscript, signOralReview, mediaUsableForCertification } from './v3oral.mjs'
import { readLessonAudio } from './v3audio.mjs'
import { registerTrial, recordObservation, compareTrial, listTrials } from './v3trial.mjs'

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
    const sessionId = ctx.body?.sessionId
    // F6：诊断会话只接受“当前步骤实际发出的活动”——乱序/跨会话提交在落库前拒绝
    if (sessionId) {
      const expected = expectedActivityFor(ctx.params.id, sessionId)
      if (expected && expected.activityId !== ctx.body?.activityId) {
        // F6：步骤不匹配但 attemptId 已存在 → 是重放，返回首次结果（不推进）
        const stored = getStoredAttempt(ctx.params.id, String(ctx.body?.attemptId || ''))
        if (stored) return { ...stored, diagnostic: getDiagnostic(ctx.params.id, sessionId) }
        throw new ApiError(400, `DIAGNOSTIC_STEP_MISMATCH: 当前应答 ${expected.step}/${expected.activityId}`)
      }
    }
    const result = recordAttempt(ctx.params.id, ctx.body ?? {})
    // F6：幂等重放不产生第二次推进；未判定/争议不强行分流
    const diag = sessionId && !result.replayed
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

  // W3：课程包 —— 学习者只拿 published 课包；无 holdout 答案；提示逐层揭晓。
  // accountScope/releaseChannel 给审核视图：个人定制课 vs 公共课、mainline vs dev_only 一眼可辨（C4）
  ['GET', '/api/v1/lessons', () => {
    seedLessons()
    return { lessons: listLessons().map((l) => ({ lessonId: l.lessonId, version: l.version, title: l.title,
      strategyId: l.strategyId, objectiveIds: l.objectiveIds, contentStatus: l.contentStatus,
      humanReview: l.humanReview, accountScope: l.accountScope, releaseChannel: l.releaseChannel })) }
  }],
  ['GET', '/api/v1/accounts/:id/lessons/:lessonId', (ctx) => {
    const pkg = serveLesson(ctx.params.id, ctx.params.lessonId)
    // 取课即把指向它的 ready 计划置为 served（15 §5：candidate→ready→served→completed）
    ensureV3Schema().prepare(
      "UPDATE plan_decisions SET status = 'served', served_at = ? WHERE account_id = ? AND status = 'ready' AND served_lesson_id = ?")
      .run(Date.now(), ctx.params.id, ctx.params.lessonId)
    return pkg
  }],
  ['POST', '/api/v1/accounts/:id/lessons/:lessonId/hints', (ctx) => revealHint(
    ctx.params.id, ctx.params.lessonId, body_str(ctx, 'activityId'), num(ctx.body?.level, 1))],
  ['POST', '/api/v1/accounts/:id/lessons/:lessonId/complete', (ctx) => {
    const done = completeLesson(ctx.params.id, ctx.params.lessonId)
    // F2：完成事件立即触发重算，返回可直接展示的新推荐（重复完成不重复更新）
    const decision = done.replanNeeded
      ? recomputePlan(ctx.params.id, { requestId: `lessonCompleted:${ctx.params.lessonId}`, triggerEvent: `lessonCompleted:${ctx.params.lessonId}` })
      : null
    return { ...done, decision }
  }],
  ['POST', '/api/v1/lessons/:lessonId/publish', (ctx) => publishLesson(ctx.params.lessonId, {
    acknowledgeUnreviewed: !!ctx.body?.acknowledgeUnreviewed,
    by: body_str(ctx, 'by') || 'operator',
  })],
  ['POST', '/api/v1/lessons/:lessonId/sign', (ctx) => signLesson(ctx.params.lessonId, {
    reviewer: body_str(ctx, 'reviewer'), note: body_str(ctx, 'note'),
  })],
  ['POST', '/api/v1/lessons/:lessonId/withdraw', (ctx) => withdrawLesson(
    ctx.params.lessonId, body_str(ctx, 'reason'), body_str(ctx, 'confirm'))],

  // W4：按需生成供给。生成默认关闭（防误调真实模型计费），ENGLISHFORGE_V4_GENERATION=1 显式开启
  ['GET', '/api/v1/accounts/:id/window', (ctx) => { requireAccount(ctx.params.id); return ensureWindow(ctx.params.id) }],
  ['POST', '/api/v1/accounts/:id/window/reestimate', (ctx) => { requireAccount(ctx.params.id); return reestimateWindow(ctx.params.id, body_str(ctx, 'trigger') || 'manual') }],
  ['GET', '/api/v1/accounts/:id/generation', (ctx) => { requireAccount(ctx.params.id); return { metrics: generationMetrics(ctx.params.id), jobs: listJobs(ctx.params.id) } }],
  ['POST', '/api/v1/accounts/:id/generation/start', (ctx) => {
    requireAccount(ctx.params.id)
    const r = startGenerationJob(ctx.params.id, {
      objectiveId: body_str(ctx, 'objectiveId'),
      strategyId: body_str(ctx, 'strategyId') || null,
    })
    return r // fire-and-forget：{jobId}；任务完成看 GET /generation
  }],

  // W5：口语（15 §8 /oral 合同）。录音由用户明确触发；机器评分只作练习建议；
  // 只有 oral_reviews 人审签署才能升级口语状态。
  ['POST', '/api/v1/accounts/:id/oral/intent', (ctx) => createOralIntent(ctx.params.id, {
    activityId: body_str(ctx, 'activityId'),
    mime: body_str(ctx, 'mime'),
    bytes: num(ctx.body?.bytes, 0),
    durationMs: num(ctx.body?.durationMs, 0) || null,
  })],
  // 一次性票据上传（二进制体）；body 是 Buffer（测试里传 Buffer，线上是 raw 字节）
  ['PUT', '/api/v1/accounts/:id/oral/:mediaId', (ctx) => storeOralAudio(
    ctx.params.id, ctx.params.mediaId, body_str(ctx, 'token') || String(ctx.query.get('token') || ''), ctx.body)],
  ['GET', '/api/v1/accounts/:id/oral/:mediaId/audio', (ctx) => {
    const { buf, mime } = readOralAudio(ctx.params.id, ctx.params.mediaId)
    return { audioBase64: buf.toString('base64'), mime } // 中间件是 JSON 形状；真实流式播放走同路径的 raw 分支
  }],
  ['POST', '/api/v1/accounts/:id/attempts/oral', (ctx) => submitOralAttempt(ctx.params.id, ctx.body ?? {})],
  ['POST', '/api/v1/accounts/:id/oral/:mediaId/transcript', (ctx) => correctTranscript(
    ctx.params.id, ctx.params.mediaId, body_str(ctx, 'text'), { origin: body_str(ctx, 'origin') || 'user_corrected' })],
  ['POST', '/api/v1/accounts/:id/oral-reviews', (ctx) => signOralReview(ctx.params.id, ctx.body ?? {})],
  // 录音删除控制（15 §4：可删除；保留期规格见 v3oral.mjs 头注）
  ['DELETE', '/api/v1/accounts/:id/oral/:mediaId', (ctx) => deleteOralAudio(ctx.params.id, ctx.params.mediaId)],

  // 课程音频（21 §6.1/§6.2）+ 真实外部素材（§6.3）：manifest+sha256 四关校验后才分发；
  // 转写不随音频下发（首听隐藏脚本）。账户无关的公共受控内容，不要求登录
  ['GET', '/api/v1/media/:mediaId', (ctx) => {
    const { entry, buf, mime } = readLessonAudio(ctx.params.mediaId)
    return {
      audioBase64: buf.toString('base64'), mime,
      synthetic: entry.sourceType === 'synthetic', speakerLabel: entry.speakerLabel ?? null,
      durationMs: entry.durationMs, licenseNote: entry.licenseNote,
      // 真实素材的溯源（21 §6.3：来源、可播放/使用条件、片段起止一并带出）
      sourceUrl: entry.sourceUrl ?? null, author: entry.author ?? null,
      license: entry.license ?? null, segmentWindow: entry.segmentWindow ?? null,
    }
  }],

  // W6：本人试学工具包（先预注册后施测；机制不做效果宣称）
  ['GET', '/api/v1/accounts/:id/trials', (ctx) => { requireAccount(ctx.params.id); return { trials: listTrials(ctx.params.id) } }],
  ['POST', '/api/v1/accounts/:id/trials', (ctx) => registerTrial(ctx.params.id, ctx.body ?? {})],
  ['POST', '/api/v1/accounts/:id/trials/:trialId/observations', (ctx) => recordObservation(ctx.params.id, {
    trialId: ctx.params.trialId, phase: body_str(ctx, 'phase'), attemptId: body_str(ctx, 'attemptId'),
    materialWasNovel: ctx.body?.materialWasNovel !== false, support: ctx.body?.support ?? {},
  })],
  ['GET', '/api/v1/accounts/:id/trials/:trialId/compare', (ctx) => { requireAccount(ctx.params.id); return compareTrial(ctx.params.id, ctx.params.trialId) }],
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
