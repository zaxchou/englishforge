// 单一推进路径的首页。
//
// 用户的要求（也是这个项目最初的方向）：界面上只回答一个问题——「下一步做什么」。
// 所以这里只有：当前知识点 + 距离掌握还差什么 + 一个大按钮；章节、记录、设置全部退到
// 「回顾」里。学习记录页仍保留（旧 Dashboard），只是不再挡在路上。
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
  soundOn: boolean
  /** 一行入库状态：进度是否已经写进数据库（null = 数据库还没连上） */
  dbLine: string | null
  onToggleSound: () => void
  onStartToday: () => void
  onResume: () => void
  onStartReview: () => void
  onStartSkill: (skillId: string) => void
  onOpenRecords: () => void
  onReviewContent: () => void
}

export function PathHome({
  progress, evidence, todayBrief: brief, pool, soundOn, dbLine, onToggleSound,
  onStartToday, onResume, onStartReview, onStartSkill, onOpenRecords, onReviewContent,
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
      <header className="path-top">
        <span className="path-brand"><img className="path-mark" src="/icon-96.png" alt="" />EnglishForge</span>
        <button className="sound-control" onClick={onToggleSound} aria-label={soundOn ? '关闭音效' : '开启音效'}>
          {soundOn ? '音效 开' : '音效 关'}
        </button>
      </header>

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

        <div className="path-foot">
          <button onClick={onOpenRecords}>回顾：全部课程与学习记录</button>
          <button onClick={onStartReview}>只做到期复习{brief.dueCount ? `（${brief.dueCount}）` : ''}</button>
          <button onClick={onReviewContent}>题目审核</button>
        </div>
        {dbLine && <div className="path-db">🗄️ {dbLine}</div>}
      </main>
    </div>
  )
}

const STATE_TEXT: Record<string, string> = {
  unseen: '未练习', building: '建立中', 'early-stable': '初步稳定', durable: '持续巩固',
}
