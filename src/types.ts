// EnglishForge 核心类型定义
// v2：新增作答事件（Attempt）、题级复习状态、冻结队列与会话断点契约
// 旧 v1 类型 Progress/SkillProgress 保留，仅用于迁移读取

export type QType = 'choice' | 'tiles' | 'tap' | 'match' | 'sort' | 'speak'

/** 证据维度：形式识别 / 含义理解 / 构造表达 / 口头表达 */
export type Mode = 'recognition' | 'comprehension' | 'construction' | 'oral'

export type ReviewStatus = 'draft' | 'reviewed' | 'quarantined'

export type Outcome = 'correct' | 'incorrect' | 'uncertain' | 'skipped'

export type Evaluator = 'deterministic' | 'self' | 'transcriptMatch' | 'aiText'

export interface Question {
  id: string
  skill: string            // 思维点 id
  type: QType
  /** 题干（中文场景 / 指令） */
  prompt: string
  /** choice: 选项；answer 为正确选项文本 */
  options?: string[]
  answer?: string
  /** tap: 句子的词序列，answer 为应被点中的词（含标点），fix 为正确形式 */
  tokens?: string[]
  fix?: string
  /** tiles: 正确顺序 */
  order?: string[]
  /** 张老师式解析 */
  explain: string
  /** 需要朗读的英文句子（可选） */
  tts?: string
  /** 听力题：进入时自动播放、不显示原句 */
  autoTTS?: boolean
  /** 难度：1 基础(课内原句) / 2 进阶(同规律新词) / 3 挑战(多知识点组合) */
  diff?: 1 | 2 | 3
  /** 破惯性纠错题（张老师打碎旧认知的题） */
  myth?: boolean
  /** 产出跟读题 */
  target?: string
  /** match 配对题 */
  pairs?: [string, string][]
  /** sort 分类题 */
  buckets?: string[]
  items?: { w: string; b: number }[]
  /** 二次出现时换的问法提示（可选） */
  hint?: string

  // ---- v2 元数据（可选字段 + 适配器补默认值，不重写题库）----
  /** 答案或教学目标变更后递增；旧证据可追踪与失效 */
  contentVersion?: number
  /** 本题实际测量的细分目标（初版 = skill id） */
  objectiveId?: string
  mode?: Mode
  /** 变式家族：同一种结构与错误机制；默认 = 题目 id */
  variantGroupId?: string
  scenarioId?: string
  /** 预设支持等级 0~3；实际使用等级记录在作答事件 */
  supportLevel?: number
  errorTags?: string[]
  optionFeedback?: Record<string, string>
  /** 多个允许答案（按选项/词块 ID） */
  acceptedAnswers?: string[]
  sourceRef?: string
  accuracyRef?: string
  scopeNote?: string
  reviewStatus?: ReviewStatus
  vocabIds?: string[]
  prerequisites?: string[]
  /** practice | holdout：保留题不进入普通抽题 */
  assessmentRole?: 'practice' | 'holdout'
}

/** 适配后的题目：旧题经适配器补齐 v2 必需字段，判定一律按 ID */
export interface AdaptedQuestion extends Question {
  optionIds: string[]            // 与 options 平行的稳定 ID
  tokens2: { id: string; text: string }[]  // 词块/词序列（独立 ID，允许同文本）
  orderIds: string[]             // tiles 正确顺序（token ID 序列）
  answerId: string               // choice/tap 正确项 ID
  mode: Mode
  variantGroupId: string
  objectiveId: string
  contentVersion: number
  reviewStatus: ReviewStatus
  assessmentRole: 'practice' | 'holdout'
}

export interface ConceptCard {
  title: string
  /** 张老师的核心讲法（短段落） */
  body: string[]
  /** 示例展示 */
  example: string
  exampleNote: string
}

export interface Skill {
  id: string
  name: string
  /** 一句话说明这个思维点 */
  tagline: string
  icon: string
  concept: ConceptCard
}

export interface Lesson {
  id: string
  no: string
  title: string
  subtitle: string
  skills: Skill[]
}

export interface Module {
  id: string
  name: string
  desc: string
  lessons: string[]
}

// ================= v1 存档（仅迁移读取） =================

export interface SkillProgress {
  conceptSeen: boolean
  box: number          // 0~5 掌握盒（历史练习记录，不再映射掌握百分比）
  due: number          // 时间戳
  correct: number
  total: number
}

export interface Progress {
  xp: number
  streak: number
  lastActiveDate: string
  comboBest: number
  skills: Record<string, SkillProgress>
  /** v1 题级掌握度：子技能×题 双层追踪（迁移后仅存于 v1 备份） */
  questions?: Record<string, { box: number; due: number; correct: number; total: number }>
  /** 每日获得 XP（仪表盘图表用） */
  dailyXp?: Record<string, number>
  /** 最近练习记录（仪表盘列表用，倒序，最多 30 条） */
  sessions?: SessionLog[]
}

export interface SessionLog {
  ts: number
  label: string   // 例：第 07 课 · 单复数
  lessonNo: string
  acc: number     // 0-100
  xp: number
  total: number
  firstTry: number
}

// ================= v2 存档 =================

/** 作答事件：每次提交一条，首次判定与后续重试分别保存，聚合不覆盖 */
export interface Attempt {
  attemptId: string        // 幂等键：重复提交只记一次
  sessionId: string
  questionId: string
  contentVersion: number
  objectiveId: string
  variantGroupId: string
  mode: Mode
  timestamp: number
  localDate: string        // 本地日期 YYYY-MM-DD（训练日统计不等 UTC）
  firstAttempt: boolean    // 是否本轮该题首次作答
  supportUsed: number      // 0~3 实际支持等级
  answer: string           // 用户作答摘要
  outcome: Outcome
  errorTags?: string[]
  evaluator: Evaluator
  responseMs?: number
  isDueReview: boolean     // 是否到期检索
  isVariantDrill?: boolean
}

/** 题级复习状态（5.3 单题复习规则） */
export interface QuestionState {
  stage: number            // 0~5，对应 INTERVALS
  dueAt: number
  lastIndependentSuccessAt?: number
  lastFailureAt?: number
  correct: number
  total: number
  /** 从 v1 迁移而来：只有历史练习记录，不当新证据 */
  legacy?: boolean
  /** 口语独立显示（不与客观证据混算） */
  speak?: { status: 'prompted' | 'independent-self' | 'independent-ai'; at: number }
}

/** 冻结队列条目：生成后保存，恢复时不重新抽题 */
export interface QueueItem {
  qid: string
  /** choice/listen 选项 ID 顺序（生成时随机，冻结） */
  optionOrder?: string[]
  /** match 右列顺序（冻结） */
  rightOrder?: string[]
  isDueReview?: boolean
  isVariantDrill?: boolean   // 错题变式补练
}

export type SessionKind = 'today' | 'skill' | 'review'

/** 运行时快照：每次答题后保存，刷新可恢复到当前题 */
export interface QuizRuntime {
  phase: { kind: 'concept' | 'q' | 'retry'; index: number }
  retryIds: string[]
  combo?: { cur: number; best: number }
  pending?: PersistedResult | null
  results: PersistedResult[]
}

export interface PersistedResult {
  qid: string
  firstTryCorrect: boolean
  retriedCorrect: boolean | null
  given: string
  evaluator?: Evaluator
  outcome?: Outcome
  supportUsed?: number
}

/** 进行中的会话：队列冻结 + 断点 */
export interface ActiveSession {
  sessionId: string
  kind: SessionKind
  skillId?: string
  queue: QueueItem[]
  runtime: QuizRuntime | null
  createdAt: number
  committed: boolean        // 结算完成后置 true，恢复时不再重放
  /** 各技能连续首次答错计数（§3.3 三次降难） */
  wrongStreaks?: Record<string, number>
  /** 会话内提示（如降难说明） */
  note?: string
}

/** v2 存档（sf-progress-v2） */
export interface ProgressV2 {
  schemaVersion: 2
  xp: number
  streak: number
  lastActiveDate: string
  comboBest: number
  skills: Record<string, SkillProgress>   // 历史/推荐用，不再映射掌握百分比
  dailyXp?: Record<string, number>
  sessions?: SessionLog[]
  questionStates: Record<string, QuestionState>
  attempts: Attempt[]
  activeSession: ActiveSession | null
}

export const INTERVALS = [0, 1, 2, 4, 7, 15] // 天：stage 0~5 对应下次复习间隔

/** 存档版本键 */
export const V2_KEY = 'sf-progress-v2'
export const V1_KEY = 'sf-progress-v1'
export const BACKUP_PREFIX = 'sf-progress-v2-backup-'
