// 内容审核页：把语料派生的题一次列全，供人工逐题核对（R1-03）。
// 为什么放在 app 里：审核者本人就坐在浏览器前，给仓库路径没法用。
// 标记存在独立的 localStorage 键里，不碰学习进度。
import { useMemo, useState } from 'react'
import type { AdaptedQuestion } from '../types'
import { saveReviewMarks, type ReviewMarks } from '../content/reviewMarks'
import './content-review.css'

const DIFF = ['', '基础', '进阶', '挑战']

export function ContentReview({ questions, marks, onMarks, onExit }: {
  questions: AdaptedQuestion[]
  marks: ReviewMarks
  onMarks: (m: ReviewMarks) => void
  onExit: () => void
}) {
  const [scope, setScope] = useState<'corpus' | 'all'>('corpus')
  const corpus = useMemo(
    () => questions.filter((q) => /(tatoeba|ud-en-ewt):/.test(q.sourceRef ?? '')),
    [questions],
  )
  const shown = scope === 'corpus' ? corpus : questions

  function update(qid: string, patch: { verdict?: 'ok' | 'fix' | 'kill'; note?: string }) {
    const next: ReviewMarks = { ...marks, [qid]: { ...(marks[qid] ?? {}), ...patch } }
    onMarks(next)
    saveReviewMarks(next)
  }

  /** 批量通过：旧题是人工写的、不是机器生成，逐题点不现实 */
  function approveAll() {
    if (!confirm(`把这 ${shown.length} 题全部标为「通过」？
通过后它们会开始计入你的掌握度。`)) return
    const next: ReviewMarks = { ...marks }
    for (const q of shown) next[q.id] = { ...(next[q.id] ?? {}), verdict: 'ok' }
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
      <header className="review-head">
        <div>
          <h1>内容审核 · 语料派生题</h1>
          <p>
            共 {questions.length} 道待审核题（语料派生 {corpus.length} 道）。逐题看四件事：<b>句子像不像人话</b>、
            <b>干扰项是不是"错在该错的地方"</b>（你要能用"含义"排除它，而不是靠读着别扭）、
            <b>中文释义对不对</b>、<b>解析是不是张老师的口吻</b>（不该出现"三单规则"这类术语）。
          </p>
          <div className="review-scope">
            <button className={scope === 'corpus' ? 'on' : ''} onClick={() => setScope('corpus')}>语料派生题（{corpus.length}）</button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>全部未审核题（{questions.length}）</button>
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
