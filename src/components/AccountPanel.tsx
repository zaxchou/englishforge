// 「账户与进度数据库」面板。
//
// 用户的原话是"为了防止你看不到我的进度，干脆把账户系统做了" —— 所以这个面板要回答两个
// 具体问题：进度到底存进库了没有（可验证）、万一丢了我能不能拿回来（快照可恢复）。
// 它只出现在「回顾」页里，不挡在推进路径上。
import { useState } from 'react'
import type { DbAccount, DbState, DbStats, SnapshotInfo } from '../store/db'
import { fetchSnapshots, makeSnapshot, restoreSnapshot } from '../store/db'

export interface DbPanelProps {
  account: DbAccount | null
  accounts: DbAccount[]
  dbState: DbState
  stats: DbStats | null
  syncedAt: number
  onRename: (name: string) => void
  onNewAccount: (name: string) => void
  onSwitch: (id: string) => void
  onSyncNow: () => void
  onReload: () => void
  onRefreshStats: () => void
}

function timeOf(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function pct(part: number, whole: number): string {
  return whole > 0 ? Math.round((part / whole) * 100) + '%' : '—'
}

export function AccountPanel({
  account, accounts, dbState, stats, syncedAt,
  onRename, onNewAccount, onSwitch, onSyncNow, onReload, onRefreshStats,
}: DbPanelProps) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [snap, setSnap] = useState<{ accountId: string; list: SnapshotInfo[] } | null>(null)
  const [msg, setMsg] = useState('')

  const accountId = account?.id ?? ''
  // 快照跟着账户走：换了账户就等于收起（不用 effect，直接派生）
  const snapshots = snap && snap.accountId === accountId ? snap.list : null

  async function loadSnapshots() {
    if (!accountId) return
    setMsg('正在读取快照…')
    const list = await fetchSnapshots(accountId)
    setSnap(list ? { accountId, list } : null)
    setMsg(list ? '' : '数据库未连接，读不到快照。')
  }

  async function doRestore(id: number) {
    if (!confirm('用这份快照覆盖当前进度？\n（当前进度会先自动留一份新快照，可以再换回来）')) return
    setMsg('正在恢复…')
    const ok = await restoreSnapshot(id)
    if (!ok) { setMsg('恢复失败：数据库未连接。'); return }
    setMsg('已按快照恢复，正在重新载入…')
    onReload()
  }

  /** 手动留一份快照：用户想试点什么之前，先有个能回来的点 */
  async function doSnapshot() {
    if (!accountId) return
    setMsg('正在留存快照…')
    const ok = await makeSnapshot(accountId, 'manual')
    if (!ok) { setMsg('留存失败：数据库未连接。'); return }
    const list = await fetchSnapshots(accountId)
    setSnap(list ? { accountId, list } : null)
    setMsg('已留存一份快照。')
  }

  const statusText = !account
    ? '正在连接进度数据库…'
    : dbState === 'offline'
      ? '未连接（进度仍保存在本机浏览器里，练习照常；连上后会自动补写）'
      : dbState === 'connecting'
        ? '正在写入…'
        : `已连接 · 最近写入 ${timeOf(syncedAt)}`

  const tone = !account ? 'wait' : dbState === 'offline' ? 'off' : dbState === 'connecting' ? 'wait' : 'on'

  return (
    <section className="account-panel" id="account">
      <div className="account-head">
        <h2>账户与进度数据库</h2>
        <span className={`db-dot is-${tone}`}><i aria-hidden="true" />{statusText}</span>
      </div>

      <div className="account-row">
        {account ? (
          renaming ? (
            <form
              className="account-form"
              onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onRename(draft.trim()); setRenaming(false) } }}
            >
              <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={30} autoFocus aria-label="账户名" />
              <button className="secondary" type="submit">保存</button>
              <button className="text-button" type="button" onClick={() => setRenaming(false)}>取消</button>
            </form>
          ) : (
            <>
              <span className="account-chip"><b>{account.name}</b><code>{account.id}</code></span>
              <button className="text-button" onClick={() => { setDraft(account.name); setRenaming(true) }}>改名</button>
            </>
          )
        ) : (
          <span className="account-chip"><b>尚未连接</b><code>离线模式</code></span>
        )}
        {accounts.length > 1 && account && (
          <label className="account-switch">
            切换账户
            <select value={account.id} onChange={(e) => onSwitch(e.target.value)} aria-label="切换账户">
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}（{a.attempts} 条记录）</option>)}
            </select>
          </label>
        )}
        <div className="account-actions">
          <button className="secondary" onClick={onSyncNow} disabled={!account}>立即写入</button>
          <button className="secondary" onClick={onReload} disabled={!account}>按数据库重载</button>
          <button className="secondary" onClick={() => { onRefreshStats(); void loadSnapshots() }} disabled={!account}>刷新</button>
          {creating ? (
            <form
              className="account-form"
              onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { onNewAccount(newName.trim()); setCreating(false); setNewName('') } }}
            >
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新账户名" maxLength={30} autoFocus aria-label="新账户名" />
              <button className="secondary" type="submit">创建并切换</button>
              <button className="text-button" type="button" onClick={() => setCreating(false)}>取消</button>
            </form>
          ) : (
            <button className="text-button" onClick={() => setCreating(true)} disabled={dbState === 'offline'}>新建账户</button>
          )}
        </div>
      </div>

      {stats && account && (
        <>
          <div className="account-grid">
            <div><span>作答事件</span><b>{stats.attempts.toLocaleString('zh-CN')}</b><small>首发 {stats.attemptsFirst} 条</small></div>
            <div><span>首发答对</span><b>{stats.attemptsCorrectFirst}</b><small>{pct(stats.attemptsCorrectFirst, stats.attemptsFirst)} 正确率</small></div>
            <div><span>练过的题</span><b>{stats.questionsPracticed}</b><small>状态记录 {stats.questionStates} 条</small></div>
            <div><span>练习记录</span><b>{stats.sessions}</b><small>{stats.dailyXpDays} 个训练日</small></div>
            <div><span>到期复习</span><b>{stats.dueNow}</b><small>XP {stats.xp} · 连续 {stats.streak} 天</small></div>
            <div><span>题目审核</span><b>{stats.reviews}</b><small>快照 {stats.snapshots} 份</small></div>
          </div>

          {stats.objectives.length > 0 && (
            <div className="account-objectives">
              <h3>各知识点（来自数据库的原始统计）</h3>
              <ul>
                {stats.objectives.slice(0, 8).map((o) => (
                  <li key={o.objective_id}>
                    <span className="obj-id">{o.objective_id}</span>
                    <span>{o.attempts} 次作答</span>
                    <span>首发正确率 {pct(o.first_correct, o.attempts)}</span>
                    <span>跨 {o.days} 天</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {stats.errorTags.length > 0 && (
            <div className="account-errors">
              <h3>错因分布</h3>
              <ul>{stats.errorTags.slice(0, 6).map((t) => <li key={t.tag}><code>{t.tag}</code><b>×{t.n}</b></li>)}</ul>
            </div>
          )}
        </>
      )}

      <div className="account-snapshots">
        <div className="snap-head">
          <h3>存档快照（导入 / 清空前自动留存）</h3>
          <div className="snap-actions">
            <button className="secondary" onClick={() => void doSnapshot()} disabled={!account}>留一份快照</button>
            {snapshots === null
              ? <button className="text-button" onClick={() => void loadSnapshots()} disabled={!account}>查看快照</button>
              : <button className="text-button" onClick={() => setSnap(null)}>收起</button>}
          </div>
        </div>
        {snapshots !== null && (
          snapshots.length === 0
            ? <p className="account-empty">还没有快照。做过一次导入或清空后，这里会出现可回捞的存档。</p>
            : <ul className="snap-list">
              {snapshots.map((s) => (
                <li key={s.id}>
                  <span>{timeOf(s.createdAt)}</span>
                  <span className="snap-reason">{s.reason}</span>
                  <span>{Math.round(s.bytes / 1024)} KB</span>
                  <button className="text-button" onClick={() => void doRestore(s.id)}>恢复</button>
                </li>
              ))}
            </ul>
        )}
      </div>

      {msg && <p className="account-msg">{msg}</p>}
      <p className="account-note">
        进度同时保存在两处：本机浏览器（离线也能练）与数据库（可查询、可回溯、换浏览器也在）。
        数据库不可用时应用自动退回本地模式，练习与判分完全不受影响。
      </p>
    </section>
  )
}
