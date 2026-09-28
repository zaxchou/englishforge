import type { AdaptedQuestion, Lesson, Module, Question } from '../types'
import { adaptAll } from '../content/adapt'
import { validateQuestions, errorsOf } from '../content/validation'
import { lesson07 } from './lesson07-meta'
import { lesson10 } from './lesson10-meta'
import { questionsA } from './lesson07-q-a'
import { questionsB } from './lesson07-q-b'
import { questionsC } from './lesson07-q-c'
import { questionsD } from './lesson07-q-d'
import { questionsE } from './lesson07-q-e'
import { lesson10qA } from './lesson10-q-a'
import { lesson10qB } from './lesson10-q-b'
// R1-02 种子题：由真实语料派生（出处见 docs/curriculum/corpus-coverage-spike.md）
// 一律 draft，供练习与试用；未人工审核前不参与能力认证
import { subjectObjectPilot } from './pilots/subject-object'

const rawQuestions: Question[] = [
  ...questionsA, ...questionsB, ...questionsC, ...questionsD, ...questionsE,
  ...lesson10qA, ...lesson10qB,
  ...subjectObjectPilot,
]

/** 加载时适配：ID 化 + v2 元数据默认值 */
export const allQuestions: AdaptedQuestion[] = adaptAll(rawQuestions)

// 结构校验在加载时执行一次：error 级问题打印到控制台（正式门槛见 tests/validate.test.ts）
const issues = validateQuestions(allQuestions)
if (issues.length) {
  const errs = errorsOf(issues)
  if (errs.length) {
    console.error(`[题库结构校验] ${errs.length} 个错误：`)
    for (const e of errs) console.error(`  ${e.qid}: ${e.msg}`)
  }
}

export function questionsOfSkill(skillId: string): AdaptedQuestion[] {
  return allQuestions.filter((q) => q.skill === skillId)
}

export const modules: Module[] = [
  {
    id: 'm-c',
    name: '模块 C · 一个含义一个形式',
    desc: '第 7 课：直线型思维——整套体系的根源',
    lessons: ['l07'],
  },
  {
    id: 'm-cd',
    name: '模块 D · 动词是发动机',
    desc: '第 10~14 课：时态、谓语、语态（第 10 课已上线）',
    lessons: ['l10'],
  },
  {
    id: 'm-ab',
    name: '模块 A+B · 声音与词义（建设中）',
    desc: '第 1~6、9 课：音标、词源、含义——M2 解锁',
    lessons: [],
  },
]

export const lessons: Record<string, Lesson> = {
  l07: lesson07,
  l10: lesson10,
}

/** 课程顺序的技能 id 列表（今日队列推荐用） */
export const skillOrder: string[] = Object.values(lessons).flatMap((l) => l.skills.map((s) => s.id))
