import { decodeRecordingWav } from '../learning/recordingWav'
// curriculum-v4 能力路径（W3 双轨展示，docs/curriculum-v4/15 §9）。
//
// 与旧首页的双轨纪律：这里是新域（目标/证据/计划），旧 XP/题量/箱数**不进**本页，
// 页面常驻“旧进度不换算”的说明 —— 两个系统不能给用户互相矛盾的“掌握率”。
// 口语录音（W5）接入前，口述任务以文字版走通并如实标注“口语证据未测”。
import { useCallback, useEffect, useRef, useState } from 'react'
import { goalLabel, learnerToday } from '../learning/learnerView'
import { clearDraft, draftKey, loadDraft, saveDraft } from '../learning/draftStore'
import './v4.css'
import { JourneyHero, JourneyRoute, JourneyAbilities } from './LearningJourney'
import './learning-space.css'

type Plan = {
  decisionId: string
  primaryGoal: string | null
  primarySkill?: string | null
  strategyId: string
  reason: string
  hypotheses: string[]
  uncertainAreas: string[]
  lesson: { lessonId: string | null; activityId: string | null; status: string; waitNotice?: string; devSample?: boolean; contentPreview?: boolean; fallbackTask?: boolean; fallbackReason?: string; resumeAvailable?: boolean }
  fallback: { lessonId: string; title: string; reason: string; objectiveIds?: string[] } | null
  notChosen: { objectiveId: string; reason: string }[]
  status: string
}
type AttemptFeedback = { pass: boolean | null; displayPass?: boolean | null; evaluationStatus: string; practiceOnly?: boolean; studentClaimed?: boolean; dimensions?: { id: string; label: string; hit: boolean; required: boolean }[]; slotResults?: { slotId: string; prompt: string; given: string | null; status: string }[]; mustNotViolations?: string[]; aiReview?: { verdict: string; feedback: string; agreesWithMechanical: boolean } | null; reveal?: { referenceExpression: string; supportingQuotes: string[]; followup: string | null } }
type ContentReview = { preview: boolean; humanSignPending: boolean; semanticVerdict: string | null; pending: string | null }
type LessonPkg = {
  lessonId: string
  title: string
  whyNow: string
  teachingNote: string | null
  devSampleNotice: string | null
  contentReview?: ContentReview | null
  activities: { resume?: { response: { text?: string; answers?: Record<string, string> }; result: AttemptFeedback } | null; nextTake: number; taskId: string; activityVersion: number; activityId: string; role: string; prompt: string; hintStageCount: number; firstHint: string | null; simulatesAudio: boolean; fixtureNotice: string | null; oralTask?: boolean; audio?: AudioInfo | null; slots?: { slotId: string; prompt: string; options: string[] }[] | null; reasonLabel?: string | null; material?: { materialId: string; materialVersion?: number; kind: string; segments: { segmentId: string; title?: string; text: string }[] } | null }[]
  nextCandidates: string[]
  holdout: { lessonId: string; answersIncluded: boolean } | null
}
type Evidence = {
  completedLessons?: {lessonId:string;title:string}[]
  states: { objectiveId: string; skill: string; complexity: string; state: string; flags: string[] }[]
  disputedAttempts: { attempt_id: string }[]
  note: string
}
type MapIdx = {
  mapVersion: string
  summary: { groups: number; byAtomization: Record<string, number>; objectives: number; coveredClaims: number }
  objectives: { objectiveId: string; name: string; layer: string; behavior: string; verification: string; flags: string[]; firstPath: boolean }[]
  groups: { groupId: string; title: string; atomizationStatus: string }[]
  legacyNotice: string
}

async function api<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const res = await fetch('/api/v1' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? String(res.status))
  return json as T
}

const STATE_LABEL: Record<string, string> = {
  unmeasured: '还没练到', tentative: '刚起步', trained: '练过', independent: '能自己做对', transferred: '换个情境也会', retained: '隔一阵还会',
}
const SKILL_LABEL: Record<string, string> = {
  listening: '听', speaking: '说', reading: '读', writing: '写', interaction: '互动',
}
// 复杂度与技能独立；已知指代任务显示实际负担，其余不猜档位含义。
const BAND_LABEL: Record<string, string> = {
  base: '全部难度', band1: '难度 1', band2: '难度 2', band3: '难度 3', band4: '难度 4', band5: '难度 5', band6: '难度 6',
}

export function V4Path({ accountId }: { accountId: string | null }) {
  // 28 号薄片：默认入口 = 今日学习（唯一主按钮回答"练什么/点哪里/为什么"）；
  // 后台视角（推荐详情/证据/地图）降为辅助入口，审核收进运营折叠
  const [tab, setTab] = useState<'today' | 'plan' | 'diag' | 'evidence' | 'map' | 'review'>('today')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { try { return localStorage.getItem('forge-learning-theme') === 'dark' ? 'dark' : 'light' } catch { return 'light' } })
  useEffect(() => { document.documentElement.dataset.learningTheme = theme; try { localStorage.setItem('forge-learning-theme', theme) } catch { /* Theme still works without storage. */ } return () => { delete document.documentElement.dataset.learningTheme } }, [theme])
  const [err, setErr] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [noPlan, setNoPlan] = useState(false)
  const [planLoading, setPlanLoading] = useState(true)
  const [lesson, setLesson] = useState<LessonPkg | null>(null)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [waiverBusy,setWaiverBusy] = useState(false)
  const [mapIdx, setMapIdx] = useState<MapIdx | null>(null)
  // 31 第三批：个体生成库存（只读接口，不触发任务）——推荐详情页诚实显示补课管线状态
  const [stock, setStock] = useState<{ disabled: boolean; ready: number; pendingReview: number; failedCooldown: number } | null>(null)

  const loadPlan = useCallback(async () => {
    if (!accountId) return
    setPlanLoading(true)
    try {
      const r = await api<{ decision: Plan | null }>(`/accounts/${accountId}/plan`)
      setPlan(r.decision)
      setNoPlan(!r.decision)
      setEvidence(null)
      setLesson(null)
    } catch (e) { setErr(String(e)) } finally { setPlanLoading(false) }
  }, [accountId])

  useEffect(() => { void loadPlan() }, [loadPlan])
  useEffect(() => { setEvidence(null) }, [accountId])
  useEffect(() => {
    let cancelled = false
    if (accountId && !evidence) {
      api<Evidence>(`/accounts/${accountId}/evidence`).then((value) => { if (!cancelled) setEvidence(value) }).catch((e) => { if (!cancelled) setErr(String(e)) })
    }
    if (tab === 'map' && !mapIdx) {
      api<MapIdx>('/map').then(setMapIdx).catch((e) => setErr(String(e)))
    }
    if (tab === 'plan' && accountId && !stock) {
      api<{ stock: { disabled: boolean; ready: number; pendingReview: number; failedCooldown: number } }>(`/accounts/${accountId}/generation-stock`)
        .then((r) => setStock(r.stock)).catch(() => { /* 只读展示，失败不打扰 */ })
    }
    return () => { cancelled = true }
  }, [tab, accountId, evidence, mapIdx, stock])

  // ---------- 诊断流程（会话状态在 DiagPanel 内部管理） ----------

  /** 打开课程（今日入口与推荐详情共用） */
  const openLesson = useCallback(async (lessonId: string) => {
    try {
      setLesson(await api<LessonPkg>('/accounts/' + accountId + '/lessons/' + lessonId))
    } catch (e) { setErr(String(e)) }
  }, [accountId])

  const today = learnerToday(plan)
  // 31 第三批落地：等待态一键生成——用户明示计费确认 → 调真实模型 → 轮询 → 完成后可直接开始（开发样本）
  const [genPhase, setGenPhase] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [genNote, setGenNote] = useState('')
  const [genLessonId, setGenLessonId] = useState<string | null>(null)
  // 换了目标就重置生成流状态
  useEffect(() => { setGenPhase('idle'); setGenNote(''); setGenLessonId(null) }, [today.goalId])

  const startGeneration = useCallback(async () => {
    if (!today.goalId) return
    setGenPhase('running'); setGenNote('')
    try {
      const r = await api<{ jobId?: string; reused?: boolean; cooledDown?: boolean; note?: string }>(
        `/accounts/${accountId}/generation/start`, { objectiveId: today.goalId, confirmCost: true }, 'POST')
      if (r.cooledDown) { setGenPhase('failed'); setGenNote(r.note ?? '这一课刚才没做成，过几分钟再试一次就行。'); return }
      const jobId = r.jobId ?? null
      // 轮询任务状态（生成的课约半分钟；最多等 3 分钟）。
      // 38-S3：succeeded ≠ 有课——审核未过（published:false + pending）有明确字段，
      // 给恢复路径，不再让"成功却无课"卡住学习者
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 3000))
        const d = await api<{ jobs: { job_id: string; status: string; output_lesson_id: string | null; published?: boolean | null; pending?: string | null; semanticVerdict?: string | null; reject_reasons: string | null }[] }>(`/accounts/${accountId}/generation`)
        const job = d.jobs.find((j) => j.job_id === jobId)
        if (!job) continue
        if (job.status === 'succeeded' && job.output_lesson_id && job.published) {
          setGenLessonId(job.output_lesson_id); setGenPhase('done'); return
        }
        if (job.status === 'succeeded' && job.output_lesson_id && job.pending === 'content_semantic_review') {
          setGenPhase('failed')
          setGenNote('AI 做的这一课没通过检查（' + (job.semanticVerdict === 'unsupported' ? '题目和材料对不上' : '还没查完') + '），所以没给你用——不会让你学讲不通的内容。可以重新做一次，或先学别的。')
          void loadPlan()
          return
        }
        if (job.status === 'succeeded' && job.output_lesson_id && job.pending === 'human_sign') {
          setGenPhase('failed')
          setGenNote('课已做好，等老师确认后就能学。可以先学别的，或稍后再来。')
          void loadPlan()
          return
        }
        if (job.status === 'failed' || job.status === 'rejected' || job.status === 'superseded') {
          setGenPhase('failed')
          setGenNote(job.status === 'superseded'
            ? '等你做题的这几分钟里，学习安排变了，这一课就作废了。可以重新做一次，或先学别的。'
            : '这一课没做好，先不给你用。可以重新做一次，或先学别的。（原因：' + String(job.reject_reasons ?? job.status).slice(0, 80) + '）')
          void loadPlan()
          return
        }
      }
      setGenPhase('failed'); setGenNote('等太久了没做成，稍后再试一次。')
    } catch (e) { setGenPhase('failed'); setGenNote(String(e)) }
  }, [accountId, today.goalId, loadPlan])
  
  if (!accountId) {
    return <div className="v4 learning-space" data-theme={theme}><div className="v4-empty">正在连接数据库……连接后这里显示你的能力路径。</div></div>
  }

async function changeWaiver(objectiveId:string,skill:string,revoked:boolean) {
    if(waiverBusy)return
    setWaiverBusy(true)
    try {
      await api(`/accounts/${accountId}/waivers${revoked?'/revoke':''}`,{objectiveId,skill,reason:revoked?'学习者恢复训练':'学习者自行确认熟悉，免修重复目标'},'POST')
      await api(`/accounts/${accountId}/plan/recompute`,{requestId:crypto.randomUUID(),triggerEventId:revoked?'userRevokeWaiver':'userWaive'},'POST')
      await loadPlan();setTab('today')
    }catch(e){setErr(String(e))}finally{setWaiverBusy(false)}
  }

  return (
    <div className="v4 learning-space" data-theme={theme}>
      <div className="journey-top"><div className="journey-wordmark">FORGE <span>→</span><small>理解 · 表达 · 持续生长</small></div><button className="journey-theme" aria-label={theme === 'light' ? '切换暗色表达工作室' : '切换亮色成长关卡'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '◐ 暗色工作室' : '☀ 亮色关卡'}</button></div>
      <div className="v4-tabs">
        <button className={tab === 'today' ? 'on' : ''} disabled={waiverBusy} onClick={() => setTab('today')}>今日学习</button>
        <button className={tab === 'plan' ? 'on' : ''} disabled={waiverBusy} onClick={() => setTab('plan')}>推荐详情</button>
        <button className={tab === 'diag' ? 'on' : ''} disabled={waiverBusy} onClick={() => setTab('diag')}>入口诊断</button>
        <button className={tab === 'evidence' ? 'on' : ''} disabled={waiverBusy} onClick={() => setTab('evidence')}>我的成长</button>
        <button className={tab === 'map' ? 'on' : ''} disabled={waiverBusy} onClick={() => setTab('map')}>学习路线</button>
        <details className="v4-ops">
          <summary>运营工具</summary>
          <button className={tab === 'review' ? 'on' : ''} disabled={waiverBusy} onClick={() => setTab('review')}>审核与试听</button>
        </details>
      </div>
      {err && <div className="v4-err">{err}</div>}
      {tab === 'today' && !lesson && <><JourneyHero goal={plan?.primaryGoal ?? null} skill={plan?.primarySkill} mode={today.mode} onMap={() => setTab('map')} /><JourneyRoute goal={plan?.primaryGoal ?? null} /></>}

      {tab === 'today' && !lesson && (
        <div className="v4-card v4-today">
          <div className="journey-eyebrow">今日挑战 / {plan?.primarySkill ? (SKILL_LABEL[plan.primarySkill] ?? '理解与表达') : '找到起点'}</div>
          <h2 className="v4-today-head">{today.headline}</h2>
          {today.reason && <p className="v4-why">{today.reason}</p>}
          {today.mode === 'wait' ? (
            // 等待态 = 可动作：一键按需生成（用户点按钮即明示计费确认），不再是死按钮。
            // 38-S3：完成/失败都给一致的审核状态与恢复路径——失败可重新生成或转备用课。
            // 40-P1：主目标没内容时，**备用迁移任务**（与主目标分开、有理由、不用付费/免修）优先给出
            genPhase === 'done' && genLessonId ? (
              <>
                <button className="v4-primary v4-today-btn" onClick={() => void openLesson(genLessonId)}>开始这一课（AI 现做）</button>
                <p className="v4-dim">这一课是 AI 按你最近的练习<b>现做的</b>：已经过自动检查，还没有老师确认。可以学；发现哪里讲得不对，直接告诉我们。</p>
              </>
            ) : genPhase === 'running' ? (
              <button className="v4-primary v4-today-btn" disabled>正在生成这一课…（约半分钟，别关页面）</button>
            ) : (
              <>
                {plan?.fallback && (
                  <div className="v4-note" style={{ marginBottom: 8 }}>
                    <b>先练这个也行：</b>{plan.fallback.title}
                    <p style={{ margin: '4px 0' }}>{plan.fallback.reason}</p>
                    {!!plan.fallback.objectiveIds?.length && (
                      <p style={{ margin: '4px 0' }}>练的内容：{plan.fallback.objectiveIds.map((oid) => goalLabel(oid)).join('、')}。</p>
                    )}
                    {(plan.primarySkill === 'listening' || plan.primarySkill === 'speaking') && (
                      <p style={{ margin: '4px 0 8px' }}>提醒：你现在主要练{SKILL_LABEL[plan.primarySkill]}，这节课练的不是它，也算不进它的成绩；{SKILL_LABEL[plan.primarySkill]}的正课正在准备。</p>
                    )}
                    <button className="v4-primary" disabled={waiverBusy} onClick={() => { if (plan.fallback) void openLesson(plan.fallback.lessonId) }}>打开备用任务</button>
                  </div>
                )}
                {genPhase === 'failed' && (
                  <div className="v4-today-aux" style={{ marginBottom: 8 }}>
                    <button className="v4-ghost" disabled={waiverBusy} onClick={() => { setGenPhase('idle'); void startGeneration() }}>重新生成一次</button>
                    {plan?.lesson?.lessonId && plan.lesson.status === 'published' && (
                      <button className="v4-ghost" disabled={waiverBusy} onClick={() => { if (plan.lesson?.lessonId) void openLesson(plan.lesson.lessonId) }}>先学备用课</button>
                    )}
                  </div>
                )}
                <button className="v4-primary v4-today-btn" disabled={waiverBusy || planLoading || !!err} onClick={() => { void startGeneration() }}>
                  让 AI 现在做一课（用真模型 · 按次收费）
                </button>
                <p className="v4-dim">做完会直接出现在这里；不想用 AI 做，也可以跳过这项。</p>
              </>
            )
          ) : (
            <button className="v4-primary v4-today-btn" disabled={waiverBusy || today.waiting || planLoading || !!err}
              onClick={() => {
                if (today.mode === 'find_start') { setTab('diag'); return }
                if (today.lessonId) void openLesson(today.lessonId)
              }}>{planLoading ? '正在读取学习安排…' : today.primaryLabel}</button>
          )}
          {plan?.lesson?.fallbackTask && plan.lesson.status === 'published' && (
            <p className="v4-dim">这是安排里的过渡课（你主练的那课还在准备中）：{plan.lesson.fallbackReason}</p>
          )}
          {genNote && <div className="v4-note">{genNote}</div>}
          {today.goalId && (
            <details className="v4-fold">
              <summary>查看安排依据</summary>
              <p><code>{today.goalId}</code>{today.lessonId ? <> · 课程 <code>{today.lessonId}</code></> : null}</p>
              {plan?.primarySkill && <><p>如果这项你已经很熟，可以跳过，不重复练。跳过不代表已经掌握，想练随时恢复。</p><button className="v4-ghost" disabled={waiverBusy} onClick={()=>{void changeWaiver(today.goalId!,plan.primarySkill!,false)}}>这项我已经会了，跳过</button></>}
            </details>
          )}
          <div className="v4-today-aux">
            <button className="v4-ghost" disabled={waiverBusy} onClick={() => setTab('evidence')}>我的成长</button>
            <button className="v4-ghost" disabled={waiverBusy} onClick={() => setTab('map')}>学习路线</button>
            <button className="v4-ghost" disabled={waiverBusy} onClick={() => setTab('plan')}>推荐详情</button>
          </div>
          <div className="journey-cycle"><span><b>理解</b>抓住真实关系</span><span><b>补足</b>提示后再尝试</span><span><b>表达</b>用自己的话</span><span><b>迁移</b>换情境再观察</span></div>
        </div>
      )}

      {tab === 'plan' && (
        <PlanPanel plan={plan} noPlan={noPlan} stock={stock} onDiagnostic={() => setTab('diag')}
          onOpenLesson={(lessonId) => void openLesson(lessonId)} />
      )}

      {tab === 'diag' && <DiagPanel key={accountId} accountId={accountId} onDone={async () => { await loadPlan(); setTab('today') }} />}

      {tab === 'evidence' && (
        <div className="v4-card journey-growth">
          <JourneyAbilities states={evidence?.states ?? []} loading={!evidence} />
          <h3>我的成长</h3>
          {evidence?.completedLessons?.length ? <>
            <p>最近完成的训练</p>
            <ul>{evidence.completedLessons.map(l=><li key={l.lessonId}>{l.title}</li>)}</ul>
            <p className="v4-dim">这些是你练过的课。练过 ≠ 都会了——具体到什么程度，看下面。</p>
          </> : <p>完成第一段训练后，这里会留下你的学习轨迹。</p>}
          {evidence?.states.filter(s=>s.complexity==='base' && ['independent','transferred','retained'].includes(s.state) && !s.flags.includes('disputed')).map(s=><p key={s.objectiveId+s.skill}>{goalLabel(s.objectiveId)} · {SKILL_LABEL[s.skill] ?? s.skill}：{STATE_LABEL[s.state] ?? s.state}</p>)}
          <p>下一步：{today.headline.replace('今天这一步：','').replace('接下来该练：','')}</p>
          {today.waiting && <p>{today.reason}</p>}
          <button className="v4-primary" disabled={waiverBusy} onClick={()=>setTab('today')}>回到今日学习</button>
          <details className="v4-fold"><summary>查看各项能力记录</summary><p className="v4-dim">「跳过」是你自己选的：只是不用重复练这项，不代表已经会了；想练随时恢复。</p>
          <p className="v4-dim">每一行是一个难度的情况；「全部难度」按最弱的算——简单的过了，也不会替你掩盖难的没过。</p>
          {!evidence?.states.length && <p className="v4-dim">还没有记录。练过的内容会先记成练习，练到能独立做对才算数。</p>}
          <div className="v4-states">
            {evidence?.states.map((s) => (
              <div key={s.objectiveId + s.skill + s.complexity} className="v4-state">
                <code>{s.objectiveId}</code>
                <span className="v4-skill">{SKILL_LABEL[s.skill] ?? s.skill}</span>
                <span className="v4-skill">{s.objectiveId==='O-K115-02'&&s.complexity==='band2'?'简单句':s.objectiveId==='O-K115-02'&&s.complexity==='band4'?'复杂句':BAND_LABEL[s.complexity] ?? '全部难度'}</span>
                <b>{STATE_LABEL[s.state] ?? s.state}</b>
                {s.flags.map((f) => <em key={f}>{f === 'disputed' ? '有分歧待复核' : f === 'waived_by_user' ? '已跳过' : f === 'needs_repair' ? '需要多练' : f}</em>)}
                {s.complexity==='base' && <button className="v4-ghost" disabled={waiverBusy} onClick={()=>{void changeWaiver(s.objectiveId,s.skill,s.flags.includes('waived_by_user'))}}>{s.flags.includes('waived_by_user')?'恢复这项训练':`这项我会了，跳过${SKILL_LABEL[s.skill] ?? ''}练习`}</button>}
              </div>
            ))}
          </div>
          {evidence && <p className="v4-dim">{evidence.note}</p>}
          </details>
        </div>
      )}

      {tab === 'review' && <ReviewPanel />}

      {tab === 'map' && mapIdx && (
        <div className="v4-card">
          <div className="journey-eyebrow">完整知识地图 / 个人路径按需展开</div><h2>看清方向，再深入到知识。</h2><JourneyRoute goal={plan?.primaryGoal ?? null} expanded /><p>下列是系统准备覆盖的内容。列出来 ≠ 已经能学——能学的课会出现在「今日学习」。</p><h3>具体能力目标</h3>
          <p>
            共 {mapIdx.summary.groups} 个话题组、{mapIdx.summary.objectives} 个具体目标。课程正在一项项做出来，能学的会出现在「今日学习」。
          </p>
          <div className="v4-objlist">
            {mapIdx.objectives.map((o) => (
              <div key={o.objectiveId} className="v4-obj">
                <code>{o.objectiveId}</code> <b>{o.name}</b>
                <span className="v4-ver">{o.verification === 'claim_checked' ? '已核实' : '准备中'}</span>
                {o.flags.includes('needs_audio') && <span className="v4-ver">等录音</span>}
                <p>{o.behavior}</p>
              </div>
            ))}
          </div>
          <p className="v4-dim">{mapIdx.legacyNotice}</p>
        </div>
      )}

      {(tab === 'plan' || tab === 'today') && lesson && (
        <LessonRunner
          key={lesson.lessonId}
          accountId={accountId}
          pkg={lesson}
          onDone={async () => { await loadPlan() }}
        />
      )}
    </div>
  )
}

function PlanPanel({ plan, noPlan, stock, onDiagnostic, onOpenLesson }: {
  plan: Plan | null
  noPlan: boolean
  stock: { disabled: boolean; ready: number; pendingReview: number; failedCooldown: number } | null
  onDiagnostic: () => void
  onOpenLesson: (lessonId: string) => void
}) {
  if (noPlan || !plan) {
    return (
      <div className="v4-card">
        <h3>还没有推荐</h3>
        <p>先做 5–10 分钟入口诊断（文字路径，可随时暂停）。诊断只决定"近期最值当的一步"，不会给你贴等级。</p>
        <button className="v4-primary" onClick={onDiagnostic}>开始入口诊断</button>
      </div>
    )
  }
  // 31 第三批：补课管线状态诚实显示——区分可学/待人审/失败冷却/未开启，不冒充"制作中"
  const stockLine = stock && (stock.ready > 0 || stock.pendingReview > 0 || stock.failedCooldown > 0 || stock.disabled)
    ? [
      stock.disabled ? 'AI 现做功能未开启' : null,
      stock.ready > 0 ? `现成可学 ${stock.ready} 课` : null,
      stock.pendingReview > 0 ? `等人确认 ${stock.pendingReview} 课` : null,
      stock.failedCooldown > 0 ? `刚做过 1 次没成功，稍等几分钟` : null,
    ].filter(Boolean).join(' · ')
    : null
  return (
    <div className="v4-card">
      <h3>当前推荐 · {goalLabel(plan.primaryGoal)}</h3>
      <p className="v4-why">{plan.reason}</p>
      <div className="v4-meta">
        <span>按你最近的学习表现安排</span>
        {plan.lesson.lessonId && (
          <button className="v4-primary" onClick={() => onOpenLesson(plan.lesson.lessonId!)}>打开课程</button>
        )}
        {plan.lesson.status === 'fixture_dev_only' && (
          <span className="v4-wait">⏳ 这一课还在准备中，做好了会出现在「今日学习」</span>
        )}
        {plan.lesson.status === 'content_pending' && <span className="v4-wait">⏳ {plan.lesson.waitNotice}</span>}
        {plan.lesson.devSample && <span className="v4-dev">{plan.lesson.contentPreview ? 'AI 现做 · 已自动检查 · 老师还没确认' : '练习版 · 老师还没确认'}</span>}
      </div>
      {stockLine && <p className="v4-dim">AI 补课：{stockLine}。</p>}
      {!!plan.hypotheses.length && <p><b>根因假设：</b>{plan.hypotheses.join('、')}</p>}
      {!!plan.uncertainAreas.length && <p><b>未测区域：</b>{plan.uncertainAreas.join('、')}</p>}
      <details>
        <summary>为什么不是别的（{plan.notChosen.length}）</summary>
        <ul>{plan.notChosen.map((n) => <li key={n.objectiveId}><code>{n.objectiveId}</code> {n.reason}</li>)}</ul>
      </details>
    </div>
  )
}

type AudioInfo = { mediaId: string; synthetic: boolean; speakerLabel: string; durationMs: number; licenseNote: string }

type DiagState = { diagnosticId: string; status: string; step: string | null; note?: string | null; activity: { taskId: string; activityId: string; prompt: string; hints: string[]; audio?: AudioInfo | null } | null; tentative: { strongPoints: string[]; hypotheses: string[]; unmeasured: string[]; route: string; stopReason: string } | null }

/** 课程音频播放器（21 §6.1/6.2 + 24 号 R4）：base64 → blob URL；synthetic 标注必须可见；
 * 首次播放 POST /support/play 落**服务端**播放事件（听力证据的前提，客户端自报不算）；
 * onPlay 每次播放上报，提交时计 playCount。 */
function LessonAudio({ info, taskId, activityId, accountId, onPlay }: { info: AudioInfo; taskId?: string; activityId?: string; accountId?: string; onPlay?: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const deliveryRef = useRef<string | null>(null)
  useEffect(() => {
    setErr(''); setUrl(null); deliveryRef.current = null
    let revoke: string | null = null
    let alive = true
    ;(async () => {
      try {
        const r = await api<{ audioBase64: string; mime: string; deliveryId?: string }>(taskId && accountId ? `/accounts/${accountId}/tasks/${taskId}/media/${info.mediaId}` : `/media/${info.mediaId}`)
        const bytes = Uint8Array.from(atob(r.audioBase64), (c) => c.charCodeAt(0))
        revoke = URL.createObjectURL(new Blob([bytes], { type: r.mime }))
        if (alive) { deliveryRef.current = r.deliveryId ?? null; setUrl(revoke) }
        else URL.revokeObjectURL(revoke)
      } catch (e) { if (alive) setErr(String(e)) }
    })()
    return () => { alive = false; if (revoke) URL.revokeObjectURL(revoke) }
  }, [info.mediaId, taskId, accountId])
  async function onFirstPlay() {
    onPlay?.()
    if (!accountId || !activityId || !taskId || !deliveryRef.current) return
    try { await api(`/accounts/${accountId}/support/play`, { taskId, deliveryId: deliveryRef.current, eventId: crypto.randomUUID(), activityId, mediaId: info.mediaId }, 'POST') } catch (e) { setErr('播放记录未保存，请重新打开任务后重试：' + String(e)) }
  }
  if (err) return <p className="v4-dev">音频加载失败：{err}</p>
  if (!url) return <p className="v4-dim">音频加载中…</p>
  return (
    <div className="v4-audio">
      <audio controls src={url} onPlay={onFirstPlay} />
      <span className="v4-dim">
        电脑合成的发音（不是真人）· 约 {Math.round(info.durationMs / 1000)} 秒。真人录音正在准备。听力题要先播放再作答。
      </span>
    </div>
  )
}

function DiagPanel({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [diag, setDiag] = useState<DiagState | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [hintShown, setHintShown] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const playsRef = useRef(1)
  const startRef = useRef(false) // 本地已开过新场：晚到的恢复结果不许覆盖它

  useEffect(() => {
    if (diag?.status === 'completed') onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diag?.status])

  // 刷新/换浏览器后恢复最近一场未完成的诊断——服务端是事实源，客户端不存会话指针
  //（实测事故：会话只活在组件 state 里，D2 卡住 → 刷新 → 回到开始页 → 重开又卡同一步，
  // 库里积了一堆 open 会话，用户之前的作答也接不上）
  useEffect(() => {
    let alive = true
    api<{ diagnostic: DiagState | null }>(`/accounts/${accountId}/diagnostics/latest`)
      .then((r) => {
        if (alive && !startRef.current && r.diagnostic?.status === 'open') setDiag(r.diagnostic)
      })
      .catch(() => { /* 没有进行中的会话或接口异常：停在开始页 */ })
    return () => { alive = false }
  }, [accountId])

  async function submit() {
    if (!diag?.activity) return
    setBusy(true)
    setErr('')
    const prevStep = diag.step
    try {
      const r = await api<{ diagnostic: DiagState }>(`/accounts/${accountId}/attempts`, {
        attemptId: `diag-${diag.diagnosticId}-${diag.step}-${Date.now()}`,
        taskId: diag.activity.taskId,
        sessionId: diag.diagnosticId,
        activityId: diag.activity.activityId,
        response: { kind: 'text', text },
        conditions: {
          firstExposure: true, hintLevel: hintShown ? 1 : 0, transcriptShown: diag.step === 'D2b',
          playCount: playsRef.current, lookupUsed: false, responseMode: 'typed_summary',
        },
      }, 'POST')
      const d = r.diagnostic
      setDiag(d)
      setNote(d.note ?? null)
      if (d.step && d.step !== prevStep) {
        // 只有真推进才清空作答区。disputed/未判定时原地不动：答案保留，用户照 note 改说法重交
        // （之前无条件清空 + 丢弃 note，重交同样文字再次卡住，看起来就是"窗口清空了"）
        setText('')
        playsRef.current = 1
        setHintShown(false)
      }
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const start = useCallback(async () => {
    setErr('')
    try {
      const d = await api<DiagState>('/accounts/' + accountId + '/diagnostics', { requestId: 'diag-' + Date.now() }, 'POST')
      startRef.current = true
      setDiag(d)
      setNote(null)
    } catch (e) { setErr(String(e)) }
  }, [accountId])

  if (!diag) {
    return (
      <div className="v4-card">
        <h3>起点测试</h3>
        <p>大约 5–10 分钟，几道小题看看你现在到哪一步：读句子 → 听一段话 → 说一段话。说明两点：听的是电脑合成音（不是真人，正式录音在准备）；说的一段先用打字代替，口语暂时不打分。做完只定起点，不给你贴等级。</p>
        <button className="v4-primary" onClick={start}>开始测试</button>
        {err && <div className="v4-err">{err}</div>}
      </div>
    )
  }
  if (diag.status === 'completed' && diag.tentative) {
    return (
      <div className="v4-card">
        <h3>测试完成 · 你的起点</h3>
        <p><b>还不错的地方：</b>{diag.tentative.strongPoints.join('；') || '—'}</p>
        <p><b>可能卡住的地方：</b>{diag.tentative.hypotheses.join('、') || '—'}</p>
        <p><b>还没看到的：</b>{diag.tentative.unmeasured.join('、')}</p>
        <p className="v4-dim">{diag.tentative.stopReason}</p>
      </div>
    )
  }
  return (
    <div className="v4-card">
      <h3>起点测试 · {diag.step}</h3>
      {note && <div className="v4-note">{note}</div>}
      <pre className="v4-prompt">{diag.activity?.prompt}</pre>
      {diag.activity?.audio && (
        <LessonAudio taskId={diag.activity.taskId} info={diag.activity.audio} activityId={diag.activity.activityId} accountId={accountId}
          onPlay={() => { playsRef.current += 1 }} />
      )}
      {hintShown && diag.activity?.hints?.[0] && <p className="v4-hint">提示：{diag.activity.hints[0]}</p>}
      {!hintShown && !!diag.activity?.hints?.length && (
        <button className="v4-ghost" onClick={() => setHintShown(true)}>看个提示</button>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
        placeholder="用自己的话回答（中英文都可以）" />
      <button className="v4-primary" disabled={busy || !text.trim()} onClick={submit}>{note ? '换说法再提交' : '提交'}</button>
      <button className="v4-ghost" disabled={busy} onClick={start}>重新开始</button>
      {err && <div className="v4-err">{err}</div>}
    </div>
  )
}

function LessonRunner({ accountId, pkg, onDone }: {
  accountId: string
  pkg: LessonPkg
  onDone: () => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(pkg.activities.map(a => [a.activityId, a.resume?.response.text ?? ''])))
  // D0-1：封闭槽位题的逐槽选择（activityId → slotId → 选项代号）
  const [slotPicks, setSlotPicks] = useState<Record<string, Record<string, string>>>(() => Object.fromEntries(pkg.activities.map(a => [a.activityId, a.resume?.response.answers ?? {}])))
  const [revealed, setRevealed] = useState<Record<string, string[]>>({})
  const [feedback, setFeedback] = useState<Record<string, { pass: boolean | null; status: string; practiceOnly?: boolean; studentClaimed?: boolean; relations?: { id: string; label: string; hit: boolean; required: boolean }[]; mustNot?: string[]; slotResults?: { slotId: string; prompt: string; given: string | null; status: string }[]; aiReview?: AttemptFeedback['aiReview']; reveal?: AttemptFeedback['reveal'] }>>(() => Object.fromEntries(pkg.activities.filter(a => a.resume).map(a => [a.activityId, { pass: a.resume!.result.displayPass ?? a.resume!.result.pass, status: a.resume!.result.evaluationStatus, practiceOnly: a.resume!.result.practiceOnly, studentClaimed: a.resume!.result.studentClaimed, relations: a.resume!.result.dimensions, slotResults: a.resume!.result.slotResults, aiReview: a.resume!.result.aiReview, reveal: a.resume!.result.reveal }])))
  const [pkgLive, setPkgLive] = useState(pkg)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const playsRef = useRef<Record<string, number>>({}) // 音频播放次数：提交时计 playCount，不再写死 1
  const lastAttemptRef = useRef<Record<string, string>>({}) // 每活动最近一次作答的 attemptId（表达申诉用）
  // R5（24 号）：每活动第几轮作答。首轮 attemptId 稳定（网络重试同 ID 不重复入库）；
  // 看到反馈后点「再试一次」→ take+1 → 新 attemptId（学生再次作答=新 take，不撞 409）
  const [takes, setTakes] = useState<Record<string, number>>(() => Object.fromEntries(pkg.activities.map(a => [a.activityId, a.nextTake ?? 1])))

  const [currentIndex, setCurrentIndex] = useState(() => { const i = pkg.activities.findIndex(a => !a.resume); return i < 0 ? Math.max(0, pkg.activities.length - 1) : i })
  const visibleActs = pkgLive.activities
  const allDone = visibleActs.every((a) => feedback[a.activityId])

  async function reveal(act: LessonPkg['activities'][number]) {
    const next = (revealed[act.activityId]?.length ?? 0) + 1
    setErr('')
    try {
      const r = await api<{ hint: string }>(`/accounts/${accountId}/lessons/${pkgLive.lessonId}/hints`,
        { activityId: act.activityId, level: next }, 'POST')
      setRevealed((rv) => ({ ...rv, [act.activityId]: [...(rv[act.activityId] ?? []), r.hint] }))
    } catch (e) { setErr(String(e)) } // 揭示失败不展示任何更深提示
  }

  /** 再试一次：清反馈、take+1。旧答案与反馈保留在服务端历史里；提示条件不清零（ hinted 不变独立） */
  function retry(act: LessonPkg['activities'][number]) {
    setTakes((t) => ({ ...t, [act.activityId]: (t[act.activityId] ?? 1) + 1 }))
    setFeedback((f) => { const n = { ...f }; delete n[act.activityId]; return n })
  }

  async function submit(act: LessonPkg['activities'][number]) {
    setErr('')
    const take = takes[act.activityId] ?? 1
    const attemptId = take === 1 ? `les-${act.taskId}-${act.activityId}` : `les-${act.taskId}-${act.activityId}-t${take}`
    // D0-1：封闭槽位题提交结构化 answers；开放题提交自由文本
    const isSlots = !!act.slots?.length
    const response = isSlots
      ? { kind: 'choice', text: answers[act.activityId] ?? '', answers: slotPicks[act.activityId] ?? {} }
      : { kind: 'text', text: answers[act.activityId] ?? '' }
    try {
      const r = await api<AttemptFeedback & { attemptIdUsed?: string }>(`/accounts/${accountId}/attempts`, {
        attemptId,
        taskId: act.taskId,
        activityId: act.activityId,
        response,
        conditions: {
          firstExposure: take === 1, hintLevel: revealed[act.activityId]?.length ?? 0,
          transcriptShown: false, playCount: playsRef.current[act.activityId] ?? 0, lookupUsed: false, responseMode: 'typed_summary',
        },
      }, 'POST')
      // 服务端在"同 ID 不同内容"时自动分配了下一轮 take（刷新后计数丢失的场景）：
      // 把实际轮次记回来，下次「再试一次」从它继续，不再撞 ID
      const usedTake = String(r.attemptIdUsed ?? '').match(/-t(\d+)$/)?.[1]
      if (usedTake) setTakes((t) => ({ ...t, [act.activityId]: Math.max(t[act.activityId] ?? 1, Number(usedTake)) }))
      lastAttemptRef.current[act.activityId] = String(r.attemptIdUsed ?? attemptId)
      // 40 号：mustNotViolations 一并带给"词全有但关系错"的区分展示
      setFeedback((f) => ({ ...f, [act.activityId]: { pass: r.displayPass ?? r.pass, status: r.evaluationStatus, practiceOnly: r.practiceOnly, studentClaimed: r.studentClaimed, relations: r.dimensions, mustNot: r.mustNotViolations, slotResults: r.slotResults, aiReview: r.aiReview ?? null, reveal: r.reveal } }))
      // 门控活动（如未预告追问）在前提活动提交后才出现：重取课包
      const fresh = await api<LessonPkg>(`/accounts/${accountId}/lessons/${pkgLive.lessonId}`)
      if (fresh.activities.length > visibleActs.length) setPkgLive(fresh)
    } catch (e) { setErr(String(e)) }
  }

  /** 40 号表达反馈：学生认为表达语义正确但被词表判据拒收 → 记录申诉（保留争议，不扣能力不认证） */
  async function claimExpression(act: LessonPkg['activities'][number]) {
    const fb = feedback[act.activityId]
    const attemptId = lastAttemptRef.current[act.activityId]
    if (!fb || fb.studentClaimed || !attemptId) return
    setErr('')
    try {
      await api(`/accounts/${accountId}/attempts/${encodeURIComponent(attemptId)}/claim`, { note: '我认为我的表达意思是对的' }, 'POST')
      setFeedback((f) => ({ ...f, [act.activityId]: { ...fb, studentClaimed: true } }))
    } catch (e) { setErr(String(e)) }
  }

  async function refreshLesson() {
    setRefreshing(true)
    try {
      const fresh = await api<LessonPkg>(`/accounts/${accountId}/lessons/${pkgLive.lessonId}`)
      const changed = new Set(fresh.activities.filter(a=>{const old=pkgLive.activities.find(o=>o.activityId===a.activityId);return !old || old.activityVersion!==a.activityVersion || old.prompt!==a.prompt}).map(a=>a.activityId))
      setAnswers(old=>Object.fromEntries(fresh.activities.map(a=>[a.activityId,a.resume?.response.text ?? (changed.has(a.activityId)?'':old[a.activityId] ?? '')])))
      setSlotPicks(old=>Object.fromEntries(fresh.activities.map(a=>[a.activityId,a.resume?.response.answers ?? (changed.has(a.activityId)?{}:old[a.activityId] ?? {})])))
      setFeedback(Object.fromEntries(fresh.activities.filter(a=>a.resume).map(a=>[a.activityId,{pass:a.resume!.result.displayPass ?? a.resume!.result.pass,status:a.resume!.result.evaluationStatus,practiceOnly:a.resume!.result.practiceOnly,studentClaimed:a.resume!.result.studentClaimed,relations:a.resume!.result.dimensions,mustNot:a.resume!.result.mustNotViolations,slotResults:a.resume!.result.slotResults,aiReview:a.resume!.result.aiReview,reveal:a.resume!.result.reveal}])))
      setTakes(Object.fromEntries(fresh.activities.map(a=>[a.activityId,a.nextTake ?? 1])))
      const next=fresh.activities.findIndex(a=>!a.resume);setCurrentIndex(next<0?Math.max(0,fresh.activities.length-1):next)
      setPkgLive(fresh);setErr('')
    }catch(e){setErr(String(e));throw e}finally{setRefreshing(false)}
  }

  async function complete() {
    setErr('')
    try {
      await api(`/accounts/${accountId}/lessons/${pkgLive.lessonId}/complete`, {}, 'POST')
      setDone(true)
    } catch (e) { setErr(String(e)) }
  }

  if (done) {
    return (
      <div className="v4-card">
        <h3>{pkgLive.title} · 已完成</h3>
        <p>这一课练完了！练过不等于完全掌握——你的表现都记下来了，后面会安排复习。</p>
        <p>接下来学什么，会根据这一课的表现来安排。可以继续，也可以明天再来。</p>
        <button className="v4-primary" onClick={onDone}>看下一步学什么</button>
      </div>
    )
  }
  return (
    <div className="v4-card">
      <div className="journey-eyebrow">专注训练 / 理解 → 表达 → 迁移</div><h2>{pkgLive.title}</h2>
      <button className="v4-ghost" disabled={refreshing} onClick={()=>{void refreshLesson().catch(()=>{})}}>刷新这一步</button>
      <p className="v4-why">为什么现在学：{pkgLive.whyNow}</p>
      {pkgLive.teachingNote && <p className="v4-teach">要点：{pkgLive.teachingNote}</p>}
      {pkgLive.devSampleNotice && <p className="v4-dev">{pkgLive.devSampleNotice}</p>}
      {/* 38-S3：课内与推荐卡、生成结果页同一份审核事实（缓存恢复后重取课包也带 contentReview） */}
      {pkgLive.contentReview?.preview && <p className="v4-dev">这一课是 AI 现做的：已自动检查，还没有老师确认——有问题直接说。</p>}
      {pkgLive.contentReview?.pending === 'content_semantic_review' && <p className="v4-dev">这节课还没检查完，暂时不能继续。回上一页可以重新做一课，或先学别的。</p>}
      <div className="journey-task-progress" aria-label={`当前第 ${currentIndex + 1} 步，共 ${visibleActs.length} 步`}><span>当前第 {currentIndex + 1} 步，共 {visibleActs.length} 步</span><div>{visibleActs.map((a, i) => <i key={a.activityId} className={i === currentIndex ? 'current' : i < currentIndex ? 'visited' : ''} />)}</div><small>看完这步的讲解再进下一步。走过 ≠ 掌握，别担心。</small></div>
      {visibleActs.slice(currentIndex, currentIndex + 1).map((act) => (
        <div key={act.activityId + act.activityVersion + act.prompt} className="v4-act">
          <div className="v4-act-head">
            <b>{act.role === 'transfer' ? '陌生迁移' : act.role === 'practice' ? '练习' : act.role}</b>
            {act.simulatesAudio && !act.audio && <span className="v4-dev">这题用文字代替发音（不算听力成绩）</span>}
          </div>
          <pre className="v4-prompt">{act.prompt}</pre>
          {act.material?.segments?.length ? (
            <div className="v4-material">
              {act.material.segments.map((m, i) => (
                <div key={i} className="v4-material-item">
                  {m.title && <b>{m.title}</b>}
                  <p>{m.text}</p>
                </div>
              ))}
            </div>
          ) : null}
          {act.audio && (
            <LessonAudio taskId={act.taskId} info={act.audio} activityId={act.activityId} accountId={accountId}
              onPlay={() => { playsRef.current[act.activityId] = (playsRef.current[act.activityId] ?? 0) + 1 }} />
          )}
          {(revealed[act.activityId] ?? []).map((h, i) => (
            <p key={i} className="v4-hint">提示 {i + 1}：{h}</p>
          ))}
          {(revealed[act.activityId]?.length ?? 0) < act.hintStageCount && (
            <button className="v4-ghost" onClick={() => reveal(act)}>
              看个提示（{revealed[act.activityId]?.length ?? 0}/{act.hintStageCount}）
            </button>
          )}
          {act.oralTask
            ? <OralRecorder onRefreshTask={refreshLesson} taskId={act.taskId} accountId={accountId} activityId={act.activityId} onSubmitted={async (fb) => {
                setRefreshing(true)
                setFeedback((f) => ({ ...f, [act.activityId]: fb }))
                try { setPkgLive(await api<LessonPkg>(`/accounts/${accountId}/lessons/${pkgLive.lessonId}`)) }
                catch (e) { setErr(String(e)) } finally { setRefreshing(false) }
              }} />
            : act.slots?.length ? (
                // D0-1：封闭槽位题——逐空按钮选择；正确答案不下发到前端，对错由服务端判
                <div className="v4-slots">
                  {act.slots.map((s) => (
                    <div key={s.slotId} className="v4-slot">
                      <span>{s.prompt}</span>
                      <div className="v4-slot-opts">
                        {s.options.map((o) => (
                          <button key={o}
                            className={slotPicks[act.activityId]?.[s.slotId] === o ? 'v4-opt on' : 'v4-opt'}
                            onClick={() => setSlotPicks((p) => ({ ...p, [act.activityId]: { ...(p[act.activityId] ?? {}), [s.slotId]: o } }))}>
                            {o}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {act.reasonLabel && (
                    <textarea value={answers[act.activityId] ?? ''} rows={2}
                      onChange={(e) => setAnswers((a) => ({ ...a, [act.activityId]: e.target.value }))}
                      placeholder={act.reasonLabel} />
                  )}
                </div>
              )
              : (
                  <textarea value={answers[act.activityId] ?? ''} rows={3} onChange={(e) => setAnswers((a) => ({ ...a, [act.activityId]: e.target.value }))}
                    placeholder="用自己的话回答" />
                )}
          <div className="v4-act-foot">
            {!act.oralTask && !feedback[act.activityId] && (
              <button className="v4-primary"
                disabled={!(act.slots?.length
                  ? act.slots.every((s) => slotPicks[act.activityId]?.[s.slotId])
                  : answers[act.activityId]?.trim())}
                onClick={() => submit(act)}>提交</button>
            )}
            {(() => {
              const fb = feedback[act.activityId]
              if (!fb || act.oralTask) return null
              return fb.aiReview ? (
                <span className={
                  fb.aiReview.verdict === 'correct' ? 'v4-ok'
                    : fb.aiReview.verdict === 'partial' ? 'v4-advise' : 'v4-no'}>
                  AI 老师批改：{fb.aiReview.verdict === 'correct' ? '✓ 意思对了'
                    : fb.aiReview.verdict === 'partial' ? '部分对' : '✗ 还不对'}
                  {fb.aiReview.feedback && ` —— ${fb.aiReview.feedback}`}
                </span>
              ) : (
                <span className={fb.pass ? 'v4-ok' : 'v4-no'}>
                  {fb.status === 'disputed' ? '这题系统拿不准，先不算你的错'
                    : fb.pass ? '对了！' : '还差一点——看下面的对照'}
                </span>
              )
            })()}
            {/* R5（24 号）：错→（看提示）→改答→再试。新一轮=新 take ID，旧作答与反馈保留在服务端 */}
            {feedback[act.activityId] && !act.oralTask && !feedback[act.activityId].pass && (
              <button className="v4-ghost" onClick={() => retry(act)}>再试一次</button>
            )}
            {feedback[act.activityId]?.status === 'disputed' && act.oralTask && (
              <span className="v4-advise">你说的话系统没太听清，先不算你的错；可以把文字改一改再提交。</span>
            )}
          </div>
          {feedback[act.activityId]?.practiceOnly && (
            <p className="v4-advise">这题由 AI 老师批改，算<b>练习参考</b>，不算进成绩。真正的成绩来自选择题和老师的确认。</p>
          )}
          {feedback[act.activityId]?.slotResults?.length ? (
            <ul className="v4-relations">
              {feedback[act.activityId].slotResults!.map((s) => (
                <li key={s.slotId} className={s.status === 'correct' ? 'v4-ok' : 'v4-no'}>
                  {s.status === 'correct' ? '✓' : '✗'} {s.prompt}
                  {s.status !== 'correct' && `（${s.status === 'missing' ? '这个空没选' : s.status === 'multiple' ? '选了好几个' : s.status === 'invalid' ? '这个选项不对' : '选错了'}）`}
                </li>
              ))}
            </ul>
          ) : null}
          {/* 40 号：两类失败分开说——"词全有但关系错"不同于"词没抓到" */}
          {feedback[act.activityId]?.pass === false && !feedback[act.activityId].aiReview && (feedback[act.activityId].mustNot?.length ?? 0) > 0 && (
            <p className="v4-advise">要点词都在，但意思连得不对：{feedback[act.activityId]!.mustNot!.join('；')}。回到材料再读一遍试试。</p>
          )}
          {/* 40 号表达反馈：语义对但被词表判据拒收 → 学生可记录申诉（保留争议，不扣能力不认证） */}
          {feedback[act.activityId]?.status === 'evaluated' && feedback[act.activityId].pass === false && feedback[act.activityId].practiceOnly && !feedback[act.activityId].studentClaimed && (
            <button className="v4-ghost" onClick={() => claimExpression(act)}>我觉得我说得对（记下来，先不算错）</button>
          )}
          {feedback[act.activityId]?.studentClaimed && (
            <p className="v4-advise">已记下：这句先不算错，之后一起复核。</p>
          )}
          {/* 40 号：提交后揭晓——参考表达 + 原文依据 + 不能照抄的开放追问 */}
          {feedback[act.activityId]?.reveal && (
            <details className="v4-fold">
              <summary>看看参考说法（建议自己先再试一次再看）</summary>
              <p><b>可以这样说：</b>{feedback[act.activityId]!.reveal!.referenceExpression}</p>
              {feedback[act.activityId]!.reveal!.supportingQuotes.map((q, i) => <p key={i} className="v4-dim">原文里是这么说的：{q}</p>)}
              <p className="v4-dim">参考只是一种说法，不是唯一答案。如果你说的意思一样却没算对，点上面的「我觉得我说得对」记下来。</p>
              {feedback[act.activityId]!.reveal!.followup && <FollowupBox accountKey={accountId} actId={act.activityId} prompt={feedback[act.activityId]!.reveal!.followup!} />}
            </details>
          )}
          {feedback[act.activityId]?.relations && (
            act.oralTask ? (
              feedback[act.activityId]?.aiReview ? (
                <div className="v4-advise">
                  <b>AI 老师批改（只供练习参考，不算成绩）：</b>
                  {feedback[act.activityId]!.aiReview!.verdict === 'correct' ? '✓ 意思到了' : feedback[act.activityId]!.aiReview!.verdict === 'partial' ? '部分对' : '✗ 还不对'}
                  {feedback[act.activityId]!.aiReview!.feedback && ` —— ${feedback[act.activityId]!.aiReview!.feedback}`}
                  <details style={{ marginTop: 4 }}><summary className="v4-dim">机器词表对照（很死板，仅供对照）</summary>
                    <ul>{feedback[act.activityId].relations!.map((rel) => (
                      <li key={rel.id}>{rel.hit ? '说到了' : '没说到'}「{rel.label}」{rel.required ? '' : '（加分项）'}</li>
                    ))}</ul>
                  </details>
                </div>
              ) : (
                <div className="v4-advise">
                  <b>练习参考（机器只对词，你说得对但用词不同也会显示没提到；不算成绩）：</b>
                  <ul>
                    {feedback[act.activityId].relations!.map((rel) => (
                      <li key={rel.id}>{rel.hit ? '说到了' : '没说到'}「{rel.label}」{rel.required ? '' : '（加分项）'}</li>
                    ))}
                  </ul>
                </div>
              )
            ) : (
              <ul className="v4-relations">
                {feedback[act.activityId].relations!.map((rel) => (
                  <li key={rel.id} className={rel.hit ? 'v4-ok' : 'v4-no'}>
                    {rel.hit ? '✓' : '✗'} {rel.label}{rel.required ? '' : '（加分项）'}
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      ))}
      <div className="v4-act-foot">
        {currentIndex > 0 && <button className="v4-ghost" onClick={() => setCurrentIndex(i => i - 1)}>回看上一步</button>}
        {currentIndex < visibleActs.length - 1 && <button className="v4-primary" disabled={refreshing || !feedback[visibleActs[currentIndex]?.activityId]} onClick={() => setCurrentIndex(i => i + 1)}>下一步</button>}
        {currentIndex === visibleActs.length - 1 && <button className="v4-primary" disabled={refreshing || !allDone} onClick={complete}>完成这一课</button>}
      </div>
      {err && <div className="v4-err">{err}</div>}
    </div>
  )
}

/** 口语任务：浏览器录音（用户点按钮才录）→ 回放 → 提交 → 机器建议 + 可纠转写（15 §9 录音页） */
function OralRecorder({ accountId, taskId, activityId, onSubmitted, onRefreshTask }: {
  taskId: string
  accountId: string
  activityId: string
  onRefreshTask: () => Promise<void>
  onSubmitted: (fb: { pass: boolean | null; status: string; relations?: { id: string; label: string; hit: boolean; required: boolean }[] }) => void
}) {
  const [recording, setRecording] = useState(false)
  const [audioUrl, setAudioUrl] = useState('')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [transcript, setTranscript] = useState('')
  const [transcriptOrigin, setTranscriptOrigin] = useState<'asr' | 'user_typed'>('user_typed')
  const submissionRef = useRef<string | null>(null)
  const uploadRequestRef = useRef<string | null>(null)
  useEffect(()=>{submissionRef.current=null;setErr('')},[taskId])
  const [asrSupported, setAsrSupported] = useState(true)
  const [mediaId, setMediaId] = useState('')
  const [corrected, setCorrected] = useState(false)
  const [micDenied, setMicDenied] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const asrRef = useRef<{ stop: () => void; abort?: () => void } | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)
  const draftKeyStr = draftKey(accountId, taskId)
  // 31 收口：跨页面未提交录音草稿恢复——进页先查本机 IndexedDB；提交/删除后即清
  useEffect(() => {
    let alive = true
    loadDraft(draftKeyStr).then((d) => {
      if (!alive || !d) return
      setBlob(d.blob)
      setAudioUrl(URL.createObjectURL(d.blob))
      setTranscript(d.transcript)
      setTranscriptOrigin(d.transcriptOrigin)
      setDraftRestored(true)
    })
    return () => { alive = false }
  }, [draftKeyStr])
  useEffect(() => () => {
    asrRef.current?.abort?.()
    const rec = recRef.current
    if (rec?.state === 'recording') rec.stop()
    rec?.stream.getTracks().forEach(t => t.stop())
  }, [])
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl) }, [audioUrl])
  const recStartRef = useRef<number>(0) // R8：真实录音时长（上传时随 take 报告，不再传 0）

  async function start() {
    setErr('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunksRef.current = []
      uploadRequestRef.current = null; submissionRef.current = null
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => chunksRef.current.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const raw = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        setBusy(true)
        try {
          const wav = await decodeRecordingWav(raw)
          setBlob(wav)
          setAudioUrl(URL.createObjectURL(wav))
          void saveDraft(draftKeyStr, { blob: wav, transcript, transcriptOrigin, mime: wav.type || 'audio/wav' })
        } catch {
          setBlob(raw)
          setAudioUrl(URL.createObjectURL(raw))
          setErr('这段录音暂时存不上，可以先留个草稿；重录一遍，或先用文字练习（口语成绩不受影响）。')
        } finally { setBusy(false) }
      }
      recRef.current = rec
      recStartRef.current = Date.now()
      rec.start()
      setRecording(true)
      try {
        const w = window as unknown as { SpeechRecognition?: new () => {
          lang: string; continuous: boolean; interimResults: boolean
          onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void
          onerror: (e: { error: string }) => void
          start: () => void
          stop: () => void
          abort?: () => void
        } }
        const SR = w.SpeechRecognition
        if (SR) {
          const asr = new SR()
          asr.lang = 'en-US'
          asr.continuous = true
          asr.interimResults = false
          asr.onresult = (e) => {
            let text = ''
            for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + ' '
            setTranscript(text.trim())
            setTranscriptOrigin('asr')
          }
          asr.onerror = (e) => {
            // no-speech/网络/超时都不是用户的错：如实标注 ASR 不可用，转写可手打
            if (e.error !== 'no-speech') setAsrSupported(false)
          }
          asrRef.current = asr
          asr.start()
        } else setAsrSupported(false)
      } catch { setAsrSupported(false) }
    } catch (e) {
      setMicDenied(true)
      setErr('麦克风用不了：' + (e as Error).message + '——先用下面的文字练习，口语不算你没练。')
    }
  }

  function stop() { asrRef.current?.stop(); recRef.current?.stop(); setRecording(false) }

  async function submit() {
    if (!blob && !(micDenied && transcript.trim())) return
    setBusy(true)
    setErr('')
    try {
      if (!blob) {
        submissionRef.current ??= `oral-text-${crypto.randomUUID()}`
        const r = await api<AttemptFeedback>(`/accounts/${accountId}/attempts`, { attemptId: submissionRef.current, taskId, activityId, response:{kind:'text',text:transcript},conditions:{firstExposure:true,hintLevel:0,transcriptShown:false,playCount:0,lookupUsed:false,responseMode:'typed_summary'} }, 'POST')
        void clearDraft(draftKeyStr)
        onSubmitted({pass:r.pass,status:r.evaluationStatus,relations:r.dimensions})
        return
      }
      uploadRequestRef.current ??= `upload-${crypto.randomUUID()}`
      submissionRef.current ??= `oral-${crypto.randomUUID()}`
      const intent = await api<{ mediaId: string; uploadUrl: string; token: string; uploaded?: boolean }>('/accounts/' + accountId + '/oral/intent', {
        requestId: uploadRequestRef.current, activityId, mime: blob.type || 'audio/webm', bytes: blob.size, durationMs: recStartRef.current ? Date.now() - recStartRef.current : 0,
      }, 'POST')
      if (!intent.uploaded) {
      const put = await fetch(intent.uploadUrl + '?token=' + encodeURIComponent(intent.token), { method: 'PUT', body: blob })
      if (!put.ok) throw new Error('上传失败 ' + put.status)
      }
      const r = await api<{ pass: boolean | null; evaluationStatus: string; dimensions?: { id: string; label: string; hit: boolean; required: boolean }[]; mediaId: string }>(
        '/accounts/' + accountId + '/attempts/oral', {
        attemptId: submissionRef.current, taskId, mediaId: intent.mediaId, activityId,
        transcript, transcriptOrigin,
        conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'oral_recording' },
      }, 'POST')
      setMediaId(r.mediaId)
      void clearDraft(draftKeyStr)
      onSubmitted({ pass: r.pass, status: r.evaluationStatus, relations: r.dimensions })
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  function retake() {
    // F5 验收：支持重新录一遍——新 take/新 attempt ID，旧作答保留
    void clearDraft(draftKeyStr)
    setBlob(null); setAudioUrl(''); setTranscript(''); setTranscriptOrigin('user_typed'); submissionRef.current = null; setMediaId(''); setCorrected(false); uploadRequestRef.current = null; setDraftRestored(false)
  }

  async function correct() {
    if (!mediaId || !transcript.trim()) return
    setErr('')
    try {
      await api(`/accounts/${accountId}/oral/${mediaId}/transcript`, { text: transcript }, 'POST')
      setCorrected(true)
    } catch (e) { setErr(String(e)) }
  }

  async function remove() {
    if (!mediaId) return
    setErr('')
    try {
      await fetch(`/api/v1/accounts/${accountId}/oral/${mediaId}`, { method: 'DELETE' })
      setDeleted(true)
    } catch (e) { setErr(String(e)) }
  }

  return (
    <div className="v4-oral">
      {!audioUrl && !micDenied && (
        <button className="v4-primary" onClick={recording ? stop : start}>
          {recording ? '⏹ 停止录音' : '🎙️ 开始录音（默认不录，点击才开始）'}
        </button>
      )}
      {micDenied && <p className="v4-dim">你可以先保存文字练习，口语能力仍为未测。</p>}
      {draftRestored && audioUrl && <p className="v4-dim">已恢复你上次未提交的录音草稿（只存在本机浏览器；提交或重录后会清除）。</p>}
      {audioUrl && <audio controls src={audioUrl} />}
      <textarea value={transcript} rows={2} onChange={(e) => { asrRef.current?.abort?.(); setTranscriptOrigin('user_typed'); setTranscript(e.target.value); submissionRef.current = null }}
        placeholder={asrSupported ? '语音转写（可手动纠正后再提交）' : '浏览器不支持语音识别：请打字写下你说的内容'} />
      <button className="v4-primary" disabled={busy || (!blob && !(micDenied && transcript.trim()))} onClick={submit}>{blob ? '提交口语作答' : '保存文字练习（口语未测）'}</button>
      {mediaId && !corrected && (
        <button className="v4-ghost" onClick={correct}>转写有误？纠正并保留原版</button>
      )}
      {corrected && <span className="v4-ok">已提交纠正版（原版保留，供复核对照）</span>}
      {mediaId && <button className="v4-ghost" onClick={retake}>重新录一遍（新 take）</button>}
      {mediaId && !deleted && <button className="v4-ghost" onClick={remove}>删除这段录音</button>}
      {deleted && <span className="v4-dim">录音已删除（数据库与文件一并移除）</span>}
      {err && <div className="v4-err">{err}<button className="v4-ghost" disabled={busy || recording} onClick={async()=>{try{await onRefreshTask();setErr('')}catch(e){setErr(String(e))}}}>重新获取任务后再试（保留这段录音）</button></div>}
    </div>
  )
}

/** 40 号：揭晓后的开放追问——回答保存在本机（localStorage），作为下次学习的引子，不产生假证据 */
function FollowupBox({ accountKey, actId, prompt }: { accountKey: string; actId: string; prompt: string }) {
  const key = `v4-followup:${accountKey}:${actId}`
  const [text, setText] = useState(() => localStorage.getItem(key) ?? '')
  const [savedAt, setSavedAt] = useState<number>(() => Number(localStorage.getItem(key + ':at') ?? 0))
  return (
    <div style={{ marginTop: 6 }}>
      <p style={{ margin: '4px 0' }}><b>{prompt}</b></p>
      <textarea value={text} rows={3} style={{ width: '100%' }}
        placeholder="写在这里（只保存在本机浏览器）"
        onChange={(e) => { setText(e.target.value); localStorage.setItem(key, e.target.value); const t = Date.now(); localStorage.setItem(key + ':at', String(t)); setSavedAt(t) }} />
      {savedAt > 0 && <p className="v4-dim">已保存在本机（{new Date(savedAt).toLocaleString()}）；不参与判分，也不会上传。</p>}
    </div>
  )
}

// ---------------------------------------------------------------- 审核与试听（真人审签入口）

type AudioAsset = {
  mediaId: string; kind: string; sourceType: string; title: string; speakerLabel: string | null
  durationMs: number; license: string; licenseStatus: string; sourceUrl: string | null
  author: string | null; candidateStatus: string | null; activityIds: string[]
  segments: { label: string; meaningBasis: string }[]
}
type LessonRow = {
  lessonId: string; version: number; title: string; strategyId: string
  objectiveIds: string[]; contentStatus: string; humanReview: string
  accountScope?: string; releaseChannel?: string
}

/** 试听播放器（审核版：带转写逐段意义依据，与学习页的首听隐藏不同——审的是内容本身） */
function AuditAudio({ asset }: { asset: AudioAsset }) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let revoke: string | null = null
    let alive = true
    ;(async () => {
      try {
        const r = await api<{ audioBase64: string; mime: string }>(`/media/${asset.mediaId}`)
        const bytes = Uint8Array.from(atob(r.audioBase64), (c) => c.charCodeAt(0))
        revoke = URL.createObjectURL(new Blob([bytes], { type: r.mime }))
        if (alive) setUrl(revoke)
        else URL.revokeObjectURL(revoke)
      } catch (e) { if (alive) setErr(String(e)) }
    })()
    return () => { alive = false; if (revoke) URL.revokeObjectURL(revoke) }
  }, [asset.mediaId])
  return (
    <div className="v4-card" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: '4px 0' }}>{asset.title} <span className="v4-dim">· {Math.round(asset.durationMs / 1000)} 秒</span></h3>
      <p className="v4-dim">
        {asset.sourceType === 'synthetic' ? `电脑合成音 · ${asset.speakerLabel ?? ''}` : `真实素材 · ${asset.author ?? ''}`}
        {' · '}{asset.license}
      </p>
      {err && <p className="v4-err">加载失败：{err}</p>}
      {url && <audio controls src={url} style={{ width: '100%', maxWidth: 560 }} />}
      {asset.candidateStatus && <p className="v4-dev">{asset.candidateStatus}</p>}
      {asset.sourceUrl && <p className="v4-dim">来源：<a href={asset.sourceUrl} target="_blank" rel="noreferrer">{asset.sourceUrl}</a></p>}
      {!!asset.segments.length && (
        <details>
          <summary className="v4-dim">逐段意义依据（{asset.segments.length} 段）</summary>
          <ul>{asset.segments.map((s, i) => <li key={i}><b>{s.label}</b>：{s.meaningBasis}</li>)}</ul>
        </details>
      )}
    </div>
  )
}

/** 审核与试听：真人试听音频、审签课程。签署是人对内容的结论，签了名字就落进记录。 */
function ReviewPanel() {
  const [assets, setAssets] = useState<AudioAsset[] | null>(null)
  const [lessons, setLessons] = useState<LessonRow[] | null>(null)
  const [reviewer, setReviewer] = useState(localStorage.getItem('v4-reviewer') ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const [a, l] = await Promise.all([
        api<{ assets: AudioAsset[] }>('/audio-assets'),
        api<{ lessons: LessonRow[] }>('/lessons'),
      ])
      setAssets(a.assets)
      setLessons(l.lessons)
    } catch (e) { setErr(String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function sign(lessonId: string) {
    if (!reviewer.trim()) { setErr('先在上方填写审阅人姓名——签署会记录是谁审的'); return }
    setBusy(lessonId)
    setErr('')
    try {
      localStorage.setItem('v4-reviewer', reviewer.trim())
      await api(`/lessons/${lessonId}/sign`, { reviewer: reviewer.trim(), note }, 'POST')
      setNote('')
      await load()
    } catch (e) { setErr(String(e)) } finally { setBusy('') }
  }

  const pending = (lessons ?? []).filter((l) => l.humanReview !== 'signed')
  return (
    <div>
      <div className="v4-card">
        <h3>这一页是给「真人审核」用的</h3>
        <p>① <b>试听</b>：下面每段音频直接点播放——合成的标注了 synthetic，真实的给了来源和许可。听完不自然/听不清，直接说，我重做。</p>
        <p>② <b>审签</b>：课程区列出待审课程，先在下面填你的名字，点「签署」即记录为该课程的人审结论（dev_only → mainline）。没有真人签署的课永远是开发样本。</p>
        <label style={{ display: 'block', margin: '8px 0 4px' }}>审阅人（你的名字，签署时记入）</label>
        <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="例：张俊杰"
          style={{ width: 240, padding: '6px 8px', background: '#15151a', color: 'inherit', border: '1px solid #333', borderRadius: 6 }} />
        <label style={{ display: 'block', margin: '8px 0 4px' }}>审签备注（可选：哪里改过、为什么放行）</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：L2 第 3 句语速偏快，但可接受"
          style={{ width: '100%', maxWidth: 560, padding: '6px 8px', background: '#15151a', color: 'inherit', border: '1px solid #333', borderRadius: 6 }} />
        {err && <div className="v4-err">{err}</div>}
      </div>

      <h3 style={{ margin: '14px 0 8px' }}>① 试听（{assets?.length ?? 0} 段）</h3>
      {(assets ?? []).map((a) => <AuditAudio key={a.mediaId} asset={a} />)}

      <h3 style={{ margin: '14px 0 8px' }}>② 课程审签（待审 {pending.length}）</h3>
      {(lessons ?? []).map((l) => (
        <div key={l.lessonId} className="v4-card" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{l.title}</b>
            <code className="v4-dim">{l.lessonId} v{l.version}</code>
            <span className="v4-skill">{l.releaseChannel === 'mainline' ? 'mainline' : 'dev_only'}</span>
            {l.accountScope && l.accountScope !== 'global' && <span className="v4-skill">个人定制</span>}
            <b>{l.humanReview === 'signed' ? '✅ 已签署' : '待签署'}</b>
          </div>
          <p className="v4-dim">目标：{l.objectiveIds.join('、')} · 策略：{l.strategyId}</p>
          {l.humanReview !== 'signed' && l.contentStatus !== 'withdrawn' && (
            <button className="v4-primary" disabled={busy === l.lessonId} onClick={() => sign(l.lessonId)}>
              {busy === l.lessonId ? '签署中…' : '签署（我审过，内容合格）'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
