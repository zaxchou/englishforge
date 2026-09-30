// W6：216 组原子化推进工具（docs/curriculum-v4/15 §11.6/§11.7、00 §4 P1）。
//
// 诚实边界（13 §3：不可用 AI 自动填满后直接宣称全覆盖）：
// · 本脚本产出的是 **AI 草稿**（ai_draft_unreviewed），写入 v3-decompose-drafts.json；
// · 账本状态只从 pending → decomposing，fact_review_status 恒为 pending；
// · 草稿在人工逐条核验前不进 objective_versions、不算覆盖、不可教学；
// · 断点续跑：每完成一组就落盘，重跑自动跳过已完成组。
// 用法：node scripts/decompose-ledger.mjs [--units=10] [--only=U03,U39]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatWithMeta, LlmError } from '../server/llm.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SEED = resolve(ROOT, 'server', 'data', 'v3-map-seed.json')
const OUT = resolve(ROOT, 'server', 'data', 'v3-decompose-drafts.json')

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))

const seed = JSON.parse(readFileSync(SEED, 'utf8'))
const drafts = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { notice: notice(), units: {} }

function notice() {
  return 'AI 草稿（ai_draft_unreviewed）：仅作账本推进的工作底稿，未经人工事实核验前不得进 objective_versions、不得教学、不算覆盖。'
}

// 按单元聚合（一次调用拆一个单元的 2~4 个组，控制调用数）
const byUnit = {}
for (const g of seed.groups) (byUnit[g.unitId] ??= []).push(g)
let unitIds = Object.keys(byUnit)
if (args.only) unitIds = unitIds.filter((u) => String(args.only).split(',').includes(u))
const limit = Number(args.units ?? 0) // 0 = 不限量

let done = 0
let processed = 0
for (const unitId of unitIds) {
  if (limit && processed >= limit) break
  processed++
  if (drafts.units[unitId]) { done++; continue } // 断点续跑
  const groups = byUnit[unitId]
  const prompt = [
    '你在为成人英语课程拆解能力目标。给一个单元的若干知识组（组名/复杂度层级/单元出口任务），',
    '为**每个组**产出 2~3 条可观察的原子目标草稿。',
    '只输出 JSON：{"groups":[{"groupId","drafts":[{"name","behavior","boundary","prerequisiteHints":[],"taskFamily","skill"}]}]}，不要 markdown。',
    '要求：behavior 写"学习者能做什么+在什么条件下"，可观察、可判分；boundary 写判分边界与不适用范围；',
    'skill 从 listening/speaking/reading/writing/interaction 中选主技能；这是草稿，事实核验由人工另行完成。',
    '',
    `单元 ${unitId}：`,
    ...groups.map((g) => `- ${g.groupId} ${g.title}（复杂度 ${g.complexityBand}；出口：${g.unitExitTask}；参考：${g.referenceScope.join('/')}）`),
  ].join('\n')
  try {
    const out = await chatWithMeta([{ role: 'user', content: prompt }], { maxTokens: 2000 })
    let parsed
    try { parsed = JSON.parse(out.text.match(/\{[\s\S]*\}/)?.[0] ?? out.text) } catch { throw new LlmError('bad json') }
    drafts.units[unitId] = {
      model: 'deepseek', generatedAt: new Date().toISOString(),
      groups: (parsed.groups ?? []).map((g) => ({ groupId: g.groupId, drafts: g.drafts ?? [] })),
    }
    done++
    writeFileSync(OUT, JSON.stringify(drafts, null, 1) + '\n') // 每组落盘（断点续跑）
    console.log(`[decompose] ${unitId} ok (${done}/${unitIds.length})`)
  } catch (e) {
    console.error(`[decompose] ${unitId} FAILED: ${String(e.message).slice(0, 100)}`)
    // 失败不中断：继续下一单元（resumable）
  }
  await new Promise((r) => setTimeout(r, 300)) // 温和限速
}
const totalDrafts = Object.values(drafts.units).reduce((n, u) => n + u.groups.reduce((m, g) => m + g.drafts.length, 0), 0)
console.log(`[decompose] done: ${Object.keys(drafts.units).length} units, ${totalDrafts} draft objectives -> ${OUT}`)
