// 题库结构校验：自动化检查（不能证明语义正确——自然度、单选唯一性、
// 语境充分性与解析准确性必须单独审核，见 PLAN-v2 §8.3）
import type { AdaptedQuestion } from '../types'

export interface Issue {
  qid: string
  level: 'error' | 'warn'
  msg: string
}

export function validateQuestions(questions: AdaptedQuestion[]): Issue[] {
  const issues: Issue[] = []
  const seen = new Set<string>()

  for (const q of questions) {
    const push = (level: Issue['level'], msg: string) => issues.push({ qid: q.id, level, msg })

    if (!q.id) push('error', '缺少 id')
    if (seen.has(q.id)) push('error', 'id 重复')
    seen.add(q.id)

    if (!q.skill) push('error', '缺少 skill')
    if (!q.prompt) push('error', '缺少 prompt')
    if (!q.explain) push('error', '缺少 explain')

    // choice：答案必须存在于选项，选项不得重复
    if (q.type === 'choice') {
      if (!q.options || q.options.length < 2) push('error', 'choice 选项不足 2 个')
      if (!q.answer) push('error', 'choice 缺少 answer')
      if (!q.answerId) push('error', 'answer 不在 options 中（判定将永远失败）')
      const dup = q.options?.filter((o, i) => q.options!.indexOf(o) !== i) ?? []
      if (dup.length) push('error', `选项重复：${[...new Set(dup)].join(' / ')}`)
      if (new Set(q.optionIds).size !== q.optionIds.length) push('error', '选项 ID 重复')
      if (q.acceptedAnswers) {
        for (const a of q.acceptedAnswers) {
          if (a !== q.answerId && !q.optionIds.includes(a)) push('error', `acceptedAnswers 引用不存在的选项 ${a}`)
        }
      }
    }

    // tap：answer 必须命中某个 token
    if (q.type === 'tap') {
      if (!q.tokens?.length) push('error', 'tap 缺少 tokens')
      if (!q.answerId) push('error', 'tap answer 不在 tokens 中')
      if (!q.fix) push('warn', 'tap 缺少 fix（正确形式展示）')
    }

    // tiles：order 必须能映射到全部引用的词块
    if (q.type === 'tiles') {
      if (!q.order?.length) push('error', 'tiles 缺少 order')
      if (!q.tokens?.length) push('error', 'tiles 缺少 tokens')
      if (q.orderIds.some((id) => id.startsWith('__missing__'))) push('error', 'order 中存在无法匹配的词块文本')
      const unused = q.tokens2.filter((t) => !q.orderIds.includes(t.id))
      if (unused.length && (q.order?.length ?? 0) !== q.tokens2.length) {
        push('warn', `有 ${unused.length} 个干扰词块（若非刻意设计请核对）`)
      }
    }

    // match / sort：结构成对
    if (q.type === 'match') {
      if (!q.pairs?.length) push('error', 'match 缺少 pairs')
      const rights = q.pairs?.map((p) => p[1]) ?? []
      if (new Set(rights).size !== rights.length) push('error', 'match 右列有重复项（将无法区分）')
    }
    if (q.type === 'sort') {
      if (!q.items?.length) push('error', 'sort 缺少 items')
      if ((q.buckets?.length ?? 0) !== 2) push('error', 'sort 需要 2 个 bucket')
      if (q.items?.some((it) => it.b !== 0 && it.b !== 1)) push('error', 'sort item.b 必须是 0/1')
    }

    // speak：目标句必须存在
    if (q.type === 'speak') {
      if (!(q.target || q.tts)) push('error', 'speak 缺少 target/tts')
    }

    // 听力：必须有 tts
    if (q.autoTTS && !q.tts) push('error', 'autoTTS 题缺少 tts')

    // v2 元数据
    if (q.contentVersion < 1) push('error', 'contentVersion 必须 >= 1')
    if (!q.variantGroupId) push('error', '缺少 variantGroupId')
    if (!q.objectiveId) push('error', '缺少 objectiveId')
    if (!['draft', 'reviewed', 'quarantined'].includes(q.reviewStatus)) push('error', 'reviewStatus 非法')
    if (!q.sourceRef) push('warn', '缺少 sourceRef（课稿出处）')
    if (q.mode === 'oral' && q.type !== 'speak') push('warn', 'mode=oral 但题型不是 speak')
  }

  return issues
}

/** 只返回 error 级问题（测试门槛） */
export function errorsOf(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.level === 'error')
}
