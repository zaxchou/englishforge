// 深度阶梯：把"层层递进"变成可解锁的档位。
//
// 为什么需要它：掌握判据（evidence.ts）只回答"这个知识点掌握没有"，它不回答
// **"我现在做的题有多深"**。题库一旦分了档（认→造→辨→说→迁→释），
// 如果不按档放行，抽题池会把 6 档全部混在一起按 SRS 分捞（新题都是 100 分），
// 用户看到的就是"一堆难度随机的题"——递进感消失。
//
// 三个设计边界：
// 1. **只管有阶梯的技能**：无阶梯的技能（老题库全部 level=1）返回 unlocked=6，
//    行为与改造前完全一致，不影响任何旧题。
// 2. **通过 = 做满本档 + 首发答对达到门槛**（答对 ≥ 2/3 且至少 1 题），既看做过也看做对，
//    与"掌握即升级"同源：不数覆盖率，但 3 题的小档必须真的做出来。
// 3. **防卡死必须有**：本档累计首发作答达 题数×3 仍不达标就放行
//    （同 ADVANCE_ATTEMPT_FALLBACK 的存在理由：档位不该成为永久牢房）。
import type { AdaptedQuestion, ProgressV2 } from '../types'

export type LadderLevel = 1 | 2 | 3 | 4 | 5 | 6

export interface LadderStep {
  level: LadderLevel
  short: string      // 图标/圆点上用的单字
  name: string       // 全名
  desc: string       // 一句话：这档到底在考什么
}

export const LADDER_STEPS: LadderStep[] = [
  { level: 1, short: '认', name: '识别形式↔含义', desc: '看懂意思，选出唯一正确的形式' },
  { level: 2, short: '造', name: '受控产出', desc: '给词块，按意思把句子拼出来' },
  { level: 3, short: '辨', name: '最小对立对比', desc: '词序一换，谁做谁挨就翻过来' },
  { level: 4, short: '说', name: '无脚手架产出', desc: '不看原句，对着中文直接说' },
  { level: 5, short: '迁', name: '干扰下迁移', desc: '长句、对话里照样选对' },
  { level: 6, short: '释', name: '反向解释为何错', desc: '说清错的形式其实在说什么' },
]

export interface LevelStatus {
  level: LadderLevel
  total: number      // 本档在抽题池里的题数
  done: number       // 已作答过
  firstOk: number    // 首发答对
  need: number       // 通过所需首发答对数
  attempts: number   // 本档累计首发作答（防卡死计数）
  passed: boolean
  /** 本档还差什么（给界面看，空串 = 已过） */
  gap: string
}

/** 通过所需首发答对数：2/3，但至少 1 题（3 题档 = 2 题） */
export function needOf(total: number): number {
  if (total <= 0) return 0
  return Math.max(1, Math.floor((total * 2) / 3))
}

/** 该技能在题池里实际有哪几档（全 level 1 = 没有阶梯） */
export function ladderLevels(pool: AdaptedQuestion[], skillId: string): LadderLevel[] {
  const set = new Set<LadderLevel>()
  for (const q of pool) if (q.skill === skillId) set.add(q.level as LadderLevel)
  const list = [...set].sort((a, b) => a - b)
  return list.length > 1 ? list : []
}

export function hasLadder(pool: AdaptedQuestion[], skillId: string | null): boolean {
  return !!skillId && ladderLevels(pool, skillId).length > 1
}

/** 逐档状态：做完了吗、做对了吗、还差什么 */
export function levelStatuses(
  pool: AdaptedQuestion[],
  progress: ProgressV2,
  skillId: string,
): LevelStatus[] {
  const firstOkQ = new Set<string>()
  const doneQ = new Set<string>()
  const attemptsPerQ = new Map<string, number>()
  for (const a of progress.attempts) {
    if (a.evaluator !== 'deterministic') continue
    doneQ.add(a.questionId)
    if (a.firstAttempt && a.outcome !== 'skipped' && a.outcome !== 'uncertain') {
      attemptsPerQ.set(a.questionId, (attemptsPerQ.get(a.questionId) ?? 0) + 1)
      if (a.outcome === 'correct') firstOkQ.add(a.questionId)
    }
  }

  return ladderLevels(pool, skillId).map((level) => {
    const qs = pool.filter((q) => q.skill === skillId && q.level === level)
    const total = qs.length
    const done = qs.filter((q) => doneQ.has(q.id)).length
    const firstOk = qs.filter((q) => firstOkQ.has(q.id)).length
    const attempts = qs.reduce((n, q) => n + (attemptsPerQ.get(q.id) ?? 0), 0)
    const need = needOf(total)
    const ok = done === total && firstOk >= need
    const deadlocked = attempts >= total * 3
    const passed = ok || deadlocked
    let gap = ''
    if (!passed) {
      const bits: string[] = []
      if (done < total) bits.push(`做完本档 ${done}/${total} 题`)
      if (firstOk < need) bits.push(`首发答对 ${firstOk}/${need}`)
      gap = bits.join(' · ')
    }
    return { level, total, done, firstOk, need, attempts, passed, gap }
  })
}

/** 已解锁到第几档（连续解锁：前一档过了才开下一档）；无阶梯 → 6（全部放行，老题库行为不变） */
export function unlockedLevel(pool: AdaptedQuestion[], progress: ProgressV2, skillId: string): number {
  const levels = ladderLevels(pool, skillId)
  if (levels.length === 0) return 6
  const statuses = levelStatuses(pool, progress, skillId)   // 已按档位升序
  let unlocked = statuses[0].level
  for (let i = 1; i < statuses.length; i++) {
    if (statuses[i - 1].passed) unlocked = statuses[i].level
    else break                       // 卡在未通过的那档，后面一律不开
  }
  return unlocked
}

/** 按档位过滤题池：只放行已解锁的档。无阶梯的技能原样保留。 */
export function ladderFilter(
  pool: AdaptedQuestion[],
  progress: ProgressV2,
): AdaptedQuestion[] {
  const bySkill = new Map<string, AdaptedQuestion[]>()
  for (const q of pool) {
    const arr = bySkill.get(q.skill)
    if (arr) arr.push(q)
    else bySkill.set(q.skill, [q])
  }
  const out: AdaptedQuestion[] = []
  for (const [sid, qs] of bySkill) {
    const max = qs.reduce((m, q) => Math.max(m, q.level ?? 1), 1)
    if (max <= 1) { out.push(...qs); continue }          // 无阶梯 → 全放行
    const unlocked = unlockedLevel(pool, progress, sid)
    out.push(...qs.filter((q) => (q.level ?? 1) <= unlocked))
  }
  return out
}
