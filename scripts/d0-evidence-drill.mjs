// 31 第一批 · D0-3 迁移演练：在隔离副本上重算旧 keyword 证据，输出受影响数量与保留证明。
// 真实库只作只读源（VACUUM INTO 一致性快照），全程不写。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 真实库定位：仓库外的 JunEnglish/data/englishforge（与 server/db.mjs 默认一致），只读快照源
const REAL = new URL('../../data/englishforge/englishforge.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dir = mkdtempSync(join(tmpdir(), 'd0-drill-'))
const copyPath = join(dir, 'drill.db')

// 1) 一致性快照（只读连接 VACUUM INTO）
const src = new DatabaseSync(REAL, { readOnly: true })
src.exec(`VACUUM INTO '${copyPath.replace(/\\/g, '/')}'`)
src.close()

process.env.ENGLISHFORGE_DB = copyPath
const ev = await import(new URL('../server/v3evidence.mjs', import.meta.url))

const db = new DatabaseSync(copyPath)
const accounts = db.prepare('SELECT DISTINCT account_id FROM learner_attempts_v3').all().map((r) => r.account_id)
console.log(`快照建立：${copyPath}`)
console.log(`有 v3 作答的账户：${accounts.length} 个`)

let totalKeywordPos = 0, totalNeutral = 0, statesChanged = 0, statesKept = 0
const beforeAttempts = db.prepare('SELECT COUNT(*) n FROM learner_attempts_v3').get().n
const beforeEvents = db.prepare('SELECT COUNT(*) n FROM evidence_events').get().n
const eventHashBefore = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(LENGTH(basis)),0) s FROM evidence_events").get()

for (const acc of accounts) {
  const kwPosBefore = db.prepare(`
    SELECT COUNT(*) n FROM evidence_events WHERE account_id = ?
      AND kind = 'observed' AND pass = 1 AND basis LIKE '%"keywordContentCheck":true%'`).get(acc).n
  const before = db.prepare('SELECT objective_id, skill, complexity, state, flags FROM learner_states WHERE account_id = ?').all(acc)
  const beforeMap = new Map(before.map((r) => [`${r.objective_id}|${r.skill}|${r.complexity}`, `${r.state}:${r.flags}`]))

  ev.recomputeStates(acc) // 同一函数、同一语义：派生行重建，事件/作答不删

  const kwPosAfter = db.prepare(`
    SELECT COUNT(*) n FROM evidence_events WHERE account_id = ?
      AND kind = 'observed' AND pass = 1 AND basis LIKE '%"keywordContentCheck":true%'`).get(acc).n
  const after = db.prepare('SELECT objective_id, skill, complexity, state, flags FROM learner_states WHERE account_id = ?').all(acc)
  totalKeywordPos += kwPosBefore
  for (const r of after) {
    const k = `${r.objective_id}|${r.skill}|${r.complexity}`
    if (beforeMap.has(k)) { beforeMap.get(k) !== `${r.state}:${r.flags}` ? statesChanged++ : statesKept++ }
  }
  // 中性参与事件（slotOnly）数量统计
  totalNeutral += db.prepare(`
    SELECT COUNT(*) n FROM evidence_events WHERE account_id = ? AND basis LIKE '%"slotOnly":true%'`).get(acc).n
  if (kwPosBefore > 0) {
    console.log(`  ${acc.slice(0, 16)}…: keyword 正分事件 ${kwPosBefore} 条（重算后事件行不变：${kwPosAfter === kwPosBefore ? '✓' : '✗'}）`)
  }
}

const afterAttempts = db.prepare('SELECT COUNT(*) n FROM learner_attempts_v3').get().n
const afterEvents = db.prepare('SELECT COUNT(*) n FROM evidence_events').get().n
const eventHashAfter = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(LENGTH(basis)),0) s FROM evidence_events").get()
console.log(`\n-- 汇总 --`)
console.log(`keyword 正分事件（重算时被跳过、按参与处理）：${totalKeywordPos} 条`)
console.log(`slotOnly 中性事件：${totalNeutral} 条`)
console.log(`派生 learner_states：变化 ${statesChanged} 行 / 保持 ${statesKept} 行`)
console.log(`原始作答行：${beforeAttempts} → ${afterAttempts}（${beforeAttempts === afterAttempts ? '不变 ✓' : '变了 ✗'}）`)
console.log(`原始事件行：${beforeEvents} → ${afterEvents}（${beforeEvents === afterEvents && eventHashBefore.s === eventHashAfter.s ? '不变 ✓' : '变了 ✗'}）`)
db.close()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄延迟，忽略 */ }
console.log('\nDRILL_OK（隔离副本，真实库未触碰）')
