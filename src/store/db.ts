// 客户端 → 进度数据库的同步层。
//
// 分工：浏览器 localStorage 仍是"当前工作的存档"（离线也能练，刷新不丢），
// 数据库是长期的、可查询的那一份。每次提交后防抖推一次：
//   · 作答事件按 attemptId 增量推（只增不改，服务端取并集，永远不会重复也不会丢）
//   · 其余状态（XP / 题状态 / 断点 / 审核标记）整份覆盖
// 服务端连不上就静默退回本地模式，界面只显示"数据库未连接"，练习照常。
import type { Attempt, ProgressV2 } from '../types'
import type { ReviewMark, ReviewMarks } from '../content/reviewMarks'
import { isProgressV2, normalizeProgress } from './migrations'

const API = '/api'
const ACCOUNT_KEY = 'sf-account-id'
const revKey = (id: string) => `sf-db-rev:${id}`
const cursorKey = (id: string) => `sf-db-cursor:${id}`
const syncedKey = (id: string) => `sf-db-synced-at:${id}`

/** 推事件时若游标失效（事件被 5000 上限裁掉）最多回补多少条 */
const BACKFILL = 500
/** 单次请求超时：本地服务，超过这个数就算不可用，不要吊住界面 */
const TIMEOUT_MS = 8000

export type DbState = 'connecting' | 'online' | 'offline'

export interface DbAccount {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  xp: number
  streak: number
  revision: number
  attempts: number
}

export interface DbStats {
  xp: number
  streak: number
  revision: number
  updatedAt: number
  attempts: number
  attemptsFirst: number
  attemptsCorrectFirst: number
  questionStates: number
  questionsPracticed: number
  skills: number
  sessions: number
  dailyXpDays: number
  reviews: number
  snapshots: number
  dueNow: number
  hasActiveSession: boolean
  objectives: { objective_id: string; attempts: number; first_correct: number; days: number }[]
  errorTags: { tag: string; n: number }[]
}

export interface PullResult {
  progress: ProgressV2
  revision: number
  reviews: ReviewMarks
  updatedAt: number
}

export interface SyncResult {
  ok: boolean
  revision?: number
  inserted?: number
  error?: string
}

// ---------------------------------------------------------------- 状态广播

let dbState: DbState = 'connecting'
const listeners = new Set<(s: DbState) => void>()

export function getDbState(): DbState { return dbState }

export function subscribeDbState(fn: (s: DbState) => void): () => void {
  listeners.add(fn)
  fn(dbState)
  return () => { listeners.delete(fn) }
}

function setDbState(s: DbState) {
  if (dbState === s) return
  dbState = s
  for (const fn of listeners) fn(s)
}

// ---------------------------------------------------------------- 本地记账

function read(key: string): string {
  try { return localStorage.getItem(key) ?? '' } catch { return '' }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* 隐私模式：同步照样能用，只是记不住游标 */ }
}

export function currentAccountId(): string {
  return read(ACCOUNT_KEY)
}

export function setCurrentAccountId(id: string) {
  if (id) write(ACCOUNT_KEY, id)
}

export function lastSyncedAt(accountId: string): number {
  return Number(read(syncedKey(accountId))) || 0
}

// ---------------------------------------------------------------- 请求

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { msg = (JSON.parse(text) as { error?: string }).error ?? msg } catch { /* 非 JSON 错误体 */ }
    lastError = msg
    throw new Error(msg)
  }
  try {
    return JSON.parse(text || '{}') as T
  } catch {
    // /api 返回了 HTML —— 说明跑着的服务进程里没有装载数据库插件
    // （最常见：应用是改动之前启动的）。这不是网络故障，修法是重启应用。
    lastError = 'NO_API'
    throw new Error('进度数据库接口没有响应（服务进程里没有 /api）')
  }
}

let lastError = ''

/** 最近一次失败原因；'NO_API' 表示服务端根本不认识 /api（需要重启应用） */
export function getDbError(): string { return lastError }

async function attemptReq<T>(fn: () => Promise<T>): Promise<T | null> {
  setDbState('connecting')
  try {
    const out = await fn()
    lastError = ''
    setDbState('online')
    return out
  } catch {
    setDbState('offline')
    return null
  }
}

// ---------------------------------------------------------------- 账户

export async function fetchAccounts(): Promise<DbAccount[] | null> {
  const res = await attemptReq(() => req<{ accounts: DbAccount[] }>('/accounts'))
  return res?.accounts ?? null
}

/** 首次使用：库里没有账户就建一个，并记住它 */
export async function bootstrap(name = '默认账户'): Promise<(PullResult & { account: DbAccount }) | null> {
  const res = await attemptReq(() => req<{ account: DbAccount } & PullResult>('/bootstrap', {
    method: 'POST', body: JSON.stringify({ name }),
  }))
  if (!res) return null
  const progress = adoptable(res.progress)
  if (!progress) {
    setDbState('offline')
    return null
  }
  setCurrentAccountId(res.account.id)
  write(revKey(res.account.id), String(res.revision))
  write(syncedKey(res.account.id), String(Date.now()))
  return { account: res.account, progress, revision: res.revision, reviews: res.reviews ?? {}, updatedAt: res.updatedAt }
}

export async function createAccount(name: string): Promise<DbAccount | null> {
  const res = await attemptReq(() => req<{ account: DbAccount }>('/accounts', {
    method: 'POST', body: JSON.stringify({ name }),
  }))
  return res?.account ?? null
}

export async function renameAccount(id: string, name: string): Promise<DbAccount | null> {
  const res = await attemptReq(() => req<{ account: DbAccount }>(`/accounts/${id}`, {
    method: 'PATCH', body: JSON.stringify({ name }),
  }))
  return res?.account ?? null
}

/** 校验并归一化服务端存档：结构不合法就拒绝接管（宁可报离线，也不要用坏数据覆盖好进度） */
function adoptable(raw: unknown): ProgressV2 | null {
  if (!isProgressV2(raw)) return null
  return normalizeProgress(raw)
}

// ---------------------------------------------------------------- 读 / 写

export async function pullProgress(accountId: string): Promise<PullResult | null> {
  const res = await attemptReq(() => req<PullResult>(`/accounts/${accountId}/progress`))
  if (!res) return null
  const progress = adoptable(res.progress)
  if (!progress) { setDbState('offline'); return null }
  write(revKey(accountId), String(res.revision))
  write(syncedKey(accountId), String(Date.now()))
  return { progress, revision: res.revision, reviews: res.reviews ?? {}, updatedAt: res.updatedAt }
}

function stateOf(p: ProgressV2) {
  return {
    xp: p.xp, streak: p.streak, lastActiveDate: p.lastActiveDate, comboBest: p.comboBest,
    skills: p.skills, dailyXp: p.dailyXp ?? {}, sessions: p.sessions ?? [],
    questionStates: p.questionStates, activeSession: p.activeSession,
  }
}

/** 只推"上次之后新产生的"事件；游标失效时回补最近一批（服务端幂等，重发不会重复计） */
function pendingAttempts(accountId: string, all: Attempt[], full: boolean): Attempt[] {
  if (full) return all
  const cursor = read(cursorKey(accountId))
  if (!cursor) return all
  const idx = all.findIndex((a) => a.attemptId === cursor)
  if (idx < 0) return all.slice(-BACKFILL)
  return all.slice(idx + 1)
}

function rememberCursor(accountId: string, sent: Attempt[]) {
  const last = sent[sent.length - 1]
  if (last) write(cursorKey(accountId), last.attemptId)
}

export interface SyncOptions {
  reviews?: ReviewMarks
  /** 整份替换（导入存档 / 首次把浏览器里的进度搬进库）：服务端会先留快照 */
  full?: boolean
  reason?: string
}

export async function syncProgress(accountId: string, p: ProgressV2, opts: SyncOptions = {}): Promise<SyncResult> {
  if (!accountId) return { ok: false, error: '没有账户' }
  const full = opts.full === true
  const sent = pendingAttempts(accountId, p.attempts, full)
  const path = full ? 'replace' : 'sync'
  const out = await attemptReq(() => req<{ revision: number; attemptsInserted: number }>(
    `/accounts/${accountId}/${path}`,
    {
      method: 'POST',
      body: JSON.stringify({
        baseRevision: Number(read(revKey(accountId))) || 0,
        state: stateOf(p),
        attempts: sent,
        reviews: opts.reviews ?? null,
        reason: opts.reason ?? (full ? 'replace' : 'save'),
      }),
    },
  ))
  if (!out) return { ok: false, error: '数据库未连接' }
  write(revKey(accountId), String(out.revision))
  if (full) {
    const last = p.attempts[p.attempts.length - 1]
    write(cursorKey(accountId), last ? last.attemptId : '')
  } else {
    rememberCursor(accountId, sent)
  }
  write(syncedKey(accountId), String(Date.now()))
  return { ok: true, revision: out.revision, inserted: out.attemptsInserted }
}

/** 清空账户进度：先让服务端留快照再清，避免"本地清了、库里又同步回来" */
export async function resetRemote(accountId: string, reason = 'user-reset'): Promise<boolean> {
  const out = await attemptReq(() => req<{ revision: number }>(`/accounts/${accountId}/reset`, {
    method: 'POST', body: JSON.stringify({ reason }),
  }))
  if (!out) return false
  write(revKey(accountId), String(out.revision))
  write(cursorKey(accountId), '')
  write(syncedKey(accountId), String(Date.now()))
  return true
}

export async function fetchStats(accountId: string): Promise<DbStats | null> {
  const res = await attemptReq(() => req<{ stats: DbStats }>(`/accounts/${accountId}/stats`))
  return res?.stats ?? null
}

export interface SnapshotInfo { id: number; createdAt: number; reason: string; revision: number; bytes: number }

export async function fetchSnapshots(accountId: string): Promise<SnapshotInfo[] | null> {
  const res = await attemptReq(() => req<{ snapshots: SnapshotInfo[] }>(`/accounts/${accountId}/snapshots`))
  return res?.snapshots ?? null
}

export async function restoreSnapshot(snapshotId: number): Promise<boolean> {
  const res = await attemptReq(() => req(`/snapshots/${snapshotId}/restore`, { method: 'POST', body: '{}' }))
  return res !== null
}

export async function makeSnapshot(accountId: string, reason = 'manual'): Promise<boolean> {
  const res = await attemptReq(() => req(`/accounts/${accountId}/snapshots`, {
    method: 'POST', body: JSON.stringify({ reason }),
  }))
  return res !== null
}

// ---------------------------------------------------------------- 决策

export function isEmptyProgress(p: ProgressV2): boolean {
  return p.attempts.length === 0 && Object.keys(p.questionStates).length === 0 &&
    p.xp === 0 && (p.sessions?.length ?? 0) === 0
}

/**
 * 事件取并集：以 base 为底，把 remote 里本地还没有的作答事件补进来。
 * 这是"两边都练过"时唯一安全的做法 —— 状态可能被后写的一方覆盖，
 * 但事件只能增不能减，否则离线练的那一轮就凭空消失了。
 */
export function unionProgress(base: ProgressV2, remote: ProgressV2): { progress: ProgressV2; added: number } {
  const have = new Set(base.attempts.map((a) => a.attemptId))
  const extra = remote.attempts.filter((a) => !have.has(a.attemptId))
  if (!extra.length) return { progress: base, added: 0 }
  const attempts = [...base.attempts, ...extra]
    .sort((a, b) => a.timestamp - b.timestamp || a.attemptId.localeCompare(b.attemptId))
  return { progress: { ...base, attempts }, added: extra.length }
}

export type BootDecision =
  /** 库里还没有进度：把本地这份整份搬进库（老用户第一次跑），服务端会先留快照 */
  | { kind: 'upload-local' }
  /** 两边都空：全新开始 */
  | { kind: 'fresh' }
  /** 本地空、库里有：接管库里的进度（换了浏览器 / 清了缓存） */
  | { kind: 'adopt-remote'; pull: PullResult }
  /** 两边都有：以本地为准（它最新），同时把库里多出来的事件并进来 */
  | { kind: 'merge'; pull: PullResult }

/** 启动时的接管决策（纯函数，便于测试） */
export function decideBoot(local: ProgressV2, pull: PullResult | null): BootDecision {
  if (!pull) return isEmptyProgress(local) ? { kind: 'fresh' } : { kind: 'upload-local' }
  const localEmpty = isEmptyProgress(local)
  const remoteEmpty = isEmptyProgress(pull.progress)
  if (localEmpty && remoteEmpty) return { kind: 'fresh' }
  if (remoteEmpty) return { kind: 'upload-local' }          // 库被清空过：整份补回去
  if (localEmpty) return { kind: 'adopt-remote', pull }     // 新浏览器：接管库里的进度
  return { kind: 'merge', pull }
}

export type { ReviewMark }
