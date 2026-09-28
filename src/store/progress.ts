// v2 进度存档的读写与 XP / 会话 / 日历统计
// 题级复习规则在 learning/scheduler.ts；证据推导在 learning/evidence.ts
import type { ProgressV2, QuestionState, SessionLog, SkillProgress, AdaptedQuestion } from '../types'
import {
  loadProgressV2, saveProgressV2, resetProgress as resetV2,
  localDateStr, pushAttempt,
} from './migrations'
import type { LoadResult } from './migrations'

export type { LoadResult } from './migrations'
export { localDateStr } from './migrations'

const DAY = 24 * 60 * 60 * 1000

/** 本地日期（训练日） */
export function todayStr(): string {
  return localDateStr()
}

export function loadProgress(): LoadResult {
  return loadProgressV2()
}

export function saveProgress(p: ProgressV2): boolean {
  return saveProgressV2(p)
}

export function resetProgress() {
  resetV2()
}

export function getSkillProgress(p: ProgressV2, skillId: string): SkillProgress {
  return p.skills[skillId] ?? { conceptSeen: false, box: 0, due: 0, correct: 0, total: 0 }
}

export function getQuestionState(p: ProgressV2, qid: string): QuestionState | undefined {
  return p.questionStates[qid]
}

export { pushAttempt }

/** 记一次技能级练习（历史记录 + 推荐用；不再用于展示掌握百分比） */
export function recordSkillPractice(p: ProgressV2, skillId: string, firstTryCorrect: boolean) {
  const sp = getSkillProgress(p, skillId)
  sp.total += 1
  if (firstTryCorrect) {
    sp.correct += 1
    sp.box = Math.min(5, sp.box + 1)
    sp.due = Date.now() + (sp.box > 0 ? [0, 1, 2, 4, 7, 15][sp.box] : 1) * DAY
  } else {
    sp.box = 0
    sp.due = Date.now() + DAY
  }
  p.skills[skillId] = sp
}

/** 记录一次练习会话（供仪表盘列表/图表） */
export function recordSession(p: ProgressV2, log: Omit<SessionLog, 'ts'>) {
  if (!p.sessions) p.sessions = []
  p.sessions.unshift({ ...log, ts: Date.now() })
  p.sessions = p.sessions.slice(0, 30)
  if (!p.dailyXp) p.dailyXp = {}
  const d = todayStr()
  p.dailyXp[d] = (p.dailyXp[d] ?? 0) + log.xp
}

/** 近 n 天的每日 XP（含今天，按本地日期正序） */
export function recentDaysXp(p: ProgressV2, n = 7): { date: string; xp: number }[] {
  const out: { date: string; xp: number }[] = []
  const base = new Date()
  base.setHours(0, 0, 0, 0)
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * DAY)
    out.push({ date: localDateStr(d.getTime()), xp: p.dailyXp?.[localDateStr(d.getTime())] ?? 0 })
  }
  return out
}

/** 本周（近 7 天）与上周 XP 汇总，用于涨幅标签（本地日期） */
export function weekXp(p: ProgressV2): { thisWeek: number; lastWeek: number; trend: number | null } {
  let tw = 0, lw = 0
  const base = new Date()
  base.setHours(0, 0, 0, 0)
  for (let i = 0; i < 14; i++) {
    const d = localDateStr(base.getTime() - i * DAY)
    const v = p.dailyXp?.[d] ?? 0
    if (i < 7) tw += v; else lw += v
  }
  const trend = lw === 0 ? (tw > 0 ? null : 0) : Math.round(((tw - lw) / lw) * 100)
  return { thisWeek: tw, lastWeek: lw, trend }
}

/** 结算一次会话：XP、连续天数（本地日期） */
export function commitSession(p: ProgressV2, xpGain: number, comboBest: number): boolean {
  p.xp += xpGain
  p.comboBest = Math.max(p.comboBest, comboBest)
  const today = todayStr()
  if (p.lastActiveDate !== today) {
    const gap = p.lastActiveDate
      ? (new Date(today + 'T00:00:00').getTime() - new Date(p.lastActiveDate + 'T00:00:00').getTime()) / DAY
      : 99
    p.streak = gap <= 1 ? p.streak + 1 : 1
    p.lastActiveDate = today
  }
  return saveProgress(p)
}

/** 打乱数组（Fisher-Yates，运行时随机） */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 字符串哈希（seed 用） */
export function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return (h ^ (h >>> 16)) >>> 0
}

/** 种子随机洗牌：同 seed 可复现（测试用例 6：固定种子的测试可复现） */
export function seededShuffle<T>(arr: T[], seed: string): T[] {
  let s = hashSeed(seed) || 1
  const rnd = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 取题目（id → 题），供队列还原 */
export type QuestionIndex = Map<string, AdaptedQuestion>
