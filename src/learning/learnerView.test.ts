// 28 号薄片：learner view model 的映射与降级回归（纯函数，无网络）。
import { describe, expect, it } from 'vitest'
import { cleanReason, goalLabel, learnerToday } from './learnerView'

describe('learnerView 行为名称', () => {
  it('已知目标映射为行为名；未知目标回退通用名，绝不用 ID 当主标题', () => {
    expect(goalLabel('O-K115-02')).toBe('分清代词指代的是设备还是整件事')
    expect(goalLabel('O-UNKNOWN-99')).toBe('一项英语理解与表达训练')
    expect(goalLabel(null)).toBe('一项英语理解与表达训练')
  })

  it('理由清洗：目标 ID 与状态/策略术语换可读说法', () => {
    const out = cleanReason('O-K115-01 证据薄弱（unmeasured）且能打开 2 条后继：短讲后练')
    expect(out).toContain('读懂一句话里谁修饰谁')
    expect(out).not.toContain('O-K115-01')
    expect(out).toContain('还没测到')
    expect(cleanReason('discriminate_cause 策略')).toContain('先做一次短区分')
    expect(cleanReason(null)).toBe('')
  })

  it('learnerToday：有已发布课 → continue；内容等待 → wait 不冒充可学；无诊断 → find_start', () => {
    const cont = learnerToday({
      primaryGoal: 'O-K115-01', reason: 'O-K115-01 证据薄弱（unmeasured）',
      lesson: { lessonId: 'les-relations-v1', status: 'published' },
    })
    expect(cont.mode).toBe('continue')
    expect(cont.primaryLabel).toBe('开始训练')
    expect(cont.headline).toContain('今天这一步')
    expect(cont.reason).not.toContain('O-K115-01')
    expect(cont.waiting).toBe(false)

    expect(learnerToday({ primaryGoal: 'O-K115-01', lesson: {lessonId: 'les-relations-v1',status:'published',resumeAvailable:true} }).primaryLabel).toBe('继续上一段')

    const wait = learnerToday({
      primaryGoal: 'O-K007-02', reason: '', lesson: { lessonId: null, status: 'content_pending' },
    })
    expect(wait.mode).toBe('wait')
    expect(wait.waiting).toBe(true)
    expect(wait.reason).toContain('没有可用的后继课程')

    const fresh = learnerToday(null)
    expect(fresh.mode).toBe('find_start')
    expect(fresh.primaryLabel).toBe('开始入口诊断')

    const noLesson = learnerToday({ primaryGoal: 'O-K190-01', reason: undefined, lesson: null })
    expect(noLesson.mode).toBe('find_start')
    expect(noLesson.reason).toContain('证据还不够')
  })
})
