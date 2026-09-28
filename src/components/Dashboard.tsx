import { useMemo, useState } from 'react'
import type { ProgressV2 } from '../types'
import { lessons } from '../data/course'
import { recentDaysXp, todayStr } from '../store/progress'
import type { EvidenceReport } from '../learning/evidence'
import './dashboard.css'

export interface TodayBrief {
  skillName: string | null
  skillLesson: string
  dueCount: number
  dueTake: number
  hasResume: boolean
  queueLen: number
  stateCounts: { unseen: number; building: number; early: number; durable: number; total: number }
}

interface Props {
  progress: ProgressV2
  evidence: EvidenceReport
  todayBrief: TodayBrief
  soundOn: boolean
  saveErr: boolean
  onToggleSound: () => void
  onOpenLesson: (id: string) => void
  onStartToday: () => void
  onResume: () => void
  onStartReview: () => void
  onExportSave: () => void
  onImportSave: () => void
  onReset: () => void
  onReviewContent: () => void
}


type NavTarget = 'today' | 'courses' | 'history' | 'settings'
export function Sidebar({ active = 'today', dueCount, onNavigate, onReview }: {
  active?: NavTarget; dueCount: number; onNavigate: (target: NavTarget) => void; onReview: () => void
}) {
  return <aside className="forge-sidebar">
    <button className="forge-brand" onClick={() => onNavigate('today')} aria-label="EnglishForge 首页">
      <img className="forge-mark" src="/icon-96.png" alt="" /><span>EnglishForge<small>英语思维训练</small></span>
    </button>
    <div className="sidebar-space"><span className="profile-circle">学</span><div>我的学习空间<small>循序渐进 · 自在表达</small></div></div><div className="nav-label">LEARNING SPACE</div><nav aria-label="主导航">
      <button className={active === 'today' ? 'selected' : ''} onClick={() => onNavigate('today')}><NavIcon kind="home" />今日练习</button>
      <button className={active === 'courses' ? 'selected' : ''} onClick={() => onNavigate('courses')}><NavIcon kind="book" />全部课程</button>
      <button onClick={onReview}><NavIcon kind="review" />巩固复习{dueCount > 0 && <span className="nav-count">{dueCount}</span>}</button>
      <button className={active === 'history' ? 'selected' : ''} onClick={() => onNavigate('history')}><NavIcon kind="chart" />学习记录</button>
    </nav>
    <div className="sidebar-bottom"><div className="sidebar-focus"><span>✦ 每天，一点进步</span><p>让理解成为直觉</p><button onClick={() => onNavigate('today')}>回到今日练习 <span>↗</span></button></div><button className={active === 'settings' ? 'selected' : ''} onClick={() => onNavigate('settings')}><NavIcon kind="settings" />设置与存档</button>
      <div className="local-profile"><span className="profile-circle">学</span><div>本地学员<small>一步一步，让表达更自然</small></div></div>
    </div>
  </aside>
}
function NavIcon({ kind }: { kind: string }) {
  const paths: Record<string, string> = { home: 'M3 10 12 3l9 7v10h-6v-6H9v6H3Z', book: 'M12 5v15M3 4h5l4 2 4-2h5v15h-5l-4 2-4-2H3Z', review: 'M20 8A8 8 0 1 0 20 16M20 3v5h-5', chart: 'M4 20V12M10 20V5M16 20V9M22 20V2', settings: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1' }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[kind]} />{kind === 'settings' && <circle cx="12" cy="12" r="5" />}</svg>
}
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
export function Dashboard({ progress, evidence, todayBrief: brief, soundOn, saveErr, onToggleSound, onOpenLesson, onStartToday, onResume, onStartReview, onExportSave, onImportSave, onReset, onReviewContent }: Props) {
  const [query, setQuery] = useState('')
  const [section, setSection] = useState<NavTarget>('today')
  const [showMore, setShowMore] = useState(false)
  const days = recentDaysXp(progress, 7)
  const sessions = progress.sessions ?? []
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return Object.values(lessons).filter(l => [l.no,l.title,l.subtitle,...l.skills.map(s => s.name + s.tagline)].join(' ').toLowerCase().includes(needle))
  }, [query])
  const recommended = Object.values(lessons).flatMap(l => l.skills).find(s => s.name === brief.skillName)
  const recommendedLesson = Object.values(lessons).find(l => l.skills.some(s => s.name === brief.skillName)) ?? Object.values(lessons)[0]
  const example = recommended?.concept.example ?? 'She helps him.'
  const states = [
    { label: '待探索', count: brief.stateCounts.unseen, tone: 'unseen' },
    { label: '建立中', count: brief.stateCounts.building, tone: 'building' },
    { label: '初步稳定', count: brief.stateCounts.early, tone: 'early' },
    { label: '持续巩固', count: brief.stateCounts.durable, tone: 'durable' },
  ]
  const weekXp = days.reduce((sum, day) => sum + day.xp, 0)
  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  function navigate(target: NavTarget) {
    setSection(target)
    document.getElementById(target === 'today' ? 'today' : target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return <div className="workspace">
    <Sidebar active={section} dueCount={brief.dueCount} onNavigate={navigate} onReview={onStartReview} />
    <header className="workspace-header"><div>学习空间 <span>/</span> <b>今日练习</b></div>
      <div className="header-tools"><div className="search-wrap"><span aria-hidden="true">⌕</span><input aria-label="搜索课程或知识点" placeholder="搜索课程或知识点" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery('') }} />
        {query.trim() && <div className="search-results">{results.length ? results.map(l => <button key={l.id} onClick={() => { onOpenLesson(l.id); setQuery('') }}>第 {l.no} 课 · {l.title}<small>{l.subtitle}</small></button>) : <p>没有找到相关课程，试试“动词”或“07”。</p>}</div>}
      </div><button className="sound-control" aria-label={soundOn ? '关闭音效' : '开启音效'} onClick={onToggleSound}>{soundOn ? '音效 开' : '音效 关'}</button><span className="profile-circle">学</span></div>
    </header>
    <div className="workspace-body" id="today">
      <div className="welcome"><div><h1>{greeting}，开始今天的练习</h1><p>每次练一点，让理解慢慢变成直觉。</p></div><div className="welcome-meta"><time>{now.getMonth()+1}月{now.getDate()}日 · 周{WEEKDAYS[now.getDay()]}</time><span className="attention-pill">{brief.dueCount ? `${brief.dueCount} 个任务待巩固` : '今天，也向前一步'}</span></div></div>

      <div className="learning-grid"><div className="learning-main">
        <section className="recommend-card" aria-labelledby="recommend-title"><div className="recommend-content"><div className="eyebrow">{brief.hasResume ? '继续上次 · 进度已保留' : `今日推荐 · 第 ${brief.skillLesson || '07'} 课`}</div><h2 id="recommend-title">{brief.hasResume ? '从上次停下的地方继续' : brief.skillName ?? '让含义与形式连接起来'}</h2><p>{brief.hasResume ? '已经完成的任务不会丢失，按自己的节奏继续。' : recommended?.tagline ?? '从理解到表达，一次练好一个知识点。'}</p>
          <div className="sentence-preview"><span className="example-label">{brief.hasResume ? '学习提示' : '本课例句'}</span><div>{brief.hasResume ? '理解 → 练习 → 表达' : example}</div><small>{brief.hasResume ? '遇到不确定的地方，可以慢慢来。' : '先读懂意思，再练习如何表达。'}</small></div>
          <div className="recommend-action"><button className="primary" onClick={brief.hasResume ? onResume : onStartToday}>{brief.hasResume ? '继续上次练习' : '开始练习'} <span>→</span></button><button className="lesson-preview-button" onClick={() => onOpenLesson(recommendedLesson.id)}>查看本课知识点 ↗</button><span>约 {brief.queueLen} 个短任务 · 随时可暂停</span></div></div>
        </section>
        <div className="learning-steps" aria-label="练习流程"><span><i>1</i>{brief.dueCount ? `先复习 ${brief.dueTake} 题` : '理解知识点'}</span><b /><span><i>2</i>练习新变化</span><b /><span><i>3</i>尝试表达</span></div>
        <section className="course-section" id="courses"><div className="section-heading"><h2>按章节，稳步向前</h2><span>{Object.keys(lessons).length} 个可学章节</span></div><div className="course-list">
          {Object.values(lessons).map(lesson => {
            const started = lesson.skills.filter(s => (progress.skills[s.id]?.total ?? 0) > 0 || (evidence.bySkill[s.id]?.state ?? 'unseen') !== 'unseen').length
            const stable = lesson.skills.filter(s => ['early-stable','durable'].includes(evidence.bySkill[s.id]?.state ?? '')).length
            const markTone = stable ? ' is-stable' : started ? ' is-started' : ''
            return <button className="course-row" key={lesson.id} onClick={() => onOpenLesson(lesson.id)}><span className={`course-number${markTone}`}>{lesson.no}</span><div className="course-copy"><h3>{lesson.no === '07' ? '含义与形式' : lesson.no === '10' ? '动词与表达' : lesson.title}</h3><p>{lesson.subtitle}</p><small>{stable} / {lesson.skills.length} 个知识点达到初步稳定</small></div><span className="course-status">{started ? '继续学习' : '开始学习'}<span>→</span></span></button>
          })}<div className="course-row forthcoming"><span className="course-number">···</span><div className="course-copy"><h3>后续课程</h3><p>更多句子结构与阅读练习</p></div><span>正在准备</span></div>
        </div></section>
        <section className="learning-overview" aria-label="学习概览"><div className="section-heading"><h2>每一步，都算数</h2><span className="period-label">最近 7 天</span></div><div className="overview-metrics"><div className="metric metric-dark"><span>练习足迹</span><strong>{weekXp}<small> XP</small></strong><small>最近 7 天积累</small></div><div className="metric"><span>连续学习</span><strong>{progress.streak}<small> 天</small></strong><small>保持自己的节奏</small></div><div className="metric"><span>待巩固任务</span><strong>{brief.dueCount}</strong><small>通过复习加深记忆</small></div><div className="metric"><span>已稳定知识点</span><strong>{brief.stateCounts.early + brief.stateCounts.durable}<small> / {brief.stateCounts.total}</small></strong><small>以实际练习证据为准</small></div></div><div className="knowledge-pipeline"><div><b>知识正在生长</b><span>理解 → 练熟 → 保持</span></div><div className="pipeline-track" aria-hidden="true">{states.filter(s => s.count > 0).map(s => <i key={s.tone} className={s.tone} style={{ flex: s.count }} />)}</div><div className="pipeline-legend">{states.map(s => <span key={s.tone}><i className={s.tone} /><b>{s.count}</b> {s.label}</span>)}</div></div></section>
        <section id="history"><div className="section-heading"><h2>最近练习</h2>{sessions.length > 3 && <button className="text-button" onClick={() => setShowMore(!showMore)}>{showMore ? '收起记录' : '查看全部记录'} →</button>}</div><div className="history-list">{sessions.length === 0 ? <div className="empty-state">还没有练习记录。完成第一轮，就能在这里看到自己的脚步。</div> : sessions.slice(0,showMore ? 30 : 3).map((s,i) => <div className="history-row" key={`${s.ts}-${i}`}><span className="history-symbol">▤</span><div><b>{s.label}</b><small>{new Date(s.ts).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · {s.total} 个任务</small></div><span>+{s.xp} XP</span></div>)}</div></section>
      </div>
      <aside className="learning-aside"><section className="review-spotlight"><div className="spotlight-top"><span>✦ 巩固时刻</span><span>SPACED PRACTICE</span></div><h2>{brief.dueCount ? `${brief.dueCount} 个任务，等你再见` : '给记忆一点时间'}</h2><p>{brief.dueCount ? '换个时间再次想起，让学过的知识留得更久。' : '目前没有到期任务。完成练习后，系统会安排后续复习。'}</p><button onClick={brief.dueCount ? onStartReview : onStartToday}>{brief.dueCount ? '开始巩固' : '探索今日练习'} <span>↗</span></button></section><section className="side-panel"><h2>{brief.hasResume ? '这次，接着往前' : '本轮安排'}</h2><ol className="round-plan"><li><i>01</i><div><b>{brief.dueCount ? '温习旧知识' : '理解一个知识点'}</b><p>{brief.dueCount ? `${brief.dueCount} 个到期任务，分轮巩固` : '从简短的微课开始'}</p></div></li><li><i>02</i><div><b>练习新变化</b><p>选择、拼句，换种方式理解</p></div></li><li><i>03</i><div><b>尝试表达</b><p>按题型练习，不急着一次学会</p></div></li></ol><div className={`save-status ${saveErr ? 'save-warning' : ''}`}>{saveErr ? '保存遇到问题，请先在设置中导出当前进度。' : '每次提交后自动保存，随时可以暂停。'}</div></section>
        <section className="side-panel"><div className="section-heading"><h2>我的学习足迹</h2><span>{progress.streak} 天连续</span></div><div className="week-strip">{days.map(d => <div key={d.date} className={d.date === todayStr() ? 'current' : ''} title={`${d.date} · ${d.xp} XP`}><span>周{WEEKDAYS[new Date(d.date+'T12:00:00').getDay()]}</span><i className={d.xp ? 'practiced' : ''} /></div>)}</div><div className="ability-list">{evidence.dims.map(d => <div key={d.mode}><span>{d.label}</span><b>{d.total ? `${d.correct}/${d.total} 次首次答对` : '待练习'}</b></div>)}<div><span>延迟保持</span><b>{evidence.dueSuccesses ? `${evidence.dueSuccesses} 次检索成功` : '待隔日检查'}</b></div><div><span>口头表达</span><b>{evidence.oral.independentAi ? '已有 AI 评价' : evidence.oral.independentSelf ? '已有自评记录' : evidence.oral.prompted ? '有提示练习' : '待尝试'}</b></div></div><p className="panel-note">记录来自实际练习，逐步积累，不急于打分。</p></section>
        <section className="quiet-note">更清晰地表达，<br />就是更自由地生活。<small>ENGLISHFORGE</small></section>
      </aside></div>
      <section id="settings" className="settings-panel"><div><h2>设置与存档</h2><p>进度保存在当前浏览器。导出备份后，可以在其他设备恢复；「审核生成内容」用于逐题核对语料派生的题目。</p></div><div className="settings-actions"><button className="secondary" onClick={onReviewContent}>审核生成内容</button><button className="secondary" onClick={onExportSave}>导出存档</button><button className="secondary" onClick={onImportSave}>导入存档</button><button className="text-button danger" onClick={onReset}>清空进度</button></div></section>
    </div>
  </div>
}
