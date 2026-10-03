// 托福学习系统（59 号 S1/S2）——界面基线 = toefl-demo-v2 浅色原型（58 号定稿）。
// 数据全部来自 /api/toefl/*（NAS SQLite）；进度口径只在服务端 computeProgress 一处。
// 诚实边界（照抄合同）：空状态不造分数；独立测试无未见池就明说；老师反馈失败可重试；
// 口语无 ASR → 本人补录文字稿（origin=user_typed）。
import { useCallback, useEffect, useRef, useState } from 'react'
import './toefl.css'
import { ExamLibrary, ExamRunner } from './ExamRunner'

// ---------- 类型 ----------

type Part = 'listening' | 'reading' | 'writing' | 'speaking'
type View = 'dashboard' | 'course' | 'profile' | 'errors' | 'weak' | 'resources' | 'test'
type Tab = 'learn' | 'practice' | 'review'

interface Chapter {
  chapterId: string; part: Part; moduleId: string; title: string; goal: string; partName?: string
  learnWhat: string; position: string; methodText: string; methodSource: string
  videoBindings: { mediaId: string; role: string }[]
  handoutPages: { notesId: string; file: string; pages: number[]; note: string }[]
  practiceTaskId: string; reviewPolicy: string
  requiredActivities: string[]; weaknessTags: string[]
  publicationStatus: string; newQuestionCheck: string
}
interface Dashboard {
  progress: { parts: { part: Part; name: string; done: number; total: number; chapters: { chapterId: string; title: string; done: number; total: number; doneKeys: string[] }[] }[]; overall: { done: number; total: number }; catalogVersion: number }
  resume: Record<Part, { chapterId: string; activity: Tab; mediaId: string | null; lastPosition: number; updatedAt?: number } | undefined>
  errors: { total: number; byStatus: Record<string, number>; recent: ErrorEntry[] }
  latestTeacherAnalysis: { feedbackId: string; attemptId: string; part: Part; output: TeacherOutput } | null
  profile: { fields: ProfileFields; updatedAt: number | null }
  planNotice: string
}
interface ProfileFields { target?: FieldVal; exam_date?: FieldVal; focus?: FieldVal; background?: BgItem[]; habits?: Record<string, string> }
interface FieldVal { value: string; source: string; at: number }
interface BgItem { id: string; label: string; value: string; source: string; at: number }
interface ErrorEntry {
  errorId: string; part: Part; partName: string; chapterId: string | null; kind: string
  title: string; detail: string | null; tag: string | null; status: string; retries: number
  hypothesis: { statement?: string; confidence?: string } | null; userResponse: string | null
}
interface TeacherOutput { observation: string; evidence?: string[]; hypothesis?: string; confidence?: string; one_fix?: string; followup?: string }
interface TaskQ { id: string; prompt: string; options: string[] }
interface Task {
  taskId: string; kind: 'mc_group' | 'open_writing' | 'open_speaking'; title: string
  material: { type: string; mediaId?: string; imageMediaId?: string; prompt?: string; body?: string; title?: string; honestyNote?: string }
  source: { pack: string; pdfPage: number }
  questions?: TaskQ[]
  feedbackScale?: string
}
interface Attempt {
  attemptId: string; part: Part; taskId: string; status: string; mode: string
  answers: Record<string, number> | null; draft: string | null
  audioAvailable: boolean; transcript: string | null; transcriptOrigin: string | null
  submittedAt: number | null
  task?: { taskId: string; kind: string; title: string; questions?: TaskQ[] }
}
interface Results {
  kind: 'closed' | 'open'
  results?: { questionId: string; prompt: string; chosen: number | null; chosenText: string | null; key: number; keyText: string; correct: boolean; quote: string; why: string; tag: string }[]
  note?: string
}
interface ChapterState {
  chapter: Chapter
  taskDef: Task
  activities: Record<string, { done: boolean; taskId?: string }>
  attempts: Attempt[]
  latestAttempt: Attempt | null
  results: Results | null
  feedbacks: Record<string, { feedbackId: string; version: number; status: string; output: TeacherOutput | null; error: string | null }>
  note: string
  newQuestionCheck: string
}

// ---------- API 客户端 ----------

/** 错误人话化：服务端错误码前缀剥掉，剩下的直接给人看 */
function humanize(err: string): string {
  return err.replace(/^[A-Z_]+:\s*/, '')
}
async function api<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(humanize(String(json.error ?? `请求失败（${res.status}）`)))
  return json as T
}

const MEDIA = (id: string) => `/api/toefl/media/${encodeURIComponent(id)}`

// ---------- 小件 ----------

const esc = (s: unknown) => String(s ?? '')

function Bar({ ratio }: { ratio: number }) {
  return <div className="bar"><i style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
}

/** 媒体播放器：续播 + 观看区间（拖动不算）——口径与原型一致，区间合并交给服务端 */
function MediaPlayer({ mediaId, part, accountId, startAt }: { mediaId: string; part: Part; accountId: string; startAt: number }) {
  const ref = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const last = useRef(0)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    let lastPost = 0
    const onMeta = () => { v.currentTime = Math.min(startAt || 0, v.duration || 0); last.current = v.currentTime }
    const onTime = () => {
      const t = v.currentTime
      const delta = t - last.current
      if (!v.paused && delta > 0 && delta < 5) {
        // 只收 ≤5s 正向小段（拖动不算）；每 5 秒节流上报，失败不影响播放
        if (Date.now() - lastPost > 5000) {
          lastPost = Date.now()
          void api(`/api/toefl/accounts/${accountId}/media-progress`, {
            mediaId, part, position: t, interval: [last.current, t],
          }, 'POST').catch(() => {})
        }
      }
      last.current = t
    }
    const onErr = () => {
      const st = document.getElementById('toeflMediaStatus')
      if (st) st.textContent = '播放器未能加载此文件，可读讲义继续；播放不算完成。'
    }
    const onSeek = () => { last.current = v.currentTime }
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('seeking', onSeek)
    v.addEventListener('error', onErr)
    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('seeking', onSeek)
      v.removeEventListener('error', onErr)
    }
  }, [mediaId, part, accountId, startAt])
  const isAudio = mediaId.startsWith('aud_')
  return isAudio
    ? <audio ref={ref as React.RefObject<HTMLAudioElement>} controls preload="metadata" src={MEDIA(mediaId)} />
    : <video ref={ref as React.RefObject<HTMLVideoElement>} controls preload="metadata" src={MEDIA(mediaId)} />
}

// ---------- 页面：首页 ----------

const STAGES: Record<string, string> = { learn: '方法学习', practice: '配套真题', review: '老师复盘' }

function DashboardPage({ data, onOpenCourse, onOpenProfile, onOpenErrors, onOpenWeak }: {
  data: Dashboard
  onOpenCourse: (part: Part) => void
  onOpenProfile: () => void
  onOpenErrors: () => void
  onOpenWeak: () => void
}) {
  const parts = data.progress.parts
  const overall = data.progress.overall
  const lastPart = (Object.entries(data.resume).filter(([, v]) => v).sort((a, b) => (b[1]!.updatedAt ?? 0) - (a[1]!.updatedAt ?? 0))[0]?.[0] ?? 'listening') as Part
  const d = parts.find((p) => p.part === lastPart)
  const resume = data.resume[lastPart]
  const chapter = d?.chapters[0]
  const stage = resume?.activity ?? 'learn'
  const wrong = data.errors.recent.filter((e) => e.kind === 'first_wrong').length
  const self = data.errors.recent.filter((e) => e.kind !== 'first_wrong').length
  const ta = data.latestTeacherAnalysis
  const pct = overall.total ? Math.round(overall.done / overall.total * 100) : 0
  return <>
    <div className="dashhero">
      <div className="dashintro">
        <div className="eyebrow">学习总览</div>
        <h1>我的托福课程</h1>
        <p className="muted">{chapter ? `${d?.name} · ${chapter.title} · ${STAGES[stage] ?? '方法学习'}` : '从一科开始，按自己的节奏推进。'}</p>
        <button className="primary" onClick={() => onOpenCourse(lastPart)}>{chapter ? '继续' : '开始'}{d?.name} · {STAGES[stage] ?? '方法学习'}</button>
      </div>
      <div className="progressSummary">
        <div className="bigprogress">{pct}<small style={{ font: '18px Segoe UI' }}>%</small></div>
        <p>课程进度 · {overall.done} / {overall.total} 活动</p>
        <p className="source">范围：当前目录版本 v{data.progress.catalogVersion} 已发布 4 章 × 3 活动；不是能力分数。</p>
      </div>
    </div>
    <div className="overviewgrid">
      <div>
        <h2>四科课程</h2>
        {parts.map((p) => {
          const ch = p.chapters[0]
          const done = p.done, total = p.total
          const complete = done >= total
          const r = data.resume[p.part]
          return (
            <article className="courseRow" key={p.part}>
              <div>
                <h3>{p.name}</h3>
                <p>{ch ? `第 1 章 · ${ch.title}` : '规划中'}</p>
                <p>当前：{STAGES[r?.activity ?? 'learn']}{r?.lastPosition ? ` · ${Math.floor(r.lastPosition)} 秒` : ''}</p>
                <span className="source">{total ? (complete ? '本章已完成 · 待新题检验' : `${done} / ${total} 活动完成`) : '尚未发布'}</span>
              </div>
              <div><b>{total ? Math.round(done / total * 100) : 0}%</b><Bar ratio={total ? done / total : 0} /></div>
              <button onClick={() => onOpenCourse(p.part)}>{complete ? `查看${p.name}本章` : `继续${p.name}`}</button>
            </article>
          )
        })}
        <section className="section">
          <div className="row"><h2>错题与疑点</h2><button className="secondary" onClick={onOpenErrors}>打开错题本</button></div>
          <div className="statline">
            <div><strong>{wrong}</strong><span>不同原题错误</span></div>
            <div><strong>{self}</strong><span>主动记录疑点</span></div>
            <div><strong>{data.errors.byStatus.awaiting_new_check ?? 0}</strong><span>待新题检验</span></div>
          </div>
          {data.errors.recent.length
            ? data.errors.recent.slice(0, 3).map((e) => (
              <div className="records" key={e.errorId}>
                <span className="source">{e.partName} · {esc(e.tag) || '待归类'}</span>
                <p>{e.title}</p>
                <button className="secondary" onClick={onOpenErrors}>查看作答与依据</button>
              </div>
            ))
            : <p className="muted">暂无记录。答错、猜对或卡住，都可以留下来复盘。</p>}
        </section>
      </div>
      <div>
        <section className="quietpanel">
          <h2>老师复盘</h2>
          {ta
            ? <div className="result">
                <span className="tag">老师分析 · {data.progress.parts.find((p) => p.part === ta.part)?.name}</span>
                <p>{esc(ta.output?.observation)}</p>
                <p>{esc(ta.output?.one_fix)}</p>
                <button className="secondary" onClick={() => onOpenCourse(ta.part)}>查看这题的复盘</button>
              </div>
            : <div className="blank"><p>做完一组题，这里会整理你的答案与原题依据。</p></div>}
          <p className="source">{ta ? '分析绑定你的作答与题目版本。' : '个性化分析尚未启用 · 做完配套题后可请求分析。'}</p>
          <button className="secondary" onClick={onOpenWeak}>查看薄弱环节记录</button>
        </section>
        <section className="quietpanel">
          <div className="row"><h2>我的学习计划</h2><button className="secondary" onClick={onOpenProfile}>编辑计划</button></div>
          <dl>
            <dt>目标与日期</dt>
            <dd>{data.profile.fields.target?.value || data.profile.fields.exam_date?.value
              ? <>{esc(data.profile.fields.target?.value || '目标分数待确定')}<br />{esc(data.profile.fields.exam_date?.value || '考试日期待确定')}</>
              : '目标与考试日期待设置'}</dd>
            <dt>当前重点 · 你的自述</dt>
            <dd>{esc(data.profile.fields.focus?.value) || '声音识别、长句关系、独立表达。'}</dd>
            <dt>基础与习惯 · 你的自述</dt>
            <dd>四级 · 词汇约 8,000–10,000<br />每天学习约 3–4 小时</dd>
          </dl>
          <button className="secondary" onClick={onOpenProfile}>查看完整学习档案</button>
        </section>
      </div>
    </div>
  </>
}

// ---------- 页面：课程（学习/配套真题/复盘） ----------

function LearnTab({ st, part, accountId, onGoPractice, onComplete }: {
  st: ChapterState; part: Part; accountId: string; onGoPractice: () => void; onComplete: () => void
}) {
  const ch = st.chapter
  const video = ch.videoBindings[0]?.mediaId
  const [note, setNote] = useState(st.note)
  const [saved, setSaved] = useState('')
  const saveNote = async () => {
    await api(`/api/toefl/accounts/${accountId}/notes`, { chapterId: ch.chapterId, body: note }, 'POST')
    setSaved('已保存')
  }
  return <>
    <section className="section">
      <div className="row">
        <h2>方法学习</h2>
        <span className="tag">{st.activities.method.done ? '方法活动已完成' : '待学习'}</span>
        <button className="secondary" onClick={onGoPractice}>直接做配套题</button>
      </div>
      <p>看视频或读讲义，任选一种方式。</p>
      {video && <MediaPlayer mediaId={video} part={part} accountId={accountId} startAt={0} />}
      <p id="toeflMediaStatus" className="source">保存观看位置；拖动不计观看。跳到结尾不算看完。</p>
      <p className="source">{ch.methodSource}</p>
    </section>
    <section className="section">
      <h2>讲义快读 · 本章要点</h2>
      <div className="method">{ch.methodText}</div>
      <ul>
        {ch.handoutPages.map((h) => (
          <li key={h.notesId + h.pages[0]}>
            {h.note}（{h.notesId}，PDF 第 {h.pages.join('、')} 页）
            <a href={MEDIA(pdfMediaIdFor(h.notesId))} target="_blank" rel="noreferrer"> 打开原讲义</a>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="primary" onClick={onComplete}>我已读懂要点，进入练习</button>
      </div>
      <p className="source">两条路径等价：视频/讲义任一完成即算方法活动完成（不重复加分）。</p>
    </section>
    <section className="section">
      <label htmlFor="toeflNote">本章笔记 / 想问老师的问题</label>
      <textarea id="toeflNote" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <button onClick={saveNote}>保存笔记</button>
        <span className="noteSaved">{saved}</span>
      </div>
    </section>
  </>
}

function pdfMediaIdFor(notesId: string): string {
  const map: Record<string, string> = {
    'notes-02': 'pdf_notes_listenbase', 'notes-03': 'pdf_notes_listening',
    'notes-04': 'pdf_notes_reading', 'notes-05': 'pdf_notes_reading',
    'notes-06': 'pdf_notes_writing', 'notes-07': 'pdf_notes_speaking',
  }
  return map[notesId] ?? 'pdf_notes_listening'
}

function PracticeTab({ st, accountId, onSubmitted }: {
  st: ChapterState; accountId: string; onSubmitted: () => void
}) {
  const ch = st.chapter
  const task = st.taskDef
  const attempt = st.latestAttempt
  const taskId = ch.practiceTaskId
  const [answers, setAnswers] = useState<Record<string, number>>(attempt?.answers ?? {})
  const [draft, setDraft] = useState(attempt?.draft ?? '')
  const [transcript, setTranscript] = useState(attempt?.transcript ?? '')
  const [recording, setRecording] = useState(false)
  const [recUrl, setRecUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const attemptRef = useRef<Attempt | null>(attempt)
  attemptRef.current = attempt

  const idemKey = `s01-${taskId}-${accountId.slice(-6)}`

  const ensureAttempt = async (): Promise<string> => {
    const a = attemptRef.current
    if (a && a.attemptId) return a.attemptId
    const r = await api<{ attempt: Attempt }>(`/api/toefl/accounts/${accountId}/attempts`, {
      idempotencyKey: idemKey, taskId,
    }, 'POST')
    attemptRef.current = r.attempt
    return r.attempt.attemptId
  }
  const submit = async (extra: Record<string, unknown> = {}) => {
    setBusy(true); setErr('')
    try {
      await api(`/api/toefl/accounts/${accountId}/attempts`, {
        idempotencyKey: idemKey, taskId, submit: true, ...extra,
      }, 'POST')
      onSubmitted()
    } catch (e) { setErr(String((e as Error).message)) } finally { setBusy(false) }
  }
  const logSupport = (kind: string) => {
    const a = attemptRef.current
    if (a) void api(`/api/toefl/accounts/${accountId}/attempts/${a.attemptId}/support`, { kind }, 'POST').catch(() => {})
  }

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => chunksRef.current.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        setRecUrl(URL.createObjectURL(blob))
        const aId = await ensureAttempt()
        const res = await fetch(`/api/toefl/accounts/${accountId}/attempts/${aId}/audio`, { method: 'PUT', body: blob })
        if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(humanize(String(j.error ?? '录音上传失败'))) }
      }
      recorderRef.current = rec
      rec.start()
      setRecording(true)
    } catch {
      setErr('浏览器没有获得麦克风权限；可以直接补录文字稿，或稍后在系统设置允许麦克风。')
    }
  }
  const stopRec = () => {
    recorderRef.current?.stop()
    setRecording(false)
  }

  if (task.kind === 'mc_group') {
    const questions = task.questions ?? []
    const answered = questions.every((q) => answers[q.id] !== undefined)
    return <>
      <h2>{task.title}</h2>
      {st.chapter.part === 'listening'
        ? <>
            <h2>Listen to a conversation.</h2>
            <MediaPlayer mediaId={task.material.mediaId!} part={st.chapter.part} accountId={accountId} startAt={0} />
            <p className="muted">{task.material.honestyNote}</p>
            <button className="secondary" onClick={() => logSupport('replay')}>重播一次（会记入支持条件）</button>
          </>
        : <div className="reading"><b>{task.material.title}</b>{(task.material.body ?? '').split('\n').map((line, i) => <p key={i}>{line}</p>)}</div>}
      <p className="source">来源：{task.source.pack} PDF {task.source.pdfPage} 页。提交前不显示答案。</p>
      {questions.map((q) => (
        <fieldset key={q.id}>
          <legend className="qtitle">{q.prompt}</legend>
          <div className="choices">
            {q.options.map((o, i) => (
              <label key={i}>
                <input type="radio" name={q.id} checked={answers[q.id] === i} onChange={() => setAnswers({ ...answers, [q.id]: i })} />
                {String.fromCharCode(65 + i)}. {o}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={!answered || busy} onClick={() => submit({ answers })}>提交本组</button>
      {!answered && <p className="source">答完两题才能提交；不确定也可以选——复盘时会问你为什么。</p>}
    </>
  }

  if (task.kind === 'open_writing') {
    return <>
      <h2>Write an email.</h2>
      <details open={!draft}>
        <summary>查看原任务</summary>
        <img className="sourceimg" src={MEDIA(task.material.mediaId!)} alt="原题影印" />
      </details>
      <p className="muted">{task.material.prompt}</p>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="第一稿写在这里。先不求好，求把问题与请求说清楚。" />
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button className="primary" disabled={!draft.trim() || busy} onClick={() => submit({ draft })}>保存并提交第一稿</button>
        <button
          disabled={busy}
          onClick={async () => { setBusy(true); try { await ensureAttempt(); await api(`/api/toefl/accounts/${accountId}/attempts`, { idempotencyKey: idemKey, taskId, draft }, 'POST'); onSubmitted() } catch (e) { setErr(String((e as Error).message)) } finally { setBusy(false) } }}
        >只保存草稿</button>
      </div>
      <p className="source">第一稿、你的修改、AI 建议会分开保存；AI 不代写。字数不是分数。</p>
    </>
  }

  // open_speaking
  return <>
    <h2>Take an interview.</h2>
    <MediaPlayer mediaId={task.material.mediaId!} part={st.chapter.part} accountId={accountId} startAt={0} />
    <details><summary>查看采访题目</summary>
      <img className="sourceimg" src={MEDIA(task?.material.imageMediaId!)} alt="采访原题影印" />
    </details>
    <p className="muted">{task?.material.prompt}</p>
    <div className="row">
      {!recording
        ? <button onClick={startRec}>开始录音</button>
        : <button className="primary" onClick={stopRec}>停止录音</button>}
      {recUrl && <audio controls src={recUrl} />}
    </div>
    <label htmlFor="toeflTranscript">你的文字稿（系统暂无自动转写；凭记忆把刚才的回答写下来，老师按它分析）</label>
    <textarea id="toeflTranscript" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="例如：I would prefer to study in the morning, because..." />
    {err && <div className="error">{err}</div>}
    <button className="primary" disabled={busy || (!recUrl && !transcript.trim())} onClick={() => submit({ transcript, transcriptOrigin: 'user_typed' })}>提交本次回应</button>
    <p className="source">{task?.material.honestyNote}</p>
  </>
}

function ReviewTab({ st, accountId, onDone }: {
  st: ChapterState; accountId: string; onDone: () => void
}) {
  const attempt = st.latestAttempt
  const [fb, setFb] = useState<{ feedbackId: string; version: number; output: TeacherOutput } | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [fbErr, setFbErr] = useState('')
  const [note, setNote] = useState('')
  const [noteSaved, setNoteSaved] = useState('')
  const [audioUrl, setAudioUrl] = useState('')
  const [speaking, setSpeaking] = useState('')

  useEffect(() => {
    const taskId = st.chapter.practiceTaskId
    const f = st.feedbacks[taskId]
    if (f?.status === 'done' && f.output) setFb({ feedbackId: f.feedbackId, version: f.version, output: f.output })
  }, [st])

  if (!attempt || !attempt.submittedAt) {
    return <div className="blank">
      <h2>还没有你的作答。</h2>
      <p>先做一组，老师才有依据复盘。不会提前用一段通用答案评价你。</p>
    </div>
  }

  const askTeacher = async () => {
    setAnalyzing(true); setFbErr('')
    try {
      const r = await api<{ feedback: { feedbackId: string; version: number; status: string; output: TeacherOutput | null } }>(
        `/api/toefl/accounts/${accountId}/attempts/${attempt.attemptId}/feedback`, { note: note || undefined }, 'POST')
      if (r.feedback.output) setFb({ feedbackId: r.feedback.feedbackId, version: r.feedback.version, output: r.feedback.output })
      else setFbErr('分析没有完成，稍后可以重试；你的作答已保留。')
    } catch (e) { setFbErr(String((e as Error).message)) } finally { setAnalyzing(false) }
  }
  const speak = async () => {
    if (!fb) return
    setSpeaking('正在合成语音…')
    try {
      const r = await api<{ audioUrl: string }>(`/api/toefl/accounts/${accountId}/feedback/${fb.feedbackId}/tts`, {}, 'POST')
      setAudioUrl(r.audioUrl + '?v=' + fb.version)
      setSpeaking('')
    } catch (e) { setSpeaking('语音没合成出来：' + humanize(String((e as Error).message)) + '。文字反馈仍然可用。') }
  }
  const recordDoubt = async () => {
    await api(`/api/toefl/accounts/${accountId}/errors`, {
      kind: 'self_noted', part: st.chapter.part, chapterId: st.chapter.chapterId, taskId: st.chapter.practiceTaskId,
      title: note.slice(0, 80) || '复盘中的疑问', detail: note, tag: '待归类',
    }, 'POST')
    setNoteSaved('疑问已记录，等老师下一次分析')
  }

  const results = st.results
  return <>
    <h2>先看作答与依据，再讨论原因。</h2>
    {results?.kind === 'closed'
      ? results.results!.map((r) => (
        <article className={`result ${r.correct ? '' : 'wrong'}`} key={r.questionId}>
          <b>{r.prompt}</b>
          <p>你的选择：{r.chosenText ? `${String.fromCharCode(65 + r.chosen!)} · ${r.chosenText}` : '未作答'}<br />
            原文支持：{String.fromCharCode(65 + r.key)} · {r.keyText}</p>
          <p>“{r.quote}”</p>
          <p>{r.why}</p>
          <span className="source">{r.correct ? '本题选对；是否犹豫可另记。' : `观察线索：${r.tag}，原因需与你一起确认。`}</span>
        </article>
      ))
      : <div className="result">
          <h3>你的第一稿 / 回应已保留</h3>
          {attempt.draft && <blockquote>{attempt.draft}</blockquote>}
          {attempt.transcript && <blockquote>{attempt.transcript}<br /><span className="source">文字稿来源：{attempt.transcriptOrigin === 'asr' ? '自动转写' : '本人补录'}</span></blockquote>}
          <p className="source">{results?.note}</p>
        </div>}

    <section className="teacher">
      <div className="row">
        <h3>专属老师 / 本章上下文</h3>
        {fb && <button className="secondary" onClick={speak}>朗读当前文字</button>}
        {audioUrl && <audio controls src={audioUrl} />}
      </div>
      {analyzing && <p className="muted">老师正在对照你的作答与原材料分析…（失败会保留作答，可重试）</p>}
      {fb
        ? <div className="reviewText">
            <p><b>老师看到：</b>{esc(fb.output.observation)}</p>
            {fb.output.evidence?.map((e, i) => <p key={i}>· {esc(e)}</p>)}
            {fb.output.hypothesis && <p><b>可能的原因（假设，由你确认）：</b>{esc(fb.output.hypothesis)}{fb.output.confidence ? `（把握：${fb.output.confidence === 'high' ? '较有把握' : fb.output.confidence === 'medium' ? '中等' : '初步线索'}）` : ''}</p>}
            {fb.output.one_fix && <p><b>先修这一处：</b>{esc(fb.output.one_fix)}</p>}
            {fb.output.followup && <p><b>下一步：</b>{esc(fb.output.followup)}</p>}
            <p className="source">反馈版本 v{fb.version} · 绑定本次作答与题目版本；辅助意见，不含分数。口语反馈不评价发音（系统暂无声学分析）。</p>
          </div>
        : <p className="source">还没有针对这次作答的老师分析。以下疑问会随请求一起发给老师。</p>}
      {fbErr && <div className="error">{fbErr}</div>}
      {speaking && <p className="noteSaved">{speaking}</p>}
      <label htmlFor="toeflAsk">我卡在哪里 / 对分析有什么异议？</label>
      <textarea id="toeflAsk" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：不是没理解日期，是听到 tomorrow 时没反应过来。" />
      <div className="row">
        <button className="primary" disabled={analyzing} onClick={askTeacher}>{fb ? '再请老师分析一次' : '请老师分析'}</button>
        <button onClick={recordDoubt}>把疑问记进错题本</button>
      </div>
      {noteSaved && <p className="noteSaved">{noteSaved}</p>}
    </section>

    <div className="section row">
      <button className="primary" onClick={onDone}>我已复盘，记录本章完成</button>
      <p className="source">完成复盘是本人学习活动确认，仍需不同新题检查；当前还没有已核验的未见题池，本条保持「待新题检验」。</p>
    </div>
  </>
}

function CoursePage({ part, accountId, onBack }: { part: Part; accountId: string; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>(() => 'learn')
  const [st, setSt] = useState<ChapterState | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(async () => {
    try {
      setErr('')
      const cat = await api<{ chapters: Chapter[] }>('/api/toefl/catalog')
      const chapter = cat.chapters.find((c) => c.part === part && c.publicationStatus === 'published')
      if (!chapter) { setErr('这一科还没有已发布章节'); return }
      const s = await api<ChapterState>(`/api/toefl/accounts/${accountId}/chapter/${chapter.chapterId}`)
      setSt(s)
      await api(`/api/toefl/accounts/${accountId}/resume`, {
        part, chapterId: chapter.chapterId, activity: tab, source: 'course_open',
      }, 'POST')
    } catch (e) { setErr(String((e as Error).message)) }
  }, [part, accountId, tab])
  useEffect(() => { void load() }, [load])

  if (err) return <div className="blank"><p>{err}</p><button onClick={onBack}>回首页</button></div>
  if (!st) return <p className="muted">正在读取本章…</p>
  const ch = st.chapter
  const doneCount = Object.values(st.activities).filter((v) => v.done).length
  return <>
    <div className="eyebrow">第 1 章 / {ch.partName}入门方法与原题应用</div>
    <h1>{ch.title}</h1>
    <p className="muted">{ch.goal}</p>
    <div className="status">
      {(['method', 'practice', 'review'] as const).map((k) => (
        <strong key={k} style={{ color: st.activities[k].done ? 'var(--action)' : 'var(--muted)' }}>
          {STAGES[k]}{st.activities[k].done ? ' ✓' : ''}
        </strong>
      ))}
      <span>{doneCount} / {ch.requiredActivities.length} 活动</span>
      <span className="source">{ch.position}</span>
    </div>
    <div className="tabs">
      {(['learn', 'practice', 'review'] as Tab[]).map((t) => (
        <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
          {t === 'learn' ? '学习' : t === 'practice' ? '配套真题' : '复盘'}
          <small>{t === 'learn' ? '视频或讲义' : t === 'practice' ? '原题 · 先做' : '作答对照与老师'}</small>
        </button>
      ))}
    </div>
    <div className="stageContent">
      <div hidden={tab !== 'learn'}>
        <LearnTab st={st} part={part} accountId={accountId}
          onGoPractice={() => setTab('practice')}
          onComplete={async () => { await api(`/api/toefl/accounts/${accountId}/events`, { kind: 'method_done', chapterId: ch.chapterId, path: 'self_confirm' }, 'POST'); setTab('practice'); void load() }} />
      </div>
      <div hidden={tab !== 'practice'}>
        <PracticeTab st={st} accountId={accountId} onSubmitted={() => { setTab('review'); void load() }} />
      </div>
      <div hidden={tab !== 'review'}>
        <ReviewTab st={st} accountId={accountId} onDone={async () => { await api(`/api/toefl/accounts/${accountId}/events`, { kind: 'review_done', chapterId: ch.chapterId }, 'POST'); void load() }} />
      </div>
    </div>
  </>
}

// ---------- 页面：档案 / 错题本 / 薄弱环节 / 资料库 / 测试 ----------

function ProfilePage({ accountId, data, onSaved }: { accountId: string; data: Dashboard; onSaved: () => void }) {
  const f = data.profile.fields
  const [target, setTarget] = useState(f.target?.value ?? '')
  const [date, setDate] = useState(f.exam_date?.value ?? '')
  const [focus, setFocus] = useState(f.focus?.value ?? '')
  const [saved, setSaved] = useState('')
  const save = async () => {
    const now = Date.now()
    const fields: ProfileFields = { ...f }
    if (target) fields.target = { value: target, source: 'self', at: now }; else delete fields.target
    if (date) fields.exam_date = { value: date, source: 'self', at: now }; else delete fields.exam_date
    if (focus) fields.focus = { value: focus, source: 'self', at: now }; else delete fields.focus
    await api(`/api/toefl/accounts/${accountId}/profile`, { fields }, 'PUT')
    setSaved('已保存 · ' + new Date(now).toLocaleString('zh-CN'))
    onSaved()
  }
  return <>
    <div className="eyebrow">个人信息与学习约定</div>
    <h1>老师需要了解的，不只有错题。</h1>
    <p className="muted">你的基础、目标和学习习惯是教学背景；具体能力仍要通过作答验证。</p>
    <section className="section">
      <h2>已知背景 / 来自你的自述</h2>
      <p>英语四级；词汇约8,000–10,000；每天约3–4小时学习。考试至少还有一年，准确日期未定。</p>
      <p>听懂熟悉词的速度、复杂句关系和独立表达是你希望改善的方向。愿意写作、录音和对话；先做小题组再复盘，先理解原理，再解释特殊情况。</p>
      <p>已有词汇、跟读、听力与阅读练习习惯；不希望已掌握的内容反复刷。艺术与科技方向留学是长期应用背景。</p>
      <p className="source">以上记录不是AI评分；逐条可改可删，带来源与记录时间。</p>
    </section>
    <section className="section profileForm">
      <h2>补充当前计划</h2>
      <label htmlFor="targetScore">目标分数（也可暂时留空）</label>
      <input id="targetScore" type="text" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="总分和单科要求，分制待确认" />
      <label htmlFor="examDate">预计考试日期</label>
      <input id="examDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <label htmlFor="personalFocus">目前最希望老师帮助的事情</label>
      <textarea id="personalFocus" value={focus} onChange={(e) => setFocus(e.target.value)} />
      <div className="row">
        <button className="primary" onClick={save}>保存计划</button>
        <span className="noteSaved">{saved}</span>
      </div>
    </section>
  </>
}

const STATUS_LABEL: Record<string, string> = {
  pending_review: '待复盘', reviewed: '已复盘', awaiting_new_check: '待新题验证',
  verified: '新题验证通过', disputed: '有争议', analyze_failed: '分析失败可重试', dismissed: '已打勾 · 不再训练',
}

function ErrorsPage({ accountId, onChanged }: { accountId: string; onChanged: () => void }) {
  const [errors, setErrors] = useState<ErrorEntry[] | null>(null)
  const [filter, setFilter] = useState<'active' | 'dismissed' | 'all'>('active')
  const [training, setTraining] = useState<{ errorId: string; kind: string; prompt: string; options: string[] | null; groupTitle: string | null; streak: number } | null>(null)
  const [trainValue, setTrainValue] = useState<string>('')
  const [trainMsg, setTrainMsg] = useState('')
  const load = useCallback(async () => {
    setErrors((await api<{ errors: ErrorEntry[] }>(`/api/toefl/accounts/${accountId}/errors`)).errors)
  }, [accountId])
  useEffect(() => { void load() }, [load])
  const setStatus = async (errorId: string, status: string) => {
    try {
      await api(`/api/toefl/accounts/${accountId}/errors/${errorId}/status`, { status }, 'POST')
      await load(); onChanged()
    } catch (e) { alert(String((e as Error).message).replace(/^[A-Z_]+:\s*/, '')) }
  }
  const startTraining = async (errorId: string) => {
    setTrainMsg(''); setTrainValue('')
    try {
      const q = await api<any>(`/api/toefl/accounts/${accountId}/errors/${errorId}/retry`)
      setTraining({ errorId, kind: q.kind, prompt: q.prompt, options: q.options, groupTitle: q.groupTitle, streak: q.streak })
    } catch (e) { setTrainMsg(String((e as Error).message).replace(/^[A-Z_]+:\s*/, '')) }
  }
  const submitAnswer = async () => {
    if (!training) return
    try {
      const value = training.kind === 'mc' ? Number(trainValue) : trainValue
      const r = await api<any>(`/api/toefl/accounts/${accountId}/errors/${training.errorId}/answer`, { value }, 'POST')
      setTrainMsg(r.correct
        ? `✓ 答对了！${r.streak >= 1 ? `这条已连对 ${r.streak} 次。` : ''}${r.explain ? ` ${r.explain}` : ''}`
        : `✗ 还没对。正确答案：${r.keyText}。${r.explain ?? ''} 这道题继续留在训练队列。`)
      if (r.correct) setTraining({ ...training, streak: r.streak })
      await load(); onChanged()
    } catch (e) { setTrainMsg(String((e as Error).message).replace(/^[A-Z_]+:\s*/, '')) }
  }
  const dismiss = async (errorId: string) => {
    await api(`/api/toefl/accounts/${accountId}/errors/${errorId}/dismiss`, {}, 'POST').catch(() => {})
    await load(); onChanged()
  }
  const restore = async (errorId: string) => {
    await api(`/api/toefl/accounts/${accountId}/errors/${errorId}/restore`, {}, 'POST').catch(() => {})
    await load(); onChanged()
  }
  if (!errors) return <p className="muted">正在读取…</p>
  const shown = errors.filter((e) => filter === 'all' ? true : filter === 'dismissed' ? e.status === 'dismissed' : e.status !== 'dismissed')
  const activeCount = errors.filter((e) => e.status !== 'dismissed' && e.status !== 'verified').length
  return <>
    <div className="eyebrow">跨课程记录 · 课程与模考共用</div>
    <h1>错题本</h1>
    <p className="muted">保留首次错误和当时的疑问；重做到连对为止，或自己打勾标记不再训练（历史保留，随时恢复）。</p>
    <div className="statline">
      <div><strong>{activeCount}</strong><span>训练中</span></div>
      <div><strong>{errors.filter((e) => e.status === 'dismissed').length}</strong><span>已打勾结业</span></div>
      <div><strong>{errors.length}</strong><span>全部记录</span></div>
    </div>
    <div className="row" style={{ marginBottom: 8 }}>
      {([['active', '训练中'], ['dismissed', '已打勾'], ['all', '全部']] as const).map(([k, label]) => (
        <button key={k} className={filter === k ? '' : 'secondary'} onClick={() => setFilter(k)}>{label}</button>
      ))}
    </div>
    {training && <div className="panel" style={{ borderColor: 'var(--action)' }}>
      <b>重训这道题</b>
      {training.groupTitle && <p className="source">{esc(training.groupTitle)}</p>}
      <p>{esc(training.prompt)}</p>
      {training.kind === 'mc'
        ? <div className="choices">
            {(training.options ?? []).map((o, i) => (
              <label key={i}>
                <input type="radio" name="retrain" checked={trainValue === String(i)} onChange={() => setTrainValue(String(i))} />
                {String.fromCharCode(65 + i)}. {o}
              </label>
            ))}
          </div>
        : <input type="text" value={trainValue} onChange={(e) => setTrainValue(e.target.value)} placeholder="填缺失字母" style={{ width: '100%', padding: 10, border: '1px solid var(--control)', borderRadius: 6 }} />}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={trainValue === ''} onClick={submitAnswer}>提交答案</button>
        <button className="secondary" onClick={() => { setTraining(null); setTrainMsg('') }}>收起</button>
        {training.streak > 0 && <span className="noteSaved">已连对 {training.streak} 次</span>}
      </div>
      {trainMsg && <p className="noteSaved">{trainMsg}</p>}
    </div>}
    {shown.length
      ? shown.map((e) => (
        <article className="records" key={e.errorId}>
          <span className="tag">{e.partName} / {esc(e.tag) || '待归类'}</span>
          <h3>{e.title}</h3>
          <p>{e.detail}</p>
          <span className="source">状态：{STATUS_LABEL[e.status] ?? e.status}{e.retries > 0 ? ` · 重做错 ${e.retries} 次` : ''}{(e as any).answer_streak > 0 ? ` · 连对 ${(e as any).answer_streak} 次` : ''}</span>
          <div className="row">
            {e.status === 'dismissed'
              ? <button onClick={() => restore(e.errorId)}>恢复训练</button>
              : <>
                  {!['verified'].includes(e.status) && <button onClick={() => startTraining(e.errorId)}>重做这道题</button>}
                  {e.status === 'pending_review' && <button className="secondary" onClick={() => setStatus(e.errorId, 'reviewed')}>标记：已复盘</button>}
                  {e.status === 'reviewed' && <button className="secondary" onClick={() => setStatus(e.errorId, 'awaiting_new_check')}>标记：等新题验证</button>}
                  <button className="secondary" onClick={() => dismiss(e.errorId)}>✓ 打勾 · 不再训练</button>
                </>}
          </div>
        </article>
      ))
      : <div className="blank">这个视图下没有记录。做错题、猜对或卡住的题都会进到这里。</div>}
  </>
}

function WeakPage({ data }: { data: Dashboard }) {
  return <>
    <div className="eyebrow">根据实际记录逐步分析</div>
    <h1>我的薄弱环节</h1>
    <p className="muted">错误是观察，原因是需要你确认的假设。少量题不能给出完整能力画像。</p>
    {data.errors.recent.length
      ? <div className="records">
          <h3>待你复盘确认</h3>
          <p>{data.errors.total} 条记录 · 每一条都可以回到原章复盘，标注是词义、声音、关系还是时间问题。</p>
          <span className="source">同题重做不增加独立证据；分类线索尚待新题验证。</span>
        </div>
      : <div className="blank">现在没有足够观察，不展示虚构弱项或掌握雷达图。</div>}
  </>
}

function ResourcesPage({ catalog }: { catalog: { resources: { videoCatalog: { videos?: { file: string }[] } | null; handoutManifest: { handouts?: { file?: string; pages?: number }[] } | null } } }) {
  const videos = catalog.resources.videoCatalog?.videos ?? []
  const handouts = catalog.resources.handoutManifest?.handouts ?? []
  return <>
    <div className="eyebrow">原教师目录与教材库存</div>
    <h1>所有资料都有位置。</h1>
    <p>当前快照：{videos.length} 段视频、{handouts.length} 份核心讲义。教学章节映射尚未全部审校；已接入样板章的只有本章绑定媒体。</p>
    <h2>原始视频目录</h2>
    <div className="catalog">
      {videos.map((v, i) => <p key={i}>{esc(v.file)}<br /><span className="source">文件存在；尚未播放/映射验收</span></p>)}
    </div>
    <p className="source">词汇、听口基础、阅写基础作为四科共用补课。真题库存与来源见 PRD，不把文件数称作题目数。</p>
  </>
}

function TestPage({ accountId }: { accountId: string }) {
  const [examId, setExamId] = useState<string | null>(null)
  if (examId) return <ExamRunner accountId={accountId} examId={examId} onExit={() => setExamId(null)} />
  return <ExamLibrary onOpen={setExamId} />
}

interface CatalogFull {
  parts: Record<Part, { name: string; modules: { id: string; name: string; status: string }[] }>
  resources: { videoCatalog: { videos?: { file: string }[] } | null; handoutManifest: { handouts?: { file?: string; pages?: number }[] } | null }
}

// ---------- 根组件 ----------

export function ToeflApp({ accountId, onExit }: { accountId: string; onExit: () => void }) {
  const [view, setView] = useState<View>('dashboard')
  const [part, setPart] = useState<Part>('listening')
  const [data, setData] = useState<Dashboard | null>(null)
  const [catalog, setCatalog] = useState<CatalogFull | null>(null)
  const [err, setErr] = useState('')
  const loadDashboard = useCallback(async () => {
    try {
      setData(await api<Dashboard>(`/api/toefl/accounts/${accountId}/dashboard`))
      setErr('')
    } catch (e) { setErr(String((e as Error).message)) }
  }, [accountId])
  useEffect(() => { void loadDashboard() }, [loadDashboard])
  useEffect(() => {
    void api<CatalogFull>('/api/toefl/catalog')
      .then(setCatalog).catch(() => {})
  }, [])

  const openCourse = (p: Part) => { setPart(p); setView('course'); setDrawer(false); window.scrollTo(0, 0) }
  const goto = (v: View) => { setView(v); setDrawer(false); window.scrollTo(0, 0) }
  const [drawer, setDrawer] = useState(false)
  const [dirOpen, setDirOpen] = useState(false)
  useEffect(() => {
    if (!drawer && !dirOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDrawer(false); setDirOpen(false) } }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [drawer, dirOpen])
  const crumb = view === 'course'
    ? `四科课程 / ${({ listening: '听力', reading: '阅读', writing: '写作', speaking: '口语' } as const)[part]} / 第 1 章`
    : ({ dashboard: '首页 / 学习总览', profile: '我的学习 / 个人档案', test: '独立真题测试', errors: '错题本', weak: '薄弱环节', resources: '资料库' } as const)[view]
  const partNames: { id: Part; name: string }[] = [
    { id: 'listening', name: '听力' }, { id: 'reading', name: '阅读' }, { id: 'writing', name: '写作' }, { id: 'speaking', name: '口语' },
  ]

  return (
    <div className="toefl-app">
      <div className={`app ${view !== 'course' ? 'overview' : ''}${drawer ? ' showMenu' : ''}${dirOpen ? ' showDirectory' : ''}`}>
        <nav className="side" aria-label="托福导航">
          <button className="drawerClose" onClick={() => setDrawer(false)}>关闭菜单</button>
          <div className="logo">Forge</div>
          {partNames.map((p) => (
            <button key={p.id} className={view === 'course' && part === p.id ? 'active' : ''} onClick={() => openCourse(p.id)}>
              {p.name}课程
            </button>
          ))}
          <div className="caption">跨课程</div>
          {([['dashboard', '首页总览'], ['test', '独立真题测试'], ['errors', '错题本'], ['weak', '薄弱环节'], ['profile', '个人学习档案'], ['resources', '资料库']] as [View, string][]).map(([v, label]) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => goto(v)}>{label}</button>
          ))}
          <small>
            账户：{accountId.slice(0, 8)}…<br />
            <button className="secondary" onClick={onExit}>返回旧版学习应用</button>
          </small>
        </nav>
        {view === 'course' && (() => {
          const mods = catalog?.parts?.[part]?.modules ?? []
          const prog = data?.progress.parts.find((p) => p.part === part)
          const done = prog ? `${prog.done} / ${prog.total} 活动` : '…'
          return (
            <nav className="directory" aria-label="科目目录">
              <button className="drawerClose" onClick={() => setDirOpen(false)}>关闭目录</button>
              <div className="dirhead"><h2>{partNames.find((p) => p.id === part)?.name}课程</h2><p className="muted">当前开放第 1 章</p></div>
              {mods.map((m, i) => (
                <button key={m.id} className={'item' + (i === 0 ? ' active' : '')}>
                  <b>{String(i + 1).padStart(2, '0')}　{m.name}</b>
                  <span>{i === 0 ? `第 1 章 · ${done}` : '规划中'}</span>
                </button>
              ))}
              <div className="footer">老师原课程视频与讲义已登记在资料库；<br />逐章映射按扩建流程验收后发布。</div>
            </nav>
          )
        })()}
        <div className="content">
          <div className="top">
            <button className="menu" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>菜单</button>
            {view === 'course' && <button className="menu" aria-expanded={dirOpen} onClick={() => setDirOpen(!dirOpen)}>目录</button>}
            <span className="crumb">{crumb}</span>
            {view !== 'dashboard' && <button data-act="continue" onClick={() => { setView('dashboard'); window.scrollTo(0, 0) }}>回首页</button>}
          </div>
          <div className="body">
            {err && <div className="error">{err}（数据库不可用时托福层无法记录进度）</div>}
            {view === 'dashboard' && (data
              ? <DashboardPage
                  data={data}
                  onOpenCourse={openCourse}
                  onOpenProfile={() => setView('profile')}
                  onOpenErrors={() => setView('errors')}
                  onOpenWeak={() => setView('weak')}
                />
              : <p className="muted">正在读取学习总览…</p>)}
            {view === 'course' && <CoursePage part={part} accountId={accountId} onBack={() => setView('dashboard')} />}
            {view === 'profile' && data && <ProfilePage accountId={accountId} data={data} onSaved={loadDashboard} />}
            {view === 'errors' && <ErrorsPage accountId={accountId} onChanged={loadDashboard} />}
            {view === 'weak' && data && <WeakPage data={data} />}
            {view === 'resources' && catalog && <ResourcesPage catalog={catalog} />}
            {view === 'test' && <TestPage accountId={accountId} />}
          </div>
        </div>
      </div>
      {drawer && <div className="drawerShade" onClick={() => setDrawer(false)} />}
      {dirOpen && <div className="drawerShade" onClick={() => setDirOpen(false)} />}
    </div>
  )
}
