import { useState } from 'react'
import { goalLabel } from '../learning/learnerView'

export type JourneyState = { objectiveId: string; skill: string; complexity: string; state: string; flags: string[] }
const directions = [
  { title: '句子主线', subtitle: '谁做什么，抓住核心', detail: '先看懂句子的主干，再把同样的读法用到听力和你自己的表达里。已经会的部分可以直接上挑战。' },
  { title: '信息连接', subtitle: '修饰、限定与逻辑', detail: '看清一句话里谁在说明谁，分清决定、原因和条件。长句按意思拆开读，不靠猜。' },
  { title: '声音理解', subtitle: '从看懂到听得出来', detail: '先不看文字听一遍，卡住了再分段、看文字，然后不听文字再听一遍。换别的材料试试是不是真的会了。' },
  { title: '自己的话', subtitle: '复述、理由与澄清', detail: '用自己的话说清楚一件事，别人追问也接得住。系统给你的只是练口提示，说得好不好最后由人来听。' },
  { title: '真实讨论', subtitle: '互动、追问与观点', detail: '课堂和生活里真正的交流：确认自己听懂了没、请对方说清楚、说出自己的不同看法。' },
  { title: '专业语境', subtitle: '艺术、科技与学习场景', detail: '在设计、AI 这些你熟悉的领域里读和听，再讲清楚你自己的项目和理由。' },
]
export function journeyDirection(goal: string | null | undefined): number | null {
  if (!goal) return null
  if (goal.startsWith('O-K007') || goal.startsWith('O-K184')) return 2
  if (goal.startsWith('O-K115')) return 1
  if (goal.startsWith('O-K190')) return 3
  if (goal.startsWith('O-K194')) return 4
  return null
}
export function JourneyRoute({ goal, expanded = false }: { goal: string | null; expanded?: boolean }) {
  const current = journeyDirection(goal)
  const [selected, setSelected] = useState<number | null>(null)
  const focus = selected ?? current
  return <section className="journey-route" aria-label="学习方向地图">
    <div className="journey-route-caption"><span>六个方向，交叉着练</span><span>{current === null ? '先做个小测试定起点' : `你现在主要练：${directions[current].title}`}</span></div>
    <div className="journey-stops">{directions.map((d, i) => <button key={d.title} className={i === focus ? 'current' : ''} aria-pressed={i === focus} onClick={() => setSelected(i)}><span>{String(i + 1).padStart(2, '0')}{i === current ? ' →' : ''}</span><b>{d.title}</b><small>{d.subtitle}</small></button>)}</div>
    {(expanded || selected !== null) && <div className="journey-detail"><h3>{focus === null ? '这是路线图，不是考试等级' : directions[focus].title}</h3><p>{focus === null ? '这几个方向会穿插着练，不用从第一条走到底。你现在的位置来自系统推荐，不是打分。' : directions[focus].detail}</p><small>编号只是顺序，不代表前面的都过关了。会的内容可以跳过。</small></div>}
  </section>
}
export function JourneyHero({ goal, skill, mode, onMap }: { goal: string | null; skill?: string | null; mode: string; onMap: () => void }) {
  const label: Record<string, string> = { listening: '听力', speaking: '口头表达', reading: '阅读理解', writing: '写作', interaction: '互动回应' }
  return <section className="journey-hero"><div><div className="journey-eyebrow">今天向前一步</div><h1>{mode === 'find_start' ? <>先找到起点，<br/>再走自己的路。</> : <>从理解关系，<br/>到接得上话。</>}</h1><p>{mode === 'find_start' ? '不用从零开始。先来一两个小挑战，看看从哪里补最划算。' : '每个练习都对应一个真实场景：听懂一个决定、解释一个理由，或接住别人的问题。学完一课，下一课自动接上。'}</p><button className="journey-text-button" onClick={onMap}>我在地图的哪里？ ↗</button></div><aside><span>当前坐标</span><strong>{goal ? goalLabel(goal) : '尚未定位'}</strong><p>{skill ? `这次重点：${label[skill] ?? '理解与表达'}` : '先测试定位，不给你贴等级。'}</p><small>听、说、读、写分开记<br/>自己做的和看提示做的，分开算</small></aside></section>
}
export function JourneyAbilities({ states, loading }: { states: JourneyState[]; loading: boolean }) {
  const [selected, setSelected] = useState('listening')
  const skills = [{ id: 'listening', title: '听', task: '听出主张、条件与结论' }, { id: 'speaking', title: '说', task: '用自己的话回应追问' }, { id: 'reading', title: '读', task: '抓主线，核对修饰范围' }, { id: 'writing', title: '写', task: '组织观点、理由和边界' }]
  const records = states.filter(s => s.skill === selected && s.complexity === 'base')
  const stateLabel: Record<string, string> = {unmeasured:'还没练到',tentative:'刚起步',trained:'练过',independent:'能自己做对',transferred:'换个情境也会',retained:'隔一阵还会'}
  return <section className="journey-abilities"><div className="journey-section-head"><div><div className="journey-eyebrow">你的情况 / 来自你自己的练习</div><h2>练过什么很清楚，<br/>还没会的也如实记着。</h2></div><p>练过不等于都会：看提示完成的、自己独立完成的，我们分开记。</p></div><div className="journey-skill-tabs">{skills.map(s=>{const n=states.filter(x=>x.skill===s.id&&x.complexity==='base'&&x.state!=='unmeasured').length;return <button key={s.id} className={selected===s.id?'on':''} aria-pressed={selected===s.id} onClick={()=>setSelected(s.id)}><strong>{s.title}</strong><span>{s.task}<small>{loading?'读取中…':n?`${n} 项有记录`:'还没有记录'}</small></span></button>})}</div><div className="journey-evidence-list">{loading?<p>正在读取…</p>:records.length?records.map(r=><div key={r.objectiveId}><b>{goalLabel(r.objectiveId)}</b><span>{r.flags.includes('disputed')?'有分歧，先不算数':stateLabel[r.state]??'待确认'}</span>{r.flags.includes('waived_by_user')&&<small>你选择了跳过；想练随时恢复。</small>}</div>):<p>这项还没有记录。下次遇到合适的练习，会如实记下来。</p>}</div></section>
}

// ---------- 47 号：学习路线时间线 + 段位卡 ----------
export type JourneyData = {
  completed: { lessonId: string; title: string; at: number }[]
  current: { lessonId: string; title: string; doneSteps: number; total: number; finished: boolean } | null
  upcoming: { lessonId: string; title: string; status: string; note: string }[]
  lessonNumber: number
  totalLessonsLearnable: number
}
export type GrowthData = { level: string; levelIndex: number; nextTitle: string | null; nextHow: string | null; stats: { lessons: number; independent: number; transfer: number; growth: number; fourSkills: number } }

export function JourneyTimeline({ journey, growth }: { journey: JourneyData | null; growth: GrowthData | null }) {
  if (!journey) return <p className="v4-dim">正在读取你的学习路线…</p>
  return (
    <div className="journey-timeline">
      <div className="journey-level-card">
        <div className="journey-level-now">
          <span className="journey-level-label">当前段位</span>
          <strong>{growth?.level ?? '起步者'}</strong>
          {growth && <span className="journey-level-stats">已完成 {growth.stats.lessons} 课 · 独立做到 {growth.stats.independent} 项 · 换情境也会 {growth.stats.transfer} 项</span>}
        </div>
        {growth?.nextTitle && (
          <div className="journey-level-next">
            下一段位：<b>{growth.nextTitle}</b> —— {growth.nextHow}
          </div>
        )}
        {!growth?.nextTitle && <div className="journey-level-next">已经是最高段位——保持练习，别让能力生锈。</div>}
      </div>
      <ol className="journey-steps">
        {journey.completed.map((c, i) => (
          <li key={c.lessonId} className="done">
            <span className="dot">{i + 1}</span>
            <div><b>{c.title}</b><small>已完成 · {new Date(c.at).toLocaleDateString()}</small></div>
          </li>
        ))}
        {journey.current && (
          <li className="now">
            <span className="dot">{journey.completed.length + 1}</span>
            <div>
              <b>{journey.current.title}</b>
              <small>正在学 · {journey.current.doneSteps}/{journey.current.total} 步</small>
              <div className="bar"><i style={{ width: `${Math.round((journey.current.doneSteps / Math.max(1, journey.current.total)) * 100)}%` }} /></div>
            </div>
          </li>
        )}
        {journey.upcoming.map((u, i) => (
          <li key={u.lessonId} className="next">
            <span className="dot">{journey.completed.length + (journey.current ? 1 : 0) + i + 1}</span>
            <div><b>{u.title}</b><small>{u.note}</small></div>
          </li>
        ))}
        {!journey.current && !journey.upcoming.length && (
          <li className="next"><span className="dot">?</span><div><b>下一课在准备中</b><small>做好了会出现在「今日学习」，也会排进这条路线</small></div></li>
        )}
      </ol>
    </div>
  )
}

// ---------- 49 号：成长作品页（quest.html data-screen="growth" 的真实产品版） ----------
export type WorkItem = {
  attemptId: string; activityId: string; objectiveId: string | null; skill: string
  taskLabel: string; at: number; text: string; mediaId: string | null; oral: boolean
  label: string; pass: boolean | null; aiVerdict: string | null; aiFeedback: string | null
  relations: { label: string; hit: boolean; required: boolean }[]; practiceOnly: boolean
  materialTitle: string | null; materialText: string | null
}
export type WorksData = {
  pair: { objectiveId: string; old: WorkItem; new: WorkItem } | null
  recent: WorkItem[]
  adjustments: { reduce: { real: boolean; title: string; body: string }; keep: { real: boolean; title: string; body: string }; add: { real: boolean; title: string; body: string } }
  level: { title: string; nextTitle: string | null; nextHow: string | null }
  totalWorks: number
}

function WorkCard({ w, kind }: { w: WorkItem; kind: 'old' | 'new' }) {
  return (
    <div className={kind === 'new' ? 'work new' : 'work'}>
      <div className="kicker">{kind === 'old' ? `原来的回应 / ${w.label}` : `新的回应 / ${w.label}`}</div>
      {w.mediaId
        ? <audio controls src={`/media/${w.mediaId}`} style={{ width: '100%', marginTop: 12 }} />
        : <blockquote>{w.text || '（这题没有留下文字——录音文件缺失，如实标注）'}</blockquote>}
      {w.mediaId && w.text && <p className="works-transcript">转写：{w.text}</p>}
      <p>
        {w.aiFeedback ? `AI 批改：${w.aiFeedback}` : w.relations.length ? w.relations.map((r) => `${r.hit ? '✓' : '✗'}${r.label}`).join(' ') : ''}
        {w.practiceOnly && '（练习参考，不算成绩）'}
      </p>
      <small className="works-meta">{new Date(w.at).toLocaleString()} · {w.taskLabel}{w.materialTitle ? ` · 材料：${w.materialTitle}` : ''}{!w.mediaId && w.oral ? ' · 录音文件缺失' : ''}</small>
    </div>
  )
}

export function GrowthWorksPage({ works, onGoToday, onGoEvidence }: {
  works: WorksData | null
  onGoToday: () => void
  onGoEvidence: () => void
}) {
  if (!works) return <div className="v4-card"><p className="v4-dim">正在读取你的作品…</p></div>
  const empty = works.totalWorks === 0
  return (
    <div className="works-page">
      <div className="page-head">
        <div className="kicker">成长档案 / 记住真正跨过的地方</div>
        <h1>进步是这句话，<br />现在你能说清楚了。</h1>
        <p>比较作品和完成条件，比比较刷题数量更有意义。</p>
      </div>
      {empty ? (
        <div className="work" style={{ marginBottom: 20 }}>
          <div className="kicker">还没有可对照的作品</div>
          <blockquote>完成第一课之后，这里会放上你当时和现在的回答。</blockquote>
          <p>只用你自己保存的提交和录音，不会拿别人的或模拟的内容冒充。</p>
        </div>
      ) : works.pair ? (
        <>
          <div className="grid">
            <WorkCard w={works.pair.old} kind="old" />
            <WorkCard w={works.pair.new} kind="new" />
          </div>
          <p className="works-note">这一对来自同一个目标（{works.pair.objectiveId}）：从「{works.pair.old.label}」到「{works.pair.new.label}」。{works.pair.new.label !== '独立完成' && '注意：这次还不是独立完成，先算练习进步。'}</p>
        </>
      ) : (
        <div className="work" style={{ marginBottom: 20 }}>
          <div className="kicker">还没有可配对的进步</div>
          <blockquote>{works.totalWorks === 1 ? '已经有一份作品了。' : `已有 ${works.totalWorks} 份作品。`}</blockquote>
          <p>配对需要同一个目标下"先需要帮助、后独立完成"的两次真实记录。下面的作品按时间列出，不做硬凑的比较。</p>
        </div>
      )}
      {works.recent.length > 0 && (
        <div className="works-recent">
          <div className="kicker">最近的作品（按时间，不做硬凑比较）</div>
          <ul>
            {works.recent.map((w) => (
              <li key={w.attemptId}>
                <b>{new Date(w.at).toLocaleDateString()}</b> · {w.taskLabel || '练习'} · {w.label}
                {w.mediaId && ' · 🎧 有录音'} — {w.text.slice(0, 60)}{w.text.length > 60 ? '…' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="section">
        <h2>这次之后，课程怎样变化？</h2>
        <div className="three">
          <div className="panel"><div className="kicker">保留</div><h3>{works.adjustments.keep.title}</h3><p>{works.adjustments.keep.body}</p></div>
          <div className="panel"><div className="kicker">减少</div><h3>{works.adjustments.reduce.title}</h3><p>{works.adjustments.reduce.body}</p></div>
          <div className="panel"><div className="kicker">增加</div><h3>{works.adjustments.add.title}</h3><p>{works.adjustments.add.body}</p></div>
        </div>
      </div>
      <div className="actions">
        <button className="v4-primary" onClick={onGoToday}>看看更新后的下一站 →</button>
        <button className="v4-ghost" onClick={onGoEvidence}>变化有哪些证据？</button>
      </div>
      <div className="works-footer">需要提示的进步值得保留。更强的能力结论等待独立迁移和后续观察。</div>
    </div>
  )
}
