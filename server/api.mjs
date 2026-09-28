// /api 路由：把 server/db.mjs 暴露成一个很小的 JSON 接口。
//
// 刻意不引框架：整个后端只有「读一份存档」「合并一次写入」「查两组统计」三类需求，
// 一个纯函数 + 一个中间件就够了，也能直接在测试里调用（不起 HTTP）。
import {
  ApiError, addItems, audit, createAccount, dbInfo, deleteItem, ensureDefaultAccount, getAccount,
  catalogForReview, itemStats, listAccounts, listBatches, listEnrichments, listItems,
  listRunLog, listSnapshots, pipelineQueue, reopenBulk, reopenIncompleteAi, reviewQueue,
  loadProgress, queryAttempts, renameAccount, replaceState, resetAccount, restoreSnapshot,
  saveAiReview, saveEnrichment, saveRewrite, setItemReview, setSetting, stats, syncAccount, touchAccount,
  upsertCatalog, writeSnapshot, writeRunLog, getDb,
} from './db.mjs'
import { enrichCauses, rewriteQuestions, reviewQuestions } from './content-ai.mjs'
import { invalidateLlmConfig, llmStatus, DEFAULT_MODEL } from './llm.mjs'

const MAX_BODY = 64 * 1024 * 1024   // 首次把浏览器里的整份进度搬进库时会有一次大包

/** 同一账户同时只跑一条流水线（多标签页/重复点击防重） */
const pipelineLock = new Set()

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

/** 路由表：pattern 用 :name 占位 */
const ROUTES = [
  ['GET', '/api/health', () => ({ ok: true, ...dbInfo(), accounts: listAccounts(), time: Date.now() })],

  ['GET', '/api/accounts', () => ({ accounts: listAccounts() })],
  ['POST', '/api/accounts', (ctx) => ({ account: createAccount(body_str(ctx, 'name') || '默认账户') })],
  ['GET', '/api/accounts/:id', (ctx) => {
    const a = getAccount(ctx.params.id)
    if (!a) throw new HttpError(404, '账户不存在：' + ctx.params.id)
    return { account: a }
  }],
  ['PATCH', '/api/accounts/:id', (ctx) => ({ account: renameAccount(ctx.params.id, body_str(ctx, 'name')) })],
  ['POST', '/api/accounts/:id/touch', (ctx) => { touchAccount(ctx.params.id); return { ok: true } }],

  ['GET', '/api/accounts/:id/progress', (ctx) => loadProgress(ctx.params.id)],
  ['POST', '/api/accounts/:id/sync', (ctx) => ({
    ok: true,
    ...syncAccount(ctx.params.id, {
      clientRevision: num(ctx.body?.baseRevision),
      state: ctx.body?.state ?? null,
      attempts: Array.isArray(ctx.body?.attempts) ? ctx.body.attempts : [],
      reviews: ctx.body?.reviews ?? null,
      reason: body_str(ctx, 'reason') || 'save',
    }),
  })],
  ['POST', '/api/accounts/:id/replace', (ctx) => ({
    ok: true,
    ...replaceState(ctx.params.id, {
      state: ctx.body?.state ?? null,
      attempts: Array.isArray(ctx.body?.attempts) ? ctx.body.attempts : [],
      reviews: ctx.body?.reviews ?? null,
      clientRevision: num(ctx.body?.baseRevision),
      reason: body_str(ctx, 'reason') || 'replace',
    }),
  })],
  ['POST', '/api/accounts/:id/reset', (ctx) => ({
    ok: true,
    ...resetAccount(ctx.params.id, { reason: body_str(ctx, 'reason') || 'reset' }),
  })],

  ['GET', '/api/accounts/:id/stats', (ctx) => ({ stats: stats(ctx.params.id) })],

  // 账户题库（内容，与进度分开）：语料派生的题、以及将来即时生成的题都存在这里
  ['GET', '/api/accounts/:id/items', (ctx) => {
    const items = listItems(ctx.params.id, {
      skill: ctx.query.get('skill'),
      source: ctx.query.get('source'),
      status: ctx.query.get('status'),
      limit: num(ctx.query.get('limit'), 20000),
    })
    return { items, count: items.length, stats: itemStats(ctx.params.id) }
  }],
  ['POST', '/api/accounts/:id/items', (ctx) => {
    const body = ctx.body ?? {}
    if (!Array.isArray(body.items)) throw new HttpError(400, 'items 必须是数组')
    return { ok: true, ...addItems(ctx.params.id, { items: body.items, batch: body.batch ?? {} }) }
  }],
  ['PATCH', '/api/accounts/:id/items/:itemId', (ctx) => ({
    ok: true, ...setItemReview(ctx.params.id, ctx.params.itemId, body_str(ctx, 'verdict'), body_str(ctx, 'note') || null),
  })],
  ['DELETE', '/api/accounts/:id/items/:itemId', (ctx) => ({ ok: true, ...deleteItem(ctx.params.id, ctx.params.itemId) })],
  ['GET', '/api/accounts/:id/batches', (ctx) => ({ batches: listBatches(ctx.params.id) })],

  // ---- 系统自检与自我修复（用户的明确要求：纠正要由系统自己的 AI 跑，不靠人） ----
  ['GET', '/api/ai/status', () => ({ ai: { ...llmStatus(), defaultModel: DEFAULT_MODEL, envLocked: !!process.env.ENGLISHFORGE_AI_MODEL } })],
  /** 换模型：存库即时生效（不用改任何 .env）。环境变量 ENGLISHFORGE_AI_MODEL 优先级更高。 */
  ['POST', '/api/ai/model', (ctx) => {
    const model = body_str(ctx, 'model').trim()
    if (!/^[A-Za-z0-9._:-]{2,64}$/.test(model)) throw new HttpError(400, '模型名不合法')
    setSetting('ai_model', model)
    invalidateLlmConfig()
    return { ok: true, ai: llmStatus() }
  }],
  ['POST', '/api/catalog', (ctx) => {
    const rows = ctx.body?.questions
    if (!Array.isArray(rows)) throw new HttpError(400, 'questions 必须是数组')
    return { ok: true, ...upsertCatalog(rows) }
  }],
  ['GET', '/api/accounts/:id/audit', (ctx) => ({ audit: audit(ctx.params.id) })],
  ['GET', '/api/accounts/:id/runs', (ctx) => ({ runs: listRunLog(ctx.params.id, num(ctx.query.get('limit'), 30)) })],
  ['GET', '/api/accounts/:id/enrichments', (ctx) => ({ enrichments: listEnrichments(ctx.params.id, ctx.query.get('kind')) })],
  /**
   * 让**另一个模型**去审核题库（用户的要求：审核也该是自动的，不该让人逐题看）。
   * 只审"还没定过版"的题；结论带理由与来源写进 content_reviews，与人工标记走同一条信任路径
   * （ok → reviewed 计入掌握度 / kill → quarantined 退出抽题 / fix → 仍 draft 但列进"要人看"）。
   */
  ['POST', '/api/accounts/:id/ai-review', async (ctx) => {
    const limit = num(ctx.body?.limit, 20)
    const { solid } = reviewQueue(ctx.params.id)
    const todo = catalogForReview(ctx.params.id, { skipReviewed: solid })
      .slice(0, Math.max(1, Math.min(60, limit)))
    if (!todo.length) return { ok: true, requested: 0, reviewed: 0, killed: 0, fixed: 0, remaining: 0, reviewer: null }
    const { results, rejected, truncated, model, provider, error } = await reviewQuestions(todo)
    let killed = 0, fixed = 0, saved = 0
    const verdicts = {}
    for (const [qid, v] of Object.entries(results)) {
      const tag = provider ? `${provider}/${model}` : model
      saveAiReview(ctx.params.id, qid, v.verdict, v.reasons, tag)
      verdicts[qid] = { verdict: v.verdict, reasons: v.reasons, source: 'ai', model: tag }
      saved++
      if (v.verdict === 'kill') killed++
      else if (v.verdict === 'fix') fixed++
    }
    const after = audit(ctx.params.id)
    return {
      ok: true, requested: todo.length, reviewed: saved, killed, fixed, rejected, truncated, verdicts,
      remaining: after.unreviewed, reviewer: { provider, model, independent: llmStatus().independentReview },
      error: error ?? null,
    }
  }],

  /**
   * **全自动流水线的一轮**（用户拍板：「这个也自动化 完全不需要我审核」）：
   *   审（MiMo 找问题）→ 改（DeepSeek 按审核意见改稿）→ 待办里留着的 fix 下一轮自动复审。
   * 待办用 pipelineQueue：**人工的结论机器也复核**（单点的、批量的都算）；人毙的题不复活（kill 不进队列）。
   * 客户端循环调用直到 `pending` 归零；同一账户同时只跑一条（并发请求回 running，不重复花钱）。
   */
  ['POST', '/api/accounts/:id/ai-pipeline', async (ctx) => {
    const id = ctx.params.id
    const started = Date.now()
    if (pipelineLock.has(id)) return { ok: true, running: true }
    pipelineLock.add(id)
    try {
      const limit = Math.max(1, Math.min(60, num(ctx.body?.limit, 60)))
      const todo = pipelineQueue(id, { limit })
      if (!todo.length) {
        // 空轮是客户端循环的正常收尾，没有信息量，不写日志
        return {
          ok: true, requested: 0, reviewed: 0, killed: 0, fixed: 0, rewritten: 0,
          rejected: 0, rewriteRejected: 0, pending: audit(id).pipelinePending, verdicts: {},
          reviewer: null, error: null,
        }
      }
      const { results, rejected, truncated, model, provider, error } = await reviewQuestions(todo)
      const tag = provider ? `${provider}/${model}` : model
      let killed = 0, fixed = 0, saved = 0
      const verdicts = {}
      const killedIds = [], fixedIds = []
      for (const [qid, v] of Object.entries(results)) {
        saveAiReview(id, qid, v.verdict, v.reasons, tag)
        verdicts[qid] = { verdict: v.verdict, reasons: v.reasons, source: 'ai', model: tag }
        saved++
        if (v.verdict === 'kill') { killed++; killedIds.push(qid) }
        else if (v.verdict === 'fix') { fixed++; fixedIds.push(qid) }
      }
      // 审出"要改"的 → 出题人立刻改稿（改完的题仍在待办里，下一轮复审；单方结论不采信）
      let rewritten = 0, rewriteRejected = 0, rewriteError = null
      const fixQs = todo.filter((q) => results[q.id]?.verdict === 'fix')
        .map((q) => ({ ...q, reasons: results[q.id].reasons }))
      const rewrittenIds = []
      if (fixQs.length) {
        try {
          const rw = await rewriteQuestions(fixQs)
          for (const [qid, payload] of Object.entries(rw.results)) {
            if (saveRewrite(id, qid, payload, rw.model ? `${rw.provider}/${rw.model}` : null).saved) {
              rewritten++
              rewrittenIds.push(qid)
            }
          }
          rewriteRejected = rw.rejected
          rewriteError = rw.error
        } catch (err) {
          rewriteError = String(err?.message ?? err)
        }
      }
      // 留痕：这次自动执行干了什么、动了谁、错在哪（日志表只留最近 500 条）
      const finalError = error ?? rewriteError
      writeRunLog(id, 'pipeline', {
        requested: todo.length, reviewed: saved, killed, fixed, rewritten, rewriteRejected,
        rejected, truncated, pending: audit(id).pipelinePending, reviewer: tag,
        ms: Date.now() - started,
        killedIds: killedIds.slice(0, 50), fixedIds: fixedIds.slice(0, 50), rewrittenIds: rewrittenIds.slice(0, 50),
      }, finalError)
      return {
        ok: true, requested: todo.length, reviewed: saved, killed, fixed, rewritten,
        rejected, rewriteRejected, truncated, pending: audit(id).pipelinePending, verdicts,
        reviewer: { provider, model, independent: llmStatus().independentReview },
        error: finalError,
      }
    } finally {
      pipelineLock.delete(id)
    }
  }],

  /**
   * 把之前"批量通过"的结论降级为待审 —— 用户明确说过那种通过是"看都不看"，
   * 不该当成已经审过（否则 AI 审核无从下手，数字也会骗人）。
   */
  ['POST', '/api/accounts/:id/reopen-bulk', (ctx) => {
    const includeHumanOk = ctx.body?.includeHumanOk !== false
    if (body_str(ctx, 'what') === 'ai-incomplete') return { ok: true, ...reopenIncompleteAi(ctx.params.id) }
    return { ok: true, ...reopenBulk(ctx.params.id, { includeHumanOk }) }
  }],

  /** 让系统自己的 AI 给缺逐项纠正的题补上（一次一批，可反复点，直到补完） */
  ['POST', '/api/accounts/:id/enrich-causes', async (ctx) => {
    const started = Date.now()
    const limit = num(ctx.body?.limit, 8)
    const a = audit(ctx.params.id)
    const todo = a.missingCauseAll.slice(0, Math.max(1, Math.min(24, limit)))
    if (!todo.length) return { ok: true, requested: 0, enriched: 0, rejected: 0, remaining: 0, model: null }
    const { results, rejected, truncated, model, error } = await enrichCauses(todo)
    let saved = 0
    for (const [qid, payload] of Object.entries(results)) {
      saveEnrichment(ctx.params.id, qid, 'causes', payload, model)
      saved++
    }
    const after = audit(ctx.params.id)
    writeRunLog(ctx.params.id, 'enrich', {
      requested: todo.length, enriched: saved, rejected, truncated,
      remaining: after.missingCause.count, model, ms: Date.now() - started,
      ids: Object.keys(results).slice(0, 50),
    }, error)
    return {
      ok: true, requested: todo.length, enriched: saved, rejected, truncated, model,
      error: error ?? null, remaining: after.missingCause.count,
    }
  }],

  ['GET', '/api/accounts/:id/attempts', (ctx) => ({
    attempts: queryAttempts(ctx.params.id, {
      limit: num(ctx.query.get('limit'), 200),
      objective: ctx.query.get('objective'),
      question: ctx.query.get('question'),
      since: ctx.query.get('since') ? num(ctx.query.get('since')) : null,
    }),
  })],

  ['GET', '/api/accounts/:id/snapshots', (ctx) => ({
    snapshots: listSnapshots(ctx.params.id, ctx.query.get('full') === '1'),
  })],
  ['POST', '/api/accounts/:id/snapshots', (ctx) => {
    const a = getAccount(ctx.params.id)
    if (!a) throw new HttpError(404, '账户不存在：' + ctx.params.id)
    const id = writeSnapshot(getDb(), ctx.params.id, body_str(ctx, 'reason') || 'manual')
    return { ok: true, snapshotId: id }
  }],
  ['POST', '/api/snapshots/:id/restore', (ctx) => ({ ok: true, ...restoreSnapshot(Number(ctx.params.id)) })],

  // 首次使用：库里没有账户就建一个（"默认先做第一个账户"）
  ['POST', '/api/bootstrap', (ctx) => {
    const account = ensureDefaultAccount(body_str(ctx, 'name') || '默认账户')
    return { account, ...loadProgress(account.id) }
  }],
]

/** 数字参数解析：**缺省时必须落到 fallback**。
 *  坑：`Number(null) === 0` 且 0 是有限数，所以 `num(null, 200)` 曾返回 0，
 *  被 `Math.max(1, ...)` 夹成 1 —— 列表接口会静默只返回一行（实测导致题库存取全错）。 */
function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function body_str(ctx, key) {
  const v = ctx.body?.[key]
  return typeof v === 'string' ? v : ''
}

/** 把 /api/accounts/abc/progress 匹配到 /api/accounts/:id/progress */
function match(method, pathname) {
  for (const [m, pattern, handler] of ROUTES) {
    if (m !== method) continue
    const pp = pattern.split('/')
    const ap = pathname.split('/')
    if (pp.length !== ap.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i])
      else if (pp[i] !== ap[i]) { ok = false; break }
    }
    if (ok) return { handler, params }
  }
  return null
}

/**
 * 纯函数式入口：给 method / pathname / body，返回 { status, json }。
 * Vite 中间件和 vitest 都走这里，所以测试覆盖的就是真实行为。
 */
export async function handleApi({ method = 'GET', pathname = '/', query = new URLSearchParams(), body = null } = {}) {
  const route = match(method.toUpperCase(), pathname)
  if (!route) return { status: 404, json: { error: 'no such endpoint: ' + method + ' ' + pathname } }
  try {
    const json = await route.handler({ params: route.params, query, body })
    return { status: 200, json }
  } catch (err) {
    if (err instanceof ApiError || err instanceof HttpError) {
      return { status: err.status, json: { error: err.message } }
    }
    return { status: 500, json: { error: String(err?.message ?? err) } }
  }
}

/** Vite connect 中间件：只接管 /api/*，其余交还静态资源 */
export function apiMiddleware() {
  return async function (req, res, next) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next()
    let body = null
    try {
      body = await readJsonBody(req)
    } catch (err) {
      res.statusCode = err instanceof HttpError ? err.status : 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: String(err.message) }))
      return
    }
    const out = await handleApi({
      method: req.method, pathname: url.pathname, query: url.searchParams, body,
    })
    res.statusCode = out.status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(out.json))
  }
}

async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return null
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return null
  try { return JSON.parse(text) } catch { throw new HttpError(400, '请求体不是合法 JSON') }
}
