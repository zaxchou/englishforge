// 47/49 号：学习路线时间线 + 段位成长。48 号复审五项修正全部落实：
// · 显式四技能（listening/speaking/reading/writing；interaction 不冒充写作）；
// · 未解决的争议（disputed）与免修（waived）都不进段位（与成长视图同口径）；
// · "独立/迁移目标数"按唯一 目标×技能 键计数，transferred/retained 不与 independent 重复累加；
// · 升级文案按实际缺口动态生成（给出"已达到/还差"），不用固定话术；
// · 最高段位只说"四个方向都起步"，不暗示整体英语精通（成就徽章 ≠ 能力结论）。
// 全部只读；纯函数可测。
import { ensureV3Schema } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { getLesson, completedLessonIds } from './v3lessons.mjs'

const STATE_RANK = { unmeasured: 0, tentative: 1, trained: 1, independent: 2, transferred: 3, retained: 4 }
const FOUR_SKILLS = ['listening', 'speaking', 'reading', 'writing']

export const LEVELS = [
  { index: 1, title: '起步者', at: () => true },
  { index: 2, title: '入门了', at: (s) => s.lessons >= 1 || s.growth >= 2 },
  { index: 3, title: '上手了', at: (s) => s.lessons >= 2 && s.growth >= 5 },
  { index: 4, title: '站稳了', at: (s) => s.distinct >= 2 },
  { index: 5, title: '能迁移', at: (s) => s.transfer >= 1 },
  { index: 6, title: '熟练了', at: (s) => s.distinct >= 4 && s.lessons >= 5 },
  { index: 7, title: '四项起步', at: (s) => s.fourSkills >= 4 },
]

/** 动态升级条件：按下一级的每个条件算"已达到/还差"，返回说人话的缺口描述。 */
function nextGap(levelIndex, summary) {
  const next = LEVELS.find((l) => l.index === levelIndex + 1)
  if (!next) return { title: null, how: '这枚成长徽章记录的是已发生的表现；哪些还没测到，见下方能力记录。' }
  const parts = []
  if (next.index === 2 && !(summary.lessons >= 1 || summary.growth >= 2)) parts.push('完成第一课（或把几项练到「练过」）')
  if (next.index === 3) {
    if (summary.lessons < 2) parts.push(`再完成 ${2 - summary.lessons} 课`)
    if (summary.growth < 5) parts.push('把几项练到「练过」以上')
  }
  if (next.index === 4 && summary.distinct < 2) parts.push(`再有 ${2 - summary.distinct} 个目标做到「能自己做对」（不看提示独立答对）`)
  if (next.index === 5 && summary.transfer < 1) parts.push('有 1 个目标在新情境也答对（「换个情境也会」）')
  if (next.index === 6) {
    if (summary.distinct < 4) parts.push(`独立/迁移的目标累计到 ${4 - summary.distinct} 个`)
    if (summary.lessons < 5) parts.push(`完成 ${5 - summary.lessons} 课`)
  }
  if (next.index === 7 && summary.fourSkills < 4) parts.push(`听、说、读、写四个方向都至少有一项独立完成（现在 ${summary.fourSkills}/4）`)
  return { title: next.title, how: parts.length ? `还差：${parts.join('；')}` : '条件已满足，完成本课后就会升级' }
}

/** 纯函数：给定状态行与完成课数，算段位、实际缺口与覆盖摘要（含未测提示）。 */
export function computeLevel(states, lessonsCompleted) {
  const base = (states ?? []).filter((s) => {
    if (s.complexity !== 'base') return false
    const flags = String(s.flags ?? '')
    if (flags.includes('waived_by_user')) return false
    if (flags.includes('disputed')) return false
    return true
  })
  const rankOf = (st) => STATE_RANK[st] ?? 0
  const distinctKeys = new Set(base.filter((s) => rankOf(s.state) >= 2).map((s) => `${s.objectiveId}|${s.skill}`))
  const summary = {
    lessons: lessonsCompleted ?? 0,
    distinct: distinctKeys.size,
    independent: distinctKeys.size,
    transfer: new Set(base.filter((s) => rankOf(s.state) >= 3).map((s) => `${s.objectiveId}|${s.skill}`)).size,
    growth: base.reduce((acc, s) => acc + rankOf(s.state), 0),
    fourSkills: new Set(base.filter((s) => rankOf(s.state) >= 2 && FOUR_SKILLS.includes(s.skill)).map((s) => s.skill)).size,
    untestedSkills: FOUR_SKILLS.filter((k) => !base.some((s) => s.skill === k && rankOf(s.state) >= 1)),
  }
  let level = LEVELS[0]
  for (const l of LEVELS) if (l.at(summary)) level = l
  const gap = nextGap(level.index, summary)
  return {
    level: level.title, levelIndex: level.index,
    nextTitle: gap.title, nextHow: gap.how,
    summary,
  }
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
  // 接下来：当前/最近完成课声明的后继（已发布且没学过）。
  // 48 号口径修正：这是"已备好的候选"——最终下一推荐由规划器结合状态决定，不承诺。
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
      upcoming.push({ lessonId: l.lessonId, title: l.title, status: 'ready', note: '已备好的候选课——完成当前课后由规划确认' })
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

/** 段位卡：段位、实际缺口、成长统计（完成页的"本次小结"与升级判断用）。 */
export function getGrowth(accountId) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const states = conn.prepare("SELECT objective_id AS objectiveId, skill, complexity, state, flags FROM learner_states WHERE account_id = ?").all(accountId)
  const lessons = new Set(conn.prepare(
    "SELECT served_lesson_id FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL").all(accountId).map((r) => r.served_lesson_id))
  const g = computeLevel(states, lessons.size)
  return { ...g, stats: g.summary }
}
