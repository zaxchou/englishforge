// 成套真题模考（用户指令 2）：四部分流程、分 part 交卷即评分、AI 错题讲解。
// 诚实边界：填空/选择题按官方 Answer Key 判；写作/口语是 AI 辅助意见不是 ETS 分数；
// 听力首听不看转写，交卷后随结果回带；Build a Sentence 用键入句子代替纸面拖拽（适配说明写在题面）。
import { useCallback, useEffect, useRef, useState } from 'react'

const SECTIONS = ['reading', 'listening', 'speaking', 'writing']
const SECTION_LABEL: Record<string, string> = { reading: '阅读', listening: '听力', speaking: '口语', writing: '写作' }
const esc = (s: unknown) => String(s ?? '')

interface ExamMeta { examId: string; title: string; order: string[]; status: string; honestyNote: string; digitization: string }
interface ExamQ { n: number; prompt: string; options: string[] | null }
interface ExamGroup { type: string; title: string; instruction: string | null; passage: string | null; audioMediaId: string | null; audioNote: string | null; questions: ExamQ[] }
interface ExamSection { label: string; modules?: { moduleId: string; title: string; groups: ExamGroup[] }[]; tasks?: any[] }
interface ExamPayload {
  meta: ExamMeta
  sections: Record<string, ExamSection | null>
  run: Record<string, { attemptId: string; status: string; submittedAt: number | null; answers: any; draft: string | null; transcript: string | null }>
}
interface SectionResult {
  attemptId: string; replayed?: boolean
  score?: { correct: number; total: number }
  results?: { qKey: string; n: number; prompt: string; givenText: string; keyText: string; options: string[] | null; correct: boolean; explain: string | null; groupTitle: string | null }[]
  debrief?: string; wrongCount?: number; transcripts?: Record<string, string>
  feedbacks?: { taskType: string; output: any; error?: string }[]
  note?: string; repeatTips?: { n: number; text: string; tip: string }[]
}

async function api<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(String(json.error ?? `请求失败（${res.status}）`).replace(/^[A-Z_]+:\s*/, ''))
  return json as T
}
const MEDIA = (id: string) => `/api/toefl/media/${encodeURIComponent(id)}`
const draftKey = (examId: string, section: string) => `toefl-exam-draft-${examId}-${section}`

function loadDraft(examId: string, section: string): any {
  try { return JSON.parse(localStorage.getItem(draftKey(examId, section)) || 'null') } catch { return null }
}
function saveDraft(examId: string, section: string, data: any) {
  try { localStorage.setItem(draftKey(examId, section), JSON.stringify(data)) } catch { /* 存不下就不存 */ }
}

// ---------- 套卷列表 ----------

export function ExamLibrary({ onOpen }: { onOpen: (examId: string) => void }) {
  const [exams, setExams] = useState<ExamMeta[] | null>(null)
  const [library, setLibrary] = useState<any>(null)
  useEffect(() => {
    void api<{ exams: ExamMeta[] }>('/api/toefl/exam/available').then((r) => setExams(r.exams)).catch(() => setExams([]))
    void api<any>('/api/toefl/exam/library').then(setLibrary).catch(() => {})
  }, [])
  return <>
    <div className="eyebrow">独立真题测试 · 成套模考</div>
    <h1>像真的考试一样，做一整套。</h1>
    <p className="muted">四个 part 分开交卷：每交一部分马上出分，选择题按官方答案判、AI 讲解错题，写作口语给辅助反馈。错题自动进错题本。</p>
    {(exams ?? []).map((e) => (
      <article className="records" key={e.examId}>
        <span className="tag">已录入 · 可开考</span>
        <h3>{e.title}</h3>
        <p className="muted">顺序：{e.order.map((s) => SECTION_LABEL[s as string] ?? s).join(' → ')}</p>
        <p className="source">{e.honestyNote}</p>
        <button className="primary" onClick={() => onOpen(e.examId)}>开始这套模考</button>
      </article>
    ))}
    {exams && !exams.length && <div className="blank">还没有已录入的套卷——录入需要逐页校对题面与官方答案。</div>}
    {library && <section className="section">
      <h2>真题库快照（已扫描整理）</h2>
      <p className="muted">共 {library.packs?.length ?? 0} 个套卷组、{library.totalFiles} 个文件。以下为文件级清单（文件数 ≠ 题数）；逐套录入按流水线推进，录入一套开放一套。</p>
      <div className="catalog">
        {(library.packs ?? []).map((p: any) => (
          <p key={p.groupId}>{esc(p.groupId)}<br />
            <span className="source">{p.pdfCount} PDF · {p.audioCount} 音频 · {p.status === 'registered_not_digitized' ? '待录入' : '已录入'}</span>
          </p>
        ))}
      </div>
    </section>}
  </>
}

// ---------- 考试进行中 ----------

function ClozeGroup({ group, modulePrefix, answers, setAnswers }: { group: ExamGroup; modulePrefix: string; answers: any; setAnswers: (k: string, v: string) => void }) {
  return <section className="section">
    <h3>{group.title}</h3>
    <p className="muted">{group.instruction}</p>
    <div className="reading">{esc(group.passage)}</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, marginTop: 12 }}>
      {group.questions.map((q) => (
        <label key={q.n} style={{ display: 'flex', gap: 6, alignItems: 'center', border: '1px solid var(--control)', borderRadius: 6, padding: '6px 10px' }}>
          <span>第 {q.n} 空</span>
          <input type="text" value={answers[`${modulePrefix}-c-${q.n}`] ?? ''}
            onChange={(e) => setAnswers(`${modulePrefix}-c-${q.n}`, e.target.value)}
            placeholder="缺失字母" style={{ flex: 1, minWidth: 0, padding: '4px 8px' }} />
        </label>
      ))}
    </div>
  </section>
}
function McGroup({ gKey, group, answers, setAnswers }: { gKey: string; group: ExamGroup; answers: any; setAnswers: (k: string, v: number) => void }) {
  return <section className="section">
    <h3>{group.title}</h3>
    {group.passage && <div className="reading">{esc(group.passage).split('\n').map((line, i) => <p key={i}>{line}</p>)}</div>}
    {group.audioMediaId && <>
      <audio controls preload="metadata" src={MEDIA(group.audioMediaId)} />
      <p className="source">{group.audioNote ?? '先听音频再作答；转写在交卷后提供。'}</p>
    </>}
    {group.questions.map((q) => (
      <fieldset key={q.n}>
        <legend className="qtitle">{q.n}. {q.prompt}</legend>
        <div className="choices">
          {(q.options ?? []).map((o, i) => (
            <label key={i}>
              <input type="radio" name={`${gKey}-${q.n}`} checked={answers[`${gKey}-q-${q.n}`] === i} onChange={() => setAnswers(`${gKey}-q-${q.n}`, i)} />
              {String.fromCharCode(65 + i)}. {o}
            </label>
          ))}
        </div>
      </fieldset>
    ))}
  </section>
}

function SectionForm({ section, data, answers, setAnswers, drafts, setDrafts, transcripts, setTranscripts }: {
  section: string; data: ExamSection
  answers: Record<string, any>; setAnswers: (k: string, v: any) => void
  drafts: Record<string, string>; setDrafts: (k: string, v: string) => void
  transcripts: Record<string, string>; setTranscripts: (k: string, v: string) => void
}) {
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const [recording, setRecording] = useState('')
  const [recErr, setRecErr] = useState('')

  const startRec = async (key: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => chunksRef.current.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        // 考试录音随交卷一起走：先本地暂存（base64 太大不落 localStorage，只保留回放 URL）
        setAnswers(`__audio_${key}`, URL.createObjectURL(blob))
        setRecording('')
      }
      recRef.current = rec
      rec.start()
      setRecording(key)
    } catch { setRecErr('浏览器没有获得麦克风权限；口语题可以改用文字稿提交。') }
  }

  if (section === 'reading' || section === 'listening') {
    return <>
      {(data.modules ?? []).map((m) => (
        <div key={m.moduleId}>
          <h2>{m.title}</h2>
          {m.groups.map((g, gi) => g.type === 'cloze'
            ? <ClozeGroup key={gi} group={g} modulePrefix={m.moduleId} answers={answers} setAnswers={setAnswers} />
            : <McGroup key={gi} gKey={m.moduleId} group={g} answers={answers} setAnswers={setAnswers} />)}
        </div>
      ))}
    </>
  }
  if (section === 'speaking') {
    const repeat = (data.tasks ?? []).find((t) => t.type === 'listen_repeat')
    const interview = (data.tasks ?? []).find((t) => t.type === 'interview')
    return <>
      {repeat && <section className="section">
        <h3>{repeat.title}</h3>
        <p className="muted">{repeat.instruction}</p>
        <audio controls preload="metadata" src={MEDIA(repeat.audioMediaId)} />
        <p className="source">听完录音后逐句自评（对照下方转写要点），可把没跟上的句子号记进备注。</p>
        <ol>{(repeat.items ?? []).map((it: any) => <li key={it.n}>{esc(it.text)} <span className="source">{esc(it.tip)}</span></li>)}</ol>
        <label>跟读备注（哪几句没跟上）</label>
        <textarea value={drafts.repeat ?? ''} onChange={(e) => setDrafts('repeat', e.target.value)} style={{ minHeight: 70 }} />
      </section>}
      {interview && <section className="section">
        <h3>{interview.title}</h3>
        <p className="muted">{interview.instruction}</p>
        <audio controls preload="metadata" src={MEDIA(interview.audioMediaId)} />
        <p className="source">音频为完整 4 问连续播放。每问录一段回答，并在下方补录文字稿（老师讲评依据；系统无自动转写）。</p>
        {(interview.items ?? []).map((it: any) => (
          <div key={it.n} style={{ marginBottom: 14 }}>
            <b>问 {it.n}</b>
            <div className="row" style={{ margin: '6px 0' }}>
              {!recording || recording !== `interview-${it.n}`
                ? <button onClick={() => startRec(`interview-${it.n}`)} disabled={!!recording}>录回答 {it.n}</button>
                : <button className="primary" onClick={() => { recRef.current?.stop() }}>停止录音 {it.n}</button>}
              {answers[`__audio_interview-${it.n}`] && <audio controls src={answers[`__audio_interview-${it.n}`]} />}
            </div>
            <textarea placeholder="你的回答文字稿（可粗糙）" value={transcripts[`interview-${it.n}`] ?? ''}
              onChange={(e) => setTranscripts(`interview-${it.n}`, e.target.value)} style={{ minHeight: 60 }} />
          </div>
        ))}
        {recErr && <div className="error">{recErr}</div>}
      </section>}
    </>
  }
  // writing
  const bs = (data.tasks ?? []).find((t) => t.type === 'build_sentence')
  const email = (data.tasks ?? []).find((t) => t.type === 'email')
  const disc = (data.tasks ?? []).find((t) => t.type === 'academic_discussion')
  return <>
    {bs && <section className="section">
      <h3>{bs.title}</h3>
      <p className="muted">{bs.instruction}（纸面适配：这里用键入整句代替拖动词块——把词块排成一句，全部用上、不改词形。）</p>
      {(bs.items ?? []).map((it: any) => (
        <div key={it.n} style={{ marginBottom: 12 }}>
          <b>{it.n}. {esc(it.prompt)}</b>
          <p className="source">{it.prefix ? `开头：${it.prefix}　` : ''}{it.suffix && it.suffix !== '?' && it.suffix !== '.' ? `结尾：${it.suffix}` : ''}　词块：{it.chunks.join(' / ')}</p>
          <input type="text" value={answers[`bs-${it.n}`] ?? ''} onChange={(e) => setAnswers(`bs-${it.n}`, e.target.value)}
            placeholder="把词块排成完整句子" style={{ width: '100%', padding: 10, border: '1px solid var(--control)', borderRadius: 6 }} />
        </div>
      ))}
    </section>}
    {email && <section className="section">
      <h3>{email.title} <span className="tag">建议 {email.timeMinutes} 分钟</span></h3>
      <div className="reading">{esc(email.situation)}</div>
      <ul>{(email.requirements ?? []).map((r: string, i: number) => <li key={i}>{esc(r)}</li>)}</ul>
      <p className="source">To: {email.to}　Subject: {email.subject}</p>
      <textarea value={drafts.email ?? ''} onChange={(e) => setDrafts('email', e.target.value)} placeholder="Write your email..." />
    </section>}
    {disc && <section className="section">
      <h3>{disc.title} <span className="tag">建议 {disc.timeMinutes} 分钟 · 至少 {disc.minWords} 词</span></h3>
      <div className="reading">{esc(disc.professorPrompt)}</div>
      {(disc.classmates ?? []).map((c: any, i: number) => <div className="panel" key={i}><b>{esc(c.name)}</b><p>{esc(c.text)}</p></div>)}
      <textarea value={drafts.discussion ?? ''} onChange={(e) => setDrafts('discussion', e.target.value)} placeholder="Join the discussion..." />
    </section>}
  </>
}

function ResultsPanel({ r }: { r: SectionResult }) {
  if (!r) return null
  return <>
    {r.score && <div className="result">
      <b>本部分得分：{r.score.correct} / {r.score.total}</b>
      <p className="source">{r.wrongCount ? `${r.wrongCount} 道错题已自动进入错题本（可重训到全对）。` : '全对！'}</p>
    </div>}
    {r.debrief && <div className="result"><b>AI 老师讲评</b><p style={{ whiteSpace: 'pre-wrap' }}>{esc(r.debrief)}</p></div>}
    {(r.results ?? []).map((x) => (
      <article className={`result ${x.correct ? '' : 'wrong'}`} key={x.qKey}>
        <b>{x.n}. {esc(x.prompt)}</b>
        {x.groupTitle && <p className="source">{esc(x.groupTitle)}</p>}
        {x.options && <p className="source">{x.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('　')}</p>}
        <p>你的答案：{esc(x.givenText)}　正确答案：{esc(x.keyText)}</p>
        {x.explain && <p>{esc(x.explain)}</p>}
      </article>
    ))}
    {Object.entries(r.transcripts ?? {}).map(([title, t]) => (
      <details key={title}><summary>转写：{esc(title)}</summary><div className="reading">{esc(t).split('\n').map((l, i) => <p key={i}>{l}</p>)}</div></details>
    ))}
    {(r.feedbacks ?? []).map((f) => (
      <div className="result" key={f.taskType}>
        <b>AI 反馈 · {f.taskType === 'build_sentence' ? '组句' : f.taskType === 'email' ? '邮件' : f.taskType === 'academic_discussion' ? '学术讨论' : '口语'}</b>
        {f.error && <p className="source">这次反馈没生成出来：{esc(f.error)}。你的作答已保存。</p>}
        {typeof f.output === 'string' && <p style={{ whiteSpace: 'pre-wrap' }}>{esc(f.output)}</p>}
        {f.output && typeof f.output === 'object' && !Array.isArray(f.output) && <>
          {(f.output.items ?? []).map((it: any) => <p key={it.n}>{it.correct ? '✓' : '✗'} 第 {it.n} 题：{esc(it.note)}</p>)}
          {f.output.summary && <p><b>总体：</b>{esc(f.output.summary)}</p>}
          {!f.output.items && !f.output.summary && <p style={{ whiteSpace: 'pre-wrap' }}>{esc(JSON.stringify(f.output))}</p>}
        </>}
      </div>
    ))}
    {r.repeatTips && <div className="result"><b>跟读自检对照</b>
      <ol>{r.repeatTips.map((t) => <li key={t.n}>{esc(t.text)}<br /><span className="source">{esc(t.tip)}</span></li>)}</ol>
    </div>}
    {r.note && <p className="source">{esc(r.note)}</p>}
  </>
}

export function ExamRunner({ accountId, examId, onExit }: { accountId: string; examId: string; onExit: () => void }) {

  const [data, setData] = useState<ExamPayload | null>(null)
  const [section, setSection] = useState<string>('')
  const [answers, setAnswersState] = useState<Record<string, any>>({})
  const [drafts, setDraftsState] = useState<Record<string, string>>({})
  const [transcripts, setTranscriptsState] = useState<Record<string, string>>({})
  const [result, setResult] = useState<SectionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const order = data?.meta.order ?? SECTIONS
  // 部分切换写 hash（#/toefl/test/<examId>/<section>），刷新可回到当前部分
  useEffect(() => {
    if (section && data) window.history.replaceState(null, '', `#/toefl/test/${examId}/${section}`)
  }, [examId, section, data])

  useEffect(() => {
    void api<ExamPayload>(`/api/toefl/accounts/${accountId}/exam/${examId}`).then((d) => {
      setData(d)
      const first = (d.meta.order ?? SECTIONS).find((s) => !d.run[s]?.submittedAt) ?? 'reading'
      setSection(first)
    }).catch((e) => setErr(String((e as Error).message)))
  }, [accountId, examId])

  // 切部分：草稿从本地缓存恢复
  useEffect(() => {
    if (!section || !data) return
    const d = loadDraft(examId, section)
    setAnswersState(d?.answers ?? {})
    setDraftsState(d?.drafts ?? {})
    setTranscriptsState(d?.transcripts ?? {})
    setResult(null)
  }, [section, examId, data])

  const persist = useCallback((a: any, dr: any, tr: any) => {
    saveDraft(examId, section, { answers: a, drafts: dr, transcripts: tr })
  }, [examId, section])
  const setAnswers = (k: string, v: any) => setAnswersState((p) => { const n = { ...p, [k]: v }; persist(n, drafts, transcripts); return n })
  const setDrafts = (k: string, v: string) => setDraftsState((p) => { const n = { ...p, [k]: v }; persist(answers, n, transcripts); return n })
  const setTranscripts = (k: string, v: string) => setTranscriptsState((p) => { const n = { ...p, [k]: v }; persist(answers, drafts, n); return n })

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api<SectionResult>(`/api/toefl/accounts/${accountId}/exam/${examId}/${section}/submit`, {
        answers, drafts, transcripts,
        note: drafts.repeat ?? null,
      }, 'POST')
      setResult(r)
      // 清掉本地草稿（已交卷）
      try { localStorage.removeItem(draftKey(examId, section)) } catch { /* ignore */ }
      window.scrollTo({ top: 0 })
    } catch (e) { setErr(String((e as Error).message)) } finally { setBusy(false) }
  }

  if (err && !data) return <div className="blank"><p>{err}</p><button onClick={onExit}>回真题列表</button></div>
  if (!data) return <p className="muted">正在载入试卷…</p>
  const idx = order.indexOf(section)
  const done = !!data.run[section]?.submittedAt && !result
  const canSubmit = !result && !busy
  const allDone = order.every((s) => data.run[s]?.submittedAt || (s === section && result))

  return <>
    <div className="eyebrow">成套模考 · {esc(data.meta.title)}</div>
    <h1>{SECTION_LABEL[section]}部分</h1>
    <div className="status">
      {order.map((s, i) => (
        <strong key={s} style={{ color: (data.run[s]?.submittedAt || (s === section && result)) ? 'var(--action)' : s === section ? 'var(--ink)' : 'var(--muted)' }}>
          {i + 1}. {SECTION_LABEL[s]}{data.run[s]?.submittedAt || (s === section && result) ? ' ✓' : ''}
        </strong>
      ))}
    </div>
    {data.meta.honestyNote && <p className="source">{data.meta.honestyNote}</p>}
    {result
      ? <ResultsPanel r={result} />
      : <>
          <SectionForm section={section} data={data.sections[section]!}
            answers={answers} setAnswers={setAnswers} drafts={drafts} setDrafts={setDrafts}
            transcripts={transcripts} setTranscripts={setTranscripts} />
          {done && <p className="source">这一部分此前已交卷——重新提交只会回看结果，不会重复计分。</p>}
          {err && <div className="error">{err}</div>}
        </>}
    <div className="section row">
      {!result && <button className="primary" disabled={!canSubmit} onClick={submit}>
        {busy ? '正在批改…（选择题即判，写作口语要等 AI）' : `交卷 · ${SECTION_LABEL[section]}部分`}
      </button>}
      {result && idx < order.length - 1 && <button className="primary" onClick={() => { setSection(order[idx + 1]); window.scrollTo({ top: 0 }) }}>进入下一部分：{SECTION_LABEL[order[idx + 1]]}</button>}
      {result && idx === order.length - 1 && allDone && <button className="primary" onClick={() => { setSection(''); onExit() }}>完成整套 · 回总览</button>}
      <button className="secondary" onClick={onExit}>退出（草稿保留在本机）</button>
    </div>
    <p className="source">草稿自动保存在本机浏览器；交卷后成绩与错题永久保存在 NAS 数据库。刷新不丢草稿。</p>
  </>
}
