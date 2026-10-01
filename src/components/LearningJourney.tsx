import { useState } from 'react'
import { goalLabel } from '../learning/learnerView'

export type JourneyState = { objectiveId: string; skill: string; complexity: string; state: string; flags: string[] }
const directions = [
  { title: '句子主线', subtitle: '谁做什么，抓住核心', detail: '从句子的主干理解信息，再将同一关系用在声音和表达中。已有基础可以挑战先行。' },
  { title: '信息连接', subtitle: '修饰、限定与逻辑', detail: '看清修饰挂在哪里，分清决定、原因和条件。复杂句沿关系深入，不能只靠关键词猜。' },
  { title: '声音理解', subtitle: '从看懂到听得及时', detail: '无稿先听，卡住后分段与看稿，再关稿重听。换材料检验，不把看稿后的理解记成独立听懂。' },
  { title: '自己的话', subtitle: '复述、理由与澄清', detail: '用自己的话说清决定，接住新追问。转写与词表反馈帮助练习，不能直接证明口语掌握。' },
  { title: '真实讨论', subtitle: '互动、追问与观点', detail: '面向课堂和生活的实际交流，练习确认理解、请求澄清与表达不同观点。' },
  { title: '专业语境', subtitle: '艺术科技与学术表达', detail: '在数字媒体、AI 和交互设计等语境中理解论证与限制，再表达自己的项目与理由。' },
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
    <div className="journey-route-caption"><span>学习方向 / 结构与实用任务相互连接</span><span>{current === null ? '先定位，再选起点' : `当前重心：${directions[current].title}`}</span></div>
    <div className="journey-stops">{directions.map((d, i) => <button key={d.title} className={i === focus ? 'current' : ''} aria-pressed={i === focus} onClick={() => setSelected(i)}><span>{String(i + 1).padStart(2, '0')}{i === current ? ' →' : ''}</span><b>{d.title}</b><small>{d.subtitle}</small></button>)}</div>
    {(expanded || selected !== null) && <div className="journey-detail"><h3>{focus === null ? '地图是导航，不是英语等级' : directions[focus].title}</h3><p>{focus === null ? '这些方向会交叉训练，不要求每个人从头走同一条直线。当前位置来自实际推荐，不是已掌握比例。' : directions[focus].detail}</p><small>方向编号不表示已通过前面的阶段；熟悉内容可跳过，个人免修不自动认证掌握。</small></div>}
  </section>
}
export function JourneyHero({ goal, skill, mode, onMap }: { goal: string | null; skill?: string | null; mode: string; onMap: () => void }) {
  const label: Record<string, string> = { listening: '听力', speaking: '口头表达', reading: '阅读理解', writing: '写作', interaction: '互动回应' }
  return <section className="journey-hero"><div><div className="journey-eyebrow">YOUR LEARNING JOURNEY / 今天向前一步</div><h1>{mode === 'find_start' ? <>先找到起点，<br/>再走自己的路。</> : <>从理解关系，<br/>到接得上话。</>}</h1><p>{mode === 'find_start' ? '已有基础，不必从零重学。用一段短挑战找到现在最值得补足的地方。' : '每个任务都连接一个真实交流动作：听懂决定、解释理由，或回应新的问题。你学到哪里，后继课程就沿着知识地图继续。'}</p><button className="journey-text-button" onClick={onMap}>我在地图的哪里？ ↗</button></div><aside><span>当前坐标</span><strong>{goal ? goalLabel(goal) : '尚未定位'}</strong><p>{skill ? `这次重点：${label[skill] ?? '理解与表达'}` : '定位用于选起点，不给你贴整体等级。'}</p><small>听、说、读、写分别观察<br/>有提示完成与独立迁移分别记录</small></aside></section>
}
export function JourneyAbilities({ states, loading }: { states: JourneyState[]; loading: boolean }) {
  const [selected, setSelected] = useState('listening')
  const skills = [{ id: 'listening', title: '听', task: '听出主张、条件与结论' }, { id: 'speaking', title: '说', task: '用自己的话回应追问' }, { id: 'reading', title: '读', task: '抓主线，核对修饰范围' }, { id: 'writing', title: '写', task: '组织观点、理由和边界' }]
  const records = states.filter(s => s.skill === selected && s.complexity === 'base')
  const stateLabel: Record<string, string> = {unmeasured:'尚未测到',tentative:'初步观察',trained:'已经练过',independent:'独立完成',transferred:'新情境迁移',retained:'后续保持'}
  return <section className="journey-abilities"><div className="journey-section-head"><div><div className="journey-eyebrow">能力画像 / 来自实际学习记录</div><h2>知道练过什么，<br/>也知道什么还没确定。</h2></div><p>完成课程不是掌握证明。看稿、提示、合成声音和开放表达都有不同的判断边界。</p></div><div className="journey-skill-tabs">{skills.map(s=>{const n=states.filter(x=>x.skill===s.id&&x.complexity==='base'&&x.state!=='unmeasured').length;return <button key={s.id} className={selected===s.id?'on':''} aria-pressed={selected===s.id} onClick={()=>setSelected(s.id)}><strong>{s.title}</strong><span>{s.task}<small>{loading?'读取中…':n?`${n} 个目标有观察记录`:'尚无足够观察记录'}</small></span></button>})}</div><div className="journey-evidence-list">{loading?<p>正在读取能力依据…</p>:records.length?records.map(r=><div key={r.objectiveId}><b>{goalLabel(r.objectiveId)}</b><span>{r.flags.includes('disputed')?'存在争议，暂不据此认证':stateLabel[r.state]??'待复核'}</span>{r.flags.includes('waived_by_user')&&<small>已自主免修，可在详细记录恢复；不认证掌握。</small>}</div>):<p>这项能力仍保留未知。下一次用合适任务观察，不按词汇量或练习次数猜测。</p>}</div></section>
}
