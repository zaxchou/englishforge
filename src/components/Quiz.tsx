import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdaptedQuestion, Evaluator, Outcome, PersistedResult, QueueItem, QuizRuntime } from '../types'
import { Speaker, Spark } from './fx'
import './quiz-new.css'
import { sfx } from '../sound'
import { gradeChoice, gradeSequence, gradeTap, normText, similarity, tierOfSpeak, outcomeOfTier } from '../learning/grading'

export type SessionResult = {
  q: AdaptedQuestion
  firstTryCorrect: boolean
  retriedCorrect: boolean | null // null = 未触发二次挑战
  given: string
  outcome?: Outcome
  evaluator?: Evaluator
  supportUsed?: number
}

/** 每次提交（首发或重试）的事件数据：App 负责落盘与复习规则 */
export interface QuizAttempt {
  qid: string
  firstAttempt: boolean
  outcome: Outcome
  evaluator: Evaluator
  given: string
  supportUsed: number
  responseMs?: number
  isDueReview: boolean
}

export interface QuizEntry {
  q: AdaptedQuestion
  item: QueueItem
}

interface ConceptCardLite {
  skillId: string
  title: string
  body: string[]
  example: string
  exampleNote: string
}

interface Props {
  entries: QuizEntry[]
  conceptCards: ConceptCardLite[]
  /** 断点恢复快照（刷新后从原题继续，不重新抽题、不变序） */
  resume?: QuizRuntime | null
  /** 会话内提示（如连续三次首错后的降难说明） */
  sessionNote?: string | null
  onAttempt: (a: QuizAttempt) => void
  onRuntime: (rt: QuizRuntime) => void
  onFinish: (results: SessionResult[], comboBest: number) => void
  onQuit: () => void
}

type Phase =
  | { kind: 'concept'; index: number }
  | { kind: 'q'; index: number }
  | { kind: 'retry'; index: number }

function toPersisted(r: SessionResult): PersistedResult {
  return {
    qid: r.q.id,
    firstTryCorrect: r.firstTryCorrect,
    retriedCorrect: r.retriedCorrect,
    given: r.given,
    evaluator: r.evaluator,
    outcome: r.outcome,
    supportUsed: r.supportUsed,
  }
}

function restoreResults(resume: QuizRuntime | null | undefined, byId: Map<string, AdaptedQuestion>): Map<string, SessionResult> {
  const m = new Map<string, SessionResult>()
  for (const pr of resume?.results ?? []) {
    const q = byId.get(pr.qid)
    if (q) m.set(pr.qid, { q, firstTryCorrect: pr.firstTryCorrect, retriedCorrect: pr.retriedCorrect, given: pr.given, outcome: pr.outcome, evaluator: pr.evaluator, supportUsed: pr.supportUsed })
  }
  return m
}

export function Quiz({ entries, conceptCards, resume, sessionNote, onAttempt, onRuntime, onFinish, onQuit }: Props) {
  const qById = useMemo(() => new Map(entries.map((e) => [e.q.id, e.q])), [entries])
  const total = entries.length

  const [phase, setPhase] = useState<Phase>(
    () => resume?.phase
      ?? (conceptCards.length ? { kind: 'concept', index: 0 } : { kind: 'q', index: 0 }),
  )
  const [retryIds, setRetryIds] = useState<string[]>(() => resume?.retryIds ?? [])
  const resultsRef = useRef<Map<string, SessionResult>>(restoreResults(resume, qById))
  const comboRef = useRef({ cur: 0, best: 0 })
  const [combo, setCombo] = useState(0)
  const [flash, setFlash] = useState(false)
  const [note, setNote] = useState<string | null>(sessionNote ?? null)
  const finishedRef = useRef(false)
  const qStartRef = useRef(Date.now())

  useEffect(() => { setNote(sessionNote ?? null) }, [sessionNote])

  // 每次进入新题重置作答计时
  useEffect(() => {
    qStartRef.current = Date.now()
  }, [phase])

  // 进入时与每次状态转移后保存断点（App 落盘）
  useEffect(() => {
    onRuntime({ phase, retryIds, results: Array.from(resultsRef.current.values()).map(toPersisted) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 离开题目/退出会话：停止识别与朗读（语音生命周期，P0-06）
  useEffect(() => () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  function emitRuntime(nextPhase: Phase, nextRetry: string[]) {
    onRuntime({ phase: nextPhase, retryIds: nextRetry, results: Array.from(resultsRef.current.values()).map(toPersisted) })
  }

  function bumpCombo(ok: boolean) {
    comboRef.current.cur = ok ? comboRef.current.cur + 1 : 0
    comboRef.current.best = Math.max(comboRef.current.best, comboRef.current.cur)
    setCombo(comboRef.current.cur)
    if (ok) {
      setFlash(true)
      window.setTimeout(() => setFlash(false), 650)
      if (comboRef.current.cur > 0 && comboRef.current.cur % 5 === 0) sfx.combo()
    }
  }

  function finish() {
    if (finishedRef.current) return
    finishedRef.current = true
    onFinish(Array.from(resultsRef.current.values()), comboRef.current.best)
  }

  // 恢复时若队列已全部完成 → 直接结算（不卡死）
  useEffect(() => {
    if (finishedRef.current) return
    const qDone = phase.kind === 'q' && phase.index >= total && retryIds.length === 0
    const retryDone = phase.kind === 'retry' && phase.index >= retryIds.length
    if (total > 0 && (qDone || retryDone)) finish()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, retryIds, total])

  function nextAfterConcept() {
    const idx = phase.kind === 'concept' ? phase.index + 1 : 0
    const next: Phase = idx < conceptCards.length ? { kind: 'concept', index: idx } : { kind: 'q', index: 0 }
    setPhase(next)
    emitRuntime(next, retryIds)
  }

  function handleAnswered(r: SessionResult, meta: { outcome: Outcome; evaluator: Evaluator; supportUsed: number }, wasRetry: boolean) {
    const responseMs = Date.now() - qStartRef.current
    const entry = entries.find((e) => e.q.id === r.q.id)
    const isDueReview = entry?.item.isDueReview ?? false

    // 每次提交都是一条独立事件（首发与重试分别保存）
    onAttempt({
      qid: r.q.id,
      firstAttempt: !wasRetry,
      outcome: meta.outcome,
      evaluator: meta.evaluator,
      given: r.given,
      supportUsed: meta.supportUsed,
      responseMs,
      isDueReview,
    })

    // 计算下一轮 retry 集合（同步计算，避免在 setState updater 里做副作用）
    let nextRetry = retryIds
    if (wasRetry) {
      const prev = resultsRef.current.get(r.q.id)
      if (prev) resultsRef.current.set(r.q.id, { ...prev, retriedCorrect: r.firstTryCorrect })
      else resultsRef.current.set(r.q.id, r)
    } else {
      resultsRef.current.set(r.q.id, { ...r, outcome: meta.outcome, evaluator: meta.evaluator, supportUsed: meta.supportUsed })
      // 首次答错 → 进二次挑战；跳过/识别失败不自动重排（分别记录，用例 8）
      if (!r.firstTryCorrect && meta.outcome !== 'skipped' && !nextRetry.includes(r.q.id)) {
        nextRetry = [...nextRetry, r.q.id]
      }
    }
    bumpCombo(r.firstTryCorrect)

    if (phase.kind === 'q') {
      const nextIdx = phase.index + 1
      if (nextIdx < total) {
        const next: Phase = { kind: 'q', index: nextIdx }
        setRetryIds(nextRetry)
        setPhase(next)
        emitRuntime(next, nextRetry)
      } else if (nextRetry.length > 0) {
        const next: Phase = { kind: 'retry', index: 0 }
        setRetryIds(nextRetry)
        setPhase(next)
        emitRuntime(next, nextRetry)
      } else {
        emitRuntime({ kind: 'q', index: nextIdx }, nextRetry)
        finish()
      }
    } else if (phase.kind === 'retry') {
      const nextIdx = phase.index + 1
      if (nextIdx < nextRetry.length) {
        const next: Phase = { kind: 'retry', index: nextIdx }
        setRetryIds(nextRetry)
        setPhase(next)
        emitRuntime(next, nextRetry)
      } else {
        emitRuntime({ kind: 'retry', index: nextIdx }, nextRetry)
        finish()
      }
    }
  }

  // ---- 微课卡阶段 ----
  if (phase.kind === 'concept') {
    const card = conceptCards[phase.index]
    if (!card) { finish(); return null }
    return (
      <div className="quiz">
        <div className="quiz-top">
          <button className="ghost" onClick={onQuit}>退出</button>
          <div className="progress-track"><div className="progress-fill" style={{ width: '6%' }} /></div>
          <div className="combo">📖 微课</div>
        </div>
        <div className="concept-card">
          <div className="concept-tag">微课卡 · 张老师这么说</div>
          <h2>{card.title}</h2>
          {card.body.map((b, i) => <p key={i}>{b}</p>)}
          <div className="concept-example">
            <code>{card.example}</code>
            <div className="concept-note">{card.exampleNote}</div>
          </div>
        </div>
        <button className="primary" onClick={nextAfterConcept}>
          {phase.index + 1 < conceptCards.length ? '继续 →' : '懂了，开练 →'}
        </button>
      </div>
    )
  }

  if (phase.kind === 'q' && phase.index >= total && retryIds.length === 0) return null

  const entry = phase.kind === 'q' ? entries[phase.index] : entries.find((e) => e.q.id === retryIds[phase.index])
  const isRetry = phase.kind === 'retry'
  if (!entry) return null

  return (
    <div className={`quiz ${flash ? 'flash' : ''}`}>
      <div className="quiz-top">
        <button className="ghost" onClick={onQuit}>退出</button>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.min(100, ((phase.kind === 'q' ? phase.index : total) / Math.max(1, total)) * 100)}%` }} />
        </div>
        <div className="combo">🔥 {combo}</div>
      </div>
      {isRetry && <div className="retry-banner">🔁 二次挑战 · 上次的错误已保留，这道题（或同类变式）再给你一次机会{entry.q.hint ? `——提示：${entry.q.hint}` : ''}</div>}
      {note && !isRetry && <div className="session-note">{note}</div>}
      <QuestionView
        key={entry.q.id + (isRetry ? '-r' : '')}
        q={entry.q}
        item={entry.item}
        onAnswered={(r, meta) => handleAnswered(r, meta, isRetry)}
      />
    </div>
  )
}

type AnswerMeta = { outcome: Outcome; evaluator: Evaluator; supportUsed: number }

function QuestionView({ q, item, onAnswered }: {
  q: AdaptedQuestion
  item: QueueItem
  onAnswered: (r: SessionResult, meta: AnswerMeta) => void
}) {
  if (q.type === 'speak') return <SpeakQ q={q} onAnswered={onAnswered} />
  if (q.type === 'match') return <MatchQ q={q} item={item} onAnswered={onAnswered} />
  if (q.type === 'sort') return <SortQ q={q} onAnswered={onAnswered} />
  if (q.type === 'choice' && q.autoTTS) return <ListenQ q={q} item={item} onAnswered={onAnswered} />
  return <BasicQ q={q} item={item} onAnswered={onAnswered} />
}

/** 冻结的选项顺序（生成时随机、存档冻结；重渲染不变序，恢复不变序） */
function frozenOptions(q: AdaptedQuestion, item: QueueItem): { id: string; text: string }[] {
  const order = item.optionOrder && item.optionOrder.length === q.optionIds.length
    ? item.optionOrder
    : q.optionIds
  return order.map((id) => {
    const i = q.optionIds.indexOf(id)
    return { id, text: i >= 0 ? q.options?.[i] ?? '' : '' }
  })
}

/** 跟读：可先隐藏原句（独立表达）；反馈是文字相似度，不宣称发音；退出停止识别 */
function SpeakQ({ q, onAnswered }: { q: AdaptedQuestion; onAnswered: (r: SessionResult, meta: AnswerMeta) => void }) {
  const target = q.target ?? q.tts ?? ''
  const [phase, setPhase] = useState<'idle' | 'listening' | 'done'>('idle')
  const [said, setSaid] = useState('')
  const [ratio, setRatio] = useState(0)
  const [tier, setTier] = useState<'ok' | 'close' | 'bad'>('bad')
  const [supported, setSupported] = useState(true)
  const [firstOk, setFirstOk] = useState<boolean | null>(null)
  const [everOk, setEverOk] = useState(false)
  const [tries, setTries] = useState(0)
  const [showSelfRate, setShowSelfRate] = useState(false)
  const [revealed, setRevealed] = useState(false)   // 看过原句
  const [prompted, setPrompted] = useState(false)   // 首次作答前是否给过提示（看原句或听示范）
  const [lastEvaluator, setLastEvaluator] = useState<Evaluator>('transcriptMatch')
  const [skipped, setSkipped] = useState(false)
  const recRef = useRef<{ stop: () => void } | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  // 生命周期：离开题目即停止识别与朗读
  useEffect(() => () => {
    try { recRef.current?.stop() } catch { /* noop */ }
    window.clearTimeout(timerRef.current)
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  function playTarget() {
    if (!('speechSynthesis' in window)) return
    setPrompted(true)
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(target)
    u.lang = 'en-US'; u.rate = 1.0
    window.speechSynthesis.speak(u)
  }
  function revealTarget() {
    if (!prompted) setPrompted(true)
    setRevealed(true)
  }
  function recordOutcome(text: string) {
    const r = similarity(normText(target), normText(text))
    const t = tierOfSpeak(r)
    setSaid(text); setRatio(r); setTier(t)
    setTries((n) => n + 1)
    if (firstOk === null) setFirstOk(t !== 'bad')
    if (t !== 'bad') setEverOk(true)
    setLastEvaluator('transcriptMatch')
    setPhase('done')
    if (t === 'ok') sfx.correct()
    else if (t === 'bad') sfx.wrong()
  }
  function listen() {
    const w = window as unknown as Record<string, unknown>
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!SR) { setSupported(false); return }
    const rec = new (SR as new () => never)() as {
      lang: string; interimResults: boolean; maxAlternatives: number
      onresult: (e: { results: { 0: { 0: { transcript: string } } } }) => void
      onerror: () => void; onend: () => void; start: () => void; stop: () => void
    }
    setPhase('listening')
    rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1
    recRef.current = rec
    const cleanup = () => window.clearTimeout(timerRef.current)
    rec.onresult = (e) => { cleanup(); recordOutcome(e.results[0][0].transcript) }
    // 识别失败：分别提示，降级到自评，不判学习者答错
    rec.onerror = () => { cleanup(); setSupported(false); setPhase((v) => (v === 'listening' ? 'idle' : v)) }
    rec.onend = () => {
      cleanup()
      setPhase((v) => {
        if (v === 'listening') { setShowSelfRate(true) }
        return v === 'listening' ? 'idle' : v
      })
    }
    timerRef.current = window.setTimeout(() => {
      try { rec.stop() } catch { /* noop */ }
      setShowSelfRate(true)
      setPhase((v) => (v === 'listening' ? 'idle' : v))
    }, 8000)
    try { rec.start() } catch { setPhase('idle') }
  }
  function cancelListen() {
    try { recRef.current?.stop() } catch { /* noop */ }
    window.clearTimeout(timerRef.current)
    setShowSelfRate(true)
    setPhase('idle')
  }
  function retry() { setPhase('idle'); setSaid(''); setRatio(0) }
  function selfRate(ok: boolean) {
    setTries((n) => n + 1)
    if (firstOk === null) setFirstOk(ok)
    if (ok) setEverOk(true)
    setSaid('(自评)'); setRatio(ok ? 1 : 0); setTier(ok ? 'ok' : 'bad')
    setLastEvaluator('self')
    setPhase('done')
    if (ok) sfx.correct()
  }
  function skip() {
    setSaid('(跳过)'); setTier('bad'); setRatio(0)
    setLastEvaluator('self')
    setSkipped(true)
    setFirstOk(false)
    setPhase('done')
  }
  function submit() {
    const outcome: Outcome = skipped
      ? 'skipped'
      : lastEvaluator === 'self'
        ? (firstOk === true ? 'correct' : 'incorrect')
        : outcomeOfTier(tier)
    const supportUsed = prompted ? 3 : 0
    const independent = !prompted
    const r: SessionResult = {
      q,
      firstTryCorrect: firstOk === true,
      retriedCorrect: everOk,
      given: said,
      outcome,
      evaluator: lastEvaluator,
      supportUsed,
    }
    onAnswered(r, { outcome, evaluator: lastEvaluator, supportUsed })
    return independent
  }

  const tierText = {
    ok: '✅ 识别文字与目标很接近。',
    close: '🟡 很接近了——差一点点，可以再试一遍，也可以过关。',
    bad: '❌ 和目标差距较大——再听一遍重录没关系。',
  }[tier]

  const doneIndependent = phase === 'done' && !prompted

  return (
    <div className="qview speak-q">
      <div className="prompt">
        🗣️ 开口说：{q.prompt}
        <span className="diff-tag diff-3">产出</span>
      </div>
      {!revealed ? (
        <div className="speak-hidden">
          <div className="speak-hidden-box">🙈 这次可以不看原句——想好"谁、做什么"，直接开口；卡住了再看提示。</div>
          <div className="speak-actions row">
            <button className="opt" onClick={revealTarget}>👀 看原句</button>
            <button className="opt" onClick={playTarget}>🔊 听示范</button>
          </div>
        </div>
      ) : (
        <div className="speak-target">
          <code>{target}</code>
          <button className="speaker" onClick={playTarget}>🔊</button>
        </div>
      )}
      <div className="speak-hint">{revealed ? '对照原句读一遍，点麦克风说出来——不满意随时重录' : '不看提示直接说 = 独立完成；看了/听了再说 = 有提示完成（如实分开记录）'}</div>
      {phase !== 'done' && (
        <div className="speak-actions">
          <button className={`mic-btn ${phase === 'listening' ? 'rec' : ''}`} onClick={listen} disabled={phase === 'listening'}>
            {phase === 'listening' ? '● 正在听…' : tries > 0 ? '🔁 再说一次' : '🎤 我说了'}
          </button>
          {phase === 'listening' && (
            <button className="linkish" onClick={cancelListen}>取消监听</button>
          )}
          {(!supported || showSelfRate) && (
            <>
              <div className="listen-tip">{supported ? '没听清也没关系——读几遍后自评：' : '本浏览器不支持语音识别（推荐 Chrome/Edge）——读几遍后自评：'}</div>
              <div className="speak-actions row">
                <button className="opt" onClick={() => selfRate(true)}>会了，读顺了</button>
                <button className="opt" onClick={() => selfRate(false)}>还行，再来一次</button>
                <button className="opt" onClick={skip}>跳过这题</button>
              </div>
            </>
          )}
        </div>
      )}
      {phase === 'done' && lastEvaluator !== 'self' && said !== '(跳过)' && (
        <>
          <div className="speak-result">
            <b>第 {tries} 次：</b>{said}
            {tier !== 'ok' && <span className="speak-ratio">（与目标相似度 {Math.round(ratio * 100)}%）</span>}
          </div>
          <div className={`feedback ${tier === 'bad' ? 'no' : 'ok'}`}>
            <div className="feedback-title">{tierText}</div>
            <div className="feedback-body">{q.explain}  目标句：{target}</div>
            <div className="sr-note">这是"识别文字 vs 目标文字"的接近程度，只说明内容说得对不对，不代表发音/语音评价。</div>
          </div>
          {doneIndependent && <div className="sr-badge">🌟 没看原句、没听示范就完成了 —— 独立完成（识别接近 · 自评确认）</div>}
          {!doneIndependent && <div className="sr-badge muted">有提示完成（看/听过原句）——独立表达下次再挑战</div>}
          <div className="speak-actions row">
            <button className="opt retry-btn" onClick={retry}>🔁 再说一次</button>
            <button className="primary next-inline" onClick={submit}>
              {everOk ? '下一题 →' : tier === 'bad' ? '先下一题（稍后复习再见）' : '下一题 →'}
            </button>
          </div>
        </>
      )}
      {phase === 'done' && lastEvaluator === 'self' && said !== '(跳过)' && (
        <>
          <div className={`feedback ${firstOk ? 'ok' : 'no'}`}>
            <div className="feedback-title">{firstOk ? '✅ 自评完成。' : '🟡 自评还需练习——'}</div>
            <div className="feedback-body">{q.explain}  目标句：{target}</div>
            <div className="sr-note">自评不等于客观认证——口语证据会与点击题分开记录。</div>
          </div>
          <div className="speak-actions row">
            <button className="opt retry-btn" onClick={retry}>🔁 再说一次</button>
            <button className="primary next-inline" onClick={submit}>下一题 →</button>
          </div>
        </>
      )}
      {phase === 'done' && said === '(跳过)' && (
        <>
          <div className="feedback no">
            <div className="feedback-title">⏸ 已跳过——分别记录，不算答错。</div>
            <div className="feedback-body">{q.explain}  目标句：{target}</div>
          </div>
          <button className="primary" onClick={submit}>下一题 →</button>
        </>
      )}
    </div>
  )
}

/** 听力辨义：自动播放，不显示英文原句；选项顺序冻结 */
function ListenQ({ q, item, onAnswered }: { q: AdaptedQuestion; item: QueueItem; onAnswered: (r: SessionResult, meta: AnswerMeta) => void }) {
  const spoken = useRef(false)
  const [checked, setChecked] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const options = useMemo(() => frozenOptions(q, item), [q, item])
  useEffect(() => {
    if (spoken.current || !q.tts || !('speechSynthesis' in window)) return
    spoken.current = true
    const u = new SpeechSynthesisUtterance(q.tts)
    u.lang = 'en-US'
    u.rate = 1.0
    window.speechSynthesis.speak(u)
  }, [q])
  useEffect(() => () => { if ('speechSynthesis' in window) window.speechSynthesis.cancel() }, [])
  function replay() {
    if (!q.tts || !('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(q.tts)
    u.lang = 'en-US'
    u.rate = 1.0
    window.speechSynthesis.speak(u)
  }
  function choose(optId: string) {
    if (checked) return
    setSelected(optId)
    setChecked(true)
    if (gradeChoice(q, optId)) sfx.correct()
    else sfx.wrong()
  }
  const ok = selected !== null && gradeChoice(q, selected)
  return (
    <div className="qview">
      <div className="prompt">🎧 听一听，这句话说的是什么意思？</div>
      <div className="listen-row">
        <button className="listen-btn" onClick={replay}>🔊 再听一遍</button>
        <span className="listen-tip">可多听几次再作答</span>
      </div>
      <div className="options">
        {options.map((o) => {
          const cls = checked
            ? gradeChoice(q, o.id) ? 'opt correct' : o.id === selected ? 'opt wrong' : 'opt dim'
            : o.id === selected ? 'opt picked' : 'opt'
          return (
            <button key={o.id} className={cls} disabled={checked} onClick={() => choose(o.id)}>
              {o.text}
            </button>
          )
        })}
      </div>
      {checked && <Feedback ok={ok} explain={q.explain + (q.tts ? `  原句：${q.tts}` : '')} />}
      {checked && (
        <button className="primary" onClick={() => onAnswered(
          { q, firstTryCorrect: ok, retriedCorrect: null, given: selected ?? '', outcome: ok ? 'correct' : 'incorrect', evaluator: 'deterministic', supportUsed: 3 },
          { outcome: ok ? 'correct' : 'incorrect', evaluator: 'deterministic', supportUsed: 3 },
        )}>下一题 →</button>
      )}
    </div>
  )
}

/** 配对题（右列顺序冻结） */
function MatchQ({ q, item, onAnswered }: { q: AdaptedQuestion; item: QueueItem; onAnswered: (r: SessionResult, meta: AnswerMeta) => void }) {
  const pairs = q.pairs ?? []
  const lefts = pairs.map((p) => p[0])
  const rights = useMemo(() => {
    const orig = pairs.map((p) => p[1])
    if (item.rightOrder && item.rightOrder.length === orig.length) return item.rightOrder
    return orig
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.id])
  const [selLeft, setSelLeft] = useState<string | null>(null)
  const [matched, setMatched] = useState<Record<string, string>>({})
  const [missed, setMissed] = useState(false)
  const [checked, setChecked] = useState(false)
  const done = Object.keys(matched).length === pairs.length
  function pickRight(r: string) {
    if (!selLeft || matched[selLeft]) return
    const rightForLeft = pairs.find((p) => p[0] === selLeft)?.[1]
    if (r === rightForLeft) {
      const m = { ...matched, [selLeft]: r }
      setMatched(m)
      setSelLeft(null)
      if (Object.keys(m).length === pairs.length) {
        setChecked(true)
        if (!missed) sfx.correct()
        else sfx.wrong()
      }
    } else {
      setMissed(true) // 配错：保留左侧选中，直接试下一个右词
    }
  }
  const ok = checked && !missed
  return (
    <div className="qview">
      <div className="prompt">{q.prompt}</div>
      <div className="match-grid">
        <div className="match-col">
          {lefts.map((l) => (
            <button key={l} disabled={!!matched[l]}
              className={`token ${matched[l] ? 'correct' : selLeft === l ? 'picked' : ''}`}
              onClick={() => setSelLeft(l)}>{l}</button>
          ))}
        </div>
        <div className="match-col">
          {rights.map((r) => {
            const used = Object.values(matched).includes(r)
            return (
              <button key={r} disabled={used}
                className={`token ${used ? 'correct' : ''}`}
                onClick={() => pickRight(r)}>{r}</button>
            )
          })}
        </div>
      </div>
      {missed && !done && <div className="listen-tip" style={{ color: 'var(--no)' }}>有配错——没关系，继续配完，巩固靠复习队列。</div>}
      {checked && <Feedback ok={ok} explain={q.explain + (ok ? '' : '（中途配错过，明天再来一遍巩固）')} />}
      {checked && (
        <button className="primary" onClick={() => onAnswered(
          { q, firstTryCorrect: ok, retriedCorrect: null, given: 'match', outcome: ok ? 'correct' : 'incorrect', evaluator: 'deterministic', supportUsed: 3 },
          { outcome: ok ? 'correct' : 'incorrect', evaluator: 'deterministic', supportUsed: 3 },
        )}>下一题 →</button>
      )}
    </div>
  )
}

/** 二分类题 */
function SortQ({ q, onAnswered }: { q: AdaptedQuestion; onAnswered: (r: SessionResult, meta: AnswerMeta) => void }) {
  const items = q.items ?? []
  const buckets = q.buckets ?? ['A', 'B']
  const [idx, setIdx] = useState(0)
  const [wrongIdxs, setWrongIdxs] = useState<number[]>([])
  const [checked, setChecked] = useState(false)
  const finished = idx >= items.length
  const lastOk = useRef(true)
  function pick(b: number) {
    if (finished || checked) return
    const ok = items[idx].b === b
    if (!ok) { setWrongIdxs((w) => [...w, idx]); lastOk.current = false }
    if (idx + 1 < items.length) { setIdx(idx + 1); return }
    setIdx(items.length)
    setChecked(true)
    if (lastOk.current) sfx.correct()
    else sfx.wrong()
  }
  if (!finished) {
    return (
      <div className="qview">
        <div className="prompt">{q.prompt}</div>
        <div className="sort-counter">{idx + 1} / {items.length}</div>
        <div className="sort-word">{items[idx].w}</div>
        <div className="sort-btns">
          <button className="opt" onClick={() => pick(0)}>{buckets[0]}</button>
          <button className="opt" onClick={() => pick(1)}>{buckets[1]}</button>
        </div>
        {wrongIdxs.length > 0 && <div className="listen-tip" style={{ color: 'var(--no)' }}>已错 {wrongIdxs.length} 个——错了没关系，练完讲给你听。</div>}
      </div>
    )
  }
  const wrongList = wrongIdxs.map((i) => items[i])
  const ok = wrongIdxs.length === 0
  return (
    <div className="qview">
      <div className="prompt">{q.prompt}</div>
      {ok ? (
        <Feedback ok={true} explain={q.explain} />
      ) : (
        <Feedback ok={false} explain={q.explain + '  分类错的词：' + wrongList.map((w) => w.w).join('、')} />
      )}
      {checked && (
        <button className="primary" onClick={() => onAnswered(
          { q, firstTryCorrect: ok, retriedCorrect: null, given: 'sort', outcome: ok ? 'correct' : 'incorrect', evaluator: 'deterministic', supportUsed: 3 },
          { outcome: ok ? 'correct' : 'incorrect', evaluator: 'deterministic', supportUsed: 3 },
        )}>下一题 →</button>
      )}
    </div>
  )
}

function BasicQ({ q, item, onAnswered }: { q: AdaptedQuestion; item: QueueItem; onAnswered: (r: SessionResult, meta: AnswerMeta) => void }) {
  const [selected, setSelected] = useState<string | null>(null)   // 选项/token ID
  const [checked, setChecked] = useState(false)
  const [picked, setPicked] = useState<string[]>([])              // 词块 ID 序列
  const [tapped, setTapped] = useState<string | null>(null)
  const [spark, setSpark] = useState(false)
  const [result, setResult] = useState<boolean | null>(null)

  const options = useMemo(
    () => (q.type === 'choice' ? frozenOptions(q, item) : []),
    [q, item],
  )
  const tokens2 = q.tokens2
  const tokenText = (id: string) => tokens2.find((t) => t.id === id)?.text ?? ''
  const pickedTexts = picked.map(tokenText)
  const expectedText = q.type === 'tiles'
    ? (q.order ?? []).join(' ')
    : q.type === 'tap' ? q.fix ?? '' : q.answer ?? ''

  function finish(correct: boolean) {
    setChecked(true)
    setResult(correct)
    if (correct) sfx.correct()
    else sfx.wrong()
    if (correct) {
      setSpark(true)
      window.setTimeout(() => setSpark(false), 650)
    }
  }
  function submit(outcome: Outcome) {
    const given = q.type === 'tiles' ? pickedTexts.join(' ') : q.type === 'tap' ? (tapped ? tokenText(tapped) : '') : (selected ? (options.find((o) => o.id === selected)?.text ?? '') : '')
    onAnswered(
      { q, firstTryCorrect: result === true, retriedCorrect: null, given, outcome, evaluator: 'deterministic', supportUsed: q.type === 'tiles' ? 2 : 3 },
      { outcome, evaluator: 'deterministic', supportUsed: q.type === 'tiles' ? 2 : 3 },
    )
  }

  if (q.type === 'choice') {
    const diffName = ['', '基础', '进阶', '挑战'][q.diff ?? 1]
    const ok = selected !== null && gradeChoice(q, selected)
    return (
      <div className={`qview ${q.myth ? 'myth-q' : ''}`}>
        <div className="prompt">
          {q.myth && <span className="myth-badge">💥 破除误区</span>}
          {q.prompt}
          <span className={'diff-tag diff-' + (q.diff ?? 1)}>{diffName}</span>
        </div>
        <div className="options">
          {options.map((o) => {
            const cls = checked
              ? gradeChoice(q, o.id) ? 'opt correct' : o.id === selected ? 'opt wrong' : 'opt dim'
              : o.id === selected ? 'opt picked' : 'opt'
            return (
              <button key={o.id} className={cls} disabled={checked}
                onClick={() => { if (!checked) { setSelected(o.id); finish(gradeChoice(q, o.id)) } }}>
                {o.text}
              </button>
            )
          })}
        </div>
        {checked && <Feedback ok={ok} explain={q.explain} />}
        {checked && q.tts && <div className="tts-row"><code>{q.tts}</code><Speaker text={q.tts} /></div>}
        {checked && <button className="primary" onClick={() => submit(ok ? 'correct' : 'incorrect')}>下一题 →</button>}
        <Spark show={spark} />
      </div>
    )
  }

  if (q.type === 'tap') {
    const ok = tapped !== null && gradeTap(q, tapped)
    return (
      <div className="qview">
        <div className="prompt">{q.prompt}</div>
        <div className="tap-sentence">
          {tokens2.map((t) => {
            const cls = checked
              ? t.id === q.answerId ? 'token wrong' : 'token dim'
              : t.id === tapped ? 'token picked' : 'token'
            return (
              <button key={t.id} className={cls} disabled={checked}
                onClick={() => { if (!checked) { setTapped(t.id); finish(gradeTap(q, t.id)) } }}>
                {t.text}
              </button>
            )
          })}
        </div>
        {checked && (
          <Feedback
            ok={ok}
            explain={q.explain + (ok ? '' : `  正确形式：${q.fix}`)}
          />
        )}
        {checked && q.tts && <div className="tts-row"><code>{q.tts}</code><Speaker text={q.tts} /></div>}
        {checked && <button className="primary" onClick={() => submit(ok ? 'correct' : 'incorrect')}>下一题 →</button>}
        <Spark show={spark} />
      </div>
    )
  }

  // tiles 词块拼句（词块按 ID 选取与撤回——重复文本互不影响，用例 7）
  const pool = tokens2.filter((t) => !picked.includes(t.id))
  const okTiles = picked.length > 0 && gradeSequence(q, picked)
  return (
    <div className="qview">
      <div className="prompt">{q.prompt}</div>
      <div className={`tiles-answer ${checked ? (okTiles ? 'correct' : 'wrong') : ''}`}>
        {picked.length === 0 && <span className="tiles-placeholder">点击下方词块，按正确语序组句…</span>}
        {picked.map((id) => (
          <button key={id} className="token" disabled={checked} onClick={() => setPicked(picked.filter((x) => x !== id))}>{tokenText(id)}</button>
        ))}
      </div>
      <div className="tiles-pool">
        {pool.map((t) => (
          <button key={t.id} className="token" disabled={checked} onClick={() => setPicked([...picked, t.id])}>{t.text}</button>
        ))}
      </div>
      {!checked && (
        <button className="primary" disabled={picked.length === 0} onClick={() => finish(okTiles)}>
          检查
        </button>
      )}
      {checked && <Feedback ok={okTiles} explain={q.explain + (okTiles ? '' : `  正确语序：${expectedText}`)} />}
      {checked && q.tts && <div className="tts-row"><code>{q.tts}</code><Speaker text={q.tts} /></div>}
      {checked && <button className="primary" onClick={() => submit(okTiles ? 'correct' : 'incorrect')}>下一题 →</button>}
      <Spark show={spark} />
    </div>
  )
}

function Feedback({ ok, explain }: { ok: boolean; explain: string }) {
  return (
    <div className={`feedback ${ok ? 'ok' : 'no'}`}>
      <div className="feedback-title">{ok ? '✅ 对了！含义对了，形式就对。' : '❌ 差一点——看张老师怎么说：'}</div>
      <div className="feedback-body">{explain}</div>
    </div>
  )
}
