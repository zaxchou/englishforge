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
