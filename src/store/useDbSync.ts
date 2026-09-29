// 把进度数据库接进 React 的那一层。
//
// 只做三件事：启动时决定"谁接管谁"、每次状态变化后防抖落库、账户切换。
// 练习逻辑本身（scheduler / evidence）完全不知道数据库的存在 —— 它们只看见 ProgressV2，
// 数据库不可用时整个应用退回原来的纯本地模式，功能一个都不少。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProgressV2 } from '../types'
import type { ReviewMarks } from '../content/reviewMarks'
import {
  bootstrap, createAccount, currentAccountId, decideBoot, fetchAccounts, fetchAiStatus, fetchAudit,
  fetchEnrichments, fetchItemBatches, fetchItems, fetchRunLog, fetchStats, getDbError, getDbState, lastSyncedAt,
  pullProgress, pushCatalog, renameAccount, reopenBulk as reopenBulkApi, resetRemote, runAiPipeline,
  runEnrichCauses, setCurrentAccountId,
  setAiModel, setItemVerdict, subscribeDbState, syncProgress, unionProgress,
  type AiStatus, type CatalogRow, type DbAccount, type DbAudit, type DbItem, type DbItemBatch,
  type DbItemStats, type DbState, type DbStats, type EnrichmentMap, type PullResult, type RunLogEntry,
} from './db'

/** 状态变化后多久落库：一次练习里连续提交会合并成一次写入 */
const DEBOUNCE_MS = 800
/** 库内统计重新拉取的间隔（每次推送都拉一遍太吵） */
const STATS_TTL_MS = 5000

/**
 * 启动时的审核结论合并：**服务端优先**（远端一般是较新的 AI 结论）。
 * 本地只在"远端没有该题结论 + 这条带 source（是本机真做过的操作）"时保留；
 * 本地那些没有 source 的老标记一律不参与 —— 它们是缓存里的旧通过，会把新完成的
 * AI 判毙重新打开（实测事故；adopt 与 merge 两条启动分支都必须走这里，复核报告 #5）。
 *
 * `keepLocal: false` 是**切账户接管**专用：标记是按账户的（单键存储），切过去时
 * 必须整份接管目标账户的远端标记，把上一个账户的本地标记整个丢掉 —— 否则 A 的结论
 * 会混进 B 的题池、还会作为"B 的新增结论"被推回服务端（复核报告 R3）。
 */
export function mergeReviewMarks(remote: ReviewMarks, local: ReviewMarks, opts: { keepLocal?: boolean } = {}): ReviewMarks {
  if (opts.keepLocal === false) return { ...remote }
  const keepLocal: ReviewMarks = {}
  for (const [qid, m] of Object.entries(local)) {
    if (remote[qid]) continue
    if (m?.source) keepLocal[qid] = m
  }
  return { ...remote, ...keepLocal }
}

/** aiReviewNow 的返回形状（后台维护编排要读的那部分） */
export interface MaintenanceReview {
  reviewed: number; killed: number; fixed: number; rewritten: number
  remaining: number; reviewer: string | null; independent: boolean; error: string | null
}
/** enrichNow 的返回形状 */
export interface MaintenanceEnrich {
  enriched: number; remaining: number; gaps: number; error: string | null
}

/**
 * 后台维护编排（三审 T2）：**整条链固定在同一个账户上**。
 * 每个 await 之后校验 isCurrent —— 切换账户后后续阶段立刻停，绝不把 A 的任务尾巴
 * （补纠正）接到 B 头上（实测过：A 审完时切到 B，旧代码会对 B 先补纠正）。
 * 依赖全部注入成回调，可脱离 React 直接测试。
 */
export async function runMaintenanceFlow(opts: {
  isCurrent: () => boolean
  review: () => Promise<MaintenanceReview | null>
  /** undefined = 出题模型未配置（跳过补纠正阶段） */
  enrichBatch?: () => Promise<MaintenanceEnrich | null>
  onNote: (s: string) => void
  /** 补纠正真有产出时回调（调用方用来刷新题库池） */
  onEnriched?: (count: number) => void
}): Promise<{ reviewed: number; rewritten: number; enriched: number; aborted: boolean }> {
  opts.onNote('后台自动维护启动：审 → 改 → 复审 → 补逐项纠正…')
  const parts: string[] = []
  const r = await opts.review()
  if (!opts.isCurrent()) {
    opts.onNote('账户已切换，维护中止（A 的任务不会落到 B 头上）')
    return { reviewed: 0, rewritten: 0, enriched: 0, aborted: true }
  }
  if (!r) {
    parts.push('流水线：数据库接口没有响应')
  } else {
    parts.push(r.remaining < 0
      ? `流水线有另一条在跑（审 ${r.reviewed} · 改 ${r.rewritten} · 毙 ${r.killed}）`
      : `流水线${r.error ? '有调用失败' : '完成'}：审 ${r.reviewed} · 改写 ${r.rewritten} · 判毙 ${r.killed} · 还剩 ${Math.max(0, r.remaining)} 待机器处理`)
    if (r.error) parts.push(r.error)
  }
  let enriched = 0
  if (opts.enrichBatch) {
    // 跑到补完或**缺口不再减少**为止；进展度量 gaps（还缺几个选项），二审 R6
    let lastRemaining = -1, lastGaps = -1
    for (let i = 0; i < 60; i++) {
      if (!opts.isCurrent()) { parts.push('账户已切换，补纠正中止'); break }
      const er = await opts.enrichBatch()
      if (!er) break
      // 切换前已发出的这批是**真发生过的工作**（请求带的是旧账户身份），照实计入；
      // 只是**不再发下一批** —— 之后的阶段一律停止（三审 T2）
      enriched += er.enriched
      lastRemaining = er.remaining
      const gaps = er.gaps ?? -1
      const noProgress = gaps >= 0 && lastGaps >= 0 && gaps >= lastGaps
      if (gaps >= 0) lastGaps = gaps
      if (!opts.isCurrent()) { parts.push('账户已切换，补纠正中止'); break }
      if (er.error || er.remaining <= 0 || er.enriched === 0 || noProgress) break
    }
    if (enriched > 0) {
      opts.onEnriched?.(enriched)
      parts.push(`逐项纠正补了 ${enriched} 篇${lastRemaining > 0 ? `（还剩 ${lastRemaining}）` : '（已补齐）'}`)
    }
  }
  opts.onNote(parts.join(' · '))
  return { reviewed: r?.reviewed ?? 0, rewritten: r?.rewritten ?? 0, enriched, aborted: false }
}

/**
 * 一轮流水线算不算"真进展"（三审 T3）：改稿有落库、或有结论**真变化**、或待办减少。
 * 同结论再存一遍（reviewedUnchanged）、同稿不落库（rewritten=0）、pending 不动 = 空转 —— 不算。
 */
export function pipelineProgressed(
  res: { rewritten: number; reviewed: number; reviewedUnchanged?: number; pending: number },
  prevPending: number,
): boolean {
  const reviewedChanged = res.reviewed - (res.reviewedUnchanged ?? 0)
  return res.rewritten > 0 || reviewedChanged > 0 || (prevPending >= 0 && res.pending < prevPending)
}

export interface DbSyncNotice { kind: 'ok' | 'warn'; text: string }

export interface DbSyncApi {
  account: DbAccount | null
  accounts: DbAccount[]
  dbState: DbState
  stats: DbStats | null
  syncedAt: number
  notice: DbSyncNotice | null
  dismissNotice: () => void
  /** 往同一处提示条里写一句（App 侧清空/导入后也要说明数据库那边发生了什么） */
  note: (text: string, kind?: 'ok' | 'warn') => void
  /** 账户题库（内容层）：语料派生的题与将来即时生成的题都存在这里 */
  items: DbItem[]
  itemStats: DbItemStats | null
  itemBatches: DbItemBatch[]
  /** 题库来自离线缓存（数据库没连上） */
  itemsCached: boolean
  reloadItems: () => Promise<void>
  /** 逐题定版：写进账户题库 */
  patchItemVerdict: (itemId: string, verdict: 'ok' | 'fix' | 'kill') => Promise<void>
  /** 系统自检结果（重复题 / 打架题 / 缺逐项纠正的题） */
  audit: DbAudit | null
  /** 系统 AI 补出来的逐项纠正（按题 id），并进题目池后练习里就能看到 */
  enrichments: EnrichmentMap
  ai: AiStatus | null
  /** 把仓库题库目录推给服务端（系统要能"看见"自己的内容才能自检） */
  /** 推送题库目录；返回是否成功（调用方要**成功后**才记"已送达"签名，失败留重试） */
  syncCatalog: (rows: CatalogRow[]) => Promise<boolean>
  /** 刷新自检结果 */
  runAudit: () => Promise<void>
  /** 换模型（存库即时生效） */
  changeModel: (model: string) => Promise<boolean>
  /** 把"批量通过"的旧结论作废，交回待审 */
  reopenBulkNow: () => Promise<number>
  /** 全自动流水线：审（另一个模型）→ 按意见改稿 → 复审，循环到待办归零；结论并入本机标记 */
  aiReviewNow: (limit?: number) => Promise<{ reviewed: number; killed: number; fixed: number; rewritten: number; remaining: number; reviewer: string | null; independent: boolean; error: string | null } | null>
  /** 最近一次自动流水线的结果（系统自检页显示，不用人盯着跑） */
  pipelineNote: string | null
  /** 后台维护日志（流水线/补纠正每次自动执行的留痕），随自检刷新 */
  runs: RunLogEntry[]
  /** 让系统自己的 AI 补一批逐项纠正（gaps = 还缺几个选项，用于判进展） */
  enrichNow: (limit?: number) => Promise<{ enriched: number; rejected: number; truncated: number; remaining: number; gaps: number; error: string | null } | null>
  /** 状态变了：安排一次落库 */
  schedule: () => void
  /** 立刻落库（full = 整份替换，服务端先留快照） */
  flush: (opts?: { full?: boolean; reason?: string }) => Promise<boolean>
  refreshStats: (force?: boolean) => void
  rename: (name: string) => Promise<void>
  newAccount: (name: string) => Promise<void>
  switchTo: (id: string) => Promise<void>
  resetCurrent: () => Promise<boolean>
  reloadFromDb: () => Promise<void>
}

interface Options {
  progressRef: { current: ProgressV2 }
  /** 接管一份存档：写 localStorage + 刷新界面 */
  applyProgress: (p: ProgressV2) => void
  getMarks: () => ReviewMarks
  applyMarks: (m: ReviewMarks) => void
}

export function useDbSync({ progressRef, applyProgress, getMarks, applyMarks }: Options): DbSyncApi {
  const [account, setAccount] = useState<DbAccount | null>(null)
  const [accounts, setAccounts] = useState<DbAccount[]>([])
  const [dbState, setDbState] = useState<DbState>(getDbState())
  const [stats, setStats] = useState<DbStats | null>(null)
  const [syncedAt, setSyncedAt] = useState(0)
  const [notice, setNotice] = useState<DbSyncNotice | null>(null)
  // 账户题库（内容层）：与进度分开，走自己的接口与缓存
  const [items, setItems] = useState<DbItem[]>([])
  const [itemStats, setItemStats] = useState<DbItemStats | null>(null)
  const [itemBatches, setItemBatches] = useState<DbItemBatch[]>([])
  const [itemsCached, setItemsCached] = useState(false)
  // 系统自检 + 系统 AI 补出来的内容
  const [audit, setAudit] = useState<DbAudit | null>(null)
  const [enrichments, setEnrichments] = useState<EnrichmentMap>({})
  const [ai, setAi] = useState<AiStatus | null>(null)
  const catalogSent = useRef(false)

  const accountRef = useRef<DbAccount | null>(null)
  const bootedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const pushingRef = useRef(false)
  const queuedRef = useRef<{ full: boolean; reason: string } | null>(null)
  const statsAtRef = useRef(0)
  /**
   * 审核结论的"基线"：从服务端取回（或刚推成功）的那一份。
   * 推送时**只发与基线不同的条目** —— 否则客户端会把整份旧标记推上去，
   * 把服务端更新的（AI 审出来的）结论盖回去。实测踩过：浏览器开着不动，
   * 它 21:47 那批盲通过的旧值把 61 条 AI 结论覆盖成了"通过"。
   */
  const marksBaselineRef = useRef<ReviewMarks | null>(null)

  // 最新值放进 ref：定时器与事件回调里必须看到当前进度，不能是闭包里的旧值
  // （在 effect 里同步，而不是渲染期间写 ref）
  const optsRef = useRef({ progressRef, applyProgress, getMarks, applyMarks })
  useEffect(() => {
    optsRef.current = { progressRef, applyProgress, getMarks, applyMarks }
  })

  useEffect(() => subscribeDbState(setDbState), [])

  const refreshStats = useCallback((force = false) => {
    const id = accountRef.current?.id
    if (!id) return
    const now = Date.now()
    if (!force && now - statsAtRef.current < STATS_TTL_MS) return
    statsAtRef.current = now
    void fetchStats(id).then((s) => {
      if (!s || accountRef.current?.id !== id) return
      setStats(s)
      // 库里的计数是最权威的，顺手校正顶上来那一行
      const cur = accountRef.current
      if (cur && cur.attempts !== s.attempts) {
        const next = { ...cur, attempts: s.attempts, xp: s.xp, streak: s.streak }
        accountRef.current = next
        setAccount(next)
      }
    })
  }, [])

  /** 只挑"与基线不同"的结论发给服务端（没基线时全量，用于首次迁移） */
  const reviewDelta = useCallback((cur: ReviewMarks, full: boolean): ReviewMarks => {
    const base = marksBaselineRef.current
    if (full || !base) return cur
    const out: ReviewMarks = {}
    for (const [qid, m] of Object.entries(cur)) {
      const b = base[qid]
      if (!b || b.verdict !== m.verdict || (b.note ?? '') !== (m.note ?? '') || (b.source ?? '') !== (m.source ?? '')) {
        out[qid] = m
      }
    }
    return out
  }, [])

  /** 真正发一次同步；并发时只排队一次，保证顺序不交叉 */
  const push = useCallback(async (full: boolean, reason: string): Promise<boolean> => {
    const id = accountRef.current?.id
    if (!id) return false
    if (pushingRef.current) {
      queuedRef.current = { full: full || queuedRef.current?.full === true, reason }
      return false
    }
    pushingRef.current = true
    try {
      const { progressRef: pr, getMarks: gm } = optsRef.current
      const res = await syncProgress(id, pr.current, { reviews: reviewDelta(gm(), full), full, reason })
      if (res.ok) {
        marksBaselineRef.current = { ...gm() }   // 刚推上去的这份成为新基线
        setSyncedAt(Date.now())
        // 界面上的"N 条作答记录"要立刻跟上：服务端只回报新增了几条，加上去就是真实条数
        const cur = accountRef.current
        if (cur && res.inserted) {
          const next = { ...cur, attempts: cur.attempts + res.inserted }
          accountRef.current = next
          setAccount(next)
        }
        refreshStats()
      }
      return res.ok
    } finally {
      pushingRef.current = false
      const queued = queuedRef.current
      queuedRef.current = null
      if (queued) void push(queued.full, queued.reason)
    }
  }, [refreshStats, reviewDelta])

  const flush = useCallback((opts: { full?: boolean; reason?: string } = {}) => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null }
    return push(opts.full === true, opts.reason ?? (opts.full ? 'replace' : 'save'))
  }, [push])

  const schedule = useCallback(() => {
    if (!accountRef.current) return
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => { timerRef.current = null; void push(false, 'save') }, DEBOUNCE_MS)
  }, [push])

  /** 接管一份服务端存档：**审核结论以服务端为准**（它更新、且带来源） */
  const adopt = useCallback((pull: PullResult, opts: { keepLocal?: boolean } = {}) => {
    const { applyProgress: ap, applyMarks: am, getMarks: gm } = optsRef.current
    ap(pull.progress)
    const remote = pull.reviews ?? {}
    const merged = mergeReviewMarks(remote, gm(), opts)
    // 切账户（keepLocal:false）时空对象也要写：那是在**清空**上一个账户的标记
    if (Object.keys(merged).length || opts.keepLocal === false) am(merged)
    // 基线 = 服务端已有的那份：之后的 push 只会带上"服务端还没有、本地新做的"结论 ——
    // 既不会把旧缓存推回去，也不会把本地新增的丢掉
    marksBaselineRef.current = remote
    setSyncedAt(Date.now())
    refreshStats(true)
  }, [refreshStats])

  /** 读账户题库（并顺手把"这批题怎么来的"一起取回来） */
  const reloadItems = useCallback(async () => {
    const id = accountRef.current?.id
    if (!id) return
    const res = await fetchItems(id)
    if (!res) { setItems([]); setItemStats(null); setItemBatches([]); return }
    setItems(res.items)
    setItemStats(res.stats)
    setItemsCached(res.cached)
    const batches = await fetchItemBatches(id)
    setItemBatches(batches ?? [])
  }, [])

  // 声明必须在 runAudit 之前（oxlint react-compiler 规则：回调里引用了尚未初始化的 setter）
  const [runs, setRuns] = useState<RunLogEntry[]>([])

  /** 系统自检 + 已补内容 + 后台维护日志的加载 */
  const runAudit = useCallback(async () => {
    const id = accountRef.current?.id
    if (!id) return
    const [a, en, st, rl] = await Promise.all([fetchAudit(id), fetchEnrichments(id), fetchAiStatus(), fetchRunLog(id)])
    // 护栏：取数期间切了账户 → 这些是旧账户的数据，不许盖到新账户的界面上（复核报告 R3）
    if (accountRef.current?.id !== id) return
    if (a) setAudit(a)
    if (en) setEnrichments(en)
    setAi(st)
    if (rl) setRuns(rl)
  }, [])

  const syncCatalog = useCallback(async (rows: CatalogRow[]) => {
    if (!rows.length) return true
    const res = await pushCatalog(rows)
    if (res) {
      const first = !catalogSent.current
      catalogSent.current = true
      // 全新数据库：目录推送之前 questions 表是空的，audit 看到的待办是 0，
      // 自动流水线不会触发。首次推送成功后必须刷新一次自检，同一会话内就能开跑。
      if (first) void runAudit()
    }
    // 回报成败：调用方要**成功之后**才记"内容已送达"的签名，失败必须留出重试路径
    // （否则首推失败后同内容永远不再推，服务端目录停在旧状态 —— 二次审查补充观察）
    return !!res
  }, [runAudit])

  /** 让系统自己的 AI 补一批逐项纠正；补完刷新自检与已补内容 */
  const enrichNow = useCallback(async (limit = 8) => {
    const id = accountRef.current?.id
    if (!id) return null
    const res = await runEnrichCauses(id, limit)
    if (!res) return null
    await runAudit()
    return {
      enriched: res.enriched, rejected: res.rejected, truncated: res.truncated,
      remaining: res.remaining, gaps: res.gaps ?? -1, error: res.error,
    }
  }, [runAudit])

  const [pipelineNote, setPipelineNote] = useState<string | null>(null)
  /** 每个账户每会话只自动维护一次（三审 T2：A 跑过 ≠ B 跑过，切账户后按新账户重新武装） */
  const autoRunForRef = useRef<string | null>(null)

  /**
   * 全自动流水线：审（另一个模型）→ 按审核意见改稿 → 复审，**循环到待办归零**。
   * 用户拍板「这个也自动化 完全不需要我审核」——人工不在这条链上的任何一环里。
   * 结论并入本机标记（并入基线，不产生"待推送"的差异），改稿由 runAudit 重新拉取。
   */
  const aiReviewNow = useCallback(async (limit = 60) => {
    const id = accountRef.current?.id
    if (!id) return null
    let reviewed = 0, killed = 0, fixed = 0, rewritten = 0, remaining = -1
    let reviewer: string | null = null, independent = false, error: string | null = null
    // 处理轮次与锁等待分开计数（二审 R7）：另一条流水线占用时的等待**不消耗**处理预算
    let rounds = 0, waits = 0, prevPending = -1
    while (rounds < 6) {
      // 账户身份检查（三审 T2）：每轮**发请求前**确认还在本任务的账户上，切了就停
      if (accountRef.current?.id !== id) { error = '账户已切换，本轮中止'; break }
      let res = await runAiPipeline(id, limit)
      if (!res) {
        // 超时/断线不等于失败：服务端多半还在跑那一轮（账户锁会让下一次调用返回 running），等一下再试
        await new Promise((r) => setTimeout(r, 5000))
        res = await runAiPipeline(id, limit)
      }
      if (!res) { error = '流水线接口没有响应（服务可能在重启）'; break }
      if (res.running) {
        // 另一个标签页正在跑同一条流水线：等它跑完，不并发烧调用；最多等 20 次×3s
        if (++waits > 20) { error = '另一条流水线长时间占用，本次先退出'; break }
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }
      rounds++
      reviewed += res.reviewed
      killed += res.killed
      fixed += res.fixed
      rewritten += res.rewritten
      remaining = res.pending
      if (res.reviewer) {
        reviewer = `${res.reviewer.provider}/${res.reviewer.model}`
        independent = !!res.reviewer.independent
      }
      if (res.verdicts && Object.keys(res.verdicts).length) {
        // 异步回写护栏：请求是发给 A 账户的，返回时可能已经切到 B —— 直接并入会把
        // A 的 AI 结论写进 B 的标记（复核报告 R3）
        if (accountRef.current?.id !== id) { error = '账户已切换，本轮结果不并入'; break }
        const { applyMarks: am, getMarks: gm } = optsRef.current
        const merged = { ...gm(), ...res.verdicts }
        am(merged)
        marksBaselineRef.current = merged
      }
      // 单批坏输出已被服务端拆半重试/抢救救回，error 只是"过程中出过事"，不当成中断
      if (res.error) error = res.error
      if (res.pending <= 0) break
      // 停止条件 = **没有真进展**（三审 T3）：同结论再存一遍不算（reviewedUnchanged）、
      // 同稿不落库不算、pending 不动不算 —— 首轮总允许（它本身就是入口）
      if (rounds > 1 && !pipelineProgressed(res, prevPending)) break
      prevPending = res.pending
    }
    await runAudit()
    return { reviewed, killed, fixed, rewritten, remaining, reviewer, independent, error }
  }, [runAudit])

  /** 开机即自动维护：流水线（审→改→复审）跑到归零，接着补齐缺的逐项纠正 —— 全程无按钮
   *  （用户拍板：生成新题后自动走自我纠正管线，「连按钮都不需要」，用户对这套流程无感知）。
   *  **按账户武装**（三审 T2）：每个账户每会话只跑一次；A 跑过不代表 B 跑过，
   *  切到 B 后若 B 有待办，B 自己的维护照常启动。编排体在 runMaintenanceFlow（可脱离 React 测）。 */
  useEffect(() => {
    if (autoRunForRef.current === account?.id || !account || !audit || !ai?.review?.configured) return
    const pending = audit.pipelinePending ?? 0
    const missing = audit.missingCause?.count ?? 0
    if (pending <= 0 && missing <= 0) return
    const maintId = account.id
    autoRunForRef.current = maintId
    void runMaintenanceFlow({
      // 整条链的身份：每个 await 之后都会校验，切了账户就停（三审 T2）
      isCurrent: () => accountRef.current?.id === maintId,
      review: () => aiReviewNow(),
      enrichBatch: ai?.configured ? () => enrichNow(24) : undefined,
      onNote: setPipelineNote,
      onEnriched: () => { void reloadItems() },   // 新补的纠正要并进抽题池，练习页立刻能用
    })
  }, [account, audit, ai, aiReviewNow, enrichNow, reloadItems])

  const reopenBulkNow = useCallback(async () => {
    const id = accountRef.current?.id
    if (!id) return 0
    const n = await reopenBulkApi(id)
    if (n === null) return 0
    // 本机的标记也要跟着降级，否则下次推送又把 human 推回去
    const cur = optsRef.current.getMarks()
    const next = { ...cur }
    for (const [qid, m] of Object.entries(next)) {
      if (m?.verdict === 'ok' && (m.source === 'bulk' || m.source === undefined || m.source === 'human')) {
        next[qid] = { ...m, source: 'bulk' }
      }
    }
    optsRef.current.applyMarks(next)
    await runAudit()
    return n
  }, [runAudit])

  const changeModel = useCallback(async (model: string) => {
    const ai = await setAiModel(model)
    if (!ai) return false
    setAi(ai)
    setNotice({ kind: 'ok', text: `系统 AI 已切换为 ${ai.model}。` })
    return true
  }, [])

  const patchItemVerdict = useCallback(async (itemId: string, verdict: 'ok' | 'fix' | 'kill') => {
    const id = accountRef.current?.id
    if (!id) return
    const ok = await setItemVerdict(id, itemId, verdict)
    if (!ok) {
      setNotice({ kind: 'warn', text: '这条审核结论没能写进数据库（离线），已先记在本机。' })
      return
    }
    // 本地状态跟着更新：界面立刻是对的，不用等下一次整批读
    const status = verdict === 'ok' ? 'reviewed' : verdict === 'kill' ? 'quarantined' : 'draft'
    setItems((prev) => prev.map((it) => (it.itemId === itemId
      ? { ...it, reviewStatus: status as DbItem['reviewStatus'], question: { ...it.question, reviewStatus: status as DbItem['reviewStatus'] } }
      : it)))
    void fetchItems(id).then((res) => { if (res) { setItemStats(res.stats); setItemsCached(res.cached) } })
  }, [])

  // ---------- 启动：拉库 → 决定谁接管谁 ----------
  // 注意：这里**不能**用"cleanup 里置 dead 废弃异步启动"的写法 —— StrictMode（dev）会
  // 挂载→清理→再挂载，第一次启动会在第一个 await 后被废弃，而第二次又被 bootedRef 挡住，
  // 结果是 bootstrap 永远不发出、新用户永远停在"正在连接数据库"（实测）。boot 每个应用
  // 生命周期只该跑一次，跑起来就让它跑完；真卸载时多写几次状态无害。
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    ;(async () => {
      const wanted = currentAccountId()
      const list = await fetchAccounts()
      if (!list) {
        // 数据库不可用：完全退回本地模式，练习照常，只在设置里说明
        setSyncedAt(lastSyncedAt(wanted))
        if (getDbError() === 'NO_API') {
          setNotice({
            kind: 'warn',
            text: '进度数据库接口没有响应——如果应用是这次改动之前启动的（cmd 窗口还开着），请关掉它、重新运行 start.bat。这一轮练习仍然会完整保存在浏览器里，重启后自动补写进数据库。',
          })
        }
        return
      }
      setAccounts(list)

      let acc = list.find((a) => a.id === wanted) ?? null
      let pulled: PullResult | null = null
      if (acc) {
        pulled = await pullProgress(acc.id)
      } else {
        // 第一次跑这个功能，或者存的是别的库的账户：库里没有就建一个
        const boot = await bootstrap()
        if (!boot) { setAccounts(list); return }
        acc = boot.account
        pulled = { progress: boot.progress, revision: boot.revision, reviews: boot.reviews, updatedAt: boot.updatedAt }
        setAccounts(await fetchAccounts() ?? [acc])
      }
      accountRef.current = acc
      setAccount(acc)
      // 账户题库（内容层）与进度分开读：它决定"这个人能抽到哪些题"
      void reloadItems()
      void runAudit()

      const decision = decideBoot(optsRef.current.progressRef.current, pulled)
      const localBefore = optsRef.current.progressRef.current
      if (decision.kind === 'adopt-remote') {
        adopt(decision.pull)
        // 本地进度是空的，但审核标记（用户逐题「通过」的成果）不在进度文档里 ——
        // 不推这一次，他刚清空过进度时那几百条结论就永远进不了库（实测 rev 停在 0）。
        void push(false, 'boot-adopt-remote')
      } else if (decision.kind === 'merge') {
        const { progress, added } = unionProgress(localBefore, decision.pull.progress)
        if (added > 0) {
          optsRef.current.applyProgress(progress)
          setNotice({ kind: 'ok', text: `已把数据库里另外 ${added} 条作答记录并入本机存档。` })
        }
        const remote = decision.pull.reviews ?? {}
        if (Object.keys(remote).length) {
          // 与 adopt 同一套规则：服务端优先。旧写法 {...remote, ...local} 是本地优先 ——
          // 双标签页/旧缓存会把已完成的 AI 判毙重新打开（复核报告 #5）
          const merged = mergeReviewMarks(remote, optsRef.current.getMarks())
          optsRef.current.applyMarks(merged)
          marksBaselineRef.current = remote
        }
        setSyncedAt(lastSyncedAt(acc.id))
        void push(false, 'boot-merge')
      } else if (decision.kind === 'upload-local') {
        const n = localBefore.attempts.length
        const ok = await push(true, 'bootstrap-migrate')
        if (ok) {
          setNotice({
            kind: 'ok',
            text: n > 0
              ? `已把浏览器里的进度（${n} 条作答记录）搬进进度数据库。以后换浏览器也能接着练。`
              : '进度数据库已建立，之后的每一次作答都会入库。',
          })
        } else {
          setNotice({ kind: 'warn', text: '进度数据库暂时写不进去，已继续用浏览器存档，稍后会自动重试。' })
        }
      } else {
        // 两边都空（全新开始）：同样要推一次，把本地已有的审核标记登记进库
        setSyncedAt(lastSyncedAt(acc.id))
        void push(false, 'boot-fresh')
        refreshStats(true)
      }
    })()
  }, [adopt, push, refreshStats, reloadItems, runAudit])

  // 关页面 / 切后台前把最后一次写入补上（localStorage 已有全量，这里只是让库跟上）
  useEffect(() => {
    const flushNow = () => { if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; void push(false, 'pagehide') } }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow() }
    window.addEventListener('pagehide', flushNow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flushNow)
      document.removeEventListener('visibilitychange', onVisibility)
      flushNow()
    }
  }, [push])

  const switchTo = useCallback(async (id: string) => {
    const cur = accountRef.current?.id
    if (id === cur) return
    if (cur) await push(false, 'switch-out')
    const list = await fetchAccounts()
    const target = list?.find((a) => a.id === id)
    if (!target) { setNotice({ kind: 'warn', text: '这个账户在数据库里找不到了。' }); return }
    const pull = await pullProgress(id)
    if (!pull) { setNotice({ kind: 'warn', text: '数据库未连接，暂时无法切换账户。' }); return }
    setCurrentAccountId(id)
    accountRef.current = target
    setAccount(target)
    setAccounts(list ?? [])
    setStats(null)
    // 切账户 = 整份接管目标账户的标记，**不与上一个账户的本地标记合并**
    // （合并会把 A 的结论带进 B 的题池、还会当 B 的新增推回服务端 —— 复核报告 R3；
    //   A 的标记已在上面 switch-out 时推给了 A，丢掉本地这份不会丢数据）
    adopt(pull, { keepLocal: false })
    void reloadItems()
    void runAudit()
    setNotice({ kind: 'ok', text: `已切换到「${target.name}」。` })
  }, [adopt, push, reloadItems, runAudit])

  const newAccount = useCallback(async (name: string) => {
    const acc = await createAccount(name)
    if (!acc) { setNotice({ kind: 'warn', text: '数据库未连接，暂时无法新建账户。' }); return }
    await switchTo(acc.id)
  }, [switchTo])

  const rename = useCallback(async (name: string) => {
    const id = accountRef.current?.id
    if (!id) return
    const acc = await renameAccount(id, name)
    if (!acc) { setNotice({ kind: 'warn', text: '改名失败：数据库未连接。' }); return }
    accountRef.current = acc
    setAccount(acc)
    setAccounts((prev) => prev.map((a) => (a.id === acc.id ? acc : a)))
  }, [])

  /** 清空当前账户：先让库里留快照再清，否则清完又会被库里那份同步回来 */
  const resetCurrent = useCallback(async () => {
    const id = accountRef.current?.id
    if (!id) return false
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null }
    return await resetRemote(id)
  }, [])

  const reloadFromDb = useCallback(async () => {
    const id = accountRef.current?.id
    if (!id) return
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null }
    await push(false, 'pre-reload')
    const pull = await pullProgress(id)
    if (!pull) { setNotice({ kind: 'warn', text: '数据库未连接，读取失败。' }); return }
    adopt(pull)
    setNotice({ kind: 'ok', text: '已按数据库里的内容重新载入。' })
  }, [adopt, push])

  return {
    account, accounts, dbState, stats, syncedAt, notice,
    dismissNotice: () => setNotice(null),
    note: (text, kind = 'ok') => setNotice({ kind, text }),
    items, itemStats, itemBatches, itemsCached, reloadItems, patchItemVerdict,
    audit, enrichments, ai, syncCatalog, runAudit, enrichNow, changeModel, aiReviewNow, pipelineNote, runs, reopenBulkNow,
    schedule, flush, refreshStats, rename, newAccount, switchTo, resetCurrent, reloadFromDb,
  }
}
