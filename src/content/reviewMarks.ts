// 人工审核标记 → 信任级别。
//
// 为什么必须做这一步：`evidence` 只承认 reviewStatus === 'reviewed' 的作答，
// 而全项目没有任何地方会把题目设成 reviewed —— 所有题（376 道旧题 + 机器生成的题）
// 都是 draft。结果是无论练多少，合格证据永远是 0 条、每个知识点永远停在"未练习/建立中"、
// 仪表盘的"已稳定知识点"永远是 0 —— 用户感受就是"练了半天看不到任何变化"。
//
// 这里把审核页的标记变成真正的信任级别：通过 → reviewed（开始计入掌握度）；
// 毙掉 → quarantined（退出抽题）；要改 → 仍是 draft（可练，但不认证）。
import type { AdaptedQuestion, ReviewStatus } from '../types'

export type Verdict = 'ok' | 'fix' | 'kill'
export interface ReviewMark {
  verdict?: Verdict
  note?: string
  /** 谁定的：人（故意单点）/ 批量通过 / 系统 AI。三者的信任度不同：
   *  · human —— 逐个看过才点的，最可信；
   *  · bulk  —— "全部通过"批量标的（用户承认这种他看都不看），**AI 有权重审**；
   *  · ai    —— 机器审的，带理由。 */
  source?: 'human' | 'bulk' | 'ai'
  /** AI 定的用哪家模型 */
  model?: string | null
  /** AI 给的理由（人复核时的依据） */
  reasons?: string[]
}
export type ReviewMarks = Record<string, ReviewMark>

export const REVIEW_MARKS_KEY = 'sf-content-review'

export function loadReviewMarks(): ReviewMarks {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_MARKS_KEY) || '{}')
    return raw && typeof raw === 'object' ? (raw as ReviewMarks) : {}
  } catch {
    return {}
  }
}

export function saveReviewMarks(marks: ReviewMarks): void {
  try { localStorage.setItem(REVIEW_MARKS_KEY, JSON.stringify(marks)) } catch { /* 存不上不影响本次会话 */ }
}

/** 审核结论 → 信任级别。未标记的题保持题库自带的 reviewStatus。 */
export function statusFor(mark: ReviewMark | undefined, fallback: ReviewStatus): ReviewStatus {
  if (!mark?.verdict) return fallback
  if (mark.verdict === 'ok') return 'reviewed'
  if (mark.verdict === 'kill') return 'quarantined'
  return 'draft'          // fix：可继续练，但不参与能力认证
}

export function applyReviewMarks(
  questions: AdaptedQuestion[],
  marks: ReviewMarks,
): AdaptedQuestion[] {
  if (!Object.keys(marks).length) return questions
  return questions.map((q) => {
    const next = statusFor(marks[q.id], q.reviewStatus)
    return next === q.reviewStatus ? q : { ...q, reviewStatus: next }
  })
}

/** 统计各信任级别的题量（用于在界面上把"为什么还没变化"说清楚） */
export function countByStatus(questions: AdaptedQuestion[]) {
  const out = { reviewed: 0, draft: 0, quarantined: 0 }
  for (const q of questions) out[q.reviewStatus] += 1
  return out
}
