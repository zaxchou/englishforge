// 49 号主交付数据层：成长作品页（quest.html data-screen="growth" 的真实产品版）。
// · 作品 = 真实保存的提交/录音/转写，标注时间、任务、支持条件（需要提示/看了文字稿/独立完成）；
// · 配对只认**同目标**（objectiveId 相同）且"先需要支持、后独立完成"的真实进步；配不上的不硬凑，
//   零作品/单作品/不可比都有真实空态，不虚构进步结论；
// · "这次之后课程怎样变化"三卡（保留/减少/增加）连接真实规划依据：减少提示的依据是真实配对、
//   保留的依据是当前推荐、增加的依据是已备好的候选课；没有真实调整就如实说"尚未形成"。
// 只读；不修改任何学习数据。
import { ensureV3Schema } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { activityById } from './v3evidence.mjs'
import { getLesson } from './v3lessons.mjs'
import { materialSnapshot } from './v3registry.mjs'
import { computeLevel } from './v3journey.mjs'

/** 服务端口径的支持条件标签（不用客户端自报）：
 * independent = firstExposure 且无提示且未看稿；需要提示 = hintLevel>0；看稿 = transcriptShown。 */
function conditionLabel(cond, evaluation) {
  if (!cond) return '练习作答'
  if (evaluation?.pass === false) return '第一次没通过' // 49 号实测：失败优先标注，不把没过的独立尝试说成"独立完成"
  if (cond.hintLevel > 0) return '需要提示'
  if (cond.transcriptShown) return '看了文字稿'
  if (cond.firstExposure) return '独立完成'
  return '练习作答'
}

function workFromRow(row) {
  const act = activityById(row.activity_id)
  const evaluation = JSON.parse(row.evaluation || '{}')
  const response = JSON.parse(row.response || '{}')
  const cond = JSON.parse(row.conditions || '{}')
  const material = act?.materialId ? materialSnapshot(String(act.materialId), act.segmentIds ?? null) : null
  return {
    attemptId: row.attempt_id,
    activityId: row.activity_id,
    objectiveId: (JSON.parse(row.objective_ids || '[]')[0]) ?? null,
    skill: Object.values(act?.skillByObjective ?? {})[0] ?? 'reading',
    taskLabel: act?.prompt ? String(act.prompt).split('\n')[0].slice(0, 60) : (act?.taskFamilyId ?? row.task_family_id ?? ''),
    at: row.created_at,
    text: String(response.text ?? '').slice(0, 800),
    mediaId: response.mediaId ?? null,
    oral: !!act?.oralEvidenceDeferred,
    label: conditionLabel(cond, evaluation),
    supportLabelHint: (cond.hintLevel ?? 0) > 0 || !!cond.transcriptShown,
    pass: evaluation?.pass ?? null,
    aiVerdict: evaluation?.aiReview?.verdict ?? null,
    aiFeedback: evaluation?.aiReview?.feedback ?? null,
    relations: (evaluation?.relations ?? []).map((r) => ({ label: r.label, hit: r.hit, required: !!r.required })),
    practiceOnly: evaluation?.keywordOnly === true,
    materialTitle: material?.[0]?.title ?? null,
    materialText: material?.[0]?.text ?? null,
  }
}

export function getWorks(accountId) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const rows = conn.prepare(
    `SELECT attempt_id, activity_id, objective_ids, task_family_id, response, conditions, evaluation, created_at
     FROM learner_attempts_v3 WHERE account_id = ? AND evaluation_status = 'evaluated'
     ORDER BY created_at ASC, rowid ASC`).all(accountId)
  const works = rows.map(workFromRow).filter((w) => w.text.length >= 2 || w.mediaId)

  // 配对：同目标，先"需要支持/没通过"，后"独立完成且通过"（AI 判对也算通过——但标注为 AI 练习层）。
  // 只取最近一组可配对；其余作品单独列出，不做跨目标假进步。
  let pair = null
  const byObjective = new Map()
  for (const w of works) {
    if (!w.objectiveId) continue
    if (!byObjective.has(w.objectiveId)) byObjective.set(w.objectiveId, [])
    byObjective.get(w.objectiveId).push(w)
  }
  const objectiveOrder = [...byObjective.keys()].reverse() // 最近的目标优先
  for (const oid of objectiveOrder) {
    const list = byObjective.get(oid)
    for (let i = list.length - 1; i >= 0 && !pair; i--) {
      const newer = list[i]
      const independent = newer.label === '独立完成' && (newer.pass === true || newer.aiVerdict === 'correct')
      if (!independent) continue
      for (let k = i - 1; k >= 0 && !pair; k--) {
        const older = list[k]
        if (older.supportLabelHint || older.pass === false) {
          pair = { objectiveId: oid, old: older, new: newer }
        }
      }
    }
    if (pair) break
  }

  const pairedIds = new Set(pair ? [pair.old.attemptId, pair.new.attemptId] : [])
  const recent = works.filter((w) => !pairedIds.has(w.attemptId)).slice(-6).reverse()

  // 变化三卡：连接真实规划依据
  const planRow = conn.prepare(
    'SELECT primary_goal, reason FROM plan_decisions WHERE account_id = ? ORDER BY created_at DESC LIMIT 1').get(accountId)
  const lastDone = conn.prepare(
    "SELECT served_lesson_id FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(accountId)
  const nextIds = lastDone ? (getLesson(lastDone.served_lesson_id)?.nextCandidates ?? []) : []
  const nextLesson = nextIds.map((nid) => getLesson(nid)).find((l) => l && l.contentStatus === 'published')
  const states = conn.prepare("SELECT objective_id AS objectiveId, skill, complexity, state, flags FROM learner_states WHERE account_id = ?").all(accountId)
  const lessons = new Set(conn.prepare(
    "SELECT served_lesson_id FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL").all(accountId).map((r) => r.served_lesson_id))
  const level = computeLevel(states, lessons.size)
  const adjustments = {
    // 减少：有真实"需要提示→独立完成"配对时才成立（48/49 号：不静态承诺已撤提示）
    reduce: pair
      ? { real: true, title: '提示可以少一些了', body: `在「${pair.new.objectiveId}」上，你从需要提示做到了独立完成。后面的新材料会先让你自己试，卡住了再给帮助。` }
      : { real: false, title: '还没有形成', body: '目前还没有"从需要提示到独立完成"的成对记录。出现之后，这里会说明提示会怎么撤。' },
    // 保留：当前真实推荐
    keep: planRow
      ? { real: true, title: '按现在的方向继续', body: `当前安排：${String(planRow.reason || '继续当前方向').slice(0, 80)}。` }
      : { real: false, title: '还没有形成', body: '完成入口测试后，这里会显示当前的方向安排。' },
    // 增加：已备好的候选课（不承诺就是下一推荐）
    add: nextLesson
      ? { real: true, title: `加入新课题：《${nextLesson.title}》`, body: '这门课已经备好，完成当前课之后由规划确认接上。' }
      : { real: false, title: '还没有形成', body: '新的课题还在准备中。做好了会出现在这里和「今日学习」。' },
  }

  return {
    pair,
    recent,
    adjustments,
    level: { title: level.level, levelIndex: level.levelIndex, nextTitle: level.nextTitle, nextHow: level.nextHow, stats: level.summary },
    totalWorks: works.length,
  }
}
