// 账户切换器（点左侧栏底部的账户卡打开）。
//
// 用户的原话是「你这个账户我现在也不知道怎么登录、怎么切换账户，现在我只能看到一个默认账户」——
// 问题是账户管理此前只藏在「回顾 → 账户与进度数据库」里。
//
// 这里要把话说清楚（写在界面上，不写在文档里）：这是本机单人使用的应用，**没有密码**，
// 账户的作用是把"进度 + 题库 + 审核结论"整包分开，方便一个人试不同的练法、
// 或者将来给家里人各开一个。真正的登录（多设备、多用户）是另一件事，需要服务端 —— 现在还没做。
import { useState } from 'react'
import type { DbAccount, DbState } from '../store/db'

interface Props {
  account: DbAccount | null
  accounts: DbAccount[]
  dbState: DbState
  onClose: () => void
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onRename: (name: string) => void
}

export function AccountSwitcher({ account, accounts, dbState, onClose, onSwitch, onCreate, onRename }: Props) {
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const offline = dbState === 'offline'

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="账户" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>账户</h2>
          <button className="text-button" onClick={onClose}>关闭</button>
        </div>

        <p className="modal-note">
          这是本机单人使用的应用，<b>没有密码</b>。账户把「进度 + 题库 + 审核结论」整包分开——
          切换账户就是换一套数据来练，随时可以切回来。要做多设备登录需要服务端，那是后面的事。
        </p>

        {offline && <p className="modal-warn">数据库未连接，暂时不能新建或切换账户。</p>}

        <h3 className="modal-section">选择账户（{accounts.length}）</h3>
        <ul className="acct-list">
          {accounts.map((a) => {
            const isCurrent = a.id === account?.id
            return (
              <li key={a.id} className={isCurrent ? 'is-current' : ''}>
                <span className="profile-circle">{(a.name.replace(/[^\p{L}\p{N}]/gu, '') || '学').slice(0, 1)}</span>
                <div className="acct-copy">
                  <b>{a.name}{isCurrent && <em>当前</em>}</b>
                  <small>{a.attempts} 条作答记录 · 题库 {a.items} 道题 · XP {a.xp}</small>
                </div>
                {isCurrent
                  ? (renaming
                    ? <form className="acct-form" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onRename(draft.trim()); setRenaming(false) } }}>
                      <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={30} autoFocus aria-label="账户名" />
                      <button className="secondary" type="submit">保存</button>
                      <button className="text-button" type="button" onClick={() => setRenaming(false)}>取消</button>
                    </form>
                    : <button className="text-button" onClick={() => { setDraft(a.name); setRenaming(true) }}>改名</button>)
                  : <button className="secondary" disabled={offline} onClick={() => onSwitch(a.id)}>切换到这个账户</button>}
              </li>
            )
          })}
        </ul>

        <h3 className="modal-section">新建账户</h3>
        <form className="acct-form" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { onCreate(newName.trim()); setNewName('') } }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例如：托福备考 / 第二遍精练" maxLength={30} aria-label="新账户名" />
          <button className="secondary" type="submit" disabled={offline}>创建并切换</button>
        </form>
        <p className="modal-foot">新账户从零开始（题库也要重新导入），但两个账户的进度互不影响。</p>
      </div>
    </div>
  )
}
