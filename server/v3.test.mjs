// curriculum-v4 新域（W0–W2）验收测试 —— 对应 docs/curriculum-v4/15 §10 的 T1/T2/T3/T4/T8。
//
// 跑的是真实路径：直接调 handleApi（与 Vite 中间件同一条路），独立 tmpdir 数据库。
// 这些测试是工程验收（合同 fixture），不是学习效果的统计证明 —— 那要等真人试学。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let handleApi
let closeDb

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-v3-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  // 必须在设置 ENGLISHFORGE_DB 之后再加载模块（DB_PATH 在模块加载时求值）
  const api = await import('./api.mjs')
  const db = await import('./db.mjs')
  handleApi = api.handleApi
  closeDb = db.closeDb
})

afterAll(() => {
  try { closeDb() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const call = (pathname, body, method = 'GET', query = new URLSearchParams()) =>
  handleApi({ method, pathname, body, query })

async function mkAccount(name) {
  const r = await call('/api/accounts', { name }, 'POST')
  expect(r.status).toBe(200)
  return r.json.account.id
}

// ==================================================================
// W0 / T8：旧数据保护与双轨隔离
// 合同：建新域不改旧系统；旧记录只作候选线索；attemptId/requestId 幂等；快照可恢复。
// ==================================================================
describe('W0/T8 旧数据保护与双轨隔离', () => {
  it('新域健康检查可用，v3 表与旧表并存', async () => {
    const r = await call('/api/v1/health')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.domain).toBe('curriculum-v4')
  })

  it('旧 sync 契约在 v3 表存在后保持原形状；305 条旧历史幂等不重复', async () => {
    const id = await mkAccount('T8旧历史')
    const attempts = Array.from({ length: 305 }, (_, i) => ({
      attemptId: `old-${i}`,
      sessionId: 's1',
      questionId: `q-${i % 40}`,
      objectiveId: 'subject-object',
      variantGroupId: 'vg',
      mode: 'recognition',
      timestamp: 1_700_000_000_000 + i,
      localDate: '2026-09-28',
      firstAttempt: i % 2 === 0,
      supportUsed: 0,
      answer: 'She',
      outcome: 'correct',
      evaluator: 'deterministic',
      contentVersion: 1,
      isDueReview: false,
    }))
    const body = {
      baseRevision: 0,
      state: { xp: 10, streak: 1, lastActiveDate: '2026-09-28', skills: {}, questionStates: {}, sessions: [], dailyXp: {} },
      attempts,
      reason: 'test',
    }
    const r1 = await call(`/api/accounts/${id}/sync`, body, 'POST')
    expect(r1.status).toBe(200)
    // 旧契约形状不因 v3 出现而改变
    expect(Object.keys(r1.json).sort()).toEqual(
      expect.arrayContaining(['ok', 'revision', 'attemptsInserted', 'reviewsWritten', 'reason']),
    )
    expect(r1.json.attemptsInserted).toBe(305)
    // 幂等：同批重发，不得重复入库
    const r2 = await call(`/api/accounts/${id}/sync`, { ...body, baseRevision: r1.json.revision }, 'POST')
    expect(r2.status).toBe(200)
    expect(r2.json.attemptsInserted).toBe(0)
    const legacy = await call(`/api/v1/accounts/${id}/legacy-map`)
    expect(legacy.status).toBe(200)
    expect(legacy.json.readOnly).toBe(true)
    expect(legacy.json.oldCounts.attempts).toBe(305)
    expect(legacy.json.forbidden.join('')).toContain('不得转换为新目标完成比例')
  })

  it('旧数据映射是候选线索，不写任何新域状态', async () => {
    const id = await mkAccount('T8只读')
    const syncRes = await call(`/api/accounts/${id}/sync`, {
      baseRevision: 0,
      state: { xp: 999, streak: 9, lastActiveDate: '2026-09-28', skills: {}, questionStates: {}, sessions: [], dailyXp: {} },
      attempts: [{
        attemptId: 'sp-1', sessionId: 's', questionId: 'q', objectiveId: 'o', variantGroupId: 'vg',
        mode: 'speak', timestamp: 1, localDate: '2026-09-28', firstAttempt: true, supportUsed: 0,
        answer: 'hello', outcome: 'correct', evaluator: 'similarity', contentVersion: 1, isDueReview: false,
      }],
      reason: 'test',
    }, 'POST')
    expect(syncRes.status).toBe(200)
    expect(syncRes.json.attemptsInserted).toBe(1)
    const map = (await call(`/api/v1/accounts/${id}/legacy-map`)).json
    expect(map.oldCounts.speakAttempts).toBe(1)
    expect(map.hints.speakEntryHint).toContain('不等于已有自主表达证据')
    // 新域学习状态对这个账户仍然全空（unmeasured）——W2 起由 /evidence 断言
  })

  it('两个账户同目标不同表现互不串数据；快照恢复不触碰新域', async () => {
    const a = await mkAccount('T8甲')
    const b = await mkAccount('T8乙')
    // 老域：甲用整份替换写一份带 xp 的状态（replace 会先自动留快照），乙保持空
    await call(`/api/accounts/${a}/replace`, {
      baseRevision: 0,
      state: { xp: 777, streak: 1, lastActiveDate: '2026-09-28', skills: {}, questionStates: {}, sessions: [], dailyXp: {} },
      attempts: [], reason: 'test',
    }, 'POST')
    const pa = (await call(`/api/accounts/${a}/progress`)).json
    const pb = (await call(`/api/accounts/${b}/progress`)).json
    expect(pa.progress.xp).toBe(777)
    expect(pb.progress.xp).not.toBe(777)
    // 快照恢复：快照存的是替换前的状态 —— 再替换成 888，然后恢复，应回到 777
    await call(`/api/accounts/${a}/replace`, {
      state: { xp: 888, streak: 1, lastActiveDate: '2026-09-29', skills: {}, questionStates: {}, sessions: [], dailyXp: {} },
      attempts: [], reason: 'test-2',
    }, 'POST')
    const { getDb } = await import('./db.mjs')
    const { ensureV3Schema, nextCounter, getCounter } = await import('./v3db.mjs')
    ensureV3Schema(getDb())
    const before = nextCounter(a, 'evidence')
    expect(getCounter(a, 'evidence')).toBe(1)
    const snaps = (await call(`/api/accounts/${a}/snapshots`)).json
    expect(snaps.snapshots.length).toBeGreaterThan(0)
    const res = await call(`/api/snapshots/${snaps.snapshots[0].id}/restore`, {}, 'POST')
    expect(res.status).toBe(200)
    const pa2 = (await call(`/api/accounts/${a}/progress`)).json
    expect(pa2.progress.xp).toBe(777) // 回滚到替换前的这份
    expect(getCounter(a, 'evidence')).toBe(before) // 新域数据原样
    expect(getCounter(b, 'evidence')).toBe(0) // 且不串账户
  })

  it('发布过的目标版本不可静默覆盖（trigger 强制）', async () => {
    const { getDb } = await import('./db.mjs')
    const { ensureV3Schema } = await import('./v3db.mjs')
    const conn = ensureV3Schema(getDb())
    conn.prepare(
      `INSERT INTO objective_versions (objective_id, version, parent_group, layer, name, behavior, boundary, status, created_at)
       VALUES ('O-T8-01', 1, 'K000', 'structure', '测试目标', '测试行为', '测试边界', 'published', 0)`,
    ).run()
    let msg = ''
    try {
      conn.prepare("UPDATE objective_versions SET behavior = '被篡改' WHERE objective_id = 'O-T8-01' AND version = 1").run()
    } catch (e) { msg = String(e?.message) }
    expect(msg).toContain('OBJECTIVE_VERSION_PUBLISHED_IMMUTABLE')
    const row = conn.prepare("SELECT behavior FROM objective_versions WHERE objective_id = 'O-T8-01'").get()
    expect(row.behavior).toBe('测试行为')
    conn.prepare("DELETE FROM objective_versions WHERE objective_id = 'O-T8-01'").run()
  })
})
