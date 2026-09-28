// 内容审核页：把语料派生的题一次列全，供人工逐题核对（R1-03）。
// 为什么放在 app 里：审核者本人就坐在浏览器前，给仓库路径没法用。
// 标记存在独立的 localStorage 键里，不碰学习进度。
import { useMemo, useState } from 'react'
import type { AdaptedQuestion } from '../types'
import { saveReviewMarks, type ReviewMarks } from '../content/reviewMarks'
import type { AiStatus, DbAudit } from '../store/db'
import { SystemAudit } from './SystemAudit'
import './content-review.css'

const DIFF = ['', '基础', '进阶', '挑战']

export function ContentReview({ questions, marks, onMarks, onExit, audit, ai, onKillDuplicates, onModel, onAiReview, onReopenBulk, onEnrich }: {
  questions: AdaptedQuestion[]
  marks: ReviewMarks
  onMarks: (m: ReviewMarks) => void
  onExit: () => void
  audit: DbAudit | null
  ai: AiStatus | null
  onKillDuplicates: (ids: string[]) => Promise<void>
  onModel: (model: string) => Promise<boolean>
  onAiReview: (limit: number) => Promise<{ reviewed: number; killed: number; fixed: number; remaining: number; reviewer: string | null; independent: boolean; error: string | null } | null>
  onReopenBulk: () => Promise<number>
  onEnrich: (limit: number) => Promise<{ enriched: number; rejected: number; truncated: number; remaining: number; error: string | null } | null>
}) {
  const drafts = useMemo(() => questions.filter((q) => q.reviewStatus === 'draft'), [questions])
  // 默认范围：还有待审核的就显示待审核；全审完了就显示全部（否则用户会以为"题不见了"）
  const [scope, setScope] = useState<'draft' | 'corpus' | 'all' | 'flagged'>(() => (drafts.length ? 'draft' : 'all'))
  const [notice, setNotice] = useState('')
  const corpus = useMemo(
    () => questions.filter((q) => /(tatoeba|ud-en-ewt):/.test(q.sourceRef ?? '')),
    [questions],
  )
  // "要我决定的" = 系统判毙或要求改的题（人工量压到最小）
  const flagged = useMemo(
    () => questions.filter((q) => { const v = marks[q.id]?.verdict; return v === 'kill' || v === 'fix' }),
    [questions, marks],
  )
  const shown = scope === 'corpus' ? corpus : scope === 'draft' ? drafts : scope === 'flagged' ? flagged : questions

  function update(qid: string, patch: { verdict?: 'ok' | 'fix' | 'kill'; note?: string }) {
    const next: ReviewMarks = { ...marks, [qid]: { ...(marks[qid] ?? {}), ...patch } }
    onMarks(next)
    saveReviewMarks(next)
  }

  /** 批量通过：旧题是人工写的、不是机器生成，逐题点不现实。
   *  **只作用于"还没标记"的题** —— 绝不能覆盖你已经做过的判断（尤其"毙掉"）。
   *  实测踩过：批量通过把用户刚毙掉的重复题又改回"通过"，他就看到"点毙掉没有用"。 */
  function approveAll() {
    const pending = shown.filter((q) => !marks[q.id]?.verdict)
    if (!pending.length) { setNotice('这些题都已经标记过了，批量通过不会覆盖你已有的判断。'); return }
    const kept = shown.length - pending.length
    if (!confirm(`把还没标记的 ${pending.length} 题标为「通过」？` +
      (kept ? `\n（已有标记的 ${kept} 题保持原样，不会覆盖，包括你毙掉的）` : '') +
      '\n通过后它们会开始计入你的掌握度。')) return
    const next: ReviewMarks = { ...marks }
    // 标成 bulk（批量通过），不是 human：这种"没细看"的通过不该被当成真审过，
    // AI 审核有权把它拿回来重审（用户自己说"我可能看都不看就全部通过了"）
    for (const q of pending) next[q.id] = { ...(next[q.id] ?? {}), verdict: 'ok', source: 'bulk' }
    onMarks(next)
    saveReviewMarks(next)
  }

  const counts = useMemo(() => {
    const c = { ok: 0, fix: 0, kill: 0, none: 0 }
    for (const q of shown) {
      const v = marks[q.id]?.verdict
      if (v === 'ok' || v === 'fix' || v === 'kill') c[v] += 1
      else c.none += 1
    }
    return c
  }, [shown, marks])

  const exportText = useMemo(() => JSON.stringify({
    exportedAt: new Date().toISOString(),
    counts,
    items: shown.map((q) => ({
      id: q.id,
      kind: (q.prompt ?? '').includes('___') ? '框架填空' : '中文意思题',
      prompt: q.prompt,
      answer: q.answer,
      sourceRef: q.sourceRef,
      verdict: marks[q.id]?.verdict ?? null,
      note: marks[q.id]?.note ?? '',
    })),
  }, null, 1), [shown, marks, counts])

  function download() {
    const blob = new Blob([exportText], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `content-review-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="review-page">
      {/* 系统自检放最上面：先让系统把自己能发现的毛病找出来，再逐题看 */}
      <SystemAudit
        audit={audit}
        ai={ai}
        onKillDuplicates={onKillDuplicates}
        onModel={onModel}
        onEnrich={onEnrich}
        onAiReview={onAiReview}
        onShowFlagged={() => { setScope('flagged') }}
        onReopenBulk={onReopenBulk}
      />
      <header className="review-head">
        <div>
          <h1>内容审核 · 逐题核对</h1>
          <p>
            题库共 {questions.length} 道题。逐题看四件事：<b>句子像不像人话</b>、
            <b>干扰项是不是"错在该错的地方"</b>（你要能用"含义"排除它，而不是靠读着别扭）、
            <b>中文释义对不对</b>、<b>解析是不是张老师的口吻</b>（不该出现"三单规则"这类术语）。
            这里的结论会决定题目算不算能力证据：<b>通过</b>才计入掌握度，<b>毙掉</b>则退出抽题（且不再出现在系统自检里）。
          </p>
          {notice && <p className="review-notice">{notice}</p>}
          <div className="review-scope">
            <button className={scope === 'draft' ? 'on' : ''} onClick={() => setScope('draft')}>待审核（{drafts.length}）</button>
            <button className={scope === 'corpus' ? 'on' : ''} onClick={() => setScope('corpus')}>语料派生题（{corpus.length}）</button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>全部题目（{questions.length}）</button>
            <button className={scope === 'flagged' ? 'on' : ''} onClick={() => setScope('flagged')}>要你决定的（{flagged.length}）</button>
          </div>
          <p className="review-hint">
            标记只存在本地。<b>点「通过」= 把它升为 reviewed，从此你的作答才开始计入掌握度</b>
            （这正是进度一直不动的根因）；「毙掉」= 退出抽题；「要改」= 可继续练但不认证。标完点「下载结果」给我即可。
          </p>
        </div>
        <div className="review-side">
          <div className="review-counts">
            <span className="c-ok">通过 {counts.ok}</span>
            <span className="c-fix">要改 {counts.fix}</span>
            <span className="c-kill">毙掉 {counts.kill}</span>
            <span>未看 {counts.none}</span>
          </div>
          <div className="review-btns">
            <button className="secondary" onClick={() => { void navigator.clipboard?.writeText(exportText) }}>
              复制结果
            </button>
            <button className="secondary" onClick={download}>下载结果</button>
            <button className="secondary" onClick={approveAll}>本页全部通过（{shown.length}）</button>
            <button className="primary" onClick={onExit}>返回学习空间</button>
          </div>
        </div>
      </header>

      <ol className="review-list">
        {shown.map((q, i) => {
          const mark = marks[q.id] ?? {}
          const kind = (q.prompt ?? '').includes('___') ? '框架填空' : '中文意思题'
          return (
            <li key={q.id} className={`review-item ${mark.verdict ?? ''}`}>
              <div className="review-item-head">
                <span className="review-no">{String(i + 1).padStart(2, '0')}</span>
                <span className="review-kind">{kind}</span>
                <span className={'diff-tag diff-' + (q.diff ?? 1)}>{DIFF[q.diff ?? 1]}</span>
                <span className={`review-status st-${q.reviewStatus}`}>
                  {q.reviewStatus === 'reviewed' ? '✅ 已通过·计入掌握度' : q.reviewStatus === 'quarantined' ? '🚫 已毙掉' : '待审核'}
                </span>
                <code className="review-src">{q.sourceRef}</code>
              </div>
              <div className="review-prompt">
                {q.prompt}
                {q.tts && <span className="review-tts">🔊 {q.tts}</span>}
              </div>
              <ul className="review-opts">
                {(q.options ?? []).map((o) => {
                  const right = o === q.answer
                  return (
                    <li key={o} className={right ? 'right' : 'wrong'}>
                      <span className="mark">{right ? '✅' : '❌'}</span>
                      <span className="text">{o}</span>
                      {!right && q.optionFeedback?.[o] && (
                        <em className="fb">{q.optionFeedback[o]}</em>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="review-explain"><b>解析</b>：{q.explain}</div>
              <div className="review-verdict">
                {(['ok', 'fix', 'kill'] as const).map((v) => (
                  <button
                    key={v}
                    className={`verdict-btn ${v} ${mark.verdict === v ? 'on' : ''}`}
                    onClick={() => update(q.id, { verdict: v })}
                  >
                    {v === 'ok' ? '通过' : v === 'fix' ? '要改' : '毙掉'}
                  </button>
                ))}
                <input
                  className="verdict-note"
                  placeholder="备注：哪里要改（可选）"
                  value={mark.note ?? ''}
                  onChange={(e) => update(q.id, { note: e.target.value })}
                />
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
