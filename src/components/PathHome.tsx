// 单一推进路径首页。
//
// 用户的要求（也是这个项目最初的方向）：界面上只回答一个问题——「下一步做什么」。
// 所以这里只有：当前知识点 + 距离掌握还差什么 + 一个大按钮 + 一条路径。
// 侧边栏（导航、账户与数据库状态）与顶栏由 App 统一渲染 —— 首页与内页同一套外壳，
// 不再出现"点进去才有侧栏"的前后台不一致。
import { useMemo } from 'react'
import type { AdaptedQuestion, ProgressV2 } from '../types'
import { lessons } from '../data/course'
import type { EvidenceReport } from '../learning/evidence'
import type { TodayBrief } from './Dashboard'
import './path-home.css'

interface Props {
  progress: ProgressV2
  evidence: EvidenceReport
  todayBrief: TodayBrief
  pool: AdaptedQuestion[]
  onStartToday: () => void
  onResume: () => void
  onStartSkill: (skillId: string) => void
}

export function PathHome({
  progress, evidence, todayBrief: brief, pool,
  onStartToday, onResume, onStartSkill,
}: Props) {
  const skills = useMemo(() => Object.values(lessons).flatMap((l) => l.skills), [])
  const lessonOf = useMemo(() => {
    const m = new Map<string, { no: string; title: string }>()
    for (const l of Object.values(lessons)) for (const s of l.skills) m.set(s.id, { no: l.no, title: l.title })
    return m
  }, [])

  const current = skills.find((s) => s.name === brief.skillName) ?? skills[0]
  const ev = evidence.bySkill[current.id]
  const state = ev?.state ?? 'unseen'
  const mastered = state === 'early-stable' || state === 'durable'
  // 只显示"还差什么"：已满足的条件不必占版面
  const gaps = (ev?.evidence ?? []).filter((t) => /还需|需跨|需覆盖|还缺|待/.test(t))
  const done = pool.filter((q) => q.skill === current.id && (progress.questionStates[q.id]?.stage ?? 0) >= 1).length
  const total = pool.filter((q) => q.skill === current.id).length
  const lesson = lessonOf.get(current.id)

  // 路径：每个知识点一个点，位置 = 课程顺序
  const path = skills.map((s, i) => {
    const st = evidence.bySkill[s.id]?.state ?? 'unseen'
    const n = pool.filter((q) => q.skill === s.id && (progress.questionStates[q.id]?.stage ?? 0) >= 1).length
    const t = pool.filter((q) => q.skill === s.id).length
    return { skill: s, i, state: st, done: n, total: t, isCurrent: s.id === current.id }
  })

  return (
    <div className="path-home">
      <main className="path-main">
        <section className="next-card">
          <div className="next-eyebrow">
            {lesson ? `第 ${lesson.no} 课 · ${lesson.title}` : '当前知识点'}
            {` · 第 ${path.findIndex((p) => p.isCurrent) + 1} / ${skills.length} 个思维点`}
          </div>
          <h1>{current.name}</h1>
          <p className="next-tagline">{current.tagline}</p>
          <div className="next-example">{current.concept.example}</div>

          <div className={`next-goal ${mastered ? 'done' : ''}`}>
            {mastered ? (
              <><b>已掌握</b><p>这个知识点已经达标，主推进会前进到下一个；剩余题目只作复习素材。</p></>
            ) : (
              <>
                <b>距离掌握还差 {gaps.length || 1} 步</b>
                <ul>{(gaps.length ? gaps : ['先从微课卡理解这个知识点，再做一轮练习']).map((g) => <li key={g}>{g}</li>)}</ul>
              </>
            )}
            <div className="next-count">做过 {done}/{total} 题 · 不必做完所有题，达标即可前进</div>
          </div>

          <button className="primary next-btn" onClick={brief.hasResume ? onResume : onStartToday}>
            {brief.hasResume ? '继续上次练习' : '继续下一步'} <span>→</span>
          </button>
          <div className="next-note">
            {brief.dueCount > 0
              ? `今天有 ${brief.dueCount} 个到期复习，会先出现；约 ${brief.queueLen} 个短任务，随时可暂停`
              : `约 ${brief.queueLen} 个短任务 · 每次提交自动保存，随时可暂停`}
          </div>
        </section>

        <nav className="path-strip" aria-label="学习路径">
          <div className="path-caption">
            <b>学习路径</b>
            <span>{path.filter((p) => p.state === 'early-stable' || p.state === 'durable').length} / {skills.length} 个知识点已掌握</span>
          </div>
          <div className="path-dots">
            {path.map((p) => (
              <button
                key={p.skill.id}
                className={`path-dot st-${p.state}${p.isCurrent ? ' current' : ''}`}
                title={`${p.skill.name} · ${STATE_TEXT[p.state]}${p.total ? ` · 做过 ${p.done}/${p.total} 题` : '（暂无题目）'}`}
                onClick={() => onStartSkill(p.skill.id)}
                disabled={p.total === 0}
              >
                <i>{p.i + 1}</i>
              </button>
            ))}
          </div>
          <div className="path-here">当前：第 {path.findIndex((p) => p.isCurrent) + 1} 步 · {current.name}</div>
        </nav>
      </main>
    </div>
  )
}

const STATE_TEXT: Record<string, string> = {
  unseen: '未练习', building: '建立中', 'early-stable': '初步稳定', durable: '持续巩固',
}
