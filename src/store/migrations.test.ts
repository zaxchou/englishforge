// P0 回归：存档迁移 / 幂等 / 损坏恢复 / 导入导出（PLAN-v2 §11 用例 9、12、迁移流程）
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadProgressV2, saveProgressV2, migrateV1toV2, pushAttempt,
  exportSave, previewImport, applyImport, resetProgress, localDateStr, defaultProgressV2,
} from './migrations'
import { V1_KEY, V2_KEY, BACKUP_PREFIX, type Attempt, type Progress } from '../types'

class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  get length() { return this.m.size }
}

function seedV1(over?: Partial<Progress>): string {
  const v1: Progress = {
    xp: 300, streak: 5, lastActiveDate: localDateStr(), comboBest: 9,
    skills: { s1: { conceptSeen: true, box: 3, due: 123, correct: 10, total: 15 } },
    questions: { qA: { box: 4, due: 456, correct: 8, total: 9 }, qB: { box: 0, due: 1, correct: 0, total: 3 } },
    dailyXp: { '2026-09-27': 80 },
    sessions: [{ ts: 1, label: '旧记录', lessonNo: '07', acc: 90, xp: 80, total: 10, firstTry: 9 }],
    ...over,
  }
  return JSON.stringify(v1)
}

function mkAttempt(id: string): Attempt {
  return {
    attemptId: id, sessionId: 's', questionId: 'q', contentVersion: 1,
    objectiveId: 'skill', variantGroupId: 'q', mode: 'recognition',
    timestamp: Date.now(), localDate: localDateStr(), firstAttempt: true,
    supportUsed: 3, answer: 'A', outcome: 'correct', evaluator: 'deterministic',
    responseMs: 1200, isDueReview: false,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
})

/** 通过 Storage.key(i) 枚举（Object.keys 拿不到实例内部存储） */
function allKeys(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k) out.push(k)
  }
  return out
}

describe('v1 → v2 迁移', () => {
  it('读到 v1：转换后写入 v2，且原 v1 不删除（用例 9 的基础）', () => {
    localStorage.setItem(V1_KEY, seedV1())
    const { progress, notice } = loadProgressV2()
    expect(notice).toBe('migrated')
    expect(progress.schemaVersion).toBe(2)
    expect(progress.xp).toBe(300)
    expect(progress.streak).toBe(5)
    // 旧 box → questionStates，标 legacy（不当新证据）
    expect(progress.questionStates.qA).toMatchObject({ stage: 4, dueAt: 456, legacy: true })
    expect(progress.questionStates.qB).toMatchObject({ stage: 0, legacy: true })
    // 事件从迁移后开始
    expect(progress.attempts).toHaveLength(0)
    // v1 保留
    expect(localStorage.getItem(V1_KEY)).toBeTruthy()
    // v2 已写入并可回读
    const back = JSON.parse(localStorage.getItem(V2_KEY)!)
    expect(back.schemaVersion).toBe(2)
    expect(back.sessions).toHaveLength(1)
  })

  it('v1 微课/每日XP/连续天数原样保留', () => {
    localStorage.setItem(V1_KEY, seedV1())
    const { progress } = loadProgressV2()
    expect(progress.skills.s1.conceptSeen).toBe(true)
    expect(progress.dailyXp?.['2026-09-27']).toBe(80)
    expect(progress.comboBest).toBe(9)
  })

  it('migrateV1toV2 是纯转换：不修改输入对象', () => {
    const v1: Progress = JSON.parse(seedV1())
    migrateV1toV2(v1)
    expect(v1.questions).toBeDefined()
  })
})

describe('v2 损坏恢复（不删除旧数据，用例 9）', () => {
  it('v2 损坏 + v1 存在：备份损坏副本，从 v1 恢复', () => {
    localStorage.setItem(V1_KEY, seedV1())
    localStorage.setItem(V2_KEY, '{"schemaVersion":2,"broken":')
    const { progress, notice } = loadProgressV2()
    expect(notice).toBe('corrupt-recovered')
    expect(progress.xp).toBe(300)
    // 损坏副本有备份，v1 仍在
    expect(allKeys().some((k) => k.startsWith(BACKUP_PREFIX))).toBe(true)
    expect(localStorage.getItem(V1_KEY)).toBeTruthy()
  })

  it('v2 损坏且无 v1：返回空进度但备份损坏副本', () => {
    localStorage.setItem(V2_KEY, 'not json at all')
    const { progress, notice } = loadProgressV2()
    expect(notice).toBe('corrupt-recovered')
    expect(progress.xp).toBe(0)
    expect(allKeys().some((k) => k.startsWith(BACKUP_PREFIX))).toBe(true)
  })
})

describe('逐题落盘与幂等（用例 5）', () => {
  it('同一 attemptId 只记一次，分数事件不翻倍', () => {
    const p = defaultProgressV2()
    expect(pushAttempt(p, mkAttempt('e1')).recorded).toBe(true)
    expect(pushAttempt(p, mkAttempt('e1')).recorded).toBe(false)   // 重复提交
    expect(p.attempts).toHaveLength(1)
    expect(localStorage.getItem(V2_KEY)).toBeTruthy()               // 每题立即落盘
  })

  it('写入失败返回 saved=false（UI 据此提示，用例 12）', () => {
    const p = defaultProgressV2()
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const res = pushAttempt(p, mkAttempt('e2'))
    expect(res.recorded).toBe(true)   // 事件仍在内存里，没有假装成功
    expect(res.saved).toBe(false)
    vi.restoreAllMocks()
  })
})

describe('存档导出/导入（§6.3）', () => {
  it('导出可回读；预览校验拒绝坏文件与错版本', () => {
    const p = defaultProgressV2()
    p.xp = 123
    saveProgressV2(p)
    const text = exportSave()
    expect(previewImport(text)).toMatchObject({ xp: 123, schemaVersion: 2 })
    expect(previewImport('garbage')).toHaveProperty('error')
    expect(previewImport('{"schemaVersion":1,"xp":1}')).toHaveProperty('error')
    expect(previewImport('{"schemaVersion":2,"skills":null}')).toHaveProperty('error')
  })

  it('导入前自动备份当前存档，导入后生效', () => {
    const cur = defaultProgressV2()
    cur.xp = 1
    saveProgressV2(cur)
    const incoming = defaultProgressV2()
    incoming.xp = 999
    const res = applyImport(JSON.stringify(incoming))
    expect(res.ok).toBe(true)
    const loaded = loadProgressV2()
    expect(loaded.progress.xp).toBe(999)
    expect(allKeys().some((k) => k.startsWith(BACKUP_PREFIX))).toBe(true)
  })

  it('清空进度前先备份，并同时清 v1/v2（避免残留 v1 复活旧进度）', () => {
    localStorage.setItem(V1_KEY, seedV1())
    saveProgressV2(defaultProgressV2())
    resetProgress()
    expect(localStorage.getItem(V1_KEY)).toBeNull()
    expect(localStorage.getItem(V2_KEY)).toBeNull()
    expect(allKeys().some((k) => k.startsWith(BACKUP_PREFIX))).toBe(true)
  })
})

describe('本地日期（用例 11：跨午夜不等 UTC）', () => {
  it('localDateStr 用本地年月日拼接', () => {
    expect(localDateStr(new Date(2026, 0, 1, 0, 5).getTime())).toBe('2026-01-01')
    expect(localDateStr(new Date(2026, 11, 31, 23, 55).getTime())).toBe('2026-12-31')
  })
})
