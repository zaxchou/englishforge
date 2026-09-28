// 「系统自检」面板：让**系统自己**发现并修内容问题，而不是靠人在仓库外跑脚本。
//
// 用户的原话：「这个管线是系统本身的 AI 进行的纠正，而不是你 agent，这样我做完错题，
// 系统就能自我修复，它不可能使用你这个 agent 来进行修正，这样就不自动化了。」
//
// 所以这一块做三件事，都在界面上、点一下就跑：
//   1. 查重（纯规则，不花模型调用）：题干+答案完全相同的题 → 可一键毙掉多余的；
//   2. 找"打架"的题（同一题干、答案不同）—— 这个更危险，只报告，由人决定；
//   3. 让系统 AI 给缺逐项纠正的题补上「你选的那条等于在说什么意思」+ 错因标签。
import { useState } from 'react'
import type { AiStatus, DbAudit } from '../store/db'

interface Props {
  audit: DbAudit | null
  ai: AiStatus | null
  /** 一键把重复题的"多余那些"毙掉（每组保留第一道） */
  onKillDuplicates: (ids: string[]) => void
  /** 让系统 AI 补一批 */
  onEnrich: (limit: number) => Promise<{ enriched: number; rejected: number; truncated: number; remaining: number; error: string | null } | null>
}

export function SystemAudit({ audit, ai, onKillDuplicates, onEnrich }: Props) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [progress, setProgress] = useState('')
  const [showDup, setShowDup] = useState(false)
  const [showConflict, setShowConflict] = useState(false)

  const dup = audit?.duplicates ?? []
  const conflicts = audit?.conflicts ?? []
  const missing = audit?.missingCause.count ?? 0

  /** 一轮：让系统补 limit 道，返回本轮结果 */
  async function enrich(limit: number) {
    setBusy(true)
    setMsg(`正在让系统 AI 补 ${limit} 道题…`)
    setProgress('')
    const r = await onEnrich(limit)
    setBusy(false)
    if (!r) { setMsg('调用失败：数据库未连接。'); return null }
    setMsg(
      `补好 ${r.enriched} 道，丢弃 ${r.rejected} 条不合规内容（宁缺勿错）` +
      (r.truncated ? ` · ${r.truncated} 批输出过长已自动拆小重试` : '') +
      (r.error ? ` · 有调用失败：${shortError(r.error)}` : '') +
      ` · 还剩 ${r.remaining} 道`,
    )
    return r
  }

  /** 一键补完：连续跑，直到补完、或连续两轮没有进展（避免死循环烧调用） */
  async function enrichAll() {
    setBusy(true)
    let total = 0, stale = 0, lastRemaining = missing
    for (let i = 0; i < 200; i++) {
      const r = await onEnrich(24)
      if (!r) { setBusy(false); setMsg(`已补 ${total} 道 · 数据库断开，先停下。`); return }
      total += r.enriched
      const remaining = r.remaining
      stale = r.enriched === 0 ? stale + 1 : 0
      setProgress(`已补 ${total} 道 · 还剩 ${remaining} 道 · 第 ${i + 1} 批`)
      if (remaining === 0) { setBusy(false); setProgress(''); setMsg(`全部补完：共补 ${total} 道。`); return }
      if (stale >= 2) {
        setBusy(false); setProgress('')
        setMsg(`已补 ${total} 道 · 还剩 ${remaining} 道，连续两批没有进展，先停下（多半是模型调用不稳，过会儿再点）。`)
        return
      }
      lastRemaining = remaining
    }
    setBusy(false); setProgress('')
    setMsg(`已补 ${total} 道 · 还剩 ${lastRemaining} 道（跑满 200 批上限，可再点一次继续）`)
  }

  /** 报错只显示人话；原始文本塞进 title（模型输出可能很长，不能整段铺在界面上） */
  function shortError(e: string) {
    if (/截断|length|没有返回可解析/.test(e)) return '模型输出被截断（已自动拆小重试）'
    if (/429|503|502|500/.test(e)) return '模型服务暂时不可用'
    return e.length > 60 ? e.slice(0, 60) + '…' : e
  }

  function killDuplicates() {
    const ids = dup.flatMap((g) => g.extras.map((e) => e.id))
    if (!ids.length) return
    if (!confirm(`把 ${ids.length} 道重复题标为「毙掉」？（每组保留一道，毙掉的退出抽题）`)) return
    onKillDuplicates(ids)
    setMsg(`已毙掉 ${ids.length} 道重复题。`)
  }

  return (
    <section className="sysaudit">
      <div className="sysaudit-head">
        <h2>系统自检</h2>
        <span className={`ai-pill ${ai?.configured ? 'is-on' : 'is-off'}`}>
          {ai?.configured ? `系统 AI 已就绪 · ${ai.model}（读自${ai.source}）` : '系统 AI 未配置（在 molin-wiki/backend/.env 放 DEEPSEEK_API_KEY）'}
        </span>
      </div>
      <p className="sysaudit-note">
        这三项都由系统自己查、自己修，不需要人在仓库外跑脚本。补出来的逐项纠正会存进你的账户，
        做错题时立刻就能看到「你选的那条等于在说什么意思」。
      </p>

      <div className="sysaudit-grid">
        <div className="sysaudit-card">
          <span>重复题</span>
          <b>{dup.length} 组</b>
          <small>{audit?.duplicateCount ?? 0} 道是多余的（题干与答案完全相同，只是标点/空格不同）</small>
          <div className="sysaudit-actions">
            <button className="secondary" onClick={killDuplicates} disabled={!dup.length}>自动毙掉多余的</button>
            {dup.length > 0 && <button className="text-button" onClick={() => setShowDup(!showDup)}>{showDup ? '收起' : '看看是哪些'}</button>}
          </div>
        </div>

        <div className="sysaudit-card">
          <span>互相打架的题</span>
          <b>{conflicts.length} 组</b>
          <small>同一题干、答案不一样 —— 必有一道在教错，只报告不自动改</small>
          <div className="sysaudit-actions">
            {conflicts.length > 0 && <button className="text-button" onClick={() => setShowConflict(!showConflict)}>{showConflict ? '收起' : '看看是哪些'}</button>}
          </div>
        </div>

        <div className="sysaudit-card is-wide">
          <span>缺逐项纠正的题</span>
          <b>{missing} 道</b>
          <small>
            这些题答错时只能看到整体解析，看不到"你这条错在哪"。
            已补 {audit?.enrichedCount ?? 0} 道。
          </small>
          <div className="sysaudit-actions">
            <button className="secondary" onClick={() => void enrichAll()} disabled={busy || !missing || !ai?.configured}>
              {busy ? '正在补…' : `一键补齐（还剩 ${missing} 道）`}
            </button>
            <button className="secondary" onClick={() => void enrich(24)} disabled={busy || !missing || !ai?.configured}>
              只补一批（24 道）
            </button>
          </div>
        </div>
      </div>

      {msg && <p className="sysaudit-msg">{msg}</p>}
      {progress && <p className="sysaudit-msg is-dim">{progress}</p>}

      {showDup && (
        <div className="sysaudit-list">
          <h3>重复题（每组保留第一道）</h3>
          {dup.slice(0, 40).map((g, i) => (
            <div className="dupg" key={i}>
              <div className="dupg-keep"><b>保留</b> {g.keep.id} · {g.keep.prompt}</div>
              {g.extras.map((e) => <div className="dupg-extra" key={e.id}>毙掉 {e.id}</div>)}
            </div>
          ))}
          {dup.length > 40 && <p className="sysaudit-msg">（只显示前 40 组）</p>}
        </div>
      )}

      {showConflict && (
        <div className="sysaudit-list">
          <h3>互相打架的题（同一题干、答案不同）</h3>
          {conflicts.slice(0, 30).map((g, i) => (
            <div className="dupg" key={i}>
              <div className="dupg-keep">{g.variants[0].prompt}</div>
              {g.variants.map((v) => <div className="dupg-extra" key={v.id}>{v.id} → 答案「{v.answer}」</div>)}
            </div>
          ))}
          {conflicts.length > 30 && <p className="sysaudit-msg">（只显示前 30 组）</p>}
        </div>
      )}
    </section>
  )
}
