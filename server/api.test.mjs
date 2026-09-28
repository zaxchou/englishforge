// 进度数据库的集成测试：直接调 handleApi（不起 HTTP），跑的是 Vite 中间件走的同一条路径。
//
// 断言的都是"进度不会丢"这件事本身：事件幂等、事件取并集、清空前有快照、快照能回捞。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let handleApi
let closeDb

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-db-'))
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

function attempt(id, over = {}) {
  return {
    attemptId: id,
    sessionId: 's1',
    questionId: 'q-subj-01',
    objectiveId: 'subject-object',
    variantGroupId: 'vg-subj',
    mode: 'recognition',
    timestamp: 1_700_000_000_000,
    localDate: '2026-09-28',
    firstAttempt: true,
    supportUsed: 0,
    answer: 'She',
    outcome: 'correct',
    evaluator: 'deterministic',
    contentVersion: 1,
    isDueReview: false,
    ...over,
  }
}

function state(over = {}) {
  return {
    xp: 120, streak: 3, lastActiveDate: '2026-09-28', comboBest: 7,
    skills: { 'subject-object': { conceptSeen: true, box: 2, due: 0, correct: 5, total: 8 } },
    dailyXp: { '2026-09-28': 120 },
    sessions: [{ ts: 1_700_000_000_000, label: '今日训练 · 10 个任务', lessonNo: '今日', acc: 80, xp: 120, total: 10, firstTry: 8 }],
    questionStates: {
      'q-subj-01': { stage: 2, dueAt: 1_700_086_400_000, correct: 2, total: 3, lastIndependentSuccessAt: 1_700_000_000_000 },
      'q-subj-02': { stage: 0, dueAt: 0, correct: 0, total: 1, speak: { status: 'independent-self', at: 1_700_000_000_000 } },
    },
    activeSession: { sessionId: 's1', kind: 'today', queue: [{ qid: 'q-subj-01', optionOrder: ['a', 'b'] }], runtime: null, createdAt: 1, committed: false },
    ...over,
  }
}

let accountId = ''

describe('账户', () => {
  it('首次 bootstrap 建出默认账户', async () => {
    const res = await call('/api/bootstrap', { name: '默认账户' }, 'POST')
    expect(res.status).toBe(200)
    accountId = res.json.account.id
    expect(accountId).toMatch(/^acc_/)
    expect(res.json.account.name).toBe('默认账户')
    expect(res.json.progress.schemaVersion).toBe(2)
    expect(res.json.progress.attempts).toEqual([])
    expect(res.json.revision).toBe(0)
  })

  it('第二次 bootstrap 复用已有账户（不会每次新建）', async () => {
    const res = await call('/api/bootstrap', {}, 'POST')
    expect(res.json.account.id).toBe(accountId)
  })

  it('未知账户返回 404', async () => {
    expect((await call('/api/accounts/nope/progress')).status).toBe(404)
  })

  it('可以改名，空名被拒', async () => {
    expect((await call(`/api/accounts/${accountId}`, { name: '张俊杰' }, 'PATCH')).json.account.name).toBe('张俊杰')
    expect((await call(`/api/accounts/${accountId}`, { name: '  ' }, 'PATCH')).status).toBe(400)
  })
})

describe('写入与读取', () => {
  it('同一 attemptId 重复提交只入库一次', async () => {
    const a = attempt('s1:q-subj-01:f')
    const first = await call(`/api/accounts/${accountId}/sync`, { baseRevision: 0, state: state(), attempts: [a] }, 'POST')
    const second = await call(`/api/accounts/${accountId}/sync`, { baseRevision: first.json.revision, state: state(), attempts: [a] }, 'POST')
    expect(first.json.attemptsInserted).toBe(1)
    expect(second.json.attemptsInserted).toBe(0)
    expect((await call(`/api/accounts/${accountId}/progress`)).json.progress.attempts).toHaveLength(1)
  })

  it('事件取并集：新事件追加、旧事件不重复', async () => {
    await call(`/api/accounts/${accountId}/sync`, {
      state: state(),
      attempts: [
        attempt('s1:q-subj-01:f'),
        attempt('s1:q-subj-02:f', { questionId: 'q-subj-02', outcome: 'incorrect', errorTags: ['case-form-subject'] }),
      ],
    }, 'POST')
    const doc = await call(`/api/accounts/${accountId}/progress`)
    expect(doc.json.progress.attempts.map((a) => a.attemptId).sort())
      .toEqual(['s1:q-subj-01:f', 's1:q-subj-02:f'])
    expect(doc.json.progress.attempts.find((a) => a.attemptId === 's1:q-subj-02:f').errorTags)
      .toEqual(['case-form-subject'])
  })

  it('状态整份往返一致（xp/技能/题状态/断点/日记账）', async () => {
    const p = (await call(`/api/accounts/${accountId}/progress`)).json.progress
    expect(p.xp).toBe(120)
    expect(p.streak).toBe(3)
    expect(p.skills['subject-object']).toMatchObject({ conceptSeen: true, box: 2, correct: 5, total: 8 })
    expect(p.dailyXp['2026-09-28']).toBe(120)
    expect(p.sessions).toHaveLength(1)
    expect(p.questionStates['q-subj-01'].stage).toBe(2)
    expect(p.questionStates['q-subj-02'].speak).toEqual({ status: 'independent-self', at: 1_700_000_000_000 })
    expect(p.activeSession.queue[0]).toMatchObject({ qid: 'q-subj-01', optionOrder: ['a', 'b'] })
  })

  it('审核标记也入库并原样取回', async () => {
    await call(`/api/accounts/${accountId}/sync`, {
      reviews: { 'q-subj-01': { verdict: 'ok', note: '语料原句', at: 1_700_000_000_000 } },
    }, 'POST')
    const doc = await call(`/api/accounts/${accountId}/progress`)
    expect(doc.json.reviews['q-subj-01']).toMatchObject({ verdict: 'ok', note: '语料原句' })
  })
})

describe('统计与查询', () => {
  it('stats 给出行为聚合', async () => {
    const s = (await call(`/api/accounts/${accountId}/stats`)).json.stats
    expect(s.attempts).toBe(2)
    expect(s.questionStates).toBe(2)
    expect(s.reviews).toBe(1)
    expect(s.objectives[0]).toMatchObject({ objective_id: 'subject-object', attempts: 2 })
    expect(s.errorTags[0]).toEqual({ tag: 'case-form-subject', n: 1 })
  })

  it('可以按题目 / 目标筛事件', async () => {
    const res = await call(`/api/accounts/${accountId}/attempts`, undefined, 'GET',
      new URLSearchParams({ question: 'q-subj-02' }))
    expect(res.json.attempts).toHaveLength(1)
    expect(res.json.attempts[0].questionId).toBe('q-subj-02')
  })

  it('health 报告库位置与账户数', async () => {
    const res = await call('/api/health')
    expect(res.json.ok).toBe(true)
    expect(res.json.accounts).toHaveLength(1)
    expect(res.json.path).toContain('test.db')
  })
})

describe('清空 / 覆盖 / 快照', () => {
  it('整份替换前先留快照', async () => {
    const res = await call(`/api/accounts/${accountId}/replace`, {
      state: state({ xp: 999 }), attempts: [attempt('s9:q-subj-09:f', { questionId: 'q-subj-09' })], reason: 'import',
    }, 'POST')
    expect(res.json.snapshotId).toBeGreaterThan(0)
    const doc = await call(`/api/accounts/${accountId}/progress`)
    expect(doc.json.progress.xp).toBe(999)
    expect(doc.json.progress.attempts).toHaveLength(1)
  })

  it('清空后账户还在、进度归零、快照留存', async () => {
    const res = await call(`/api/accounts/${accountId}/reset`, { reason: 'user-reset' }, 'POST')
    expect(res.json.snapshotId).toBeGreaterThan(0)
    const doc = await call(`/api/accounts/${accountId}/progress`)
    expect(doc.json.progress.xp).toBe(0)
    expect(doc.json.progress.attempts).toEqual([])
    expect(Object.keys(doc.json.progress.questionStates)).toHaveLength(0)
    const snaps = await call(`/api/accounts/${accountId}/snapshots`)
    expect(snaps.json.snapshots.length).toBeGreaterThanOrEqual(2)
    expect(snaps.json.snapshots[0].reason).toBe('user-reset')
  })

  it('快照记的是"操作前"的状态 —— 误清空能整份捞回来', async () => {
    const snaps = (await call(`/api/accounts/${accountId}/snapshots`)).json.snapshots
    // import 快照拍在导入之前（所以是导入前的 120）；user-reset 快照拍在清空之前（999）
    expect(snaps.find((s) => s.reason === 'import').revision).toBeLessThan(
      snaps.find((s) => s.reason === 'user-reset').revision)
    const target = snaps.find((s) => s.reason === 'user-reset')
    expect(target).toBeTruthy()
    expect((await call(`/api/snapshots/${target.id}/restore`, {}, 'POST')).status).toBe(200)
    const doc = await call(`/api/accounts/${accountId}/progress`)
    expect(doc.json.progress.xp).toBe(999)
    expect(doc.json.progress.attempts).toHaveLength(1)
    expect(doc.json.progress.questionStates['q-subj-01'].stage).toBe(2)
  })

  it('快照数量有上限（不会无限长）', async () => {
    for (let i = 0; i < 35; i++) {
      await call(`/api/accounts/${accountId}/snapshots`, { reason: 'bulk-' + i }, 'POST')
    }
    const snaps = await call(`/api/accounts/${accountId}/snapshots`)
    expect(snaps.json.snapshots.length).toBeLessThanOrEqual(30)
  })
})

describe('多账户', () => {
  it('可以并存另一个账户，互不干扰', async () => {
    // 不依赖前面用例留下的状态：两边各写一个显眼的数字
    await call(`/api/accounts/${accountId}/sync`, { state: state({ xp: 555 }), attempts: [] }, 'POST')
    const second = (await call('/api/accounts', { name: '第二个账户' }, 'POST')).json.account.id
    expect(second).not.toBe(accountId)
    await call(`/api/accounts/${second}/sync`, { state: state({ xp: 7 }), attempts: [attempt('s2:q:a:f')] }, 'POST')
    expect((await call(`/api/accounts/${second}/progress`)).json.progress.xp).toBe(7)
    expect((await call(`/api/accounts/${accountId}/progress`)).json.progress.xp).toBe(555)
    // 第二个账户还没有作答事件，第一个账户的事件不串门
    expect((await call(`/api/accounts/${second}/stats`)).json.stats.attempts).toBe(1)
    expect((await call('/api/accounts')).json.accounts).toHaveLength(2)
  })
})

describe('错误处理', () => {
  it('不存在的接口返回 404 而不是崩溃', async () => {
    expect((await call('/api/nope')).status).toBe(404)
  })

  it('字段缺失的脏事件被跳过，不会污染库', async () => {
    const before = (await call(`/api/accounts/${accountId}/stats`)).json.stats.attempts
    const res = await call(`/api/accounts/${accountId}/sync`, {
      state: state(), attempts: [null, { questionId: 'x' }, 'nonsense', attempt('s3:q:a:f')],
    }, 'POST')
    expect(res.json.attemptsInserted).toBe(1)
    expect((await call(`/api/accounts/${accountId}/stats`)).json.stats.attempts).toBe(before + 1)
  })
})
