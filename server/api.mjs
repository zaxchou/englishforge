// /api 路由：把 server/db.mjs 暴露成一个很小的 JSON 接口。
//
// 刻意不引框架：整个后端只有「读一份存档」「合并一次写入」「查两组统计」三类需求，
// 一个纯函数 + 一个中间件就够了，也能直接在测试里调用（不起 HTTP）。
import {
  ApiError, createAccount, dbInfo, ensureDefaultAccount, getAccount, listAccounts,
  listSnapshots, loadProgress, queryAttempts, renameAccount, replaceState, resetAccount,
  restoreSnapshot, stats, syncAccount, touchAccount, writeSnapshot, getDb,
} from './db.mjs'

const MAX_BODY = 64 * 1024 * 1024   // 首次把浏览器里的整份进度搬进库时会有一次大包

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

function num(v, fallback = 0) {
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
