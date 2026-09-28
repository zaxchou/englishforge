// 系统自检与自我修复的集成测试。
//
// 覆盖的是用户最在意的那条：「系统本身要能修内容」——查重、找打架的题、让系统 AI 补逐项纠正，
// 而且补出来的东西要能通过闸门（编出来的选项、越界的标签一律丢弃）。
// 模型调用用替身注入，不打真实 API（省流量，也让断言可控）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, handleApi, closeDb, setChat, resetChat, ERROR_TAG_KEYS

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-audit-'))
  process.env.ENVIRONMENT = 'test'
  process.env.ENGLISHFORGE_DB = join(dir, 'audit.db')
  const api = await import('./api.mjs')
  const db = await import('./db.mjs')
  const ai = await import('./content-ai.mjs')
  const llm = await import('./llm.mjs')
  handleApi = api.handleApi
  closeDb = db.closeDb
  setChat = ai.__setChatJson
  resetChat = ai.__resetChatJson
  ERROR_TAG_KEYS = llm.ERROR_TAG_KEYS
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

  it('AI 状态只回报"配好了没"，绝不回报密钥', async () => {
    const st = (await call('/api/ai/status')).json.ai
    expect(Object.keys(st).sort()).toEqual(['configured', 'model', 'source'])
    expect(JSON.stringify(st)).not.toMatch(/sk-/)
  })
})

describe('错因标签词表前后端一致', () => {
  it('server 的标签词表与前端 errorTags.ts 的标签一一对应', async () => {
    const { TAG_LABEL } = await import('../src/learning/errorTags')
    const clientTags = Object.keys(TAG_LABEL).sort()
    expect(clientTags).toEqual([...ERROR_TAG_KEYS].sort())
  })
})
