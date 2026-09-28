import { useEffect, useMemo, useRef, useState } from 'react'
import { lessons, questionsOfSkill, allQuestions, skillOrder } from './data/course'
import { applyReviewMarks, loadReviewMarks, type ReviewMarks } from './content/reviewMarks'
import {
  loadProgress, saveProgress, resetProgress, getSkillProgress,
  recordSkillPractice, commitSession, recordSession, localDateStr,
} from './store/progress'
import {
  pushAttempt, exportSave, applyImport, previewImport, clearSaveError, hadSaveError,
} from './store/migrations'
import type { LoadNotice } from './store/migrations'
import type { ActiveSession, AdaptedQuestion, Attempt, ProgressV2, QuizRuntime, SessionKind } from './types'
import { Quiz, type SessionResult, type QuizAttempt, type QuizEntry } from './components/Quiz'
import { Confetti } from './components/fx'
import { Dashboard, Sidebar } from './components/Dashboard'
import { ContentReview } from './components/ContentReview'
import { buildEvidence, STATE_LABEL, type EvidenceReport } from './learning/evidence'
import { summarizeTags, tagLabel, TAG_FIX } from './learning/errorTags'
import {
  applyQuestionReview, recordSpeak, buildTodayQueue, buildSkillQueue, buildReviewQueue,
  insertVariantDrill, softenQueue, eligible, dueQuestions, recommendSkill, QUEUE_SIZE,
} from './learning/scheduler'
import { isMuted, setMuted, sfx } from './sound'

const allSkillList = Object.values(lessons).flatMap((l) => l.skills)

type View =
  | { name: 'home' }
  | { name: 'lesson'; lessonId: string }
  | { name: 'practice' }
  | { name: 'result'; results: SessionResult[]; comboBest: number; xpGain: number; kind: SessionKind; dueTomorrow: number }
  | { name: 'review' }   // 内容审核（R1-03）：逐题核对语料派生题

export default function App() {
  const [loaded] = useState(() => loadProgress())
  const [progress, setProgress] = useState<ProgressV2>(loaded.progress)
  const progressRef = useRef(progress)
  const [notice, setNotice] = useState<LoadNotice>(loaded.notice)
  const [saveErr, setSaveErr] = useState(hadSaveError)
  const [view, setView] = useState<View>({ name: 'home' })
  const [soundOn, setSoundOn] = useState(() => !isMuted())
  const [startError, setStartError] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const refresh = () => setClock(Date.now())
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])

  // 审核标记会改变信任级别，从而决定"这次练习算不算能力证据"——所以它必须驱动题目池
  const [marks, setMarks] = useState<ReviewMarks>(() => loadReviewMarks())
  const reviewed = useMemo(() => applyReviewMarks(allQuestions, marks), [marks])
  const pool = useMemo(() => eligible(reviewed), [reviewed])
  const questionById = useMemo(() => new Map(reviewed.map((q) => [q.id, q])), [reviewed])
  const evidence: EvidenceReport = useMemo(() => buildEvidence(progress, pool), [progress, pool])
  const dueList = useMemo(
    () => dueQuestions(progress, pool, clock, evidence.openErrorQids),
    [progress, pool, evidence, clock],
  )

  /** 保存 + 同步状态；写失败时亮横幅（用例 12） */
  function sync(p: ProgressV2 = progressRef.current) {
    progressRef.current = p
    const ok = saveProgress(p)
    setSaveErr(!ok)
    setProgress({ ...p, activeSession: p.activeSession ? { ...p.activeSession, queue: [...p.activeSession.queue] } : null })
    return ok
  }

  // ---------- 会话 ----------
  const active = progress.activeSession && !progress.activeSession.committed ? progress.activeSession : null

  function startSession(kind: SessionKind, skillId?: string): boolean {
    const p = structuredClone(progressRef.current)
    // 1. 「开始今天的练习」优先恢复未完成会话（§5.4.1）；
    //    明确点开某思维点/复习 = 新意图，用新队列替换（已答事件都在存档里）
    if (kind === 'today' && p.activeSession && !p.activeSession.committed) {
      setView({ name: 'practice' })
      return true
    }
    if (p.activeSession && !p.activeSession.committed && !confirm('还有未完成的练习。开始新练习将替换当前队列，已提交的记录会保留。是否继续？')) return true
    const sessionId = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    let queue
    if (kind === 'today') {
      queue = buildTodayQueue(p, pool, sessionId, { skillOrder, criticalQids: evidence.openErrorQids })
    } else if (kind === 'review') {
      queue = buildReviewQueue(p, pool, sessionId, evidence.openErrorQids)
    } else {
      const sp = getSkillProgress(p, skillId!)
      queue = buildSkillQueue(p, questionsOfSkill(skillId!), sessionId, sp.box)
    }
    if (queue.length === 0) return false
    const newActive: ActiveSession = {
      sessionId, kind, skillId: skillId ?? recommendSkill(p, pool, skillOrder) ?? undefined, queue, runtime: null, createdAt: Date.now(), committed: false,
      wrongStreaks: {}, note: undefined,
    }
    p.activeSession = newActive
    sync(p)
    setView({ name: 'practice' })
    return true
  }

  function resumeSession(): boolean {
    if (active) { setView({ name: 'practice' }); return true }
    return startSession('today')
  }

  // 练习会话的题与冻结 UI 顺序
  const entries: QuizEntry[] = useMemo(() => {
    const a = progress.activeSession
    if (!a) return []
    const out: QuizEntry[] = []
    for (const item of a.queue) {
      const q = questionById.get(item.qid)
      if (q) out.push({ q, item })
    }
    return out
  }, [progress.activeSession, questionById])

  function conceptCardsFor(a: ActiveSession): { skillId: string; title: string; body: string[]; example: string; exampleNote: string }[] {
    if (a.kind === 'review') return []   // 先检索后讲解：复习不预放微课（保护延迟保持证据）
    const sid = a.skillId ?? recommendSkill(progress, pool, skillOrder)
    if (!sid) return []
    if (getSkillProgress(progress, sid).conceptSeen) return []
    const sk = allSkillList.find((s) => s.id === sid)
    return sk ? [{ skillId: sk.id, title: sk.concept.title, body: sk.concept.body, example: sk.concept.example, exampleNote: sk.concept.exampleNote }] : []
  }

  /** 每次提交：一条事件 + 复习规则 + 立即落盘（幂等键 = sessionId:qid:首发/重试） */
  function handleAttempt(a: QuizAttempt) {
    const p = structuredClone(progressRef.current)
    const ses = p.activeSession
    if (!ses || ses.committed) return
    const attemptId = `${ses.sessionId}:${a.qid}:${a.firstAttempt ? 'f' : 'r'}`
    if (p.attempts.some((x) => x.attemptId === attemptId)) return   // 刷新重答/重复回调：只记一次（用例 5）

    const q = questionById.get(a.qid)
    const priorState = p.questionStates[a.qid]
    const wasDue = (priorState?.dueAt ?? 0) <= Date.now()
    const wasReview = !!priorState?.total && wasDue

    if (a.evaluator === 'deterministic') {
      applyQuestionReview(p, a.qid, {
        firstAttempt: a.firstAttempt,
        outcome: a.outcome,
        independent: a.firstAttempt && a.outcome === 'correct',
        wasDue,
        isVariantDrill: ses.queue.find(it => it.qid === a.qid)?.isVariantDrill,
      })
    } else if (q?.mode === 'oral') {
      // 口语题：**任何**作答结果都要推进排程。只承认"自评完成"的话，跳过 / 语音识别不确定 /
      // 自评未过 三条路径都不会改动 dueAt，题目就永远留在到期队列里（实测 bug）。
      // 口语状态只在真正做了自评（self/ai 判定为正确）时才写，不冒充认证。
      const ok = a.outcome === 'correct'
      const self = a.evaluator === 'self'
      const ai = a.evaluator === 'aiText'
      const independent = ok && a.supportUsed === 0 && (self || ai)
      const status = independent ? (ai ? 'independent-ai' : 'independent-self')
        : self && ok ? 'prompted' : null
      recordSpeak(p, a.qid, status, independent)
    }

    const attempt: Attempt = {
      attemptId,
      sessionId: ses.sessionId,
      questionId: a.qid,
      contentVersion: q?.contentVersion ?? 1,
      objectiveId: q?.objectiveId ?? a.qid,
      variantGroupId: q?.variantGroupId ?? a.qid,
      mode: q?.mode ?? 'recognition',
      timestamp: Date.now(),
      localDate: localDateStr(),
      firstAttempt: a.firstAttempt,
      supportUsed: a.supportUsed,
      answer: a.given.slice(0, 160),
      outcome: a.outcome,
      // 错因标签来自所选选项（选项级 optionTags）。答错才记，答对不记。
      errorTags: a.outcome === 'correct' ? undefined : q?.optionTags?.[a.given],
      evaluator: a.evaluator,
      responseMs: a.responseMs,
      isDueReview: wasReview && a.firstAttempt && !ses.queue.find(it => it.qid === a.qid)?.isVariantDrill,
      isVariantDrill: ses.queue.find(it => it.qid === a.qid)?.isVariantDrill ?? false,
    }
    const { saved } = pushAttempt(p, attempt)

    // §3.3 错误处理：变式补练 / 连续三次首错降难
    if (a.firstAttempt && q) {
      const streaks = ses.wrongStreaks ?? {}
      if (a.outcome === 'incorrect' && a.evaluator === 'deterministic') {
        const n = (streaks[q.skill] ?? 0) + 1
        streaks[q.skill] = n
        ses.wrongStreaks = streaks
        const cursor = ses.queue.findIndex((it) => it.qid === a.qid) + 1
        if (n >= 3) {
          softenQueue(ses.queue, cursor, q.skill, pool, ses.sessionId)
          ses.note = '这个知识点连续三题首发没对——停下加难，换成更基础的对比任务，慢慢来。'
        } else {
          insertVariantDrill(ses.queue, cursor, a.qid, pool, ses.sessionId)
        }
      } else if (a.outcome === 'correct' || a.outcome === 'uncertain') {
        if (streaks[q.skill]) { streaks[q.skill] = 0; ses.wrongStreaks = streaks }
      }
    }

    if (!saved) setSaveErr(true)
    sync(p)
  }

  /** 断点快照：每次状态转移后落盘 */
  function handleRuntime(rt: QuizRuntime) {
    const p = structuredClone(progressRef.current)
    if (!p.activeSession || p.activeSession.committed) return
    p.activeSession.runtime = rt
    sync(p)
  }

  /** 结算：XP、技能历史、会话日志、清除断点（保留 XP 与历史记录，P0-04） */
  function handleFinish(results: SessionResult[], comboBest: number) {
    const p = structuredClone(progressRef.current)
    const ses = p.activeSession
    if (!ses || ses.committed) return
    const perFull = ses.kind === 'review' ? 8 : 10
    let xpGain = 0
    for (const r of results) {
      recordSkillPractice(p, r.q.skill, r.firstTryCorrect)
      xpGain += r.firstTryCorrect ? perFull : 2
    }
    xpGain += Math.floor(comboBest / 3) * 5

    // 微课看过即记
    const markSid = ses.skillId
    if (markSid && p.skills[markSid]) p.skills[markSid].conceptSeen = true

    const firstTry = results.filter((r) => r.firstTryCorrect).length
    const label = ses.kind === 'review'
      ? `复习 · ${ses.queue.length} 个到期任务`
      : ses.kind === 'today'
        ? `今日训练 · ${ses.queue.length} 个任务`
        : (() => {
            const les = Object.values(lessons).find((l) => l.skills.some((k) => k.id === ses.skillId))
            const sk = allSkillList.find((s) => s.id === ses.skillId)
            return `${les ? '第 ' + les.no + ' 课' : ''} · ${sk?.name ?? ''}`
          })()
    recordSession(p, {
      label,
      lessonNo: ses.kind === 'review' ? '复习' : ses.kind === 'today' ? '今日' : (Object.values(lessons).find((l) => l.skills.some((k) => k.id === ses.skillId))?.no ?? ''),
      acc: results.length ? Math.round((firstTry / results.length) * 100) : 0,
      xp: xpGain,
      total: results.length,
      firstTry,
    })
    const kind = ses.kind
    commitSession(p, xpGain, comboBest)
    p.activeSession = null
    progressRef.current = p
    const ok = saveProgress(p)
    setSaveErr(!ok)
    setProgress({ ...p })

    const now = Date.now()
    const dueTomorrow = Object.values(p.questionStates)
      .filter((st) => st.total > 0 && st.dueAt > now && st.dueAt <= now + 24 * 60 * 60 * 1000).length
    setView({ name: 'result', results, comboBest, xpGain, kind, dueTomorrow })
  }

  function handleQuit() {
    sync()   // runtime 已由 Quiz 落盘；这里确保 UI 状态一致
    setView({ name: 'home' })
  }

  function handleReset() {
    if (confirm('确定清空全部学习进度？（当前存档会先备份到本地）')) {
      resetProgress()
      clearSaveError()
      const r = loadProgress()
      progressRef.current = r.progress
      setProgress(r.progress)
      setNotice(null)
      setSaveErr(false)
      setView({ name: 'home' })
    }
  }

  // ---------- 存档导入导出 ----------
  function doExportSave() {
    const blob = new Blob([exportSave(progress)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `EnglishForge-存档-${localDateStr()}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  function doImportSave() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const text = String(reader.result ?? '')
        const preview = previewImport(text)
        if ('error' in preview) { alert('导入失败：' + preview.error); return }
        const msg = [
          '确认导入这份存档？（当前存档会先自动备份）',
          '',
          `XP：${preview.xp} · 连续：${preview.streak} 天`,
          `作答事件：${preview.attempts} 条 · 练习记录：${preview.sessions} 条`,
          `含未完成会话：${preview.activeSession ? '是（导入后可继续）' : '否'}`,
        ].join('\n')
        if (!confirm(msg)) return
        const res = applyImport(text)
        if (!res.ok) { alert('导入失败：' + res.error); return }
        const r = loadProgress()
        progressRef.current = r.progress
      setProgress(r.progress)
        setSaveErr(false)
        setView({ name: 'home' })
      }
      reader.readAsText(file)
    }
    input.click()
  }

  const todayBrief = useMemo(() => {
    const sid = recommendSkill(progress, pool, skillOrder)
    const sk = allSkillList.find((s) => s.id === sid)
    const dueTake = dueList.length <= 4 ? dueList.length : Math.min(dueList.length, 7)
    return {
      skillName: sk ? sk.name : null,
      skillLesson: sk ? (Object.values(lessons).find((l) => l.skills.some((k) => k.id === sk.id))?.no ?? '') : '',
      dueCount: dueList.length,
      dueTake,
      hasResume: !!active,
      queueLen: active?.queue.length ?? QUEUE_SIZE,
      stateCounts: countStates(evidence),
    }
  }, [progress, pool, dueList, evidence, active])

  return (
    <div className={`app ${view.name === 'home' ? 'view-home' : 'view-inner'}`}>
      {view.name !== 'home' && <Sidebar active={view.name === 'lesson' ? 'courses' : 'today'} dueCount={dueList.length} onNavigate={(target) => { setView({ name: 'home' }); window.setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' }), 50) }} onReview={() => { if (!startSession('review')) setStartError('目前没有到期复习，可以继续课程练习。') }} />}
      {saveErr && (
        <div className="sys-banner err">
          ⚠️ 上次保存失败——进度可能没存上。<button className="linkish" onClick={doExportSave}>立即导出存档</button>
          <button className="linkish" onClick={() => setSaveErr(false)}>知道了</button>
        </div>
      )}
      {notice && (
        <div className="sys-banner">
          {notice === 'migrated'
            ? '✅ 已从旧版进度迁移到 v2 存档（原 v1 数据保留未删除）。'
            : '🔧 检测到存档损坏——已备份损坏副本并从旧版数据恢复。'}
          <button className="linkish" onClick={() => setNotice(null)}>知道了</button>
        </div>
      )}
      {startError && (
        <div className="sys-banner">
          {startError}
          <button className="linkish" onClick={() => setStartError(null)}>知道了</button>
        </div>
      )}
      {view.name !== 'home' && (
        <header className="topbar">
          <button className="brand brand-btn" onClick={() => setView({ name: 'home' })}>← 返回学习空间</button><span className="inner-location">{view.name === 'lesson' ? '课程 / 知识点' : view.name === 'practice' ? '专注练习 · 按自己的节奏' : view.name === 'review' ? '内容审核 · 逐题核对' : '本轮学习记录'}</span>
          <div className="stats">
            <button
              className="stats-btn"
              title={soundOn ? '点击关闭音效' : '点击开启音效'}
              onClick={() => { setMuted(soundOn); setSoundOn(!soundOn) }}
            >{soundOn ? '🔊' : '🔇'}</button>
          </div>
        </header>
      )}
      <main>
        {view.name === 'home' && (
          <Dashboard
            progress={progress}
            evidence={evidence}
            todayBrief={todayBrief}
            soundOn={soundOn}
            saveErr={saveErr}
            onToggleSound={() => { setMuted(soundOn); setSoundOn(!soundOn) }}
            onOpenLesson={(id) => setView({ name: 'lesson', lessonId: id })}
            onStartToday={() => { setStartError(null); if (!startSession('today')) setStartError('今天没有可抽的题目——题库正在建设中。') }}
            onResume={() => { if (!resumeSession()) setStartError('没有找到未完成的会话。') }}
            onStartReview={() => { setStartError(null); if (!startSession('review')) setStartError('今天没有到期的复习——去打新铁吧！') }}
            onExportSave={doExportSave}
            onImportSave={doImportSave}
            onReset={handleReset}
            onReviewContent={() => setView({ name: 'review' })}
          />
        )}
        {view.name === 'review' && (
          <ContentReview
            questions={pool.filter((q) => q.reviewStatus === 'draft')}
            marks={marks}
            onMarks={setMarks}
            onExit={() => setView({ name: 'home' })}
          />
        )}
        {view.name !== 'review' && <div className={`narrow ${view.name === 'practice' ? 'quiz-center' : ''}`}>
        {view.name === 'lesson' && (
          <LessonPage lessonId={view.lessonId} progress={progress} evidence={evidence} pool={pool} onStartSkill={(skillId) => { setStartError(null); if (!startSession('skill', skillId)) setStartError('这个思维点还没有题目——题库正在建设中。') }} onBack={() => setView({ name: 'home' })} />
        )}
        {view.name === 'practice' && progress.activeSession && (
          <Quiz
            key={progress.activeSession.sessionId}
            entries={entries}
            conceptCards={conceptCardsFor(progress.activeSession)}
            resume={progress.activeSession.runtime}
            sessionNote={progress.activeSession.note ?? null}
            onAttempt={handleAttempt}
            onRuntime={handleRuntime}
            onFinish={handleFinish}
            onQuit={handleQuit}
          />
        )}
        {view.name === 'practice' && !progress.activeSession && (
          <div className="page center">
            <div className="empty">🌤️ 没有进行中的练习。</div>
            <button className="primary" onClick={() => setView({ name: 'home' })}>回到学习空间</button>
          </div>
        )}
        {view.name === 'result' && (
          <ResultPage
            results={view.results}
            comboBest={view.comboBest}
            xpGain={view.xpGain}
            progress={progress}
            kind={view.kind}
            dueTomorrow={view.dueTomorrow}
            onHome={() => setView({ name: 'home' })}
            onAgain={() => setView({ name: 'home' })}
          />
        )}
        </div>}
      </main>
      {view.name !== 'home' && <footer className="foot">
        <span>素材来自张俊杰老师课程逐字稿 · 本地存档 · </span>
        <span>按自己的节奏练习</span>
      </footer>}
    </div>
  )
}

function countStates(e: EvidenceReport) {
  let unseen = 0, building = 0, early = 0, durable = 0
  for (const s of Object.values(e.bySkill)) {
    if (s.state === 'unseen') unseen++
    else if (s.state === 'building') building++
    else if (s.state === 'early-stable') early++
    else durable++
  }
  return { unseen, building, early, durable, total: unseen + building + early + durable }
}

// ---------------- 课程页（思维点小关） ----------------
/** 某知识点的练习进度：每道可用题独立答对过一次（stage ≥ 1）才算练过。
 *  这个数直接驱动"练完就升级"的推荐逻辑，所以必须让用户看得见。 */
function practiceProgress(p: ProgressV2, pool: AdaptedQuestion[], skillId: string) {
  const qs = pool.filter((q) => q.skill === skillId)
  const done = qs.filter((q) => (p.questionStates[q.id]?.stage ?? 0) >= 1).length
  return { done, total: qs.length }
}

function LessonPage({ lessonId, progress, evidence, pool, onStartSkill, onBack }: {
  lessonId: string
  progress: ProgressV2
  pool: AdaptedQuestion[]
  evidence: EvidenceReport
  onStartSkill: (skillId: string) => void
  onBack: () => void
}) {
  const les = lessons[lessonId]
  if (!les) return <div className="page">课程不存在</div>
  return (
    <div className="page narrow-wide">
      <button className="ghost" onClick={onBack}>← 全部课程</button>
      <div className="lesson-title">
        <h1>第 {les.no} 课 · {les.title}</h1>
        <p>{les.subtitle}</p>
      </div>
      <div className="skill-list">
        {les.skills.map((s, i) => {
          const ev = evidence.bySkill[s.id]
          const state = ev?.state ?? 'unseen'
          const stats = skillStats(progress, s.id)
          const prog = practiceProgress(progress, pool, s.id)
          return (
            <button key={s.id} className="skill-card" onClick={() => onStartSkill(s.id)}>
              <div className="skill-icon">{s.icon}</div>
              <div className="skill-info">
                <div className="skill-name">{i + 1}. {s.name}
                  <span className={`state-chip st-${state.replace('-', '')}`}>{STATE_LABEL[state]}</span>
                </div>
                <div className="skill-tagline">{s.tagline}</div>
                <div className="skill-meta">
                  {ev && ev.evidence.length > 0
                    ? ev.evidence[0]
                    : ev?.legacyOnly
                      ? '有历史练习记录 · 尚无新的作答证据'
                      : '未练习 · 先看微课卡'}
                </div>
                <div className="skill-meta dim">{stats.total > 0 ? `累计练习 ${stats.total} 题 · 历史首发答对 ${stats.correct}` : ''}</div>
                {/* 练习进度：这是驱动"掌握了就升级"的那个数——每道题独立答对过一次才算练过 */}
                <div className="skill-progress">
                  <div className="skill-bar" aria-hidden="true">
                    <i style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` }} />
                  </div>
                  <span>{prog.total ? `已练 ${prog.done}/${prog.total} 题` : '本知识点暂无题目'}</span>
                  {prog.done === prog.total && prog.total > 0 && <b className="skill-done">练完 · 主推进已交给下一个知识点</b>}
                </div>
              </div>
              <div className="skill-go">{getSkillProgress(progress, s.id).conceptSeen ? '▶' : '🎯'}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function skillStats(p: ProgressV2, skillId: string): { total: number; correct: number } {
  let total = 0, correct = 0
  for (const q of questionsOfSkill(skillId)) {
    const st = p.questionStates[q.id]
    if (st) { total += st.total; correct += st.correct }
  }
  return { total, correct }
}

// ---------------- 结算页 ----------------
function ResultPage({ results, comboBest, xpGain, progress, kind, dueTomorrow, onHome }: {
  results: SessionResult[]
  comboBest: number
  xpGain: number
  progress: ProgressV2
  kind: SessionKind
  dueTomorrow: number
  onHome: () => void
  onAgain: () => void
}) {
  // 这一轮的错因：从每题所选选项的标签汇总（答对不计）
  const errTags = summarizeTags(
    results.filter((r) => r.outcome !== 'correct').map((r) => r.q.optionTags?.[r.given]),
  )
  const firstTry = results.filter((r) => r.firstTryCorrect).length
  const retried = results.filter((r) => r.retriedCorrect === true).length
  const skipped = results.filter((r) => r.outcome === 'skipped').length
  const total = results.length
  const acc = total ? Math.round((firstTry / total) * 100) : 0
  useEffect(() => { sfx.finish() }, [])
  return (
    <div className="page center result">
      {acc >= 80 && <Confetti />}
      <div className="result-card">
        <div className="result-emoji">{acc >= 90 ? '🏆' : acc >= 70 ? '🔥' : '💪'}</div>
        <h1>{acc >= 90 ? '这一轮，学有所获' : acc >= 70 ? '又向前走了一步' : '慢慢来，每次练习都有收获'}</h1>
        <div className="kpi-row">
          <div className="kpi kpi-cyan">
            <div className="kpi-badge">🎯</div>
            <div className="kpi-value">{firstTry}</div>
            <div className="kpi-label">首发答对</div>
          </div>
          <div className="kpi kpi-green">
            <div className="kpi-badge">📊</div>
            <div className="kpi-value">{acc}%</div>
            <div className="kpi-label">首发正确率{retried > 0 ? ` · 二攻 ${retried}` : ''}{skipped > 0 ? ` · 跳过 ${skipped}` : ''}</div>
          </div>
          <div className="kpi kpi-purple">
            <div className="kpi-badge">✨</div>
            <div className="kpi-value">+{xpGain}</div>
            <div className="kpi-label">本关 XP</div>
          </div>
        </div>
        <div className="perf-strip" title="本关每题表现（绿=首发对 / 蓝=二攻对 / 红=未对）">
          {results.map((r, i) => (
            <span
              key={i}
              className={`bar ${r.retriedCorrect === true ? 'bar-r' : r.firstTryCorrect ? 'bar-c' : 'bar-w'}`}
              style={{ height: r.firstTryCorrect || r.retriedCorrect === true ? '100%' : '45%' }}
            />
          ))}
        </div>
        {errTags.length > 0 && (
          <div className="result-errors">
            <h3>这一轮你错在哪</h3>
            <ul>
              {errTags.slice(0, 3).map(({ tag, n }) => (
                <li key={tag}>
                  <span className="fix-tag">{tagLabel(tag)}</span>
                  <b>×{n}</b>
                  <p>{TAG_FIX[tag] ?? ''}</p>
                </li>
              ))}
            </ul>
            <p className="result-errors-note">
              同类位置再遇到时，先想"这句话要表达什么含义"，再决定形式——不要凭手感。
            </p>
          </div>
        )}
        <p className="result-note">
          {kind === 'review'
            ? '复习完成——先检索后讲解，这些知识点又往脑子里沉了一层。'
            : acc >= 80
              ? '本轮记录已保留。系统会根据每道题的到期时间安排后续巩固。'
              : '首次错误已保留。下次复习时，再检查这些容易混淆的地方。'}
        </p>
        <div className="result-next">
          ⏰ 未来 24 小时到期 {dueTomorrow} 道题 · ⭐ {progress.xp} XP · 🔥 {progress.streak} 天连续 · 本关连击 {comboBest}
        </div>
        <button className="primary" onClick={onHome}>回到学习空间</button>
      </div>
    </div>
  )
}
