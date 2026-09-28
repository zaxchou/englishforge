// 账户题库（内容层）的集成测试。
//
// 关键契约：「生成的题属于账户」这件事必须可验证 —— 幂等导入、逐题定版、统计可对照、
// 而且**清空进度不会顺手清掉题库**（题库是用户的资产，不是进度）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, handleApi, closeDb

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-items-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'items.db')
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

/** 一道语料派生的题（形状与 build-items.py 产出、前端 Question 契约都一致） */
function item(n, over = {}) {
  const id = `s2:tatoeba:${1000 + n}`
  return {
    itemId: id, skill: 's2', objectiveId: 's2-case', type: 'choice',
    source: 'corpus', generator: 'build-items.py', sourceRef: 'tatoeba:' + (1000 + n),
    reviewStatus: 'draft',
    question: {
      id, skill: 's2', type: 'choice', prompt: 'I adore ___.  （我很喜欢他。）',
      options: ['him', 'he', 'his', 'himself'], answer: 'him', tts: 'I adore him.',
      explain: '动作落到谁身上，谁就用挨动作的那个形式。',
      objectiveId: 's2-case', sourceRef: 'tatoeba:' + (1000 + n),
      errorTags: ['case-form-subject'], optionTags: { he: ['case-form-subject'] },
      ...over,
    },
  }
}

let acct = ''

describe('账户题库', () => {
  it('导入题目（带批次信息，可对照）', async () => {
    acct = (await call('/api/bootstrap', {}, 'POST')).json.account.id
    const res = await call(`/api/accounts/${acct}/items`, {
      items: [item(1), item(2)],
      batch: { source: 'corpus', generator: 'build-items.py', note: '主宾格试点导入', skill: 's2' },
    }, 'POST')
    expect(res.json).toMatchObject({ ok: true, inserted: 2, updated: 0, skipped: 0 })
    expect(res.json.batchId).toMatch(/^b_/)
  })

  it('同一 item_id 重复导入只更新不产生副本 —— 批次可以反复生成、替换', async () => {
    const res = await call(`/api/accounts/${acct}/items`, {
      items: [item(1), item(2), item(3)], batch: { source: 'corpus' },
    }, 'POST')
    expect(res.json).toMatchObject({ inserted: 1, updated: 2 })
    const list = await call(`/api/accounts/${acct}/items`)
    expect(list.json.count).toBe(3)
  })

  it('脏数据被跳过，不会污染题库', async () => {
    const res = await call(`/api/accounts/${acct}/items`, {
      items: [null, {}, { itemId: 'x' }, item(4)], batch: {},
    }, 'POST')
    expect(res.json).toMatchObject({ inserted: 1, skipped: 3 })
  })

  it('取回的题就是前端 Question 形状（可直接并进抽题池）', async () => {
    const items = (await call(`/api/accounts/${acct}/items`)).json.items
    const q = items.find((i) => i.itemId === 's2:tatoeba:1001').question
    expect(q).toMatchObject({
      id: 's2:tatoeba:1001', skill: 's2', type: 'choice', answer: 'him', objectiveId: 's2-case',
      reviewStatus: 'draft', contentVersion: 1,
    })
    expect(q.options).toHaveLength(4)
    expect(q.optionTags.he).toEqual(['case-form-subject'])
    expect(q.sourceRef).toBe('tatoeba:1001')
  })

  it('逐题定版：ok → reviewed，kill → quarantined（决定这题算不算能力证据）', async () => {
    expect((await call(`/api/accounts/${acct}/items/s2:tatoeba:1002`, { verdict: 'ok' }, 'PATCH')).json.reviewStatus).toBe('reviewed')
    expect((await call(`/api/accounts/${acct}/items/s2:tatoeba:1003`, { verdict: 'kill' }, 'PATCH')).json.reviewStatus).toBe('quarantined')
    expect((await call(`/api/accounts/${acct}/items/s2:tatoeba:1001`, { verdict: 'nonsense' }, 'PATCH')).status).toBe(400)
    expect((await call(`/api/accounts/${acct}/items/zzz`, { verdict: 'ok' }, 'PATCH')).status).toBe(404)
  })

  it('可按思维点 / 来源 / 信任级别筛选，并给出可对照的统计', async () => {
    expect((await call(`/api/accounts/${acct}/items`, undefined, 'GET', new URLSearchParams({ status: 'reviewed' }))).json.count).toBe(1)
    expect((await call(`/api/accounts/${acct}/items`, undefined, 'GET', new URLSearchParams({ skill: 's2' }))).json.count).toBe(4)
    const stats = (await call(`/api/accounts/${acct}/items`)).json.stats
    expect(stats.total).toBe(4)
    expect(stats.bySkill).toEqual([
      expect.objectContaining({ skill: 's2', total: 4, reviewed: 1, draft: 2, quarantined: 1, sources: { corpus: 4 } }),
    ])
  })

  it('批次列表能看出"这批题是怎么来的"', async () => {
    const batches = (await call(`/api/accounts/${acct}/batches`)).json.batches
    expect(batches).toHaveLength(3)
    expect(batches[0].itemCount).toBeGreaterThan(0)
    expect(batches.map((b) => b.generator)).toContain('build-items.py')
  })

  it('清空进度不清题库（题库是用户的资产，不是进度）', async () => {
    await call(`/api/accounts/${acct}/sync`, {
      state: { xp: 10, skills: {}, questionStates: {}, dailyXp: {}, sessions: [] },
      attempts: [{ attemptId: 'a1', sessionId: 's', questionId: 's2:tatoeba:1001', objectiveId: 's2-case', variantGroupId: 'v', mode: 'recognition', timestamp: 1, localDate: '2026-09-28', firstAttempt: true, supportUsed: 0, answer: 'him', outcome: 'correct', evaluator: 'deterministic', contentVersion: 1, isDueReview: false }],
    }, 'POST')
    expect((await call(`/api/accounts/${acct}/stats`)).json.stats.attempts).toBe(1)

    await call(`/api/accounts/${acct}/reset`, { reason: 'test-reset' }, 'POST')

    const after = await call(`/api/accounts/${acct}/items`)
    expect((await call(`/api/accounts/${acct}/stats`)).json.stats.attempts).toBe(0)   // 进度清了
    expect(after.json.count).toBe(4)                                                  // 题库还在
    expect(after.json.items.find((i) => i.itemId === 's2:tatoeba:1002').reviewStatus).toBe('reviewed')  // 审核结论也还在
  })

  it('可以删掉一道题', async () => {
    expect((await call(`/api/accounts/${acct}/items/s2:tatoeba:1004`, undefined, 'DELETE')).json.deleted).toBe(1)
    expect((await call(`/api/accounts/${acct}/items`)).json.count).toBe(3)
    expect((await call(`/api/accounts/${acct}/items/s2:tatoeba:1004`, undefined, 'DELETE')).status).toBe(404)
  })

  it('题库跟着账户走：另一个账户看到的还是空的', async () => {
    const other = (await call('/api/accounts', { name: '另一个账户' }, 'POST')).json.account.id
    expect((await call(`/api/accounts/${other}/items`)).json.count).toBe(0)
    expect((await call(`/api/accounts/${other}/items`, { items: [item(9, { prompt: 'only here' })], batch: {} }, 'POST')).json.inserted).toBe(1)
    expect((await call(`/api/accounts/${acct}/items`)).json.count).toBe(3)
  })

  it('items 必须是数组，否则明确报错', async () => {
    expect((await call(`/api/accounts/${acct}/items`, { items: 'nope' }, 'POST')).status).toBe(400)
  })
})
