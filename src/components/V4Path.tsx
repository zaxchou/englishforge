import { decodeRecordingWav } from '../learning/recordingWav'
// curriculum-v4 能力路径（W3 双轨展示，docs/curriculum-v4/15 §9）。
//
// 与旧首页的双轨纪律：这里是新域（目标/证据/计划），旧 XP/题量/箱数**不进**本页，
// 页面常驻“旧进度不换算”的说明 —— 两个系统不能给用户互相矛盾的“掌握率”。
// 口语录音（W5）接入前，口述任务以文字版走通并如实标注“口语证据未测”。
import { useCallback, useEffect, useRef, useState } from 'react'
import { goalLabel, learnerToday } from '../learning/learnerView'
import './v4.css'

type Plan = {
  decisionId: string
  primaryGoal: string | null
  strategyId: string
  reason: string
  hypotheses: string[]
  uncertainAreas: string[]
  lesson: { lessonId: string | null; activityId: string | null; status: string; waitNotice?: string; devSample?: boolean; resumeAvailable?: boolean }
  notChosen: { objectiveId: string; reason: string }[]
  status: string
}
type AttemptFeedback = { pass: boolean | null; evaluationStatus: string; practiceOnly?: boolean; dimensions?: { id: string; label: string; hit: boolean; required: boolean }[]; slotResults?: { slotId: string; prompt: string; given: string | null; status: string }[] }
type LessonPkg = {
  lessonId: string
  title: string
  whyNow: string
  teachingNote: string | null
  devSampleNotice: string | null
  activities: { resume?: { response: { text?: string; answers?: Record<string, string> }; result: AttemptFeedback } | null; nextTake: number; taskId: string; activityVersion: number; activityId: string; role: string; prompt: string; hintStageCount: number; firstHint: string | null; simulatesAudio: boolean; fixtureNotice: string | null; oralTask?: boolean; audio?: AudioInfo | null; slots?: { slotId: string; prompt: string; options: string[] }[] | null; reasonLabel?: string | null }[]
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
  unmeasured: '未测', tentative: '暂定', trained: '已练', independent: '独立', transferred: '迁移', retained: '保持',
}
const SKILL_LABEL: Record<string, string> = {
  listening: '听', speaking: '说', reading: '读', writing: '写', interaction: '互动',
}
// 复杂度带（coverage_groups.complexity_band 1–6）：认→造→辨→说→迁→释 的档位粗名；'base'=跨带聚合
const BAND_LABEL: Record<string, string> = {
  base: '综合', band1: '带1·认识', band2: '带2·造句', band3: '带3·辨析', band4: '带4·口说', band5: '带5·迁移', band6: '带6·解释',
}

export function V4Path({ accountId }: { accountId: string | null }) {
  // 28 号薄片：默认入口 = 今日学习（唯一主按钮回答"练什么/点哪里/为什么"）；
  // 后台视角（推荐详情/证据/地图）降为辅助入口，审核收进运营折叠
  const [tab, setTab] = useState<'today' | 'plan' | 'diag' | 'evidence' | 'map' | 'review'>('today')
  const [err, setErr] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [noPlan, setNoPlan] = useState(false)
  const [planLoading, setPlanLoading] = useState(true)
  const [lesson, setLesson] = useState<LessonPkg | null>(null)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [mapIdx, setMapIdx] = useState<MapIdx | null>(null)

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
    if (tab === 'evidence' && accountId && !evidence) {
      api<Evidence>(`/accounts/${accountId}/evidence`).then(setEvidence).catch((e) => setErr(String(e)))
    }
    if (tab === 'map' && !mapIdx) {
      api<MapIdx>('/map').then(setMapIdx).catch((e) => setErr(String(e)))
    }
  }, [tab, accountId, evidence, mapIdx])

  // ---------- 诊断流程（会话状态在 DiagPanel 内部管理） ----------

  /** 打开课程（今日入口与推荐详情共用） */
  const openLesson = useCallback(async (lessonId: string) => {
    try {
      setLesson(await api<LessonPkg>('/accounts/' + accountId + '/lessons/' + lessonId))
    } catch (e) { setErr(String(e)) }
  }, [accountId])

  if (!accountId) {
    return <div className="v4"><div className="v4-empty">正在连接数据库……连接后这里显示你的能力路径。</div></div>
  }

  const today = learnerToday(plan)

  return (
    <div className="v4">
      <details className="v4-legacy"><summary>关于学习记录</summary>本页是新版能力路径（curriculum-v4）。旧首页的 XP、题量、箱数只是历史活动记录，<b>不会换算</b>为这里的能力状态。</details>
      <div className="v4-tabs">
        <button className={tab === 'today' ? 'on' : ''} onClick={() => setTab('today')}>今日学习</button>
        <button className={tab === 'plan' ? 'on' : ''} onClick={() => setTab('plan')}>推荐详情</button>
        <button className={tab === 'diag' ? 'on' : ''} onClick={() => setTab('diag')}>入口诊断</button>
        <button className={tab === 'evidence' ? 'on' : ''} onClick={() => setTab('evidence')}>我的成长</button>
        <button className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>学习路线</button>
        <details className="v4-ops">
          <summary>运营工具</summary>
          <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>审核与试听</button>
        </details>
      </div>
      {err && <div className="v4-err">{err}</div>}

      {tab === 'today' && !lesson && (
        <div className="v4-card v4-today">
          <h2 className="v4-today-head">{today.headline}</h2>
          {today.reason && <p className="v4-why">{today.reason}</p>}
          <button className="v4-primary v4-today-btn" disabled={today.waiting || planLoading || !!err}
            onClick={() => {
              if (today.mode === 'find_start') { setTab('diag'); return }
              if (today.lessonId) void openLesson(today.lessonId)
            }}>{planLoading ? '正在读取学习安排…' : today.primaryLabel}</button>
          {today.goalId && (
            <details className="v4-fold">
              <summary>查看安排依据</summary>
              <p><code>{today.goalId}</code>{today.lessonId ? <> · 课程 <code>{today.lessonId}</code></> : null}</p>
            </details>
          )}
          <div className="v4-today-aux">
            <button className="v4-ghost" onClick={() => setTab('evidence')}>我的成长</button>
            <button className="v4-ghost" onClick={() => setTab('map')}>学习路线</button>
            <button className="v4-ghost" onClick={() => setTab('plan')}>推荐详情</button>
          </div>
          <p className="v4-dim">旧版刷题练习仍在侧栏「今日练习」，作为历史练习保留，两边分开计量。</p>
        </div>
      )}

      {tab === 'plan' && (
        <PlanPanel plan={plan} noPlan={noPlan} onDiagnostic={() => setTab('diag')}
          onOpenLesson={(lessonId) => void openLesson(lessonId)} />
      )}

      {tab === 'diag' && <DiagPanel key={accountId} accountId={accountId} onDone={async () => { await loadPlan(); setTab('today') }} />}

      {tab === 'evidence' && (
        <div className="v4-card">
          <h3>我的成长</h3>
          {evidence?.completedLessons?.length ? <>
            <p>最近完成的训练</p>
            <ul>{evidence.completedLessons.map(l=><li key={l.lessonId}>{l.title}</li>)}</ul>
            <p className="v4-dim">完成记录说明你练过这些内容；能否独立使用，还要看下面的能力记录。</p>
          </> : <p>完成第一段训练后，这里会留下你的学习轨迹。</p>}
          {evidence?.states.filter(s=>s.complexity==='base' && ['independent','transferred','retained'].includes(s.state) && !s.flags.includes('disputed')).map(s=><p key={s.objectiveId+s.skill}>{goalLabel(s.objectiveId)} · {SKILL_LABEL[s.skill] ?? s.skill}：{STATE_LABEL[s.state] ?? s.state}</p>)}
          <p>下一步：{today.headline.replace('今天这一步：','').replace('接下来该练：','')}</p>
          {today.waiting && <p>{today.reason}</p>}
          <button className="v4-primary" onClick={()=>setTab('today')}>回到今日学习</button>
          <details className="v4-fold"><summary>查看各项能力记录</summary>
          <p className="v4-dim">带行是每个复杂度档的真实状态（不同档互不覆盖）；「综合」行是跨档保守合并——取最弱一档，易档通过不会替你掩盖嵌套档的不足。</p>
          {!evidence?.states.length && <p className="v4-dim">还没有足够的能力记录。练习反馈会保留，但不会自动变成“掌握”。</p>}
          <div className="v4-states">
            {evidence?.states.map((s) => (
              <div key={s.objectiveId + s.skill + s.complexity} className="v4-state">
                <code>{s.objectiveId}</code>
                <span className="v4-skill">{SKILL_LABEL[s.skill] ?? s.skill}</span>
                <span className="v4-skill">{BAND_LABEL[s.complexity] ?? '综合'}</span>
                <b>{STATE_LABEL[s.state] ?? s.state}</b>
                {s.flags.map((f) => <em key={f}>{f === 'disputed' ? '争议复核' : f === 'waived_by_user' ? '已免修' : f === 'needs_repair' ? '待修复' : f}</em>)}
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
          <h3>能力地图 {mapIdx.mapVersion}</h3>
          <p>
            {mapIdx.summary.groups} 个知识组 · {mapIdx.summary.objectives} 条首批原子目标 ·
            已拆解 {mapIdx.summary.byAtomization.partial_draft ?? 0} 组 / 待拆解 {mapIdx.summary.byAtomization.pending ?? 0} 组 ·
            全图核验 {mapIdx.summary.coveredClaims} 组（如实为 0：账本≠覆盖证明）
          </p>
          <div className="v4-objlist">
            {mapIdx.objectives.map((o) => (
              <div key={o.objectiveId} className="v4-obj">
                <code>{o.objectiveId}</code> <b>{o.name}</b>
                <span className="v4-ver">{o.verification === 'claim_checked' ? '命题已核' : '设计草案'}</span>
                {o.flags.includes('needs_audio') && <span className="v4-ver">待音频</span>}
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

function PlanPanel({ plan, noPlan, onDiagnostic, onOpenLesson }: {
  plan: Plan | null
  noPlan: boolean
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
  return (
    <div className="v4-card">
      <h3>当前推荐 · {plan.primaryGoal ?? '—'}</h3>
      <p className="v4-why">{plan.reason}</p>
      <div className="v4-meta">
        <span>策略 {plan.strategyId}</span>
        {plan.lesson.lessonId && (
          <button className="v4-primary" onClick={() => onOpenLesson(plan.lesson.lessonId!)}>打开课程</button>
        )}
        {plan.lesson.status === 'fixture_dev_only' && (
          <span className="v4-wait">⏳ 该策略还没有课程包（只有验收用活动）；正式材料在 W3 材料清单内</span>
        )}
        {plan.lesson.status === 'content_pending' && <span className="v4-wait">⏳ {plan.lesson.waitNotice}</span>}
        {plan.lesson.devSample && <span className="v4-dev">开发样本 · 人审未签署</span>}
      </div>
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
        合成音频（synthetic · 受控练习）· {info.speakerLabel} · 约 {Math.round(info.durationMs / 1000)} 秒。自然讲者原声制作中。听力题需先播放再作答。
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
        <h3>入口诊断</h3>
        <p>约 5–10 分钟：文字关系 →（按需）对照定位 → 声音理解 → 口述。D2 声音步骤是合成语音（synthetic，受控练习音频），播放只记录输入交互，关键词反馈不认证听力理解；自然讲者原声制作中。此处口述用文字定位，真实口语能力尚未确认。</p>
        <button className="v4-primary" onClick={start}>开始诊断</button>
        {err && <div className="v4-err">{err}</div>}
      </div>
    )
  }
  if (diag.status === 'completed' && diag.tentative) {
    return (
      <div className="v4-card">
        <h3>诊断完成 · 暂定路线 {diag.tentative.route}</h3>
        <p><b>强项：</b>{diag.tentative.strongPoints.join('；') || '—'}</p>
        <p><b>根因假设：</b>{diag.tentative.hypotheses.join('、') || '—'}</p>
        <p><b>未测区域：</b>{diag.tentative.unmeasured.join('、')}</p>
        <p className="v4-dim">{diag.tentative.stopReason}</p>
      </div>
    )
  }
  return (
    <div className="v4-card">
      <h3>入口诊断 · {diag.step}</h3>
      {note && <div className="v4-note">{note}</div>}
      <pre className="v4-prompt">{diag.activity?.prompt}</pre>
      {diag.activity?.audio && (
        <LessonAudio taskId={diag.activity.taskId} info={diag.activity.audio} activityId={diag.activity.activityId} accountId={accountId}
          onPlay={() => { playsRef.current += 1 }} />
      )}
      {hintShown && diag.activity?.hints?.[0] && <p className="v4-hint">提示：{diag.activity.hints[0]}</p>}
      {!hintShown && !!diag.activity?.hints?.length && (
        <button className="v4-ghost" onClick={() => setHintShown(true)}>看提示（将记为支持）</button>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
        placeholder="用自己的话回答（中英文都可以）" />
      <button className="v4-primary" disabled={busy || !text.trim()} onClick={submit}>{note ? '重新提交这一步' : '提交这一步'}</button>
      <button className="v4-ghost" disabled={busy} onClick={start}>放弃本次，重新开始</button>
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
  const [feedback, setFeedback] = useState<Record<string, { pass: boolean | null; status: string; practiceOnly?: boolean; relations?: { id: string; label: string; hit: boolean; required: boolean }[]; slotResults?: { slotId: string; prompt: string; given: string | null; status: string }[] }>>(() => Object.fromEntries(pkg.activities.filter(a => a.resume).map(a => [a.activityId, {pass:a.resume!.result.pass,status:a.resume!.result.evaluationStatus,practiceOnly:a.resume!.result.practiceOnly,relations:a.resume!.result.dimensions,slotResults:a.resume!.result.slotResults}])))
  const [pkgLive, setPkgLive] = useState(pkg)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const playsRef = useRef<Record<string, number>>({}) // 音频播放次数：提交时计 playCount，不再写死 1
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
      const r = await api<{ pass: boolean | null; evaluationStatus: string; practiceOnly?: boolean; attemptIdUsed?: string; dimensions?: { id: string; label: string; hit: boolean; required: boolean }[]; slotResults?: { slotId: string; prompt: string; given: string | null; status: string }[] }>(`/accounts/${accountId}/attempts`, {
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
      setFeedback((f) => ({ ...f, [act.activityId]: { pass: r.pass, status: r.evaluationStatus, practiceOnly: r.practiceOnly, relations: r.dimensions, slotResults: r.slotResults } }))
      // 门控活动（如未预告追问）在前提活动提交后才出现：重取课包
      const fresh = await api<LessonPkg>(`/accounts/${accountId}/lessons/${pkgLive.lessonId}`)
      if (fresh.activities.length > visibleActs.length) setPkgLive(fresh)
    } catch (e) { setErr(String(e)) }
  }

  async function refreshLesson() {
    setRefreshing(true)
    try {
      const fresh = await api<LessonPkg>(`/accounts/${accountId}/lessons/${pkgLive.lessonId}`)
      const changed = new Set(fresh.activities.filter(a=>{const old=pkgLive.activities.find(o=>o.activityId===a.activityId);return !old || old.activityVersion!==a.activityVersion || old.prompt!==a.prompt}).map(a=>a.activityId))
      setAnswers(old=>Object.fromEntries(fresh.activities.map(a=>[a.activityId,a.resume?.response.text ?? (changed.has(a.activityId)?'':old[a.activityId] ?? '')])))
      setSlotPicks(old=>Object.fromEntries(fresh.activities.map(a=>[a.activityId,a.resume?.response.answers ?? (changed.has(a.activityId)?{}:old[a.activityId] ?? {})])))
      setFeedback(Object.fromEntries(fresh.activities.filter(a=>a.resume).map(a=>[a.activityId,{pass:a.resume!.result.pass,status:a.resume!.result.evaluationStatus,practiceOnly:a.resume!.result.practiceOnly,relations:a.resume!.result.dimensions,slotResults:a.resume!.result.slotResults}])))
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
        <p>这一课的练习已记录。完成练习不等于掌握，开放表达仍需进一步反馈。</p>
        <p>下一步会参考本次表现重新安排；你可以继续，也可以结束今天的学习。</p>
        <button className="v4-primary" onClick={onDone}>查看下一步</button>
      </div>
    )
  }
  return (
    <div className="v4-card">
      <h3>{pkgLive.title}</h3>
      <button className="v4-ghost" disabled={refreshing} onClick={()=>{void refreshLesson().catch(()=>{})}}>重新读取当前任务</button>
      <p className="v4-why">为什么现在学：{pkgLive.whyNow}</p>
      {pkgLive.teachingNote && <p className="v4-teach">要点：{pkgLive.teachingNote}</p>}
      {pkgLive.devSampleNotice && <p className="v4-dev">{pkgLive.devSampleNotice}</p>}
      <p className="v4-dim">当前第 {currentIndex + 1} 步，共 {visibleActs.length} 步。看懂反馈后再进入下一步。</p>
      {visibleActs.slice(currentIndex, currentIndex + 1).map((act) => (
        <div key={act.activityId + act.activityVersion + act.prompt} className="v4-act">
          <div className="v4-act-head">
            <b>{act.role === 'transfer' ? '陌生迁移' : act.role === 'practice' ? '练习' : act.role}</b>
            {act.simulatesAudio && !act.audio && <span className="v4-dev">文字模拟音频 · 听力证据未测</span>}
          </div>
          <pre className="v4-prompt">{act.prompt}</pre>
          {act.audio && (
            <LessonAudio taskId={act.taskId} info={act.audio} activityId={act.activityId} accountId={accountId}
              onPlay={() => { playsRef.current[act.activityId] = (playsRef.current[act.activityId] ?? 0) + 1 }} />
          )}
          {(revealed[act.activityId] ?? []).map((h, i) => (
            <p key={i} className="v4-hint">提示 {i + 1}：{h}</p>
          ))}
          {(revealed[act.activityId]?.length ?? 0) < act.hintStageCount && (
            <button className="v4-ghost" onClick={() => reveal(act)}>
              看提示（记为支持，{revealed[act.activityId]?.length ?? 0}/{act.hintStageCount}）
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
            {feedback[act.activityId] && !act.oralTask && (
              <span className={feedback[act.activityId].pass ? 'v4-ok' : 'v4-no'}>
                {feedback[act.activityId].status === 'disputed' ? '已标争议，不扣能力'
                  : feedback[act.activityId].pass ? '关系抓到了' : '还有关系没抓到——按下方逐项看'}
              </span>
            )}
            {/* R5（24 号）：错→（看提示）→改答→再试。新一轮=新 take ID，旧作答与反馈保留在服务端 */}
            {feedback[act.activityId] && !act.oralTask && !feedback[act.activityId].pass && (
              <button className="v4-ghost" onClick={() => retry(act)}>再试一次（新的一轮）</button>
            )}
            {feedback[act.activityId]?.status === 'disputed' && act.oralTask && (
              <span className="v4-advise">转写置信度低：已标争议，不影响你的能力记录；可纠正转写后供复核。</span>
            )}
          </div>
          {feedback[act.activityId]?.practiceOnly && (
            <p className="v4-advise">这是机器词表检查的<b>练习反馈</b>——帮你对照关系，不计入能力记录；能力证据来自封闭题与真人复核。</p>
          )}
          {feedback[act.activityId]?.slotResults?.length ? (
            <ul className="v4-relations">
              {feedback[act.activityId].slotResults!.map((s) => (
                <li key={s.slotId} className={s.status === 'correct' ? 'v4-ok' : 'v4-no'}>
                  {s.status === 'correct' ? '✓' : '✗'} {s.prompt}
                  {s.status !== 'correct' && `（${s.status === 'missing' ? '这空没选' : s.status === 'multiple' ? '选了多个' : s.status === 'invalid' ? '选了无效选项' : '选错了'}）`}
                </li>
              ))}
            </ul>
          ) : null}
          {feedback[act.activityId]?.relations && (
            act.oralTask ? (
              <div className="v4-advise">
                <b>练习建议（机器词表检查，低置信，不用于口语认证；转写词错≠你的错）：</b>
                <ul>
                  {feedback[act.activityId].relations!.map((rel) => (
                    <li key={rel.id}>{rel.hit ? '转写里涉及' : '转写里没提到'}「{rel.label}」{rel.required ? '' : '（加分项）'}</li>
                  ))}
                </ul>
              </div>
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
        {currentIndex < visibleActs.length - 1 && <button className="v4-primary" disabled={refreshing || !feedback[visibleActs[currentIndex]?.activityId]} onClick={() => setCurrentIndex(i => i + 1)}>看懂了，进入下一步</button>}
        {currentIndex === visibleActs.length - 1 && <button className="v4-primary" disabled={refreshing || !allDone} onClick={complete}>完成训练，查看本次反馈</button>}
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
        } catch {
          setBlob(raw)
          setAudioUrl(URL.createObjectURL(raw))
          setErr('这段录音暂未能解码成标准音频，可保留为草稿；请重录或用文字练习，暂不认证口语能力。')
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
      setErr('麦克风不可用：' + (e as Error).message + '——用下方文字练习代替（口语证据保持未测，不算你的错）')
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
      onSubmitted({ pass: r.pass, status: r.evaluationStatus, relations: r.dimensions })
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  function retake() {
    // F5 验收：支持重新录一遍——新 take/新 attempt ID，旧作答保留
    setBlob(null); setAudioUrl(''); setTranscript(''); setTranscriptOrigin('user_typed'); submissionRef.current = null; setMediaId(''); setCorrected(false); uploadRequestRef.current = null
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
        {asset.sourceType === 'synthetic' ? `合成音频（synthetic）· ${asset.speakerLabel ?? ''}` : `真实外部素材 · ${asset.author ?? ''}`}
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
