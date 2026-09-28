import { useMemo, useState } from 'react'
import type { ProgressV2 } from '../types'
import { lessons, modules } from '../data/course'
import { recentDaysXp, weekXp, todayStr } from '../store/progress'
import { STATE_LABEL, type EvidenceReport } from '../learning/evidence'
import './dashboard.css'

/** 首页三行简报（PLAN-v2 §3.1：今天练什么 / 多少到期 / 中断续练） */
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
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function Dashboard({ progress, evidence, todayBrief, soundOn, saveErr, onToggleSound, onOpenLesson, onStartToday, onResume, onStartReview, onExportSave, onImportSave, onReset }: Props) {
  const [period, setPeriod] = useState<'week' | 'all'>('week')
  const [query, setQuery] = useState('')
  const [showMore, setShowMore] = useState(false)

  // ---- 统计 ----
  const week = useMemo(() => weekXp(progress), [progress])
  const days = useMemo(() => recentDaysXp(progress, 4), [progress])
  const sc = todayBrief.stateCounts
  const stable = sc.early + sc.durable

  const dueCount = todayBrief.dueCount

  const todayXp = progress.dailyXp?.[todayStr()] ?? 0
  const todayGoal = 60
  const goalPct = Math.min(1, todayXp / todayGoal)

  const sessions = progress.sessions ?? []
  const shownSessions = showMore ? sessions.slice(0, 12) : sessions.slice(0, 3)

  // ---- 搜索 ----
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const out: { type: 'lesson' | 'skill'; lessonId: string; lessonNo: string; title: string; sub?: string }[] = []
    for (const les of Object.values(lessons)) {
      if ((les.title + les.no).toLowerCase().includes(q)) {
        out.push({ type: 'lesson', lessonId: les.id, lessonNo: les.no, title: `第 ${les.no} 课 · ${les.title}`, sub: les.subtitle })
      }
      for (const sk of les.skills) {
        if ((sk.name + sk.tagline).toLowerCase().includes(q)) {
          out.push({ type: 'skill', lessonId: les.id, lessonNo: les.no, title: sk.name, sub: `第 ${les.no} 课 · ${sk.tagline}` })
        }
      }
    }
    return out.slice(0, 6)
  }, [query])

  function exportReport() {
    const data = {
      exportedAt: new Date().toISOString(),
      系统: 'EnglishForge',
      xp: progress.xp,
      连续天数: progress.streak,
      最高连击: progress.comboBest,
      每日XP: progress.dailyXp ?? {},
      最近练习: progress.sessions ?? [],
      技能状态: Object.fromEntries(Object.entries(evidence.bySkill).map(([k, v]) => [k, { state: v.state, last10: v.last10, days: v.days, openErrors: v.openErrors }])),
      分项证据: { dims: evidence.dims, 到期检索成功: evidence.dueSuccesses, 口语: evidence.oral },
      思维点历史进度: progress.skills,
      题级状态: progress.questionStates,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `EnglishForge-学习报告-${todayStr()}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function scrollToModules() {
    document.getElementById('modules')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const accAll = sessions.length ? Math.round(sessions.reduce((s, x) => s + x.acc, 0) / sessions.length) : 0
  const skillOfBrief = todayBrief.skillName
    ? Object.values(lessons).flatMap((l) => l.skills.map((s) => ({ s, no: l.no }))).find((x) => x.s.name === todayBrief.skillName)
    : undefined
  const briefState = skillOfBrief ? evidence.bySkill[skillOfBrief.s.id]?.state : undefined

  return (
    <div className="dash">
      {/* ===== 左侧图标导航（卡内分区，无背景块；选中=实心图标+粗字） ===== */}
      <aside className="rail">
        <button className="rail-btn active" title="仪表盘">
          <svg viewBox="0 0 24 24" className="ico-line"><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></svg>
          <svg viewBox="0 0 24 24" className="ico-fill"><rect x="3" y="3" width="8" height="8" rx="2.4" /><rect x="13" y="3" width="8" height="8" rx="2.4" /><rect x="3" y="13" width="8" height="8" rx="2.4" /><rect x="13" y="13" width="8" height="8" rx="2.4" /></svg>
          <span className="rail-label">仪表盘</span>
        </button>
        <button className="rail-btn" title="课程" onClick={scrollToModules}>
          <svg viewBox="0 0 24 24" className="ico-line"><path d="M12 6.5C10.2 5.2 7.4 4.9 4.5 5.8V18.6c2.9-.9 5.7-.6 7.5.7 1.8-1.3 4.6-1.6 7.5-.7V5.8C16.6 4.9 13.8 5.2 12 6.5Z" /><path d="M12 6.5v12.8" /></svg>
          <svg viewBox="0 0 24 24" className="ico-fill"><path d="M12 6.2C10.1 4.9 7.3 4.7 4 5.6v13.2c3.3-.9 6.1-.7 8 .6 1.9-1.3 4.7-1.5 8-.6V5.6c-3.3-.9-6.1-.7-8 .6Zm0 .9v12.4" /><path d="M12 7.1v12.4" /></svg>
          <span className="rail-label">课程</span>
        </button>
        <button className="rail-btn" title="今日复习" onClick={onStartReview}>
          <svg viewBox="0 0 24 24" className="ico-line"><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 3v5h-5" /></svg>
          <svg viewBox="0 0 24 24" className="ico-fill"><path d="M12 4a8 8 0 1 0 8 8h-2.5a5.5 5.5 0 1 1-1.6-3.9L13 11h7V4l-2.4 2.4A8 8 0 0 0 12 4Z" /></svg>
          {dueCount > 0 && <span className="rail-dot">{dueCount}</span>}
          <span className="rail-label">复习</span>
        </button>
        <button className="rail-btn" title="清空进度" onClick={onReset}>
          <svg viewBox="0 0 24 24" className="ico-line"><path d="M4 8h16" /><path d="M9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8" /><path d="M6.5 8l1 11.5A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5l1-11.5" /></svg>
          <svg viewBox="0 0 24 24" className="ico-fill"><path d="M9.5 3.5A1.5 1.5 0 0 1 11 2h2a1.5 1.5 0 0 1 1.5 1.5V4H19a1 1 0 1 1 0 2h-.6l-1 12.1A2.5 2.5 0 0 1 14.9 20H9.1a2.5 2.5 0 0 1-2.5-1.9L5.6 6H5a1 1 0 0 1 0-2h4.5v-.5Z" /></svg>
          <span className="rail-label">清空</span>
        </button>
      </aside>

      {/* ===== 中间主区 ===== */}
      <div className="dash-main">
        {/* 顶栏：品牌 + 搜索 */}
        <div className="dash-top">
          <div className="logo-mark">⚒</div>
          <div className="brand-2">EnglishForge <span>英语思维训练</span></div>
          <div className="search-wrap">
            <svg viewBox="0 0 24 24" className="search-ico"><path d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" /></svg>
            <input
              className="search-box"
              placeholder="搜索课程 / 思维点…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {results.length > 0 && (
              <div className="search-drop">
                {results.map((r, i) => (
                  <button key={i} className="search-item" onClick={() => { onOpenLesson(r.lessonId); setQuery('') }}>
                    <span className="search-item-title">{r.title}</span>
                    <span className="search-item-sub">{r.sub}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 问候行：日期小字 + 大标题（参考图头部语言） */}
        <div className="greet">
          <div>
            <div className="greet-date">{dateLabel()}</div>
            <h1>{greetWord()}，今天打什么铁？</h1>
          </div>
          <div className="greet-actions">
            <div className="segmented">
              <button className={period === 'week' ? 'active' : ''} onClick={() => setPeriod('week')}>本周</button>
              <button className={period === 'all' ? 'active' : ''} onClick={() => setPeriod('all')}>全部</button>
            </div>
            <button className="pill-btn" onClick={exportReport}>导出报告</button>
          </div>
        </div>

        {/* 今日目标卡（参考图 2 "Your Goal" 语言：小字 label + 大数字 + 圆形主按钮） */}
        <div className="goal-card">
          <div className="goal-main">
            <div className="goal-cap">今日目标</div>
            <div className="goal-num">{todayXp}<span className="goal-unit">/ {todayGoal} XP</span></div>
            <div className="goal-lines">
              <div className="hero-line">
                <i className="dot dot-purple" />
                今天建议继续
                <b>{todayBrief.skillLesson ? `第 ${todayBrief.skillLesson} 课 · ` : ''}{todayBrief.skillName ?? '第一课'}</b>
                {briefState ? <span className="hero-tag">{STATE_LABEL[briefState]}</span> : null}
              </div>
              <div className="hero-line">
                <i className="dot dot-blue" />
                {todayBrief.dueCount > 0
                  ? <><b>{todayBrief.dueCount}</b> 个到期复习——本轮预计处理 <b>{todayBrief.dueTake}</b> 个，不催你清空</>
                  : '暂无到期复习——今天以新任务和变式为主'}
              </div>
              <div className="hero-line">
                <i className="dot dot-gray" />
                {todayBrief.hasResume
                  ? <>上次练习还没打完 —— <button className="hero-resume" onClick={onResume}>继续上次 →</button></>
                  : '没有中断的练习，随时可开新一轮'}
              </div>
            </div>
          </div>
          <button className="goal-fab" onClick={onStartToday} title={`开始今天的练习（约 ${todayBrief.queueLen} 个短任务）`}>
            <span className="goal-fab-circle">▶</span>
            <span className="goal-fab-len">开始 · 约 {todayBrief.queueLen} 个任务</span>
          </button>
        </div>

        {/* 统计卡（中性：白卡三列 + hairline 分隔，大数字为主角） */}
        <div className="stats-card">
          <div className="stat">
            <div className="stat-cap">{period === 'week' ? '本周获得 XP' : '累计 XP'}</div>
            <div className="stat-num">
              {(period === 'week' ? week.thisWeek : progress.xp).toLocaleString()}
              <span className="stat-pill">{week.trend === null ? '新' : (week.trend >= 0 ? '+' : '') + week.trend + '%'}</span>
            </div>
            <div className="stat-sub">上周 {week.lastWeek} XP</div>
          </div>
          <div className="stat-div" />
          <div className="stat">
            <div className="stat-cap">连续学习</div>
            <div className="stat-num">{progress.streak}<span className="stat-unit">天</span></div>
            <div className="stat-sub">最高连击 {progress.comboBest}</div>
          </div>
          <div className="stat-div" />
          <div className="stat">
            <div className="stat-cap">已稳定技能</div>
            <div className="stat-num">{stable}<span className="stat-unit">/ {sc.total}</span></div>
            <div className="stat-sub">建立中 {sc.building} · 未练习 {sc.unseen}</div>
          </div>
        </div>

        {/* 最近练习（交易列表样式） */}
        <div className="sect-head">
          <h2>最近练习</h2>
          <button className="pill-soft" onClick={() => setShowMore(!showMore)}>{showMore ? '收起' : '查看全部'}</button>
        </div>

        <div className="date-pills">
          {days.map((d) => {
            const dt = new Date(d.date + 'T00:00:00')
            const isToday = d.date === todayStr()
            return (
              <div key={d.date} className={`date-pill ${isToday ? 'on' : ''}`}>
                <span className="dp-week">周{WEEKDAYS[dt.getDay()]}</span>
                <span className="dp-day">{dt.getDate()}</span>
                <span className="dp-xp">{d.xp > 0 ? `+${d.xp}` : '—'}</span>
              </div>
            )
          })}
        </div>

        <div className="tx-list">
          {shownSessions.length === 0 && (
            <div className="tx-empty">还没有练习记录——点上面"开始今天的练习"，这里就会出现你的打铁记录 🔨</div>
          )}
          {shownSessions.map((s, i) => (
            <div key={i} className={`tx-row ${s.acc >= 80 ? 'tx-blue' : 'tx-pink'}`}>
              <div className="tx-ball">{s.acc >= 80 ? '🎯' : '💪'}</div>
              <div className="tx-main">
                <div className="tx-title">{s.label}</div>
                <div className="tx-sub">{fmtTime(s.ts)}</div>
              </div>
              <div className="tx-amt">+{s.xp} XP</div>
              <div className="tx-acc">{s.acc}%</div>
            </div>
          ))}
          {sessions.length > 3 && (
            <button className="tx-more" onClick={() => setShowMore(!showMore)}>»</button>
          )}
        </div>

        {/* 课程地图 */}
        <div id="modules">
          {modules.map((m) => (
            <section key={m.id} className="module">
              <div className="module-head">
                <h2>{m.name}</h2>
                <p>{m.desc}</p>
              </div>
              {m.lessons.length === 0 && <div className="locked-row">🔒 等前面的铁打好就来</div>}
              {m.lessons.map((lid) => {
                const les = lessons[lid]
                const done = les.skills.filter((s) => {
                  const st = evidence.bySkill[s.id]?.state
                  return st === 'early-stable' || st === 'durable'
                }).length
                return (
                  <button key={lid} className="lesson-card" onClick={() => onOpenLesson(lid)}>
                    <div className="lesson-no">第 {les.no} 课</div>
                    <div className="lesson-info">
                      <h3>{les.title}</h3>
                      <p>{les.subtitle}</p>
                      <div className="minibar"><div style={{ width: `${(done / les.skills.length) * 100}%` }} /></div>
                      <div className="lesson-meta">{done}/{les.skills.length} 个思维点达到初步稳定及以上</div>
                    </div>
                    <div className="lesson-go">▶</div>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      </div>

      {/* ===== 右侧蓝色侧栏 ===== */}
      <aside className="dash-side">
        <div className="side-top">
          <button className="bell" onClick={onStartReview} title="今日复习">
            <svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6V11a6 6 0 1 0-12 0v5l-2 2v1h16v-1l-2-2Z" /></svg>
            {dueCount > 0 && <i className="bell-dot" />}
          </button>
          <div className="user-chip">
            <div className="user-ava">🧑‍🎓</div>
            <div className="user-info">
              <b>本地学员</b>
              <span>{saveErr ? '⚠️ 保存失败' : '进度存本机'}</span>
            </div>
            <button className="stats-btn mini" onClick={onToggleSound}>{soundOn ? '🔊' : '🔇'}</button>
          </div>
        </div>

        {/* 学习进度卡：四状态分段（不显示笼统百分比，§5.2） */}
        <div className="side-card">
          <div className="side-card-head">
            <h3>学习进度</h3>
            <button className="pill-soft tiny" onClick={exportReport} title="导出统计报告">···</button>
          </div>
          <div className="seg-bar">
            <span className="seg-grad" style={{ flex: sc.durable || 0.0001 }} />
            <span className="seg-skilled" style={{ flex: sc.early || 0.0001 }} />
            <span className="seg-learn" style={{ flex: sc.building || 0.0001 }} />
            <span className="seg-none" style={{ flex: sc.unseen || 1 }} />
          </div>
          <div className="seg-legend">
            <div><i className="dot dot-purple" />持续巩固</div>
            <div><i className="dot dot-peri" />初步稳定</div>
            <div><i className="dot dot-blue" />建立中</div>
            <div><i className="dot dot-gray" />未练习</div>
          </div>
          <div className="seg-nums">
            <div>{sc.durable}<span>个</span></div>
            <div>{sc.early}<span>个</span></div>
            <div>{sc.building + sc.unseen}<span>个</span></div>
          </div>
          <div className="side-actions">
            <button className="pill-soft tiny" onClick={onExportSave}>导出存档</button>
            <button className="pill-soft tiny" onClick={onImportSave}>导入存档</button>
          </div>
        </div>

        {/* 能力证据卡：四维分项（识别/理解/表达/延迟 + 口语单独） */}
        <div className="side-card">
          <h3>能力证据</h3>
          <div className="ev-list">
            {evidence.dims.map((d) => (
              <div key={d.mode} className="ev-row">
                <span className="ev-name">{d.label}</span>
                <span className="ev-val">{d.total === 0 ? '暂无' : `${d.correct}/${d.total}`}</span>
              </div>
            ))}
            <div className="ev-row">
              <span className="ev-name">延迟保持</span>
              <span className="ev-val">{evidence.dueSuccesses} 次到期检索成功</span>
            </div>
            <div className="ev-row">
              <span className="ev-name">口头表达</span>
              <span className="ev-val">
                {evidence.oral.independentSelf + evidence.oral.independentAi === 0 && evidence.oral.prompted === 0
                  ? '未验证'
                  : `独立 ${evidence.oral.independentSelf + evidence.oral.independentAi} · 有提示 ${evidence.oral.prompted}`}
              </span>
            </div>
          </div>
          <div className="ev-note">证据来自真实作答事件；XP 与连击只是参与反馈，不代表掌握。</div>
        </div>

        {/* 今日目标卡（Upgrade 样式） */}
        <div className="side-card">
          <h3>今日目标</h3>
          <p className="side-desc">{todayXp >= todayGoal
            ? `今天已达标（${todayXp} / ${todayGoal} XP）——想加练就继续，不想就歇会儿，明天再战。`
            : `今日目标 ${todayXp} / ${todayGoal} XP——再来${todayGoal - todayXp > 40 ? '两' : '一'}关就达标。`}</p>
          <button className="btn-dark" onClick={onStartToday}>
            👑 开始今日练习
          </button>
          <div className="goal-note">平均正确率 {accAll}% · 已练 {sessions.length} 次</div>
        </div>

        {/* 环形仪表（Current balance 样式） */}
        <div className="side-card">
          <div className="gauge-head">
            <div>
              <div className="gauge-cap">今日完成度</div>
              <div className="gauge-val">{Math.round(goalPct * 100)}%</div>
            </div>
            <div className="gauge-right">
              <div className="gauge-cap">今日 XP</div>
              <b>{todayXp}</b>
            </div>
          </div>
          <Gauge pct={goalPct} />
          <div className="gauge-foot">
            <div><span>待巩固</span><b className="red">{sc.building + sc.unseen}</b></div>
            <div><span>已稳定</span><b className="purple">{sc.early + sc.durable}</b></div>
          </div>
        </div>

        <Illustration />
      </aside>
    </div>
  )
}

function greetWord(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜已深'
  if (h < 12) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/** 参考图头部的日期小字：如 "9月28日 · 周一" */
function dateLabel(): string {
  const d = new Date()
  return `${d.getMonth() + 1}月${d.getDate()}日 · 周${WEEKDAYS[d.getDay()]}`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 圆环仪表：紫色进度弧 + 蓝色指针（还原参考图 Current balance 组件） */
function Gauge({ pct }: { pct: number }) {
  const R = 64
  const C = 2 * Math.PI * R
  const ARC = C * 0.75 // 270°
  const filled = ARC * Math.min(1, Math.max(0, pct))
  return (
    <svg viewBox="0 0 180 170" className="gauge">
      <circle cx="90" cy="88" r={R} fill="none" stroke="#e8e7f4" strokeWidth="13"
        strokeDasharray={`${ARC} ${C}`} strokeLinecap="round" transform="rotate(135 90 88)" />
      <circle cx="90" cy="88" r={R} fill="none" stroke="#6f63e4" strokeWidth="13"
        strokeDasharray={`${filled} ${C}`} strokeLinecap="round" transform="rotate(135 90 88)" />
      <circle cx="90" cy="88" r={R} fill="none" stroke="#c9c6ea" strokeWidth="2.5"
        strokeDasharray="1 9" transform="rotate(135 90 88)" opacity=".9" />
      <g transform={`rotate(${-135 + 270 * Math.min(1, Math.max(0, pct))} 90 88)`}>
        <line x1="90" y1="88" x2="90" y2="40" stroke="#4aa3d9" strokeWidth="7" strokeLinecap="round" />
      </g>
      <circle cx="90" cy="88" r="9" fill="#4aa3d9" />
      <circle cx="90" cy="88" r="3.5" fill="#fff" />
    </svg>
  )
}

/** 侧栏底部插画（扁平风湖景，呼应参考图） */
function Illustration() {
  return (
    <svg viewBox="0 0 300 170" className="illus">
      <rect width="300" height="170" fill="#e9f3fa" />
      <circle cx="238" cy="38" r="18" fill="#ffd98a" />
      <path d="M-10 118 L70 52 L150 118 Z" fill="#bcd7ea" />
      <path d="M96 120 L176 58 L268 120 Z" fill="#a5c9e2" />
      <path d="M40 120 L96 74 L152 120 Z" fill="#cfe3f2" />
      <rect y="118" width="300" height="52" fill="#cbe6f6" />
      <path d="M0 132 H300" stroke="#ffffff" strokeWidth="5" strokeDasharray="16 12" opacity=".9" />
      <rect y="150" width="300" height="20" fill="#cde3c1" />
      <path d="M20 150 v-16 M44 150 v-16 M68 150 v-16" stroke="#a9c39a" strokeWidth="4" strokeLinecap="round" />
      <path d="M14 136 H74" stroke="#a9c39a" strokeWidth="4" strokeLinecap="round" />
      <circle cx="258" cy="140" r="12" fill="#9fc98d" />
      <circle cx="276" cy="146" r="8" fill="#b6d7a5" />
      <rect x="36" y="128" width="4" height="22" rx="2" fill="#8aa87b" />
      <circle cx="38" cy="118" r="14" fill="#9fc98d" />
      <circle cx="50" cy="124" r="9" fill="#b6d7a5" />
      <rect x="82" y="132" width="3.5" height="18" rx="1.75" fill="#8aa87b" />
      <circle cx="84" cy="124" r="11" fill="#b6d7a5" />
    </svg>
  )
}
