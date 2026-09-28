// 系统自检与自我修复的集成测试。
//
// 覆盖的是用户最在意的那条：「系统本身要能修内容」——查重、找打架的题、让系统 AI 补逐项纠正，
// 而且补出来的东西要能通过闸门（编出来的选项、越界的标签一律丢弃）。
// 模型调用用替身注入，不打真实 API（省流量，也让断言可控）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, handleApi, dbmod, closeDb, setChat, resetChat, ERROR_TAG_KEYS, REVIEW_PROMPT, REWRITE_PROMPT, acceptRewrite

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-audit-'))
  process.env.ENVIRONMENT = 'test'
  process.env.ENGLISHFORGE_DB = join(dir, 'audit.db')
  const api = await import('./api.mjs')
  const db = await import('./db.mjs')
  dbmod = db
  const ai = await import('./content-ai.mjs')
  const llm = await import('./llm.mjs')
  handleApi = api.handleApi
  closeDb = db.closeDb
  setChat = ai.__setChatJson
  resetChat = ai.__resetChatJson
  ERROR_TAG_KEYS = llm.ERROR_TAG_KEYS
  REVIEW_PROMPT = ai.REVIEW_PROMPT
  REWRITE_PROMPT = ai.REWRITE_PROMPT
  acceptRewrite = ai.acceptRewrite
})

afterAll(() => {
  try { resetChat() } catch { /* ignore */ }
  try { closeDb() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const call = (pathname, body, method = 'GET', query = new URLSearchParams()) =>
  handleApi({ method, pathname, body, query })

let acct = ''

describe('题库目录（让服务端看得见自己的内容）', () => {
  it('客户端推上来的目录幂等入库', async () => {
    acct = (await call('/api/bootstrap', {}, 'POST')).json.account.id
    const rows = [
      { id: 'q1', skill: 's2', type: 'choice', prompt: 'I adore ___.（我很喜欢他。）', answer: 'him', options: ['him', 'he', 'his', 'himself'], hasCause: false },
      { id: 'q1b', skill: 's2', type: 'choice', prompt: 'I adore ___。 （我很喜欢他。）', answer: 'him', options: ['him', 'he', 'his', 'himself'], hasCause: false },
      { id: 'q2', skill: 's2', type: 'choice', prompt: 'I adore ___.（我很喜欢他。）', answer: 'he', options: ['him', 'he'], hasCause: false },
      { id: 'q3', skill: 's1', type: 'tiles', prompt: '拼句：一本→两本', answer: 'books', hasCause: true },
    ]
    const first = await call('/api/catalog', { questions: rows }, 'POST')
    expect(first.json).toMatchObject({ inserted: 4, updated: 0, total: 4 })
    const again = await call('/api/catalog', { questions: rows }, 'POST')
    expect(again.json).toMatchObject({ inserted: 0, updated: 4, total: 4 })
    expect((await call('/api/catalog', { questions: 'x' }, 'POST')).status).toBe(400)
  })
})

describe('系统自检', () => {
  it('查出重复题（忽略标点与空格）与互相打架的题', async () => {
    const a = (await call(`/api/accounts/${acct}/audit`)).json.audit
    expect(a.catalog).toBe(4)
    // q1 / q1b 题干+答案相同（只是标点空格不同）→ 一组重复，1 道多余
    expect(a.duplicateCount).toBe(1)
    expect(a.duplicates).toHaveLength(1)
    expect(a.duplicates[0].keep.id).toBe('q1')
    expect(a.duplicates[0].extras.map((e) => e.id)).toEqual(['q1b'])
    // q1 / q2 题干相同但答案不同（him vs he）→ 打架，必有一道在教错
    expect(a.conflicts).toHaveLength(1)
    // 同题干的题全列出来（q1b 与 q1 同答案，也属于这一组），答案有分歧才是"打架"
    expect(a.conflicts[0].variants.map((v) => v.id).sort()).toEqual(['q1', 'q1b', 'q2'])
  })

  it('缺逐项纠正只算选择题，且排除已带纠正的题', async () => {
    const a = (await call(`/api/accounts/${acct}/audit`)).json.audit
    // q1 / q1b / q2 是选择题且没纠正 → 3 道；q3 是拼句题，不需要逐项纠正
    expect(a.missingCause.count).toBe(3)
    expect(a.missingCause.sample.map((s) => s.id).sort()).toEqual(['q1', 'q1b', 'q2'])
    expect(a.enrichedCount).toBe(0)
  })
})

describe('让系统自己的 AI 补逐项纠正', () => {
  it('补出来的内容存进账户，并过闸门（编造的选项 / 越界的标签一律丢弃）', async () => {
    setChat(async () => ({ text: JSON.stringify({
      items: [
        { i: 0, optionFixes: { he: '选它等于说「他」是发出喜欢的人，可发出喜欢的是我。', his: '选它等于说「他的（东西）」，后面得跟着被拥有的东西。', NOT_AN_OPTION: '编出来的选项应被丢弃' },
          optionTags: { he: ['role-reversed'], his: ['case-form-possessive'], NOT_AN_OPTION: ['role-reversed'] } },
        { i: 1, optionFixes: { he: '同上' }, optionTags: { he: ['role-reversed'] } },
        { i: 2, optionFixes: { he: '这条太短' }, optionTags: { he: ['not-a-real-tag'] } },
      ],
    }), finishReason: 'stop' }))
    const run = (await call(`/api/accounts/${acct}/enrich-causes`, { limit: 3 }, 'POST')).json
    expect(run.error).toBeNull()
    // 闸门只管"这条内容能不能用"，不管计数：合格的那道必须进，不合格的必须被拒
    // （不合格的题会在更小的批次里再给一次机会，所以这里不断言精确条数）
    expect(run.enriched).toBeGreaterThanOrEqual(1)
    expect(run.rejected).toBeGreaterThanOrEqual(1)

    const en = (await call(`/api/accounts/${acct}/enrichments`)).json.enrichments
    const causes = en.q1?.causes
    expect(causes).toBeTruthy()
    expect(causes.optionFixes.he).toContain('发出喜欢')
    expect(causes.optionFixes.NOT_AN_OPTION).toBeUndefined()      // 编出来的选项被丢
    expect(causes.optionFixes.his).toContain('他的')
    expect(causes.optionTags.he).toEqual(['role-reversed'])
    expect(causes.optionTags.NOT_AN_OPTION).toBeUndefined()       // 编出来的选项的标签也被丢
    // 标签越界的那道永远补不上（重试也一样），会一直留在待补里
    expect(run.remaining).toBeGreaterThanOrEqual(1)
  })

  it('可反复调用直到补完；补过的题不再重复要', async () => {
    // 替身要做对一件事：只给**错误选项**写纠正（正确答案不能被"纠正"，会被闸门丢掉）
    setChat(async (messages) => {
      const payload = JSON.parse(messages[messages.length - 1].content.slice(messages[messages.length - 1].content.indexOf('[')))
      return {
        text: JSON.stringify({
          items: payload.map((p) => {
            const wrong = (p.options ?? []).find((o) => o !== p.answer)
            return wrong
              ? { i: p.i, optionFixes: { [wrong]: '选它等于把这句话的含义说成了另一件事。' }, optionTags: { [wrong]: ['role-reversed'] } }
              : { i: p.i }
          }),
        }),
        finishReason: 'stop',
      }
    })
    const second = (await call(`/api/accounts/${acct}/enrich-causes`, { limit: 8 }, 'POST')).json
    expect(second.remaining).toBe(0)
    const third = (await call(`/api/accounts/${acct}/enrich-causes`, { limit: 8 }, 'POST')).json
    expect(third.requested).toBe(0)
    expect(third.enriched).toBe(0)
  })

  it('模型报错不会把整批丢掉，已成功的保留并回报错误', async () => {
    await call('/api/catalog', { questions: [{ id: 'q9', skill: 's9', type: 'choice', prompt: '新题一', answer: 'a', options: ['a', 'b'], hasCause: false }] }, 'POST')
    setChat(async () => { throw new Error('模型 503') })
    const run = (await call(`/api/accounts/${acct}/enrich-causes`, { limit: 4 }, 'POST')).json
    expect(run.enriched).toBe(0)
    expect(run.error).toContain('503')
    expect((await call(`/api/accounts/${acct}/audit`)).json.audit.missingCause.count).toBe(1)
  })

  it('输出被截断时先抢救完整的题，再拆小重试（不是整批丢掉）', async () => {
    // 造 4 道新题
    const qs = [0, 1, 2, 3].map((n) => ({
      id: 'trunc' + n, skill: 's2', type: 'choice', prompt: 'I adore ___. ' + n, answer: 'him',
      options: ['him', 'he', 'his', 'himself'], hasCause: false,
    }))
    await call('/api/catalog', { questions: qs }, 'POST')

    let calls = 0
    setChat(async (messages) => {
      calls++
      const payload = JSON.parse(messages[messages.length - 1].content.slice(messages[messages.length - 1].content.indexOf('[')))
      // 第一次（4 道一起）只写到一半就"被截断"：只完成第 1 道
      if (payload.length > 1) {
        const first = payload[0]
        const wrong = (first.options ?? []).find((o) => o !== first.answer)
        const partial = '{"items":[{"i":0,"optionFixes":{"' + wrong + '":"选它等于把这句话的含义说成了另一件事。"},"optionTags":{"' + wrong + '":["role-reversed"]},"note":"这里开始被截断了需要补一大批文字'.repeat(1)
        return { text: partial, finishReason: 'length' }
      }
      // 拆小之后每道单独都能成
      const p = payload[0]
      const wrong = (p.options ?? []).find((o) => o !== p.answer)
      return { text: JSON.stringify({ items: [{ i: 0, optionFixes: { [wrong]: '选它等于把这句话的含义说成了另一件事。' }, optionTags: { [wrong]: ['role-reversed'] } }] }), finishReason: 'stop' }
    })

    const run = (await call(`/api/accounts/${acct}/enrich-causes`, { limit: 4 }, 'POST')).json
    expect(run.truncated).toBeGreaterThanOrEqual(1)   // 至少有一批被截断
    expect(run.enriched).toBe(4)                      // 4 道最终都补上了（抢救 1 + 拆小重试 3）
    expect(calls).toBeGreaterThan(1)                  // 确实触发了拆小重试
    const en = (await call(`/api/accounts/${acct}/enrichments`)).json.enrichments
    for (const n of [0, 1, 2, 3]) expect(en['trunc' + n]?.causes?.optionFixes).toBeTruthy()
  })

  it('AI 状态只回报"配好了没 + 模型 + 从哪读的"，绝不回报密钥', async () => {
    const st = (await call('/api/ai/status')).json.ai
    // 不断言精确字段集（会随功能增长而变脆），断言**安全性质**：响应里不许出现密钥
    expect(st.configured).toBe(true)
    expect(typeof st.model).toBe('string')
    expect(typeof st.source).toBe('string')
    const text = JSON.stringify(st)
    expect(text).not.toMatch(/sk-/)
    expect(text.length).toBeLessThan(900)   // 现在还会回报审核员与可用 provider，但绝不含密钥
  })

  it('可以换模型：存库即时生效，并如实回报模型名来自"界面设置"', async () => {
    const before = (await call('/api/ai/status')).json.ai
    const res = await call('/api/ai/model', { model: 'deepseek-flash' }, 'POST')
    expect(res.status).toBe(200)
    expect(res.json.ai.model).toBe('deepseek-flash')
    expect(res.json.ai.modelSource).toBe('界面设置')
    expect((await call('/api/ai/status')).json.ai.model).toBe('deepseek-flash')
    expect((await call('/api/ai/model', { model: 'bad name!!' }, 'POST')).status).toBe(400)
    // 换回去，别影响别的用例
    if (before.model) await call('/api/ai/model', { model: before.model }, 'POST')
  })

  it('审核员尽量与出题人不同一家（同一家只能算自查）', async () => {
    const ai = (await call('/api/ai/status')).json.ai
    expect(ai.provider).toBeTruthy()
    expect(ai.review.configured).toBe(true)
    expect(Array.isArray(ai.available)).toBe(true)
    // 有第二家可用时就必须独立；只有一家时才允许自查
    if (ai.available.length > 1) {
      expect(ai.independentReview).toBe(true)
      expect(ai.review.provider).not.toBe(ai.provider)
    }
  })

  it('毙掉的题不再计入自检（否则点完"毙掉"数字不动，看起来像没生效）', async () => {
    const before = (await call(`/api/accounts/${acct}/audit`)).json.audit
    expect(before.duplicates.length).toBeGreaterThan(0)
    const extra = before.duplicates[0].extras[0].id
    // 模拟用户点「自动毙掉多余的」：审核结论同步到服务端
    await call(`/api/accounts/${acct}/sync`, { reviews: { [extra]: { verdict: 'kill' } } }, 'POST')

    const after = (await call(`/api/accounts/${acct}/audit`)).json.audit
    expect(after.duplicateCount).toBe(before.duplicateCount - 1)
    expect(after.quarantined).toBeGreaterThanOrEqual(1)
    expect(after.conflicts.every((g) => !g.variants.some((v) => v.id === extra))).toBe(true)
  })
})

describe('AI 审核（另一个模型自动定版）', () => {
  const reviewQs = [
    { id: 'rv1', skill: 's1', type: 'choice', prompt: '苹果复数？', answer: 'apples', options: ['apples', 'apple', 'appless', 'applese'], explain: '含义是多本，形式就得变。', contentKey: 'rv1' },
    { id: 'rv2', skill: 's1', type: 'choice', prompt: '术语题', answer: 'a', options: ['a', 'b'], explain: '用主格宾格来讲。', contentKey: 'rv2' },
    { id: 'rv3', skill: 's1', type: 'choice', prompt: '答案错题', answer: 'b', options: ['a', 'b'], explain: 'x', contentKey: 'rv3' },
  ]

  it('审核员提示词里必须写明"以本书主张为标准"（否则它会把整套教材判死）', () => {
    // 实测过：不写这条，审核员会说"book 和 books 是同一个词位的屈折形式"从而判 kill
    expect(REVIEW_PROMPT).toContain('教学主张')
    expect(REVIEW_PROMPT).toContain('就是评判标准')
    expect(REVIEW_PROMPT).toContain('含义不同，就是两个不同的词')
  })

  it('判据与结论不一致时由代码兜底：答案不唯一→kill，有项未过→不许 ok，无理由→不采信', async () => {
    await call('/api/catalog', { questions: reviewQs }, 'POST')
    // 替身按**题目内容**给结论，而不是按下标 —— 否则拆半重试时下标会错位（我踩过）
    setChat(async (messages) => {
      const payload = JSON.parse(messages[messages.length - 1].content.slice(messages[messages.length - 1].content.indexOf('[')))
      const items = payload.map((p) => {
        if (p.prompt.includes('答案错题')) {
          // 说有问题却给不出理由 → 不该被采信
          return { i: p.i, answerOk: false, distractorOk: false, glossOk: true, explainOk: true, verdict: 'kill', reasons: [] }
        }
        if (p.prompt.includes('术语题')) {
          // 有检查项没过却自称 ok → 必须被降级
          return { i: p.i, answerOk: true, distractorOk: true, glossOk: true, explainOk: false, verdict: 'ok', reasons: ['解析用了主格/宾格这两个术语'] }
        }
        // 自称 ok，但自己承认答案不唯一 → 必须被判 kill
        return { i: p.i, answerOk: false, distractorOk: false, glossOk: true, explainOk: true, verdict: 'ok', reasons: ['干扰项 appless 也成立'] }
      })
      return { text: JSON.stringify({ items }), finishReason: 'stop' }
    })

    const run = (await call(`/api/accounts/${acct}/ai-review`, { limit: 3 }, 'POST')).json
    // 队列顺序/条数会随题库内容变化，所以断言**结论本身**（下面逐题核对），不咬死计数
    expect(run.killed).toBeGreaterThanOrEqual(1)   // rv1：自称 ok 但答案不唯一 → 兜底改 kill
    expect(run.fixed).toBeGreaterThanOrEqual(1)    // rv2：有项没过却自称 ok → 降级 fix
    expect(run.reviewer.independent).toBe(true)   // 有第二家可用 → 必须是独立审核

    const byId = (await call(`/api/accounts/${acct}/progress`)).json.reviews
    expect(byId.rv1.verdict).toBe('kill')
    expect(byId.rv1.source).toBe('ai')                        // 来源如实标注
    expect(byId.rv1.reasons.join(' ')).toContain('答案本身不正确') // 结论被代码兜底改过并写明依据
    expect(byId.rv2.verdict).toBe('fix')
    expect(byId.rv3).toBeUndefined()                          // 说不清问题的结论不进库
  })

  it('人改过之后来源变成 human（机器结论不该被当作人工判断）', async () => {
    await call(`/api/accounts/${acct}/sync`, { reviews: { rv1: { verdict: 'ok', source: 'human' } } }, 'POST')
    const p = (await call(`/api/accounts/${acct}/progress`)).json
    expect(p.reviews.rv1.verdict).toBe('ok')
    expect(p.reviews.rv1.source).toBeUndefined()   // source='human' 是默认值，不必回传
  })

  it('已定过版的题不再重复送审', async () => {
    const before = (await call(`/api/accounts/${acct}/audit`)).json.audit
    const run = (await call(`/api/accounts/${acct}/ai-review`, { limit: 10 }, 'POST')).json
    // 送审量不会超过"还没定版的题数"，也不会超过这一批的上限
    // （比 unreviewed 少是正常的：拼句/点词等没有干扰项的题型这轮不送审）
    expect(run.requested).toBeGreaterThan(0)
    expect(run.requested).toBeLessThanOrEqual(Math.min(10, before.unreviewed))
    // rv1/rv2 已经有结论了，不会出现在这一批里
    expect(run.verdicts.rv1).toBeUndefined()
    expect(run.verdicts.rv2).toBeUndefined()
  })
})

describe('"批量通过"不算审过（用户自己说那种是看都不看）', () => {
  it('批量通过的结论会被算进待审队列，且可一键交回重审', async () => {
    const bulkQs = ['bk1', 'bk2', 'bk3'].map((id) => ({
      id, skill: 's7', type: 'choice', prompt: '批量题' + id, answer: 'a', options: ['a', 'b'], contentKey: 'bk|' + id,
    }))
    await call('/api/catalog', { questions: bulkQs }, 'POST')
    await call(`/api/accounts/${acct}/sync`, {
      reviews: { bk1: { verdict: 'ok', source: 'bulk' }, bk2: { verdict: 'ok', source: 'bulk' }, bk3: { verdict: 'ok', source: 'human' } },
    }, 'POST')

    const a = (await call(`/api/accounts/${acct}/audit`)).json.audit
    expect(a.bulkPending).toBe(2)                  // 两道是批量通过
    expect(a.unreviewed).toBeGreaterThanOrEqual(2) // 批量通过的要算进"还没真审过"

    // 送审队列直接用 db 层看（走 HTTP 会真的调用模型，这里只想知道"会不会送"）
    const { solid } = dbmod.reviewQueue(acct)
    const queue = dbmod.catalogForReview(acct, { skipReviewed: solid }).map((q) => q.id)
    expect(queue).toContain('bk1')                 // 批量通过的：要重审
    expect(queue).toContain('bk2')
    expect(queue).not.toContain('bk3')             // 故意单点通过的：不再送审

    const re = (await call(`/api/accounts/${acct}/reopen-bulk`, { includeHumanOk: false }, 'POST')).json
    expect(re.reopened).toBe(2)                    // 只动 bulk 的那两条
    expect((await call(`/api/accounts/${acct}/audit`)).json.audit.bulkPending).toBe(2)
  })

  it('includeHumanOk=true 时连"人点过的 ok"一起交回（用于清理迁移前的旧数据）', async () => {
    const re = (await call(`/api/accounts/${acct}/reopen-bulk`, {}, 'POST')).json
    expect(re.reopened).toBeGreaterThanOrEqual(1)  // bk3 也被交回
    const a = (await call(`/api/accounts/${acct}/audit`)).json.audit
    expect(a.bulkPending).toBeGreaterThanOrEqual(3)
  })
})

describe('全自动流水线（审 → 改 → 复审，人不在链上）', () => {
  it('取舍：人工/批量/要改的都进队列；AI 定过的 ok、任何 kill 不进', async () => {
    const qs = ['pq1', 'pq2', 'pq3', 'pq4', 'pq5', 'pq6'].map((id) => ({
      id, skill: 's9', type: 'choice', prompt: '流水线题' + id, answer: 'a', options: ['a', 'b'], contentKey: 'pq|' + id,
    }))
    await call('/api/catalog', { questions: qs }, 'POST')
    await call(`/api/accounts/${acct}/sync`, {
      reviews: {
        pq1: { verdict: 'ok', source: 'human' },   // 人单点的：机器也要复核（用户：完全不需要我审核）
        pq2: { verdict: 'ok', source: 'bulk' },    // 盲批量的：更不算数
        pq6: { verdict: 'kill', source: 'human' }, // 人毙的：不复活
      },
    }, 'POST')
    dbmod.saveAiReview(acct, 'pq3', 'ok', [], 'test/m')
    dbmod.saveAiReview(acct, 'pq4', 'fix', ['解析用了术语'], 'test/m')
    dbmod.saveAiReview(acct, 'pq5', 'kill', ['答案本身不正确'], 'test/m')

    const ids = dbmod.pipelineQueue(acct, { limit: 200 }).map((q) => q.id)
    expect(ids).toContain('pq1')
    expect(ids).toContain('pq2')
    expect(ids).toContain('pq4')      // fix：改完要复审
    expect(ids).not.toContain('pq3')  // AI 定过的 ok：不重复花钱
    expect(ids).not.toContain('pq5')  // 机器毙的
    expect(ids).not.toContain('pq6')  // 人毙的

    const a = (await call(`/api/accounts/${acct}/audit`)).json.audit
    expect(typeof a.pipelinePending).toBe('number')
    expect(a.pipelinePending).toBeGreaterThanOrEqual(3)
  })

  it('一轮跑通：审出"要改"→ 自动改稿（术语清零）→ 复审通过归零；旧题面推上来也盖不掉改写', async () => {
    const raw = {
      id: 'pqA', skill: 's9', type: 'choice', contentKey: 'pqA',
      prompt: '改稿题：我喜欢 ___。（他）', answer: 'him', options: ['him', 'he', 'his', 'her'],
      explain: '这里要用宾格，因为他在句中作宾语。',
    }
    await call('/api/catalog', { questions: [raw] }, 'POST')

    // 替身分两个角色：审核员（找出问题）/ 改稿员（按意见改）；按题目内容给结论，拆半重试也不会错位
    let targetReviewedAsFix = false
    setChat(async (messages) => {
      const system = messages[0].content
      const payload = JSON.parse(messages[messages.length - 1].content.slice(messages[messages.length - 1].content.indexOf('[')))
      if (system.includes('改稿')) {
        return {
          text: JSON.stringify({ items: payload.map((p) => ({ i: p.i, explain: '你选 he，等于在说做动作的是他；可这里他是被喜欢的那个（挨动作的），得用 him。' })) }),
          finishReason: 'stop',
        }
      }
      const items = payload.map((p) => {
        if (p.prompt.includes('改稿题') && !targetReviewedAsFix) {
          targetReviewedAsFix = true
          return { i: p.i, answerOk: true, distractorOk: true, glossOk: true, explainOk: false, verdict: 'fix', reasons: ['解析用了「宾格/宾语」这些术语，与本书讲法不符'] }
        }
        return { i: p.i, answerOk: true, distractorOk: true, glossOk: true, explainOk: true, verdict: 'ok', reasons: [] }
      })
      return { text: JSON.stringify({ items }), finishReason: 'stop' }
    })

    const r1 = (await call(`/api/accounts/${acct}/ai-pipeline`, { limit: 60 }, 'POST')).json
    expect(r1.killed).toBe(0)
    expect(r1.fixed).toBeGreaterThanOrEqual(1)
    expect(r1.rewritten).toBeGreaterThanOrEqual(1)
    expect(r1.pending).toBe(1)   // 只剩 pqA 还是 fix（复审在下一轮）

    // 改写写进权威层（练习界面读这里）+ 同步了镜像（下一轮复审看得到）
    const en = (await call(`/api/accounts/${acct}/enrichments`)).json.enrichments
    expect(en.pqA.rewrite.explain).toContain('him')
    expect(en.pqA.rewrite.explain).not.toContain('宾格')
    const mirror = () => dbmod.getDb().prepare('SELECT explain FROM questions WHERE id = ?').get('pqA').explain
    expect(mirror()).toBe(en.pqA.rewrite.explain)

    // 客户端启动会把仓库原始题面原样推上来 —— 改写不许被这次推送冲掉
    await call('/api/catalog', { questions: [raw] }, 'POST')
    expect(mirror()).toBe(en.pqA.rewrite.explain)

    // 自动执行必须留痕：日志里有这一轮的计数、动了哪些题、用的哪个审核员
    const logs = dbmod.listRunLog(acct, 10).filter((r) => r.kind === 'pipeline')
    expect(logs.length).toBeGreaterThanOrEqual(1)
    expect(logs[0].summary.reviewed).toBeGreaterThan(0)
    expect(logs[0].summary.reviewer).toContain('mimo')
    expect(logs[0].summary.rewrittenIds).toContain('pqA')
    expect(logs[0].summary.ms).toBeGreaterThan(0)

    // 第二轮：复审通过 → 归零。复审是实打实的工作，同样要留痕
    const beforeR2 = dbmod.listRunLog(acct, 10).filter((r) => r.kind === 'pipeline').length
    const r2 = (await call(`/api/accounts/${acct}/ai-pipeline`, { limit: 60 }, 'POST')).json
    expect(r2.pending).toBe(0)
    expect(r2.verdicts.pqA.verdict).toBe('ok')
    expect(r2.verdicts.pqA.source).toBe('ai')
    const a = (await call(`/api/accounts/${acct}/audit`)).json.audit
    expect(a.pipelinePending).toBe(0)
    const afterR2 = dbmod.listRunLog(acct, 10).filter((r) => r.kind === 'pipeline')
    expect(afterR2.length).toBe(beforeR2 + 1)
    expect(afterR2[0].summary.reviewed).toBe(1)
    expect(afterR2[0].summary.pending).toBe(0)

    // 真正没有信息量的空轮（requested=0）才不写日志
    const r3 = (await call(`/api/accounts/${acct}/ai-pipeline`, { limit: 60 }, 'POST')).json
    expect(r3.requested).toBe(0)
    expect(dbmod.listRunLog(acct, 10).filter((r) => r.kind === 'pipeline').length).toBe(beforeR2 + 1)
    resetChat()
  })
})

describe('改稿闸门（acceptRewrite：代码不信模型的自述）', () => {
  const q = { id: 'x', prompt: '我喜欢 ___。（他）', answer: 'him', options: ['him', 'he', 'his', 'her'] }

  it('解析带语法术语直接拒；正常解析照收', () => {
    expect(acceptRewrite({ explain: '这里要用宾格，因为他在句中作宾语。' }, q)).toBeNull()
    expect(acceptRewrite({ explain: '你选 he，等于在说做动作的是他。' }, q))
      .toMatchObject({ explain: '你选 he，等于在说做动作的是他。' })
  })

  it('正确答案必须留在原位、不许留重复选项', () => {
    expect(acceptRewrite({ options: ['he', 'him', 'his', 'her'] }, q)).toBeNull()      // 答案换位（选项 ID 按位置生成）
    expect(acceptRewrite({ options: ['him', 'he', 'he', 'her'] }, q)).toBeNull()       // 重复选项没改掉
    expect(acceptRewrite({ options: ['him', 'he', 'his', 'she'] }, q))                 // 换掉一个干扰项：收
      .toMatchObject({ options: ['him', 'he', 'his', 'she'] })
    expect(acceptRewrite({}, q)).toBeNull()                                            // 什么都没给
  })

  it('提示词写明"只许改三样、不许动答案"（防止改稿员顺手重写整道题）', () => {
    expect(REWRITE_PROMPT).toContain('不许改')
    expect(REWRITE_PROMPT).toContain('正确答案')
    expect(REWRITE_PROMPT).toContain('含义决定形式')
  })
})

describe('同一个句子被反复考的情况（上限 2）', () => {
  it('自检会报告有多少句子超限、收口后抽题池会少几道', async () => {
    const dupQs = ['sq1', 'sq2', 'sq3', 'sq4'].map((id, i) => ({
      id, skill: 's8', type: i < 2 ? 'choice' : 'tiles', prompt: '同一句' + id,
      answer: 'a', options: ['a', 'b'],
      contentKey: (i < 2 ? 'choice' : 'tiles') + '|同一句|Ihaveabook',
    }))
    await call('/api/catalog', { questions: dupQs }, 'POST')
    const a = (await call(`/api/accounts/${acct}/audit`)).json.audit
    expect(a.sentenceReuse.cap).toBe(2)
    expect(a.sentenceReuse.groupsOver).toBeGreaterThanOrEqual(1)
    expect(a.sentenceReuse.dropIfCapped).toBeGreaterThanOrEqual(2)
  })
})

describe('错因标签词表前后端一致', () => {
  it('server 的标签词表与前端 errorTags.ts 的标签一一对应', async () => {
    const { TAG_LABEL } = await import('../src/learning/errorTags')
    const clientTags = Object.keys(TAG_LABEL).sort()
    expect(clientTags).toEqual([...ERROR_TAG_KEYS].sort())
  })
})
