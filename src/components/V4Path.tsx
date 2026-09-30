// curriculum-v4 能力路径（W3 双轨展示，docs/curriculum-v4/15 §9）。
//
// 与旧首页的双轨纪律：这里是新域（目标/证据/计划），旧 XP/题量/箱数**不进**本页，
// 页面常驻“旧进度不换算”的说明 —— 两个系统不能给用户互相矛盾的“掌握率”。
// 口语录音（W5）接入前，口述任务以文字版走通并如实标注“口语证据未测”。
import { useCallback, useEffect, useRef, useState } from 'react'
import './v4.css'

type Plan = {
  decisionId: string
  primaryGoal: string | null
  strategyId: string
  reason: string
  hypotheses: string[]
  uncertainAreas: string[]
  lesson: { lessonId: string | null; activityId: string | null; status: string; waitNotice?: string; devSample?: boolean }
  notChosen: { objectiveId: string; reason: string }[]
  status: string
}
type LessonPkg = {
  lessonId: string
  title: string
  whyNow: string
  teachingNote: string | null
  devSampleNotice: string | null
  activities: { activityId: string; role: string; prompt: string; hintStageCount: number; firstHint: string | null; simulatesAudio: boolean; fixtureNotice: string | null; oralTask?: boolean }[]
  nextCandidates: string[]
  holdout: { lessonId: string; answersIncluded: boolean } | null
}
type Evidence = {
  states: { objectiveId: string; skill: string; state: string; flags: string[] }[]
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

export function V4Path({ accountId }: { accountId: string | null }) {
  const [tab, setTab] = useState<'plan' | 'diag' | 'evidence' | 'map'>('plan')
  const [err, setErr] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [noPlan, setNoPlan] = useState(false)
  const [lesson, setLesson] = useState<LessonPkg | null>(null)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [mapIdx, setMapIdx] = useState<MapIdx | null>(null)

  const loadPlan = useCallback(async () => {
    if (!accountId) return
    try {
      const r = await api<{ decision: Plan | null }>(`/accounts/${accountId}/plan`)
      setPlan(r.decision)
      setNoPlan(!r.decision)
      setLesson(null)
    } catch (e) { setErr(String(e)) }
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

  if (!accountId) {
    return <div className="v4"><div className="v4-empty">正在连接数据库……连接后这里显示你的能力路径。</div></div>
  }

  // ---------- 诊断流程（会话状态在 DiagPanel 内部管理） ----------

  return (
    <div className="v4">
      <div className="v4-legacy">双轨说明：本页是新版能力路径（curriculum-v4）。旧首页的 XP、题量、箱数只是历史活动记录，<b>不会换算</b>为这里的能力状态。</div>
      <div className="v4-tabs">
        <button className={tab === 'plan' ? 'on' : ''} onClick={() => setTab('plan')}>当前推荐</button>
        <button className={tab === 'diag' ? 'on' : ''} onClick={() => setTab('diag')}>入口诊断</button>
        <button className={tab === 'evidence' ? 'on' : ''} onClick={() => setTab('evidence')}>我的证据</button>
        <button className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>能力地图</button>
      </div>
      {err && <div className="v4-err">{err}</div>}

      {tab === 'plan' && (
        <PlanPanel plan={plan} noPlan={noPlan} onDiagnostic={() => setTab('diag')}
          onOpenLesson={async (lessonId) => {
            try {
              setLesson(await api<LessonPkg>('/accounts/' + accountId + '/lessons/' + lessonId))
            } catch (e) { setErr(String(e)) }
          }} />
      )}

      {tab === 'diag' && <DiagPanel accountId={accountId} onDone={async () => { await loadPlan(); setTab('plan') }} />}

      {tab === 'evidence' && (
        <div className="v4-card">
          <h3>四技能证据（按目标 × 技能）</h3>
          {!evidence?.states.length && <p className="v4-dim">还没有证据——先做入口诊断，状态会随练习逐格点亮。</p>}
          <div className="v4-states">
            {evidence?.states.map((s) => (
              <div key={s.objectiveId + s.skill} className="v4-state">
                <code>{s.objectiveId}</code>
                <span className="v4-skill">{SKILL_LABEL[s.skill] ?? s.skill}</span>
                <b>{STATE_LABEL[s.state] ?? s.state}</b>
                {s.flags.map((f) => <em key={f}>{f === 'disputed' ? '争议复核' : f === 'waived_by_user' ? '已免修' : f === 'needs_repair' ? '待修复' : f}</em>)}
              </div>
            ))}
          </div>
          {evidence && <p className="v4-dim">{evidence.note}</p>}
        </div>
      )}

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

      {tab === 'plan' && lesson && (
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

type DiagState = { diagnosticId: string; status: string; step: string | null; activity: { activityId: string; prompt: string; hints: string[] } | null; tentative: { strongPoints: string[]; hypotheses: string[]; unmeasured: string[]; route: string; stopReason: string } | null }

function DiagPanel({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [diag, setDiag] = useState<DiagState | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [hintShown, setHintShown] = useState(false)

  useEffect(() => {
    if (diag?.status === 'completed') onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diag?.status])

  async function submit() {
    if (!diag?.activity) return
    setBusy(true)
    setErr('')
    try {
      const r = await api<{ diagnostic: DiagState }>(`/accounts/${accountId}/attempts`, {
        attemptId: `diag-${diag.diagnosticId}-${diag.step}-${Date.now()}`,
        sessionId: diag.diagnosticId,
        activityId: diag.activity.activityId,
        response: { kind: 'text', text },
        conditions: {
          firstExposure: true, hintLevel: hintShown ? 1 : 0, transcriptShown: diag.step === 'D2b',
          playCount: 1, lookupUsed: false, responseMode: 'typed_summary',
        },
      }, 'POST')
      setDiag(r.diagnostic)
      setText('')
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const start = useCallback(async () => {
    setErr('')
    try {
      setDiag(await api<DiagState>('/accounts/' + accountId + '/diagnostics', { requestId: 'diag-' + Date.now() }, 'POST'))
    } catch (e) { setErr(String(e)) }
  }, [accountId])

  if (!diag) {
    return (
      <div className="v4-card">
        <h3>入口诊断</h3>
        <p>约 5–10 分钟：文字关系 →（按需）对照定位 → 声音理解 → 口述。D2 声音步骤当前是文字模拟（原声制作中，听力证据会如实标"未测"）；口述步骤为文字版（录音在 W5 接入）。</p>
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
      <pre className="v4-prompt">{diag.activity?.prompt}</pre>
      {hintShown && diag.activity?.hints?.[0] && <p className="v4-hint">提示：{diag.activity.hints[0]}</p>}
      {!hintShown && !!diag.activity?.hints?.length && (
        <button className="v4-ghost" onClick={() => setHintShown(true)}>看提示（将记为支持）</button>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
        placeholder="用自己的话回答（中英文都可以）" />
      <button className="v4-primary" disabled={busy || !text.trim()} onClick={submit}>提交这一步</button>
      {err && <div className="v4-err">{err}</div>}
    </div>
  )
}

function LessonRunner({ accountId, pkg, onDone }: {
  accountId: string
  pkg: LessonPkg
  onDone: () => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, string[]>>({})
  const [feedback, setFeedback] = useState<Record<string, { pass: boolean | null; status: string; relations?: { id: string; label: string; hit: boolean; required: boolean }[] }>>({})
  const [pkgLive, setPkgLive] = useState(pkg)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  const visibleActs = pkgLive.activities
  const attemptedKey = 'v4-attempted-' + pkgLive.lessonId
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

  async function submit(act: LessonPkg['activities'][number]) {
    setErr('')
    try {
      // 稳定 attemptId（lesson+activity）：网络重试不会产生重复证据；服务端会覆盖自报条件
      const r = await api<{ pass: boolean | null; evaluationStatus: string; dimensions?: { relations?: { id: string; label: string; hit: boolean; required: boolean }[] } }>(`/accounts/${accountId}/attempts`, {
        attemptId: `les-${pkgLive.lessonId}-${act.activityId}`,
        activityId: act.activityId,
        response: { kind: 'text', text: answers[act.activityId] ?? '' },
        conditions: {
          firstExposure: true, hintLevel: revealed[act.activityId]?.length ?? 0,
          transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary',
        },
      }, 'POST')
      setFeedback((f) => ({ ...f, [act.activityId]: { pass: r.pass, status: r.evaluationStatus, relations: r.dimensions?.relations } }))
      // 门控活动（如未预告追问）在前提活动提交后才出现：重取课包
      const fresh = await api<LessonPkg>(`/accounts/${accountId}/lessons/${pkgLive.lessonId}`)
      if (fresh.activities.length > visibleActs.length) setPkgLive(fresh)
    } catch (e) { setErr(String(e)) }
  }

  async function complete() {
    setErr('')
    try {
      await api(`/accounts/${accountId}/lessons/${pkgLive.lessonId}/complete`, {}, 'POST')
      setDone(true)
      onDone()
    } catch (e) { setErr(String(e)) }
  }

  if (done) {
    return (
      <div className="v4-card">
        <h3>{pkgLive.title} · 已完成</h3>
        <p>推荐已按新证据重算——回到「当前推荐」看下一步。</p>
      </div>
    )
  }
  return (
    <div className="v4-card">
      <h3>{pkgLive.title}</h3>
      <p className="v4-why">为什么现在学：{pkgLive.whyNow}</p>
      {pkgLive.teachingNote && <p className="v4-teach">要点：{pkgLive.teachingNote}</p>}
      {pkgLive.devSampleNotice && <p className="v4-dev">{pkgLive.devSampleNotice}</p>}
      {visibleActs.map((act) => (
        <div key={act.activityId} className="v4-act">
          <div className="v4-act-head">
            <b>{act.role === 'transfer' ? '陌生迁移' : act.role === 'practice' ? '练习' : act.role}</b>
            {act.simulatesAudio && <span className="v4-dev">文字模拟音频 · 听力证据未测</span>}
          </div>
          <pre className="v4-prompt">{act.prompt}</pre>
          {(revealed[act.activityId] ?? []).map((h, i) => (
            <p key={i} className="v4-hint">提示 {i + 1}：{h}</p>
          ))}
          {(revealed[act.activityId]?.length ?? 0) < act.hintStageCount && (
            <button className="v4-ghost" onClick={() => reveal(act)}>
              看提示（记为支持，{revealed[act.activityId]?.length ?? 0}/{act.hintStageCount}）
            </button>
          )}
          {act.oralTask
            ? <OralRecorder accountId={accountId} activityId={act.activityId} onSubmitted={(fb) => setFeedback((f) => ({ ...f, [act.activityId]: fb }))} />
            : (
                <textarea value={answers[act.activityId] ?? ''} rows={3} onChange={(e) => setAnswers((a) => ({ ...a, [act.activityId]: e.target.value }))}
                  placeholder="用自己的话回答" />
              )}
          <div className="v4-act-foot">
            {!act.oralTask && (
              <button className="v4-primary" disabled={!answers[act.activityId]?.trim() || !!feedback[act.activityId]}
                onClick={() => submit(act)}>提交</button>
            )}
            {feedback[act.activityId] && !act.oralTask && (
              <span className={feedback[act.activityId].pass ? 'v4-ok' : 'v4-no'}>
                {feedback[act.activityId].status === 'disputed' ? '已标争议，不扣能力'
                  : feedback[act.activityId].pass ? '关系抓到了' : '还有关系没抓到——按下方逐项看'}
              </span>
            )}
            {feedback[act.activityId]?.status === 'disputed' && act.oralTask && (
              <span className="v4-advise">转写置信度低：已标争议，不影响你的能力记录；可纠正转写后供复核。</span>
            )}
          </div>
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
      <button className="v4-primary" disabled={!allDone} onClick={complete}>完成这一课（重算推荐）</button>
      {err && <div className="v4-err">{err}</div>}
      <input type="hidden" value={attemptedKey} readOnly />
    </div>
  )
}

/** 口语任务：浏览器录音（用户点按钮才录）→ 回放 → 提交 → 机器建议 + 可纠转写（15 §9 录音页） */
function OralRecorder({ accountId, activityId, onSubmitted }: {
  accountId: string
  activityId: string
  onSubmitted: (fb: { pass: boolean | null; status: string; relations?: { id: string; label: string; hit: boolean; required: boolean }[] }) => void
}) {
  const [recording, setRecording] = useState(false)
  const [audioUrl, setAudioUrl] = useState('')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [transcript, setTranscript] = useState('')
  const [asrSupported, setAsrSupported] = useState(true)
  const [mediaId, setMediaId] = useState('')
  const [corrected, setCorrected] = useState(false)
  const [micDenied, setMicDenied] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function start() {
    setErr('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunksRef.current = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => chunksRef.current.push(e.data)
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: 'audio/webm' })
        setBlob(b)
        setAudioUrl(URL.createObjectURL(b))
        stream.getTracks().forEach((t) => t.stop())
      }
      recRef.current = rec
      rec.start()
      setRecording(true)
      try {
        const w = window as unknown as { SpeechRecognition?: new () => {
          lang: string; continuous: boolean; interimResults: boolean
          onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void
          onerror: (e: { error: string }) => void
          start: () => void
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
          }
          asr.onerror = (e) => {
            // no-speech/网络/超时都不是用户的错：如实标注 ASR 不可用，转写可手打
            if (e.error !== 'no-speech') setAsrSupported(false)
          }
          asr.start()
        } else setAsrSupported(false)
      } catch { setAsrSupported(false) }
    } catch (e) {
      setMicDenied(true)
      setErr('麦克风不可用：' + (e as Error).message + '——用下方文字练习代替（口语证据保持未测，不算你的错）')
    }
  }

  function stop() { recRef.current?.stop(); setRecording(false) }

  async function submit() {
    if (!blob) return
    setBusy(true)
    setErr('')
    try {
      const intent = await api<{ mediaId: string; uploadUrl: string; token: string }>('/accounts/' + accountId + '/oral/intent', {
        activityId, mime: blob.type || 'audio/webm', bytes: blob.size, durationMs: 0,
      }, 'POST')
      const put = await fetch(intent.uploadUrl + '?token=' + encodeURIComponent(intent.token), { method: 'PUT', body: blob })
      if (!put.ok) throw new Error('上传失败 ' + put.status)
      const r = await api<{ pass: boolean | null; evaluationStatus: string; dimensions?: { relations?: { id: string; label: string; hit: boolean; required: boolean }[] }; mediaId: string }>(
        '/accounts/' + accountId + '/attempts/oral', {
        attemptId: `oral-${activityId}-${Date.now()}`, mediaId: intent.mediaId, activityId,
        transcript, transcriptOrigin: 'asr',
        conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'oral_recording' },
      }, 'POST')
      setMediaId(r.mediaId)
      onSubmitted({ pass: r.pass, status: r.evaluationStatus, relations: r.dimensions?.relations })
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  function retake() {
    // F5 验收：支持重新录一遍——新 take/新 attempt ID，旧作答保留
    setBlob(null); setAudioUrl(''); setTranscript(''); setMediaId(''); setCorrected(false)
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
      {micDenied && (
        <textarea value={transcript} rows={3} onChange={(e) => setTranscript(e.target.value)}
          placeholder="麦克风不可用：把要说的内容打字写下来（文字练习，口语证据保持未测）" />
      )}
      {audioUrl && <audio controls src={audioUrl} />}
      <textarea value={transcript} rows={2} onChange={(e) => setTranscript(e.target.value)}
        placeholder={asrSupported ? '语音转写（可手动纠正后再提交）' : '浏览器不支持语音识别：请打字写下你说的内容'} />
      <button className="v4-primary" disabled={!blob || busy} onClick={submit}>提交口语作答</button>
      {mediaId && !corrected && (
        <button className="v4-ghost" onClick={correct}>转写有误？纠正并保留原版</button>
      )}
      {corrected && <span className="v4-ok">已提交纠正版（原版保留，供复核对照）</span>}
      {mediaId && <button className="v4-ghost" onClick={retake}>重新录一遍（新 take）</button>}
      {mediaId && !deleted && <button className="v4-ghost" onClick={remove}>删除这段录音</button>}
      {deleted && <span className="v4-dim">录音已删除（数据库与文件一并移除）</span>}
      {err && <div className="v4-err">{err}</div>}
    </div>
  )
}
