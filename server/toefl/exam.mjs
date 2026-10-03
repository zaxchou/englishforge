// 真题模考（用户指令 2/3：成套真题、分 part 交卷即评分、AI 错题讲解、错题重训）。
//
// 判分依据 = 题目册内官方 Answer Key（pack JSON 的 answer/key 字段），AI 不改判分；
// AI 负责：错题部分的整体讲评（结合官方解析给针对本人答案的说明）与开放题（写作/口语）辅助反馈。
// 错题入 toefl_errors（familyId = exam:<examId>:<questionKey>），与课程错题同一个错题本。
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError, getAccount } from '../db.mjs'
import { toeflExamPack, toeflExamIds, toeflTasks } from './content.mjs'
import { ensureToeflSchema } from './db.mjs'
import { teacherChat } from './teacher.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SECTIONS = ['reading', 'listening', 'speaking', 'writing']

const conn = (accountId) => {
  const db = ensureToeflSchema()
  if (!getAccount(accountId)) throw new ApiError(404, '账户不存在：' + accountId)
  return db
}
const j = (s) => { try { return JSON.parse(s || 'null') } catch { return null } }
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '')
const norm = (v) => String(v ?? '').trim().toLowerCase()

// ---- 题库视图：下发时不带 answer/key/explain（交卷后随结果返回） ----

function publicSection(sectionData, sectionId) {
  if (sectionId === 'reading' || sectionId === 'listening') {
    return {
      label: sectionData.label,
      modules: sectionData.modules.map((m) => ({
        moduleId: m.moduleId, title: m.title,
        groups: m.groups.map((g) => ({
          type: g.type, title: g.title, instruction: g.instruction ?? null,
          passage: g.passage ?? null,
          audioMediaId: g.audioMediaId ?? null,
          audioNote: g.audioNote ?? null,
          questions: g.questions.map((q) => ({ n: q.n, prompt: q.prompt, options: q.options ?? null })),
        })),
      })),
    }
  }
  if (sectionId === 'writing') {
    // Build a Sentence 的官方参考句不随题目下发（交卷后随反馈返回）
    return {
      label: sectionData.label,
      tasks: sectionData.tasks.map((t) => t.type === 'build_sentence'
        ? { ...t, items: t.items.map(({ answer, explain, ...rest }) => rest), grading: undefined }
        : t),
    }
  }
  return { label: sectionData.label, tasks: sectionData.tasks }
}

function eachQuestion(pack, sectionId, fn) {
  const sectionData = pack[sectionId]
  if (!sectionData) return
  if (sectionId === 'reading' || sectionId === 'listening') {
    for (const m of sectionData.modules) {
      for (const g of m.groups) {
        for (const q of g.questions) {
          fn({ group: g, q, qKey: `${m.moduleId}-${g.type === 'cloze' ? 'c' : 'q'}-${q.n}` })
        }
      }
    }
  } else if (sectionId === 'writing') {
    for (const t of sectionData.tasks) {
      if (t.type === 'build_sentence') {
        for (const it of t.items) fn({ group: t, q: { n: it.n, prompt: it.prompt, answer: it.answer, explain: it.explain }, qKey: `w-bs-${it.n}` })
      }
    }
  }
}

// ---- 判分（官方键） ----

function gradeClosed(pack, sectionId, answers) {
  const results = []
  const wrongs = []
  let correct = 0
  let total = 0
  eachQuestion(pack, sectionId, ({ q, qKey, group }) => {
    total++
    const givenRaw = answers?.[qKey]
    const given = norm(givenRaw)
    const isCloze = q.answer !== undefined
    const keyText = isCloze ? q.answer : String.fromCharCode(65 + q.key)
    const ok = isCloze ? given === norm(q.answer) : given !== '' && Number(given) === q.key
    if (ok) correct++
    else wrongs.push({ q, qKey, group, given: givenRaw })
    results.push({
      qKey, n: q.n, prompt: q.prompt,
      given: givenRaw ?? null,
      givenText: isCloze ? (givenRaw || '（空）') : (given === '' ? '（未作答）' : String.fromCharCode(65 + Number(given))),
      keyText,
      options: q.options ?? null,
      correct: ok, explain: q.explain ?? null,
      groupTitle: group?.title ?? null,
    })
  })
  return { results, correct, total, wrongs }
}

function registerExamErrors(db, accountId, examId, sectionId, wrongs) {
  for (const w of wrongs) {
    const familyId = `exam:${examId}:${w.qKey}`
    const givenText = w.q.answer !== undefined ? (norm(w.given) || '（空）') : (norm(w.given) === '' ? '（未作答）' : String.fromCharCode(65 + Number(w.given)))
    const keyText = w.q.answer !== undefined ? w.q.answer : String.fromCharCode(65 + w.q.key)
    const groupTag = (w.group?.title ?? '').replace(/\s*（.*$/, '').replace(/\s*\(.*$/, '').slice(0, 24)
    const existing = db.prepare('SELECT error_id FROM toefl_errors WHERE account_id = ? AND question_family_id = ?').get(accountId, familyId)
    if (existing) continue
    db.prepare(`INSERT INTO toefl_errors
      (error_id, account_id, question_family_id, part, chapter_id, task_id, kind, title, detail, first_answer, tag, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('te_' + randomUUID().slice(0, 12), accountId, familyId,
        sectionId === 'listening' ? 'listening' : 'reading',
        null, `exam:${examId}:${sectionId}`, 'first_wrong',
        (w.q.prompt ?? `第 ${w.q.n} 题`).slice(0, 150),
        `你的答案：${givenText}；正确答案：${keyText}`,
        JSON.stringify(w.given ?? null),
        (sectionId === 'listening' ? '听力·' : '阅读·') + (groupTag || '模考'),
        'pending_review', Date.now(), Date.now())
  }
}

// ---- AI 讲评 ----

async function examDebrief(partLabel, wrongs, note) {
  if (!wrongs.length) return '全部答对——这一部分没有需要讲解的错题。保持节奏，下一部分见。'
  const lines = wrongs.slice(0, 20).map((w) => {
    const keyText = w.q.answer !== undefined ? w.q.answer : String.fromCharCode(65 + w.q.key)
    const given = w.q.answer !== undefined ? (norm(w.given) || '（空）') : (norm(w.given) === '' ? '（未作答）' : String.fromCharCode(65 + Number(w.given)))
    return `题：${w.q.prompt}\n你的答案：${given}｜正确：${keyText}\n官方解析：${w.q.explain ?? '（见复盘页）'}`
  })
  const { text } = await teacherChat([
    { role: 'system', content: '你是托福老师，正在给一位学生讲解刚交卷的一部分真题错题。只依据给出的题目、他的答案与官方解析说话；一次考试不定性稳定弱项；最多点出 1–2 个优先改进点；中文，题目引用保留英文。输出 200–400 字的连贯讲解，不要 JSON、不要 markdown 代码块。' },
    { role: 'user', content: `这是${partLabel}部分的错题（共 ${wrongs.length} 题）：\n\n${lines.join('\n\n')}${note ? `\n\n学生补充：${note}` : ''}` },
  ], { maxTokens: 900, temperature: 0.3, role: 'generate' })
  return text
}

async function examOpenFeedback(system, user) {
  const { text } = await teacherChat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 1100, temperature: 0.2, role: 'generate' })
  return text
}

function parseLoose(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(t) } catch { /* 下一招 */ }
  const m = t.match(/\{[\s\S]*\}/)
  try { return m ? JSON.parse(m[0]) : null } catch { return null }
}

// ---- 运行状态 ----

function runState(db, accountId, examId) {
  const rows = db.prepare("SELECT * FROM toefl_attempts WHERE account_id = ? AND idempotency_key LIKE ?").all(accountId, `exam:${examId}:%`)
  const sections = {}
  for (const r of rows) {
    const section = r.idempotency_key.split(':')[1]
    if (!SECTIONS.includes(section)) continue
    sections[section] = {
      attemptId: r.attempt_id, status: r.status, submittedAt: r.submitted_at,
      answers: j(r.answers), draft: r.draft, transcript: r.draft_transcript,
    }
  }
  return sections
}

// ---- 错题重训（任务3）：重做到 100% / 本人打勾结业 ----

/** familyId → 可重做的题（不带答案；grade 在服务端闭包里） */
function resolveQuestion(familyId) {
  if (familyId.startsWith('exam:')) {
    const [, examId, qKey] = familyId.split(':')
    const pack = toeflExamPack(examId)
    if (!pack) return null
    let found = null
    for (const s of ['reading', 'listening', 'writing']) {
      if (found) break
      eachQuestion(pack, s, ({ q, group, qKey: k }) => { if (k === qKey && !found) found = { q, group } })
    }
    if (!found) return null
    const isCloze = found.q.answer !== undefined
    return {
      kind: isCloze ? 'cloze' : 'mc',
      prompt: found.q.prompt,
      options: found.q.options ?? null,
      groupTitle: found.group?.title ?? null,
      keyText: isCloze ? found.q.answer : String.fromCharCode(65 + found.q.key),
      explain: found.q.explain ?? null,
      grade: (v) => (isCloze ? norm(v) === norm(found.q.answer) : Number(v) === found.q.key),
    }
  }
  for (const t of Object.values(toeflTasks())) {
    for (const q of t.questions ?? []) {
      if (q.familyId === familyId) {
        return {
          kind: 'mc', prompt: q.prompt, options: q.options, groupTitle: t.title,
          keyText: String.fromCharCode(65 + q.key), explain: q.why ?? null,
          grade: (v) => Number(v) === q.key,
        }
      }
    }
  }
  return null
}

const RETRYABLE_STATUSES = ['pending_review', 'reviewed', 'awaiting_new_check', 'disputed', 'analyze_failed']

export const EXAM_ERROR_ROUTES = [
  ['GET', '/api/toefl/accounts/:id/errors/:errorId/retry', (ctx) => {
    const db = conn(ctx.params.id)
    const row = db.prepare('SELECT * FROM toefl_errors WHERE error_id = ? AND account_id = ?').get(ctx.params.errorId, ctx.params.id)
    if (!row) throw new ApiError(404, '错题不存在')
    if (!RETRYABLE_STATUSES.includes(row.status)) throw new ApiError(409, '这条错题已结业或已验证，不需要再训练')
    const q = resolveQuestion(row.question_family_id)
    if (!q) throw new ApiError(409, '这道错题暂时无法重做（原题不在已录入的题库中）')
    return { kind: q.kind, prompt: q.prompt, options: q.options, groupTitle: q.groupTitle, streak: row.answer_streak ?? 0, retries: row.retries }
  }],

  ['POST', '/api/toefl/accounts/:id/errors/:errorId/answer', (ctx) => {
    const db = conn(ctx.params.id)
    const row = db.prepare('SELECT * FROM toefl_errors WHERE error_id = ? AND account_id = ?').get(ctx.params.errorId, ctx.params.id)
    if (!row) throw new ApiError(404, '错题不存在')
    const q = resolveQuestion(row.question_family_id)
    if (!q) throw new ApiError(409, '这道错题暂时无法重做（原题不在已录入的题库中）')
    const value = ctx.body?.value
    const ok = q.grade(value)
    if (ok) {
      db.prepare("UPDATE toefl_errors SET answer_streak = answer_streak + 1, status = CASE WHEN status = 'pending_review' THEN 'reviewed' ELSE status END, updated_at = ? WHERE error_id = ?")
        .run(Date.now(), row.error_id)
    } else {
      db.prepare("UPDATE toefl_errors SET retries = retries + 1, answer_streak = 0, updated_at = ? WHERE error_id = ?")
        .run(Date.now(), row.error_id)
    }
    const after = db.prepare('SELECT answer_streak, retries, status FROM toefl_errors WHERE error_id = ?').get(row.error_id)
    return { correct: ok, streak: after.answer_streak, retries: after.retries, status: after.status, keyText: q.keyText, explain: q.explain }
  }],

  ['POST', '/api/toefl/accounts/:id/errors/:errorId/dismiss', (ctx) => {
    const db = conn(ctx.params.id)
    const row = db.prepare('SELECT * FROM toefl_errors WHERE error_id = ? AND account_id = ?').get(ctx.params.errorId, ctx.params.id)
    if (!row) throw new ApiError(404, '错题不存在')
    if (row.status === 'verified' || row.status === 'dismissed') return { error: { errorId: row.error_id, status: row.status }, note: '已经是结业状态' }
    // 本人打勾：不再训练（保留历史，随时可恢复）
    db.prepare("UPDATE toefl_errors SET status = 'dismissed', user_response = 'dismissed_by_user', updated_at = ? WHERE error_id = ?")
      .run(Date.now(), row.error_id)
    return { error: { errorId: row.error_id, status: 'dismissed' }, note: '已标记不再训练；历史保留，随时可恢复。' }
  }],

  ['POST', '/api/toefl/accounts/:id/errors/:errorId/restore', (ctx) => {
    const db = conn(ctx.params.id)
    const row = db.prepare("SELECT * FROM toefl_errors WHERE error_id = ? AND account_id = ?").get(ctx.params.errorId, ctx.params.id)
    if (!row) throw new ApiError(404, '错题不存在')
    if (row.status !== 'dismissed') throw new ApiError(409, '只有已打勾的条目可以恢复训练')
    db.prepare("UPDATE toefl_errors SET status = 'pending_review', user_response = NULL, updated_at = ? WHERE error_id = ?")
      .run(Date.now(), row.error_id)
    return { error: { errorId: row.error_id, status: 'pending_review' } }
  }],
]

// ---- 考试路由 ----

export const EXAM_ROUTES = [
  ['GET', '/api/toefl/exam/library', () => JSON.parse(readFileSync(join(HERE, '..', 'data', 'toefl', 'exam-library.json'), 'utf8'))],

  ['GET', '/api/toefl/exam/available', () => ({
    exams: toeflExamIds().map((id) => {
      const p = toeflExamPack(id)
      return p ? { examId: id, title: p.meta.title, order: p.meta.order, status: p.meta.status, honestyNote: p.meta.honestyNote, digitization: p.meta.digitization } : null
    }).filter(Boolean),
  })],

  ['GET', '/api/toefl/accounts/:id/exam/:examId', (ctx) => {
    const pack = toeflExamPack(ctx.params.examId)
    if (!pack) throw new ApiError(404, 'TOEFL_EXAM_NOT_FOUND')
    const db = conn(ctx.params.id)
    return {
      meta: pack.meta,
      sections: Object.fromEntries(SECTIONS.map((s) => [s, pack[s] ? publicSection(pack[s], s) : null])),
      run: runState(db, ctx.params.id, ctx.params.examId),
    }
  }],

  ['POST', '/api/toefl/accounts/:id/exam/:examId/:section/submit', async (ctx) => {
    const { id: accountId, examId, section } = ctx.params
    if (!SECTIONS.includes(section)) throw new ApiError(400, '未知部分：' + section)
    const pack = toeflExamPack(examId)
    if (!pack?.[section]) throw new ApiError(404, 'TOEFL_EXAM_SECTION_NOT_FOUND')
    const db = conn(accountId)
    const idem = `exam:${examId}:${section}`
    const body = ctx.body ?? {}
    // 完整性守卫必须先于任何落库：400 的提交绝不能留下"已交卷"的空记录（否则重放会锁死空答案）
    if (section === 'reading' || section === 'listening') {
      const ans = body.answers ?? {}
      const missing = []
      eachQuestion(pack, section, ({ q, qKey }) => { if (ans[qKey] === undefined || ans[qKey] === '') missing.push(qKey) })
      if (missing.length) throw new ApiError(400, `TOEFL_INCOMPLETE_SUBMISSION: 还有 ${missing.length} 题未作答，先答完再交卷`)
    }

    const existing = db.prepare('SELECT * FROM toefl_attempts WHERE account_id = ? AND idempotency_key = ?').get(accountId, idem)
    if (existing?.submitted_at) {
      // 幂等重放：已交卷的部分不重复判分、不重复生成 AI 讲评；重算封闭题结果供回看
      if (section === 'reading' || section === 'listening') {
        const { results, correct, total } = gradeClosed(pack, section, j(existing.answers) ?? {})
        return { attemptId: existing.attempt_id, replayed: true, score: { correct, total }, results, debrief: '（本部分已交卷，讲评以首次为准。）', wrongCount: results.filter((r) => !r.correct).length }
      }
      return { attemptId: existing.attempt_id, replayed: true, note: '本部分已交卷；反馈以首次为准。' }
    }

    const attemptId = existing?.attempt_id ?? ('te_x_' + randomUUID().slice(0, 12))
    if (!existing) {
      db.prepare(`INSERT INTO toefl_attempts
        (attempt_id, account_id, idempotency_key, part, chapter_id, task_id, mode, status, answers, draft, draft_transcript, created_at, submitted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(attemptId, accountId, idem, section, `exam:${examId}`, `exam:${examId}:${section}`, 'exam',
          'submitted', JSON.stringify(body.answers ?? {}), str(body.drafts?.email, 20000) || null, str(body.transcripts?.interview, 12000) || null,
          Date.now(), Date.now())
    } else {
      db.prepare("UPDATE toefl_attempts SET status='submitted', answers=?, draft=?, draft_transcript=?, submitted_at=? WHERE attempt_id=?")
        .run(JSON.stringify(body.answers ?? {}), str(body.drafts?.email, 20000) || null, str(body.transcripts?.interview, 12000) || null, Date.now(), attemptId)
    }

    if (section === 'reading' || section === 'listening') {
      const ans = body.answers ?? {}
      const { results, correct, total, wrongs } = gradeClosed(pack, section, ans)
      registerExamErrors(db, accountId, examId, section, wrongs)
      let debrief
      try { debrief = await examDebrief(pack[section].label, wrongs, str(body.note, 500) || null) } catch (e) {
        debrief = 'AI 讲评暂时没生成出来（' + String(e?.message ?? e).slice(0, 80) + '）；每题的官方解析仍然可用。'
      }
      // 听力交卷后回带转写稿（首听无稿 → 复盘可对照）
      const transcripts = {}
      if (section === 'listening') {
        for (const m of pack.listening.modules) for (const g of m.groups) if (g.transcript) transcripts[g.title] = g.transcript
      }
      return { attemptId, replayed: false, score: { correct, total }, results, debrief, wrongCount: wrongs.length, transcripts }
    }

    if (section === 'writing') {
      const tasks = pack.writing.tasks
      const feedbacks = []
      const bs = tasks.find((t) => t.type === 'build_sentence')
      if (bs) {
        const items = body.answers?.['build-sentence'] ?? {}
        const list = bs.items.map((it) => `题干：${it.prompt}\n词块：${it.chunks.join(' / ')}\n官方参考句：${it.answer}\n他的句子：${str(items[String(it.n)] ?? items[it.n], 300) || '（空）'}`).join('\n\n')
        try {
          const text = await examOpenFeedback(
            '你是托福写作老师。学生在"Build a Sentence"题中用给定词块组句。逐题判定：句子语法正确且意思贴合题干即算对（词序合理即可，不要求与官方参考句逐词相同；未用完词块或改动词形算错；未作答=错）。输出 JSON：{"items":[{"n":1,"correct":true,"note":"一句话说明"}],"summary":"总体一段话"}。',
            list)
          feedbacks.push({ taskType: 'build_sentence', output: parseLoose(text) ?? { raw: text } })
        } catch (e) { feedbacks.push({ taskType: 'build_sentence', error: String(e?.message ?? e).slice(0, 140) }) }
      }
      const email = tasks.find((t) => t.type === 'email')
      if (email) {
        try {
          const text = await examOpenFeedback(
            '你是托福写作老师，批改一封 7 分钟限时英文邮件。按题目要求逐条检查（漏了哪条要点要明确指出）、再看语气与语法。引用他的原句；给出一个优先修改；不提供分数。中文讲解，引用保留英文。',
            `题目情境：${email.situation}\n要求：\n${email.requirements.map((r) => '- ' + r).join('\n')}\n收件人：${email.to}｜主题：${email.subject}\n\n他的邮件：\n${str(body.drafts?.email, 12000) || '（未作答）'}`)
          feedbacks.push({ taskType: 'email', output: text })
        } catch (e) { feedbacks.push({ taskType: 'email', error: String(e?.message ?? e).slice(0, 140) }) }
      }
      const disc = tasks.find((t) => t.type === 'academic_discussion')
      if (disc) {
        try {
          const text = await examOpenFeedback(
            '你是托福写作老师，批改一篇 10 分钟学术讨论回帖。检查：是否回应教授问题、是否有自己的贡献（而不是复述同学）、理由是否有支撑、是否达到约 100 词。引用他的原句；给出一个优先修改；不提供分数。中文讲解，引用保留英文。',
            `教授的问题：${disc.professorPrompt}\n同学A说：${disc.classmates[0].text}\n同学B说：${disc.classmates[1].text}\n\n他的回帖：\n${str(body.drafts?.discussion, 12000) || '（未作答）'}`)
          feedbacks.push({ taskType: 'academic_discussion', output: text })
        } catch (e) { feedbacks.push({ taskType: 'academic_discussion', error: String(e?.message ?? e).slice(0, 140) }) }
      }
      return { attemptId, replayed: false, feedbacks, note: '写作为开放题：无对错计数，AI 反馈为辅助意见（评分要点在任务说明里）。' }
    }

    // speaking
    const transcripts = body.transcripts ?? {}
    const interviewText = ['1', '2', '3', '4']
      .map((n) => (transcripts['interview-' + n] ? `问${n}：${str(transcripts['interview-' + n], 2000)}` : null))
      .filter(Boolean).join('\n\n')
    let debrief
    if (interviewText) {
      try {
        debrief = await examOpenFeedback(
          '你是托福口语老师。这是"Take an Interview"4 个问题的转写（本人自录自校，可能有不准确处）。逐问检查：是否先直接回应、有没有与自己有关的具体细节、听者能否跟上；点出 1–2 个优先改进；系统无发音声学分析，不要评价发音，可建议回听录音对照。中文讲解，转写引用保留英文。',
          interviewText)
      } catch (e) { debrief = 'AI 讲评暂时没生成出来（' + String(e?.message ?? e).slice(0, 80) + '）。' }
    } else {
      debrief = '没有收到面试题的文字稿——录音已保存可回放自评；想老师讲评请在错题复盘里补录文字稿。'
    }
    return {
      attemptId, replayed: false, debrief,
      repeatTips: pack.speaking.tasks[0].items.map((i) => ({ n: i.n, text: i.text, tip: i.tip })),
      note: '口语无自动评分：跟读请对照转写自检漏词/变词；录音已保存可回放。',
    }
  }],
]
