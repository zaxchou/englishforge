// 28 号薄片：learner view model——把后台 ID/术语翻译成学习者读得懂的行为名称。
// 纯函数、无副作用：输入现有 plan/evidence API 数据，输出今日入口所需的展示形状。
// 后台完整数据（目标 ID、策略、证据槽）不丢弃——保留在折叠详情里给运营/复核用。

/** 首批目标的行为名称（对齐 28 §3：前台用校订过的行为名，ID 只进折叠详情）。
 * 未映射的目标回退通用名——绝不把 ID 当主标题。 */
const GOAL_LABELS: Record<string, string> = {
  'O-K115-01': '读懂一句话里谁修饰谁',
  'O-K115-02': '分清代词指代的是设备还是整件事',
  'O-K115-03': '说清决定、原因和保留的条件',
  'O-K184-01': '听懂一段介绍的主张和限制',
  'O-K184-02': '抓住话里补充的关键信息',
  'O-K184-03': '迎接一段有挑战的新任务',
  'O-K007-01': '听懂一句话的主干',
  'O-K007-02': '听懂转述里谁做了什么',
  'O-K007-03': '听出话里补充的信息',
  'O-K190-01': '脱稿讲清楚一件事',
  'O-K194-01': '回应别人的追问',
}

const GOAL_FALLBACK = '一项英语理解与表达训练'

export function goalLabel(id: string | null | undefined): string {
  if (!id) return GOAL_FALLBACK
  return GOAL_LABELS[id] ?? GOAL_FALLBACK
}

/** 把推荐理由里的后台术语换成可读说法（28 §4.B：根因代码/内部名进可选详情）。
 * 未列出的目标 ID 与策略 ID 原样保留但加上折叠提示——宁可少说，不猜。 */
const TERM_LABELS: Array<[RegExp, string]> = [
  [/\brelation_modifier_or_retention\b/g, '修饰关系或信息保持'],
  [/\bsound_segmentation_or_realtime\b/g, '声音分段或实时理解'],
  [/\bcontrast_or_lexicon\b/g, '对照关系或词义'],
  [/\bstructure_or_lexicon_also_in_audio\b/g, '声音中的结构或词义'],
  [/\bunmeasured\b/g, '还没测到'],
  [/\btentative\b/g, '初步确认'],
  [/\btrained\b/g, '已经练过'],
  [/\bindependent\b/g, '能独立完成'],
  [/\btransferred\b/g, '能在新情境用'],
  [/\bretained\b/g, '保持住了'],
  [/\bdiscriminate_cause\b/g, '先做一次短区分'],
  [/\bshort_explain\b/g, '先短讲再练'],
  [/\bchallenge_first\b/g, '直接挑战'],
  [/\bshort_repair\b/g, '局部补一下'],
  [/\breview\b/g, '复核'],
]

export function cleanReason(reason: string | null | undefined): string {
  if (!reason) return ''
  let out = reason
  for (const [id, label] of Object.entries(GOAL_LABELS)) {
    out = out.replaceAll(id, label)
  }
  for (const [re, label] of TERM_LABELS) out = out.replace(re, label)
  return out.replace(/O-[A-Za-z0-9-]+/g, '相关能力').replace(/且能打开 \d+ 条后继/g, '，为后续练习打基础')
}

/** 今日入口形状（28 §4.A：唯一主按钮，回答"练什么/点哪里/为什么"）。
 * mode:
 *  - continue：有真实推荐（已诊断），可以继续上一段
 *  - wait：有推荐但内容还在制作/等待（不假装能学）
 *  - find_start：还没有诊断证据，需要先找起点（不预写个人弱点） */
export interface LearnerToday {
  mode: 'continue' | 'wait' | 'find_start'
  /** 今天这一步（自然行为名） */
  headline: string
  /** 安排理由（可读；无真实证据时不显示） */
  reason: string
  /** 唯一主按钮文案 */
  primaryLabel: string
  /** 是否有后台 ID 可折叠展示（后台视角保留，不删除） */
  goalId: string | null
  lessonId: string | null
  /** true = 内容在等待（不可点击进入课程） */
  waiting: boolean
}

/** plan.lesson.status：published=可学；其他（content_pending 等）=等待，不冒充可学 */
export function learnerToday(plan: { primaryGoal: string | null; reason?: string; lesson?: { lessonId: string | null; status: string; resumeAvailable?: boolean } | null } | null | undefined): LearnerToday {
  if (!plan) {
    return { mode: 'find_start', headline: '先用几分钟找到起点', reason: '', primaryLabel: '开始入口诊断', goalId: null, lessonId: null, waiting: false }
  }
  const goal = goalLabel(plan.primaryGoal)
  const lessonReady = !!plan.lesson?.lessonId && plan.lesson.status === 'published'
  if (lessonReady) {
    return {
      mode: 'continue',
      headline: `今天这一步：${goal}`,
      reason: cleanReason(plan.reason),
      primaryLabel: plan.lesson?.resumeAvailable ? '继续上一段' : '开始训练',
      goalId: plan.primaryGoal,
      lessonId: plan.lesson!.lessonId,
      waiting: false,
    }
  }
  if (!plan.primaryGoal || (plan.lesson && plan.lesson.status !== 'published')) {
    // 有目标但该内容还不能学：诚实等待 + 给出可动作的出路（一键生成或免修），不冒充可学
    return {
      mode: 'wait',
      headline: `接下来该练：${goal}`,
      reason: '目前没有现成的后继课程，这里也不会用熟题填补。你可以用 AI 按你最近的练习现场生成（生成后先标内容试验预览：机器门和模型辅助检查通过、专业核验未做），或先免修这项。',
      primaryLabel: '内容准备中…',
      goalId: plan.primaryGoal,
      lessonId: null,
      waiting: true,
    }
  }
  return {
    mode: 'find_start',
    headline: `建议先确认：${goal}`,
    reason: cleanReason(plan.reason) || '证据还不够，先做一次短确认再开始。',
    primaryLabel: '开始入口诊断',
    goalId: plan.primaryGoal,
    lessonId: null,
    waiting: false,
  }
}
