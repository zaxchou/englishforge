// v2 存档：版本化读写、v1→v2 迁移、逐题落盘、幂等、导入导出
// 迁移流程：读 v1 → 校验 → 内存转换 → 写入 v2 → 回读校验 → 启用 v2；原 v1 不删除（PLAN-v2 §6.3）
import type { Attempt, Progress, ProgressV2, QuestionState } from '../types'
import { V1_KEY, V2_KEY, BACKUP_PREFIX } from '../types'

const MAX_ATTEMPTS = 5000   // 事件上限：超出丢最旧（聚合统计不丢，见已知限制）

/** 本地日期 YYYY-MM-DD：不用 toISOString（UTC），避免中国早上八点前训练日不切换（用例 11） */
export function localDateStr(ts = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function defaultProgressV2(): ProgressV2 {
  return {
    schemaVersion: 2,
    xp: 0,
    streak: 0,
    lastActiveDate: '',
    comboBest: 0,
    skills: {},
    dailyXp: {},
    sessions: [],
    questionStates: {},
    attempts: [],
    activeSession: null,
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function result(value: unknown): boolean {
  return record(value) && typeof value.qid === 'string' && typeof value.firstTryCorrect === 'boolean' &&
    (value.retriedCorrect === null || typeof value.retriedCorrect === 'boolean') && typeof value.given === 'string'
}
/** 存档结构校验：从数据库取回的整份存档也要过这一关，才允许接管本地进度 */
export function isProgressV2(raw: unknown): raw is ProgressV2 {
  if (!record(raw) || raw.schemaVersion !== 2 || !number(raw.xp) || !number(raw.streak) ||
    !number(raw.comboBest) || typeof raw.lastActiveDate !== 'string' || !record(raw.skills) ||
    !record(raw.questionStates) || !Array.isArray(raw.attempts)) return false
  if (!Object.values(raw.skills).every(s => record(s) && typeof s.conceptSeen === 'boolean' && number(s.box) && number(s.due) && number(s.correct) && number(s.total))) return false
  if (!Object.values(raw.questionStates).every(s => record(s) && number(s.stage) && Number.isInteger(s.stage) && s.stage <= 5 && number(s.dueAt) && number(s.correct) && number(s.total))) return false
  if (raw.dailyXp !== undefined && (!record(raw.dailyXp) || !Object.values(raw.dailyXp).every(number))) return false
  if (raw.sessions !== undefined && (!Array.isArray(raw.sessions) || !raw.sessions.every(s => record(s) && number(s.ts) && typeof s.label === 'string' && typeof s.lessonNo === 'string' && number(s.acc) && number(s.xp) && number(s.total) && number(s.firstTry)))) return false
  if (!raw.attempts.every(a => record(a) && ['attemptId','sessionId','questionId','objectiveId','variantGroupId','localDate','answer'].every(k => typeof a[k] === 'string') && number(a.timestamp) && number(a.contentVersion) && number(a.supportUsed) && typeof a.firstAttempt === 'boolean' && typeof a.isDueReview === 'boolean' && ['correct','incorrect','uncertain','skipped'].includes(String(a.outcome)) && ['deterministic','self','transcriptMatch','aiText'].includes(String(a.evaluator)) && ['recognition','comprehension','construction','oral'].includes(String(a.mode)))) return false
  if (raw.activeSession != null) {
    const a = raw.activeSession
    if (!record(a) || typeof a.sessionId !== 'string' || !['today','skill','review'].includes(String(a.kind)) || typeof a.committed !== 'boolean' || !number(a.createdAt) || !Array.isArray(a.queue) || !a.queue.every(q => record(q) && typeof q.qid === 'string' && [q.optionOrder,q.rightOrder].every(order => order === undefined || (Array.isArray(order) && order.every(x => typeof x === 'string'))))) return false
    if (a.runtime != null) {
      const r = a.runtime
      if (!record(r) || !record(r.phase) || !['concept','q','retry'].includes(String(r.phase.kind)) || !number(r.phase.index) || !Number.isInteger(r.phase.index) || !Array.isArray(r.retryIds) || !r.retryIds.every(x => typeof x === 'string') || !Array.isArray(r.results) || !r.results.every(result)) return false
      if (r.pending != null && !result(r.pending)) return false
      if (r.combo != null && (!record(r.combo) || !number(r.combo.cur) || !number(r.combo.best))) return false
    }
  }
  return true
}

function isV1(raw: unknown): raw is Progress {
  const p = raw as Progress
  return !!p && typeof p.xp === 'number' && typeof p.skills === 'object' && !('schemaVersion' in p)
}

/** v1 → v2（纯内存转换；questions 迁为 questionStates 并标 legacy） */
export function migrateV1toV2(v1: Progress): ProgressV2 {
  const questionStates: Record<string, QuestionState> = {}
  for (const [qid, q] of Object.entries(v1.questions ?? {})) {
    questionStates[qid] = {
      stage: q.box,
      dueAt: q.due,
      correct: q.correct,
      total: q.total,
      legacy: true,   // 只有历史练习记录，不当新证据（PLAN-v2 §6.3）
    }
  }
  return {
    schemaVersion: 2,
    xp: v1.xp ?? 0,
    streak: v1.streak ?? 0,
    lastActiveDate: v1.lastActiveDate ?? '',
    comboBest: v1.comboBest ?? 0,
    skills: v1.skills ?? {},
    dailyXp: v1.dailyXp ?? {},
    sessions: v1.sessions ?? [],
    questionStates,
    attempts: [],          // 历史作答无法还原成事件：从迁移后开始记录
    activeSession: null,
  }
}

export type LoadNotice = 'migrated' | 'corrupt-recovered' | null

export interface LoadResult {
  progress: ProgressV2
  notice: LoadNotice
}

/** 读档：v2 → v1 迁移 → 损坏恢复（不删旧数据，先备份再恢复） */
export function loadProgressV2(): LoadResult {
  let raw2: string | null = null
  try { raw2 = localStorage.getItem(V2_KEY) } catch { /* 隐私模式等 */ }

  if (raw2) {
    try {
      const parsed = JSON.parse(raw2)
      if (isProgressV2(parsed)) return { progress: normalize(parsed), notice: null }
      throw new Error('schema mismatch')
    } catch {
      // v2 损坏：先备份损坏副本，再尝试从 v1 恢复——不静默删除任何数据
      try { localStorage.setItem(BACKUP_PREFIX + Date.now(), raw2) } catch { /* ignore */ }
      const fromV1 = tryMigrateFromV1()
      if (fromV1) return { progress: normalize(fromV1), notice: 'corrupt-recovered' }
      return { progress: defaultProgressV2(), notice: 'corrupt-recovered' }
    }
  }

  const fromV1 = tryMigrateFromV1()
  if (fromV1) {
    // 写入并回读校验成功后才启用 v2（v1 保留）
    const ok = writeRaw(fromV1)
    lastSaveError = !ok
    if (ok) {
      try {
        const back = JSON.parse(localStorage.getItem(V2_KEY) ?? 'null')
        if (isProgressV2(back)) return { progress: normalize(fromV1), notice: 'migrated' }
      } catch { /* fallthrough */ }
    }
    // 回读失败：内存里继续用 v2，不报错，下次保存再试
    return { progress: normalize(fromV1), notice: 'migrated' }
  }

  return { progress: defaultProgressV2(), notice: null }
}

function tryMigrateFromV1(): ProgressV2 | null {
  try {
    const raw = localStorage.getItem(V1_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!isV1(parsed)) return null
    return migrateV1toV2(parsed)
  } catch {
    return null
  }
}

/** 归一化（连续天数清零、事件上限裁剪）：接管数据库存档前也走一遍 */
export function normalizeProgress(p: ProgressV2): ProgressV2 {
  return normalize(p)
}

function normalize(p: ProgressV2): ProgressV2 {
  // 连续天数：上次活跃不是昨天且早于昨天 → 清零（本地日期）
  if (p.lastActiveDate && p.lastActiveDate !== localDateStr()) {
    const gap = daysBetween(p.lastActiveDate, localDateStr())
    if (gap >= 2) p.streak = 0
  }
  if (p.attempts.length > MAX_ATTEMPTS) p.attempts = p.attempts.slice(-MAX_ATTEMPTS)
  return p
}

function daysBetween(a: string, b: string): number {
  return (new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000
}

function writeRaw(p: ProgressV2): boolean {
  try {
    localStorage.setItem(V2_KEY, JSON.stringify(p))
    return true
  } catch {
    return false
  }
}

let lastSaveError = false

/** 存档：返回是否写入成功；失败时 UI 需提示并允许导出（用例 12） */
export function saveProgressV2(p: ProgressV2): boolean {
  const ok = writeRaw(p)
  lastSaveError = !ok
  return ok
}

export function hadSaveError(): boolean {
  return lastSaveError
}

export function clearSaveError() {
  lastSaveError = false
}

/**
 * 记一条作答事件（幂等：同一 attemptId 只记一次），并立即落盘。
 * 返回 false 表示重复事件或写入失败。
 */
export function pushAttempt(p: ProgressV2, a: Attempt): { recorded: boolean; saved: boolean } {
  if (p.attempts.some((x) => x.attemptId === a.attemptId)) return { recorded: false, saved: true }
  p.attempts.push(a)
  if (p.attempts.length > MAX_ATTEMPTS) p.attempts = p.attempts.slice(-MAX_ATTEMPTS)
  const saved = saveProgressV2(p)
  return { recorded: true, saved }
}

export function resetProgress() {
  // 用户显式清空：先把当前 v2 备份一份，再清两版（v1 若残留会导致下次迁移复活旧进度）
  try {
    const cur = localStorage.getItem(V2_KEY)
    if (cur) localStorage.setItem(BACKUP_PREFIX + Date.now(), cur)
  } catch { /* ignore */ }
  try { localStorage.removeItem(V2_KEY) } catch { /* ignore */ }
  try { localStorage.removeItem(V1_KEY) } catch { /* ignore */ }
}

/** 导出可恢复存档（原始 v2 JSON）——与统计报告导出是两种功能 */
export function exportSave(current?: ProgressV2): string {
  if (current) return JSON.stringify(current)
  try { return localStorage.getItem(V2_KEY) ?? JSON.stringify(defaultProgressV2()) }
  catch { return JSON.stringify(defaultProgressV2()) }
}

export interface ImportPreview {
  schemaVersion: number
  xp: number
  streak: number
  attempts: number
  sessions: number
  activeSession: boolean
}

/** 导入前置校验：返回预览供确认；不写入 */
export function previewImport(text: string): ImportPreview | { error: string } {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { error: '不是有效的 JSON 文件' } }
  if (!isProgressV2(parsed)) return { error: '不是 EnglishForge v2 存档（schemaVersion 需为 2）' }
  const p = parsed
  if (typeof p.xp !== 'number' || !p.skills || !Array.isArray(p.attempts)) {
    return { error: '存档字段不完整（xp / skills / attempts 缺失）' }
  }
  return {
    schemaVersion: p.schemaVersion,
    xp: p.xp,
    streak: p.streak,
    attempts: p.attempts.length,
    sessions: p.sessions?.length ?? 0,
    activeSession: !!p.activeSession,
  }
}

/** 导入执行：先备份当前存档，再替换。返回是否成功 */
export function applyImport(text: string): { ok: boolean; error?: string } {
  const preview = previewImport(text)
  if ('error' in preview) return { ok: false, error: preview.error }
  try {
    const cur = localStorage.getItem(V2_KEY)
    if (cur) localStorage.setItem(BACKUP_PREFIX + Date.now(), cur)
    const parsed = JSON.parse(text) as ProgressV2
    localStorage.setItem(V2_KEY, JSON.stringify(normalize(parsed)))
    return { ok: true }
  } catch {
    return { ok: false, error: '写入失败：本地存储不可用' }
  }
}
