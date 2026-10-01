import { useState } from 'react'
export type TeachingGuide = { version:number; title:string; outcome:string; principle:string; example:string[]; moves:string[]; contrast:string; carry:string; provenance:string; sourceLessons:string[] }
export function CourseTeaching({ guide, note }: {guide?:TeachingGuide|null;note:string|null}) {
  const [open,setOpen]=useState(false)
  if(!guide) return note?<section className="course-teaching"><h3>先理解这次的思路</h3><p>{note}</p><small>已有基础可以直接挑战，遇到卡点再回来。</small></section>:null
  return <section className="course-teaching" aria-label="原理与演示"><div className="journey-eyebrow">这节课要带走什么</div><h3>{guide.title}</h3><p>{guide.outcome}</p><p className="course-principle">{guide.principle}</p><div className="course-framework" aria-label="共同学习思路">{["想表达什么","先立句子主线","接上必要信息","清楚后减少重复"].map((t,i)=><span key={t}><small>{i+1}</small>{t}</span>)}</div><button className="v4-ghost" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'收起演示':'看一个从简单到完整的演示'}</button><small>已经理解可以直接做下面的挑战，卡住再回来。</small>{open&&<div className="course-demonstration"><div className="course-example">{guide.example.map((s,i)=><p key={s}><span>{i+1}</span>{s}</p>)}</div><ol>{guide.moves.map(s=><li key={s}>{s}</li>)}</ol><p><b>换一种意思，会怎样？</b> {guide.contrast}</p><p><b>把它用起来：</b> {guide.carry}</p><details><summary>这段讲解与原课程的关系</summary><p>{guide.provenance}</p><p>{guide.sourceLessons.join(' · ')}</p></details></div>}</section>
}
export function activityPurpose(role:string,audio:boolean,oral:boolean) {
  if(role==='transfer') return '换一个情境，看刚才的关系还能不能用；不是记住上一题的说法。'
  if(oral) return '把理解变成你自己的回应。可以用短句，先让对方知道你的意思。'
  if(audio) return '先从声音里抓事情和关系。遇到生词先留空，保住整体意思；需要时再求助。'
  return '把原理放回具体材料：先抓发生了什么，再确认补充信息连在哪里。'
}
