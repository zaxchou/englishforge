// 托福课程目录与进度口径（59 号 S1；57 进度合同 / 56 §5）。
//
// 进度只算一个地方：这里。Dashboard 与课程页都吃本文件的纯函数，
// 禁止两套页面各写各的百分比（57「禁止两套页面各写各的百分比」）。
// 分母 = 当前版本已发布章 × 该章 requiredActivities 数；方法学习是视频/讲义 OR 路径，不重复加分。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(HERE, '..', 'data', 'toefl')

let cache = null
function loadJson(name) {
  const p = join(DATA, name)
  const stat = { m: 0, s: 0 }
  try { const st = readFileSync(p); stat.m = st.byteLength } catch { /* 缺文件在下面抛出可读错误 */ }
  const mem = cache?.[name]
  if (mem && mem.size === stat.m) return mem.value
  const value = JSON.parse(readFileSync(p, 'utf8'))
  cache = cache ?? {}
  cache[name] = { value, size: stat.m }
  return value
}

/** 目录（含规划模块）；测试可注入覆盖 */
export function toeflCatalog() { return loadJson('catalog.json') }
export function toeflTasks() { return loadJson('tasks.json').tasks }
export function toeflMediaMap() { return loadJson('media.json') }

export function toeflTask(taskId) {
  const t = toeflTasks()[taskId]
  if (!t) throw new Error('TOEFL_TASK_NOT_FOUND: ' + taskId)
  return { ...t, taskId }
}
export function toeflChapter(chapterId) {
  return toeflCatalog().chapters.find((c) => c.chapterId === chapterId) ?? null
}
export function publishedChapters() {
  return toeflCatalog().chapters.filter((c) => c.publicationStatus === 'published')
}

/** 媒体条目（白名单查找；不在清单 = 拒绝） */
export function mediaEntry(mediaId) {
  return toeflMediaMap().media[mediaId] ?? null
}
export function mediaRoot(entry) {
  if (entry?.root === 'notes') {
    // 教材根 = JunEnglish（notes 条目的 file 以 新D方/… 开头）；env 可覆盖
    return process.env.TOEFL_NOTES_ROOT ?? resolve(HERE, '..', '..', '..')
  }
  return process.env.TOEFL_MEDIA_ROOT ?? resolve(resolve(HERE, '..', '..'), toeflMediaMap().mediaRoot)
}

/** 该章必需活动清单 */
export function requiredActivities(chapter) { return chapter.requiredActivities ?? ['method', 'practice', 'review'] }

/** 课程完成总分母（全版本已发布章的必需活动总数） */
export function totalRequiredActivities() {
  return publishedChapters().reduce((n, c) => n + requiredActivities(c).length, 0)
}

/** 某账户某章已完成的活动键集合。输入全部来自真实记录：
 * method → toefl_events(kind=method_done)，practice → 提交过的 attempt，review → toefl_events(kind=review_done) */
export function chapterDoneActivities(db, accountId, chapter, { attempts, events }) {
  const done = new Set()
  if (events.method_done?.has(chapter.chapterId)) done.add('method')
  if (attempts.has(chapter.practiceTaskId)) done.add('practice')
  if (events.review_done?.has(chapter.chapterId)) done.add('review')
  return requiredActivities(chapter).filter((a) => done.has(a))
}

/** 首页/单科聚合（纯函数，读入已查询的行）。分母与分子同口径，四科行不可平均成总分（57）。 */
export function computeProgress(db, accountId, { attemptRows, eventRows }) {
  const attempts = new Set(attemptRows.filter((a) => a.status === 'submitted' || a.status === 'analyzed').map((a) => a.task_id))
  const events = { method_done: new Set(), review_done: new Set() }
  for (const e of eventRows) {
    const payload = safeJson(e.payload)
    if (e.kind === 'method_done' && payload.chapterId) events.method_done.add(payload.chapterId)
    if (e.kind === 'review_done' && payload.chapterId) events.review_done.add(payload.chapterId)
  }
  const parts = {}
  for (const chapter of publishedChapters()) {
    parts[chapter.part] ??= { part: chapter.part, name: partName(chapter.part), chapters: [], done: 0, total: 0 }
    const p = parts[chapter.part]
    const doneKeys = chapterDoneActivities(db, accountId, chapter, { attempts, events })
    p.chapters.push({
      chapterId: chapter.chapterId,
      title: chapter.title,
      done: doneKeys.length,
      total: requiredActivities(chapter).length,
      doneKeys,
    })
    p.done += doneKeys.length
    p.total += requiredActivities(chapter).length
  }
  const totalDone = Object.values(parts).reduce((n, p) => n + p.done, 0)
  return {
    parts: Object.values(parts).sort((a, b) => a.part.localeCompare(b.part)),
    overall: { done: totalDone, total: totalRequiredActivities() },
    catalogVersion: toeflCatalog().catalogVersion,
  }
}

export function partName(part) {
  return toeflCatalog().parts[part]?.name ?? part
}

/** 资料库清单：老师原视频目录快照 + 核心讲义（来自 toefl-redesign 研读目录，54 §2） */
export function toeflResources() {
  const base = resolve(HERE, '..', '..', 'docs', 'curriculum-v4', 'toefl-redesign', 'lecture-notes')
  const read = (f) => { try { return JSON.parse(readFileSync(join(base, f), 'utf8')) } catch { return null } }
  return { videoCatalog: read('video-catalog.json'), handoutManifest: read('manifest.json') }
}

function safeJson(s) {
  try { return JSON.parse(s || '{}') } catch { return {} }
}
