// 学习证据：从作答事件推导能力证据与状态（PLAN-v2 §5.1、§5.2）
// 原则：证据可重建（不依赖缓存字段）；历史 box 不当新证据；口头表达单独显示
import type { AdaptedQuestion, Attempt, Mode, ProgressV2 } from '../types'

export type SkillState = 'unseen' | 'building' | 'early-stable' | 'durable'

export const STATE_LABEL: Record<SkillState, string> = {
  unseen: '未练习',
  building: '建立中',
  'early-stable': '初步稳定',
  durable: '持续巩固',
}

export interface SkillEvidence {
  state: SkillState
  evidence: string[]          // 该状态所依据的证据 / 差哪一步
  last10: { correct: number; total: number }
  days: number
  openErrors: number
  legacyOnly: boolean         // 只有 v1 历史练习记录，无 v2 事件证据
}

export interface DimSummary {
  mode: Mode
  correct: number
  total: number
  label: string
}

export interface EvidenceReport {
  bySkill: Record<string, SkillEvidence>
  dims: DimSummary[]                      // 识别 / 理解 / 构造（客观分项）
  dueSuccesses: number                    // 延迟保持：到期检索首次独立成功次数
  oral: { prompted: number; independentSelf: number; independentAi: number }
  openErrorQids: Set<string>
}

const DIM_LABEL: Record<Mode, string> = {
  recognition: '形式识别',
  comprehension: '含义理解',
  construction: '有提示表达',
  oral: '口头表达',
}

const DAY = 24 * 60 * 60 * 1000

/** 合格客观作答：确定性判定、该题首发、结果非跳过/非存疑、题目在有效池内，
 *  且 contentVersion 与当前题目一致（题目修订后旧证据要求重检，用例 10） */
function objectiveAttempts(p: ProgressV2, questions: AdaptedQuestion[]): Attempt[] {
  const byId = new Map(questions.map((q) => [q.id, q]))
  return p.attempts.filter((a) => {
    const q = byId.get(a.questionId)
    if (!q) return false
    if (a.contentVersion !== q.contentVersion) return false
    return a.evaluator === 'deterministic' &&
      a.firstAttempt &&
      a.outcome !== 'skipped' &&
      a.outcome !== 'uncertain'
  })
}

/** 同一会话同一变式组最多贡献一次覆盖（防换名刷覆盖，§5.2） */
function dedupeBySessionVg(attempts: Attempt[]): Attempt[] {
  const seen = new Set<string>()
  const out: Attempt[] = []
  for (const a of attempts) {
    const key = `${a.sessionId}:${a.variantGroupId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

/** 每个变式组取最近一次失败；未同时满足「后续不同变式独立成功 + 该题延迟检索成功」即未处理 */
function openErrorsOf(skillAttempts: Attempt[]): Set<string> {
  const open = new Set<string>()
  const failures = skillAttempts.filter((a) => a.outcome === 'incorrect')
  // 只看每个 (vg) 的最近一次失败
  const latestByVg = new Map<string, Attempt>()
  for (const f of failures) {
    const prev = latestByVg.get(f.variantGroupId)
    if (!prev || f.timestamp >= prev.timestamp) latestByVg.set(f.variantGroupId, f)
  }
  for (const f of latestByVg.values()) {
    const later = skillAttempts.filter((a) => a.timestamp > f.timestamp)
    const variantDone = later.some((a) =>
      a.firstAttempt && a.outcome === 'correct' && a.evaluator === 'deterministic' &&
      a.variantGroupId !== f.variantGroupId)
    const delayedChecked = later.some((a) =>
      a.firstAttempt && a.outcome === 'correct' && a.evaluator === 'deterministic' &&
      a.questionId === f.questionId && a.isDueReview)
    if (!(variantDone && delayedChecked)) open.add(f.questionId)
  }
  return open
}

export function buildEvidence(p: ProgressV2, pool: AdaptedQuestion[]): EvidenceReport {
  const skillOf = new Map(pool.map((q) => [q.id, q.skill]))
  const skillOral = new Map(pool.map((q) => [q.id, q.mode === 'oral']))

  const obj = objectiveAttempts(p, pool).slice()   // 时间序（push 序）
  const bySkillAttempts = new Map<string, Attempt[]>()
  for (const a of obj) {
    const sid = skillOf.get(a.questionId)
    if (!sid) continue
    const arr = bySkillAttempts.get(sid) ?? []
    arr.push(a)
    bySkillAttempts.set(sid, arr)
  }

  const bySkill: Record<string, SkillEvidence> = {}
  const openErrorQids = new Set<string>()

  for (const sid of new Set(pool.map((q) => q.skill))) {
    const all = bySkillAttempts.get(sid) ?? []
    const open = openErrorsOf(all)
    for (const qid of open) openErrorQids.add(qid)

    const hasLegacy = pool.some((q) => q.skill === sid && p.questionStates[q.id]?.legacy)
    const evidence: string[] = []

    if (all.length === 0) {
      bySkill[sid] = {
        state: 'unseen',
        evidence: hasLegacy ? ['只有历史练习记录（v1），尚无新的作答事件证据'] : [],
        last10: { correct: 0, total: 0 },
        days: 0,
        openErrors: 0,
        legacyOnly: hasLegacy,
      }
      continue
    }

    // 最近 10 次合格客观首发作答
    const recent = all.slice(-10)
    const window = dedupeBySessionVg(recent)
    const correct = window.filter((a) => a.outcome === 'correct').length
    const total = window.length
    const rate = total ? correct / total : 0
    const days = new Set(window.map((a) => a.localDate)).size
    const vgs = new Set(window.map((a) => a.variantGroupId))

    const mOf = (qid: string): Mode | undefined => pool.find((q) => q.id === qid)?.mode
    const recOk = window.some((a) => a.outcome === 'correct' && mOf(a.questionId) === 'recognition')
    const compOk = window.some((a) => a.outcome === 'correct' && mOf(a.questionId) === 'comprehension')
    const conOk = window.some((a) => a.outcome === 'correct' && mOf(a.questionId) === 'construction')

    const rateOk = rate >= 0.8 && total >= 3
    const daysOk = days >= 2
    const vgOk = vgs.size >= 3
    const dimsOk = recOk && compOk && conOk
    const noOpen = open.size === 0

    let state: SkillState = 'building'
    if (rateOk && daysOk && vgOk && dimsOk && noOpen) state = 'early-stable'

    // 证据文案（含"差哪一步"，不用低分挫败用户）
    evidence.push(`近 ${total} 次首发答对 ${correct} 次${rateOk ? '（≥80%）' : `（需 ≥80%，还差 ${Math.max(1, Math.ceil(total * 0.8) - correct)} 次）`}`)
    evidence.push(daysOk ? `覆盖 ${days} 个训练日` : `需跨 2 个训练日（现在 ${days} 天）`)
    evidence.push(vgOk ? `覆盖 ${vgs.size} 个变式组` : `需覆盖 3 个变式组（现在 ${vgs.size} 个）`)
    const dims = [recOk ? '识别✓' : '识别', compOk ? '理解✓' : '理解', conOk ? '表达✓' : '表达'].join(' · ')
    evidence.push(dimsOk ? `三类证据齐全：${dims}` : `还缺：${dims}`)
    if (open.size > 0) evidence.push(`${open.size} 个错题待"换变式 + 隔日检查"后才算处理`)

    // 持续巩固：初步稳定 + 至少 2 次到期检索成功，其中 1 次距初次学习 ≥7 天
    if (state === 'early-stable') {
      const dueOk = all.filter((a) => a.isDueReview && a.firstAttempt && a.outcome === 'correct')
      const firstAt = all[0]?.timestamp ?? 0
      const due7 = dueOk.find((a) => a.timestamp - firstAt >= 7 * DAY)
      if (dueOk.length >= 2 && due7) {
        state = 'durable'
        evidence.push(`到期检索成功 ${dueOk.length} 次（含 1 次 ≥7 天后）`)
      } else {
        evidence.push(`还需隔日检查（到期检索成功 ${dueOk.length}/2 次${dueOk.length < 2 ? '' : '，缺 ≥7 天后 1 次'}）`)
      }
    }

    bySkill[sid] = {
      state,
      evidence,
      last10: { correct, total },
      days,
      openErrors: open.size,
      legacyOnly: false,
    }
  }

  // 分项证据（客观）
  const dims: DimSummary[] = (['recognition', 'comprehension', 'construction'] as Mode[]).map((m) => {
    const arr = obj.filter((a) => a.mode === m).slice(-10)
    return {
      mode: m,
      correct: arr.filter((a) => a.outcome === 'correct').length,
      total: arr.length,
      label: DIM_LABEL[m],
    }
  })

  const dueSuccesses = obj.filter((a) => a.isDueReview && a.outcome === 'correct').length

  // 口头表达单独记录
  let prompted = 0, independentSelf = 0, independentAi = 0
  for (const [qid, st] of Object.entries(p.questionStates)) {
    if (!skillOral.get(qid) || !st.speak) continue
    if (st.speak.status === 'prompted') prompted++
    else if (st.speak.status === 'independent-self') independentSelf++
    else if (st.speak.status === 'independent-ai') independentAi++
  }

  return { bySkill, dims, dueSuccesses, oral: { prompted, independentSelf, independentAi }, openErrorQids }
}
