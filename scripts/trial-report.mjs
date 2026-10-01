// 40 号：本人短程试学记录导出（只读，不修改任何数据）。
// 从库里组织出一次试学的关键事实：卡在哪句（失败作答）、提示条件（揭示记录）、
// 初稿/改稿（同活动多轮作答原文）、迁移表现（transfer 角色作答）、表达申诉。
// 用法：node scripts/trial-report.mjs [accountId] > trial-report.md
// 不带 accountId 时列出账户供选择。绝不写库。
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'

const dbPath = process.env.ENGLISHFORGE_DB
  ?? (statSync('data/englishforge/englishforge.db', { throwIfNoEntry: false }) ? 'data/englishforge/englishforge.db' : null)
if (!dbPath) { console.error('找不到数据库：设 ENGLISHFORGE_DB 或在仓库根运行'); process.exit(1) }
const conn = new DatabaseSync(dbPath, { readOnly: true })
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

const accounts = conn.prepare('SELECT id, name FROM accounts ORDER BY id').all()
if (!process.argv[2]) {
  console.log('可用账户：')
  for (const a of accounts) console.log(`  ${a.id}  ${a.name}`)
  console.log('\n用法：node scripts/trial-report.mjs <accountId> > trial-report.md')
  process.exit(0)
}
const accountId = process.argv[2]
const acct = accounts.find((a) => a.id === accountId)
if (!acct) { console.error('账户不存在：' + accountId); process.exit(1) }

const attemptRows = conn.prepare(`
  SELECT attempt_id, activity_id, task_family_id, role, objective_ids, response, conditions,
         evaluation_status, evaluation, disputed_reason, activity_snapshot, created_at
  FROM learner_attempts_v3 WHERE account_id = ? ORDER BY created_at, rowid`).all(accountId)
const hintRows = conn.prepare(`
  SELECT activity_id, level, created_at FROM activity_support_events
  WHERE account_id = ? AND kind = 'hint' ORDER BY created_at`).all(accountId)
const claimRows = conn.prepare(`
  SELECT attempt_id, basis, created_at FROM evidence_events
  WHERE account_id = ? AND kind = 'student_claim' ORDER BY created_at`).all(accountId)
const doneLessons = conn.prepare(`
  SELECT served_lesson_id FROM plan_decisions
  WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL ORDER BY created_at`).all(accountId)
const states = conn.prepare(`
  SELECT objective_id, skill, complexity, state, flags FROM learner_states
  WHERE account_id = ? AND complexity = 'base' ORDER BY objective_id`).all(accountId)

const lines = []
lines.push(`# 试学记录 · ${acct.name}（${accountId}）`)
lines.push('')
lines.push(`导出时间：${new Date().toLocaleString()}　|　只读导出，不修改任何数据`)
lines.push('')
lines.push(`## 完成的课（${doneLessons.length}）`)
lines.push(doneLessons.length ? doneLessons.map((r) => `- ${r.served_lesson_id}`).join('\n') : '（无）')
lines.push('')
lines.push(`## 作答时间线（${attemptRows.length} 条，含初稿/改稿）`)
lines.push('')
lines.push('| 时间 | 活动 | 轮次 | 角色 | 结果 | 提示层 | 作答原文（截前 120 字） |')
lines.push('|---|---|---|---|---|---|---|')
const perActivity = new Map()
for (const r of attemptRows) {
  const n = (perActivity.get(r.activity_id) ?? 0) + 1
  perActivity.set(r.activity_id, n)
  const ev = JSON.parse(r.evaluation || '{}')
  const cond = JSON.parse(r.conditions || '{}')
  const text = esc(String(JSON.parse(r.response || '{}')?.text ?? '').slice(0, 120))
  const result = r.evaluation_status === 'disputed' ? `争议(${esc(r.disputed_reason)})`
    : ev.pass === true ? '通过' : ev.pass === false ? (ev.keywordOnly ? '未过(练习)' : '未过') : r.evaluation_status
  lines.push(`| ${new Date(r.created_at).toLocaleString()} | ${r.activity_id} | 第${n}轮 | ${r.role} | ${result} | ${cond.hintLevel ?? 0} | ${text} |`)
}
lines.push('')
lines.push(`## 提示揭示记录（${hintRows.length}）`)
lines.push(hintRows.length ? hintRows.map((r) => `- ${new Date(r.created_at).toLocaleString()} ${r.activity_id} 第${r.level}层`).join('\n') : '（无——所有通过都是独立完成或未用提示）')
lines.push('')
lines.push(`## 表达申诉（${claimRows.length}）`)
lines.push(claimRows.length ? claimRows.map((r) => {
  const b = JSON.parse(r.basis || '{}')
  return `- ${new Date(r.created_at).toLocaleString()} ${r.attempt_id}${b.note ? `：${esc(b.note)}` : ''}`
}).join('\n') : '（无——学生没有声明"我的表达是对的"）')
lines.push('')
lines.push('## 迁移表现（transfer 角色作答）')
const transfers = attemptRows.filter((r) => r.role === 'transfer')
lines.push(transfers.length
  ? transfers.map((r) => {
      const ev = JSON.parse(r.evaluation || '{}')
      return `- ${r.activity_id}：${ev.pass === true ? '通过' : ev.pass === false ? '未过' : r.evaluation_status}（${esc(String(JSON.parse(r.response || '{}')?.text ?? '').slice(0, 80))}）`
    }).join('\n')
  : '（本段试学还没有迁移任务作答）')
lines.push('')
lines.push('## 当前能力状态（base 聚合）')
lines.push(states.length ? states.map((s) => `- ${s.objective_id} · ${s.skill}：${s.state}${s.flags && s.flags !== '[]' ? `（${esc(s.flags)}）` : ''}`).join('\n') : '（还没有能力记录——练习反馈不自动变成掌握）')
lines.push('')
lines.push('## 给下一次试学的注（人工填写）')
lines.push('- 哪一句卡住了／为什么：')
lines.push('- 提示是否够用：')
lines.push('- 揭晓的参考表达和你的说法差在哪：')
lines.push('- 迁移任务是否真的"新"：')
console.log(lines.join('\n'))
