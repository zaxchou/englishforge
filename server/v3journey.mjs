// 47 号（用户反馈：路线不清楚、没有段位感）：
// · getJourney —— 学习路线时间线：已完成的课（按时间）、正在学的课（含步数进度）、接下来有什么（已备好/备用/准备中）
// · computeLevel —— 段位：从**真实练习记录**算（完成课数 + 听说读写各项到什么程度），
//   不造百分比、不把练习次数当能力；升级条件说人话，进度可解释
// · getGrowth —— 段位卡 + 成长统计（给完成页的"本次小结"与升级时刻用）
// 全部只读；纯函数可测。
import { ensureV3Schema } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { getLesson, completedLessonIds } from './v3lessons.mjs'

const STATE_RANK = { unmeasured: 0, tentative: 1, trained: 1, independent: 2, transferred: 3, retained: 4 }

/** 段位阶梯（说人话的升级条件）。全部条件必须来自真实记录：
 * lessons = 完成课数；independent = "能自己做对"的目标数；transfer = "换个情境也会"的目标数；
 * fourSkills = 听/说/读/写里已有 independent 及以上的方向数；growth = 各目标状态加权分。 */
export const LEVELS = [
  { index: 1, title: '起步者', at: () => true, how: '完成第一课就升级' },
  { index: 2, title: '入门了', at: (s) => s.lessons >= 1 || s.growth >= 2, how: '完成第一课' },
  { index: 3, title: '上手了', at: (s) => s.lessons >= 2 && s.growth >= 5, how: '再完成 2 课，把几项练到「练过」以上' },
  { index: 4, title: '站稳了', at: (s) => s.independent >= 2, how: '有 2 个目标做到「能自己做对」（不看提示独立答对）' },
  { index: 5, title: '能迁移', at: (s) => s.transfer >= 1, how: '有 1 个目标做到「换个情境也会」' },
  { index: 6, title: '熟练了', at: (s) => s.independent + s.transfer >= 4 && s.lessons >= 5, how: '累计 4 个目标独立/迁移，并完成 5 课' },
  { index: 7, title: '高手', at: (s) => s.fourSkills >= 4, how: '听、说、读、写四个方向都至少有一项能独立完成' },
]

/** 纯函数：给定状态行与完成课数，算段位与到下一段的进度。 */
export function computeLevel(states, lessonsCompleted) {
  const base = (states ?? []).filter((s) => s.complexity === 'base' && !String(s.flags ?? '').includes('waived_by_user'))
  const rankOf = (st) => STATE_RANK[st] ?? 0
  const summary = {
    lessons: lessonsCompleted ?? 0,
    independent: base.filter((s) => s.state === 'independent' || s.state === 'transferred' || s.state === 'retained').length,
    transfer: base.filter((s) => s.state === 'transferred' || s.state === 'retained').length,
    growth: base.reduce((acc, s) => acc + rankOf(s.state), 0),
    fourSkills: new Set(base.filter((s) => rankOf(s.state) >= 2).map((s) => s.skill)).size,
  }
  let level = LEVELS[0]
  for (const l of LEVELS) if (l.at(summary)) level = l
  const next = LEVELS.find((l) => l.index === level.index + 1) ?? null
  return { level: level.title, levelIndex: level.index, nextTitle: next?.title ?? null, nextHow: next?.how ?? '已经是最高段位', summary }
}

/** 学习路线：完成的时间线 + 当前课与进度 + 接下来的课。 */
export function getJourney(accountId) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const doneRows = conn.prepare(
    "SELECT served_lesson_id, created_at FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL ORDER BY created_at").all(accountId)
  const seen = new Set()
  const completed = []
  for (const r of doneRows) {
    if (seen.has(r.served_lesson_id)) continue
    seen.add(r.served_lesson_id)
    const l = getLesson(r.served_lesson_id)
    completed.push({ lessonId: r.served_lesson_id, title: l?.title ?? r.served_lesson_id, at: r.created_at })
  }
  // 当前课：最近的 served 决策（ready/served 未完成），并按取课后的作答算步数进度
  const row = conn.prepare(
    "SELECT served_lesson_id, status, served_at, created_at FROM plan_decisions WHERE account_id = ? AND status IN ('ready','served') AND served_lesson_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(accountId)
  let current = null
  if (row) {
    const l = getLesson(row.served_lesson_id)
    if (l && l.contentStatus === 'published') {
      const since = row.served_at ?? row.created_at
      const attempted = new Set(conn.prepare(
        'SELECT DISTINCT activity_id FROM learner_attempts_v3 WHERE account_id = ? AND created_at >= ?').all(accountId, since).map((r) => r.activity_id))
      const total = l.activities.length
      const doneSteps = l.activities.filter((a) => attempted.has(a.activityId)).length
      current = { lessonId: l.lessonId, title: l.title, doneSteps, total, finished: total > 0 && doneSteps >= total }
    }
  }
  // 接下来：当前课声明的后继（已发布且没学过）→ 备用候选（最近完成课的链延续）→ 无
  const upcoming = []
  const done = completedLessonIds(conn, accountId)
  const lastDone = completed[completed.length - 1]
  const nextIds = new Set()
  if (current) {
    for (const nid of getLesson(current.lessonId)?.nextCandidates ?? []) nextIds.add(nid)
  } else if (lastDone) {
    for (const nid of getLesson(lastDone.lessonId)?.nextCandidates ?? []) nextIds.add(nid)
  }
  for (const nid of nextIds) {
    const l = getLesson(nid)
    if (l && l.contentStatus === 'published' && !done.has(l.lessonId)) {
      upcoming.push({ lessonId: l.lessonId, title: l.title, status: 'ready', note: '已备好，完成当前课就会接上' })
    }
  }
  return {
    completed,
    current,
    upcoming,
    lessonNumber: completed.length + 1,
    totalLessonsLearnable: completed.length + (current ? 1 : 0) + upcoming.length,
  }
}

/** 段位卡：段位、进度说明、成长统计（完成页的"本次小结"与升级判断用）。 */
export function getGrowth(accountId) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const states = conn.prepare("SELECT objective_id AS objectiveId, skill, complexity, state, flags FROM learner_states WHERE account_id = ?").all(accountId)
  const lessons = new Set(conn.prepare(
    "SELECT served_lesson_id FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL").all(accountId).map((r) => r.served_lesson_id))
  const g = computeLevel(states, lessons.size)
  return { ...g, stats: g.summary }
}
