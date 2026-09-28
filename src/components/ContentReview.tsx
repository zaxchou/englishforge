// 内容审核页：把语料派生的题一次列全，供人工逐题核对（R1-03）。
// 为什么放在 app 里：审核者本人就坐在浏览器前，给仓库路径没法用。
// 标记存在独立的 localStorage 键里，不碰学习进度。
import { useMemo, useState } from 'react'
import type { AdaptedQuestion } from '../types'
import './content-review.css'

export type Verdict = 'ok' | 'fix' | 'kill'
type Mark = { verdict?: Verdict; note?: string }
type Marks = Record<string, Mark>

const KEY = 'sf-content-review'

function load(): Marks {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    return raw && typeof raw === 'object' ? (raw as Marks) : {}
  } catch {
    return {}
  }
}
function persist(m: Marks) {
  try { localStorage.setItem(KEY, JSON.stringify(m)) } catch { /* 存不上不影响审核 */ }
}

const DIFF = ['', '基础', '进阶', '挑战']

export function ContentReview({ questions, onExit }: { questions: AdaptedQuestion[]; onExit: () => void }) {
  const [marks, setMarks] = useState<Marks>(() => load())

  function update(qid: string, patch: Mark) {
    const next: Marks = { ...marks, [qid]: { ...(marks[qid] ?? {}), ...patch } }
    setMarks(next)
    persist(next)
  }

  const counts = useMemo(() => {
    const c = { ok: 0, fix: 0, kill: 0, none: 0 }
    for (const q of questions) {
      const v = marks[q.id]?.verdict
      if (v === 'ok' || v === 'fix' || v === 'kill') c[v] += 1
      else c.none += 1
    }
    return c
  }, [questions, marks])

  const exportText = useMemo(() => JSON.stringify({
    exportedAt: new Date().toISOString(),
    counts,
    items: questions.map((q) => ({
      id: q.id,
      kind: (q.prompt ?? '').includes('___') ? '框架填空' : '中文意思题',
      prompt: q.prompt,
      answer: q.answer,
      sourceRef: q.sourceRef,
      verdict: marks[q.id]?.verdict ?? null,
      note: marks[q.id]?.note ?? '',
    })),
  }, null, 1), [questions, marks, counts])

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
            共 {questions.length} 题。逐题看四件事：<b>句子像不像人话</b>、
            <b>干扰项是不是"错在该错的地方"</b>（你要能用"含义"排除它，而不是靠读着别扭）、
            <b>中文释义对不对</b>、<b>解析是不是张老师的口吻</b>（不该出现"三单规则"这类术语）。
          </p>
          <p className="review-hint">
            标记只存在本地，不影响学习进度。标完点「下载审核结果」把文件给我即可。
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
            <button className="primary" onClick={onExit}>返回学习空间</button>
          </div>
        </div>
      </header>

      <ol className="review-list">
        {questions.map((q, i) => {
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
