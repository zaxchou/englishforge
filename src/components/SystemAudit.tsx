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
  /** 一键把重复题的"多余那些"毙掉（每组保留第一道）。**会等自检重新跑完**，否则数字不动、看起来像没生效 */
  onKillDuplicates: (ids: string[]) => Promise<void>
  /** 换模型（存库即时生效） */
  onModel: (model: string) => Promise<boolean>
  /** 跑一轮全自动流水线（审 → 改 → 复审，内部循环到待办归零） */
  onAiReview: (limit: number) => Promise<{ reviewed: number; killed: number; fixed: number; rewritten: number; remaining: number; reviewer: string | null; independent: boolean; error: string | null } | null>
  /** 最近一次自动流水线的结果（开机自动跑的那次也会显示在这里） */
  pipelineNote?: string | null
  /** 只看"系统认为有问题、要人定"的题（把人工量压到最小） */
  onShowFlagged: () => void
  /** 把之前"批量通过"的旧结论作废，交给 AI 重审 */
  onReopenBulk: () => Promise<number>
}

export function SystemAudit({ audit, ai, onKillDuplicates, onModel, onAiReview, pipelineNote, onShowFlagged, onReopenBulk }: Props) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [progress, setProgress] = useState('')
  const [showDup, setShowDup] = useState(false)
  const [showConflict, setShowConflict] = useState(false)
  const [modelDraft, setModelDraft] = useState('')
  const [modelOpen, setModelOpen] = useState(false)

  const dup = audit?.duplicates ?? []
  const conflicts = audit?.conflicts ?? []
  const missing = audit?.missingCause.count ?? 0

  /** 跑一遍全自动流水线（内部自己循环：审 → 改 → 复审，直到待办归零或没有进展） */
  async function aiReviewAll() {
    setBusy(true)
    setProgress('流水线运行中：审 → 改 → 复审…')
    const r = await onAiReview(60)
    setBusy(false)
    setProgress('')
    if (!r) { setMsg('调用失败：数据库未连接。'); return }
    setMsg(
      `流水线跑完：审 ${r.reviewed} 道 · 改写 ${r.rewritten} 篇 · 判毙 ${r.killed} 道 · 待机器处理还剩 ${Math.max(0, r.remaining)}` +
      (r.error ? ` · 中途出错：${shortError(r.error)}` : ''),
    )
  }

  /** 报错只显示人话；原始文本塞进 title（模型输出可能很长，不能整段铺在界面上） */
  function shortError(e: string) {
    if (/截断|length|没有返回可解析/.test(e)) return '模型输出被截断（已自动拆小重试）'
    if (/429|503|502|500/.test(e)) return '模型服务暂时不可用'
    return e.length > 60 ? e.slice(0, 60) + '…' : e
  }

  async function killDuplicates() {
    const ids = dup.flatMap((g) => g.extras.map((e) => e.id))
    if (!ids.length) return
    if (!confirm(`把 ${ids.length} 道重复题标为「毙掉」？（每组保留一道，毙掉的退出抽题，并不再计入自检）`)) return
    setBusy(true)
    setMsg('正在毙掉，并重新自检…')
    await onKillDuplicates(ids)
    setBusy(false)
    setMsg(`已毙掉 ${ids.length} 道重复题（已退出抽题，也不再计入下面的统计）。`)
  }

  return (
    <section className="sysaudit">
      <div className="sysaudit-head">
        <h2>系统自检</h2>
        <span className="ai-wrap">
          <button className={`ai-pill ${ai?.configured ? 'is-on' : 'is-off'}`} onClick={() => { setModelDraft(ai?.model ?? ''); setModelOpen(!modelOpen) }}>
            {ai?.configured
              ? `出题 ${ai.providerLabel ?? ''} ${ai.model}（模型来自${ai.modelSource ?? '?'}）`
              : '系统 AI 未配置（在 molin-wiki/backend/.env 放 API KEY）'}
          </button>
          {modelOpen && ai?.configured && (
            <form
              className="ai-model-form"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!modelDraft.trim()) return
                const ok = await onModel(modelDraft.trim())
                setMsg(ok ? `已切换为 ${modelDraft.trim()}` : '切换失败：数据库未连接。')
                setModelOpen(false)
              }}
            >
              <input value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} placeholder="例如 deepseek-flash" aria-label="模型名" />
              <button className="secondary" type="submit" disabled={ai.envLocked}>换模型</button>
              {ai.envLocked && <span className="ai-lock">环境变量锁定了模型名，界面改不动</span>}
            </form>
          )}
        </span>
      </div>
      <p className="sysaudit-note">
        这些都是系统自己查、自己修，<b>你完全不用逐题审</b>：<b>AI 流水线</b>把「审核（另一个模型）
        → 按意见改稿 → 复审」串成一条自动链，开机有待办就自己跑，跑到归零为止；
        人工的"通过/毙掉"结论机器也会复核（你之前说过"看都不看就全部通过"，所以不当数）。
        补出来的逐项纠正会存进你的账户，做错题时立刻就能看到「你选的那条等于在说什么意思」。
        {!!audit?.quarantined && <b>（你已经毙掉 {audit.quarantined} 道题，它们已退出抽题、也不再计入下面的统计。）</b>}
      </p>

      {/* AI 流水线：审（另一个模型）→ 按意见改稿 → 复审，全自动，人不在链上 */}
      <div className="sysaudit-card is-wide is-ai">
        <span>AI 流水线（审 → 改 → 复审 · 全自动）</span>
        <b>{audit ? `${audit.pipelinePending ?? 0} 道待机器处理` : '—'}</b>
        <small>
          {ai?.review?.configured
            ? <>审核员：<b>{ai.review.providerLabel} · {ai.review.model}</b>
              {ai.independentReview
                ? '（与出题人不是同一家，算独立审核）'
                : '（和出题人同一家，只能算自查 —— 建议在 molin-wiki/.env 里配上另一家的 KEY）'}
              </>
            : '审核模型未配置'}
          {audit && audit.flagged.count > 0 && <> · 改了仍不过的 <b>{audit.flagged.count}</b> 道（流水线自动剩下，好奇再看）</>}
          {audit && audit.aiReviewed > 0 && <> · 已由 AI 定版 {audit.aiReviewed} 道</>}
          {audit && audit.bulkPending > 0 && <> · 另有 {audit.bulkPending} 道旧"批量通过"（机器复核中，不用管）</>}
          {audit && audit.sentenceReuse.groupsOver > 0 && (
            <> · 另有 {audit.sentenceReuse.groupsOver} 个句子被 2 道以上题目反复考，
              已按"同一句最多 {audit.sentenceReuse.cap} 道"收口（抽题池少 {audit.sentenceReuse.dropIfCapped} 道，题库里仍保留）</>
          )}
        </small>
        <div className="sysaudit-actions">
          {!!audit?.bulkPending && (
            <button className="secondary" onClick={async () => {
              if (!confirm(`把这 ${audit.bulkPending} 道「批量通过」的旧结论作废，交给 AI 重审？
（你之前那种"全部通过"不算真审过；作废后 AI 会逐题给出结论与理由）`)) return
              setBusy(true)
              const n = await onReopenBulk()
              setBusy(false)
              setMsg(`已把 ${n} 道交回待审，点「一键审完」就会由 AI 逐题审。`)
            }} disabled={busy}>
              交回 AI 重审（{audit.bulkPending}）
            </button>
          )}
          <button className="secondary" onClick={() => void aiReviewAll()} disabled={busy || !audit?.pipelinePending || !ai?.review?.configured}>
            {busy ? '流水线运行中…' : `跑一遍流水线（${audit?.pipelinePending ?? 0} 道待处理）`}
          </button>
          <button className="secondary" onClick={async () => { setBusy(true); setMsg('正在跑一批…'); const r = await onAiReview(20); setBusy(false); setMsg(r ? `审 ${r.reviewed} 道 · 改写 ${r.rewritten} 篇（判毙 ${r.killed} · 要改 ${r.fixed}）· 还剩 ${Math.max(0, r.remaining)} 道` : '失败') }} disabled={busy || !audit?.pipelinePending || !ai?.review?.configured}>
            只跑一批（20 道）
          </button>
          {!!audit?.flagged.count && <button className="text-button" onClick={onShowFlagged}>看流水线改了仍不过的（{audit.flagged.count}）</button>}
        </div>
        {pipelineNote && <p className="sysaudit-note">{pipelineNote}</p>}
      </div>

      <div className="sysaudit-grid">
        <div className="sysaudit-card">
          <span>重复题</span>
          <b>{dup.length} 组</b>
          <small>{audit?.duplicateCount ?? 0} 道是多余的（题干与答案完全相同，只是标点/空格不同）</small>
          <div className="sysaudit-actions">
            <button className="secondary" onClick={() => void killDuplicates()} disabled={busy || !dup.length}>自动毙掉多余的</button>
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
            {missing > 0
              ? <> 出题 AI 在后台自动补齐（开机接着流水线跑），<b>不需要任何人操作</b>。</>
              : <> 已全部补齐。</>}
          </small>
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
