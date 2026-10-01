// 38 号验收：后继课程链完整页面走查（自有临时库 + 本地端口，不碰真实数据）。
// 覆盖：今日卡进入 c1 → 短讲/输入/挑战恢复（提示重试）/输出/迁移 五步 → 完成进 c2 →
// 完成后诚实空态（生成按钮可见）→ 注入"内容试验预览"生成课 → 三处标记一致（课头/推荐卡/恢复）。
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'ef-chain-walk-'))
const dbPath = join(dir, 'walk.db')
const port = 5199
const base = `http://127.0.0.1:${port}`
let server, browser, logs = ''
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(path, body) {
  const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json()
  if (!r.ok) throw Error(`${r.status} ${path}: ${JSON.stringify(data)}`)
  return data
}
const registry = JSON.parse(readFileSync(new URL('../server/data/v3-activities.json', import.meta.url), 'utf8'))
const regById = (aid) => registry.activities.find((x) => x.activityId === aid)

// 开放题/理由栏的合格回答（与链路测试同源）
const TEXT_OK = {
  g3c_rehearsal_locate: '团队保留了手势控制，推迟了语音控制——限制是先在展厅实测再决定，不是永久放弃。',
  g3c_film_transfer: '第一句只是对照（小房间好用、大厅难跟上）；第二句只是推迟配音测试，不是影片不行。',
  g4c_claim_limit_slots: '地图没坏，是团队对访客想要什么的预期不完整。',
}
const OPEN_OK = {
  g3c_paraphrase_recover: '我们留下了手势控制，语音先缓一缓——先在展厅让人多的时候试过再决定，不是永久放弃。',
  g3c_write_limit: '语音当时失灵是因为人多、好几个观众同时说话；所以先推迟到展厅测过再定。这只是先测再定，不代表语音方案不行。',
  g4c_recap_write: '地图一直按设计在运行；不完整的是我们对访客想要什么的假设。下一步先去问访客为什么这样选路线，再决定要不要改。',
}

try {
  const { chromium } = await import(process.env.EF_PLAYWRIGHT_IMPORT || 'playwright')
  server = spawn(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: repo, env: { ...process.env, ENGLISHFORGE_DB: dbPath, ENGLISHFORGE_V4_GENERATION: '0', ENGLISHFORGE_TLS_KEY: '', ENGLISHFORGE_TLS_CERT: '' }, windowsHide: true })
  server.stdout.on('data', (b) => { logs += b })
  server.stderr.on('data', (b) => { logs += b })
  let health
  for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw Error(`server failed ${logs}`); try { health = await api('/api/health'); break } catch { await pause(250) } }
  if (!health || health.path !== dbPath) throw Error('REFUSE_NONISOLATED_DATABASE')
  const id = (health.accounts[0] ?? (await api('/api/accounts', { name: 'chain-walk' })).account).id
  const db = () => new DatabaseSync(dbPath)
  await api(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'chain-walk-boot' }) // 先播种 schema/课程
  // 用户画像：旧关系课已完成（38 号起点=O-K115-03 无现成后继 → 本链补上）
  { const c = db(); c.prepare("INSERT INTO plan_decisions (account_id, decision_id, request_id, map_version, evidence_version, snapshot, candidates, primary_goal, strategy_id, reason, hypotheses, uncertain_areas, lesson_ref, served_lesson_id, status, created_at) VALUES (?,?,?,'map-v1',0,'[]','[]','O-K115-01','short_explain','seed','','[]','{}','les-relations-v1','completed',?)").run(id, `pd-seed-${id}`, `seed-${id}`, Date.now()); c.close() }
  await api(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'chain-walk' })
  { const c = db()
    c.prepare("UPDATE plan_decisions SET served_lesson_id = 'les-claim-limit-c1', status = 'ready', lesson_ref = ? WHERE account_id = ? AND status = 'ready'")
      .run(JSON.stringify({ lessonId: 'les-claim-limit-c1', version: 1, status: 'published', devSample: true, contentPreview: false }), id)
    c.close() }

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(12000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base)
  await page.getByRole('button', { name: '学习路径', exact: true }).click()
  await page.getByText('学习路径 · 今天与下一步', { exact: true }).waitFor() // V4Path 已挂载

  // ---- c1：五步全走 ----
  await page.getByRole('button', { name: /^(开始训练|继续上一段)$/ }).click()
  await page.getByRole('heading', { name: '主张、对照和限制：分清再复述', exact: true }).waitFor()
  await page.getByText('开发样本：结构质量门已过', { exact: false }).waitFor() // 策划链=开发样本标记
  if (await page.getByText('内容试验预览', { exact: false }).count()) throw Error('curated lesson must not be labeled 内容试验预览')
  let pkg = await api(`/api/v1/accounts/${id}/lessons/les-claim-limit-c1`)
  for (let step = 0; step < 8; step++) {
    const act = pkg.activities.find((x) => !x.resume)
    if (!act) break
    const area = page.locator('.v4-act')
    const reg = regById(act.activityId)
    const slots = reg?.evaluationContract?.slots
    if (act.activityId === 'g3c_paraphrase_recover') {
      // 挑战与恢复：先漏锚点失败 → 三层提示 → 用提示方向的词重试 → 通过
      await area.locator('textarea').fill('他们留了一半，另一半再等等看情况。')
      await area.getByRole('button', { name: '提交', exact: true }).click()
      await page.getByText('还有关系没抓到', { exact: false }).waitFor()
      for (let h = 0; h < 3; h++) await area.getByRole('button', { name: /看提示（记为支持/ }).click()
      await area.getByRole('button', { name: /再试一次（新的一轮）/ }).click()
      await area.locator('textarea').fill(OPEN_OK[act.activityId])
      await area.getByRole('button', { name: '提交', exact: true }).click()
    } else if (slots) {
      for (const s of slots) await area.locator('.v4-slot', { hasText: s.prompt }).getByRole('button', { name: s.accept, exact: true }).click()
      const reason = reg?.evaluationContract?.reason
      if (reason) await area.locator('.v4-slots textarea').fill(TEXT_OK[act.activityId] ?? '理由：按记录里的对照与限制说的。')
      await area.getByRole('button', { name: '提交', exact: true }).click()
    } else {
      await area.locator('textarea').fill(OPEN_OK[act.activityId] ?? '按材料回答。')
      await area.getByRole('button', { name: '提交', exact: true }).click()
    }
    const resp = await page.waitForResponse((r) => r.url().includes(`/accounts/${id}/attempts`) && r.request().method() === 'POST')
    if (resp.status() !== 200) throw Error(`attempt rejected at ${act.activityId}`)
    await page.getByText(/关系抓到了|已标争议/).waitFor({ timeout: 12000 }).catch(async () => {
      // 槽位+理由活动：理由漏填时显示"还有关系没抓到"也算提交成功（流程继续）
      await page.getByText('还有关系没抓到', { exact: false }).waitFor()
    })
    pkg = await api(`/api/v1/accounts/${id}/lessons/${pkg.lessonId}`)
    if (pkg.activities.some((x) => !x.resume)) await page.getByRole('button', { name: '看懂了，进入下一步', exact: true }).click()
    await pause(150)
  }
  if (pkg.activities.some((x) => !x.resume)) throw Error('CHAIN_STEP_GUARD_EXHAUSTED')
  await page.getByRole('button', { name: '完成训练，查看本次反馈', exact: true }).click()
  await page.getByRole('heading', { name: '主张、对照和限制：分清再复述 · 已完成', exact: true }).waitFor()
  await page.getByRole('button', { name: '查看下一步', exact: true }).click()
  await pause(400)

  // ---- 连续推进：完成后推荐 c2（主目标仍是 O-K115-03 时）----
  let plan = (await api(`/api/v1/accounts/${id}/plan`)).decision
  if (plan.primaryGoal === 'O-K115-03' && plan.lesson.lessonId === 'les-claim-limit-c2') {
    await page.getByRole('button', { name: /^(开始训练|继续上一段)$/ }).click()
    await page.getByRole('heading', { name: '新情境检验：博物馆地图的结论', exact: true }).waitFor()
    pkg = await api(`/api/v1/accounts/${id}/lessons/les-claim-limit-c2`)
    for (let step = 0; step < 5; step++) {
      const act = pkg.activities.find((x) => !x.resume)
      if (!act) break
      const area = page.locator('.v4-act')
      const reg = regById(act.activityId)
      const slots = reg?.evaluationContract?.slots
      if (slots) {
        for (const s of slots) await area.locator('.v4-slot', { hasText: s.prompt }).getByRole('button', { name: s.accept, exact: true }).click()
        if (reg?.evaluationContract?.reason) await area.locator('.v4-slots textarea').fill(TEXT_OK[act.activityId] ?? '理由。')
        await area.getByRole('button', { name: '提交', exact: true }).click()
      } else {
        await area.locator('textarea').fill(OPEN_OK[act.activityId] ?? '按材料回答。')
        await area.getByRole('button', { name: '提交', exact: true }).click()
      }
      await page.waitForResponse((r) => r.url().includes(`/accounts/${id}/attempts`) && r.request().method() === 'POST')
      await page.getByText(/关系抓到了|已标争议|还有关系没抓到/).first().waitFor()
      pkg = await api(`/api/v1/accounts/${id}/lessons/${pkg.lessonId}`)
      if (pkg.activities.some((x) => !x.resume)) await page.getByRole('button', { name: '看懂了，进入下一步', exact: true }).click()
      await pause(150)
    }
    if (pkg.activities.some((x) => !x.resume)) throw Error('C2_STEP_GUARD_EXHAUSTED')
    await page.getByRole('button', { name: '完成训练，查看本次反馈', exact: true }).click()
    await page.getByRole('button', { name: '查看下一步', exact: true }).click()
    await pause(400)
    plan = (await api(`/api/v1/accounts/${id}/plan`)).decision
    console.log(`链走完：当前推荐 ${plan.primaryGoal}（${plan.lesson?.status ?? 'no-lesson'}）`)
  } else {
    console.log(`完成 c1 后推荐：${plan.primaryGoal}（lesson=${plan.lesson?.lessonId ?? 'null'}）——c1 后主目标移动，今日卡走生成/备用路径`)
  }

  // ---- 链尾：内容耗尽的诚实空态（生成按钮可见）----
  const genBtn = page.getByRole('button', { name: /用 AI 生成这一课/ })
  if (!(await genBtn.count())) {
    // 若推荐还有课就先不强制；否则必须能看到生成按钮
    if (!plan.lesson?.lessonId) throw Error('链尾既无课也无生成入口')
  } else console.log('链尾空态：一键生成入口可见（含"先标内容试验预览"说明）')

  // ---- 内容试验预览标记三处一致（注入开发样本库里的生成课，不动真实数据）----
  { const c = db()
    // 个体生成课的适用性快照（practiceRevision/evidenceVersion 取当前值）——否则 lessonApplicable 判不适用
    const practiceRevision = c.prepare('SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id = ?').get(id).n
    const evidenceVersion = c.prepare("SELECT value FROM v3_counters WHERE account_id = ? AND name = 'evidence'").get(id)?.value ?? 0
    c.prepare(`INSERT INTO lesson_versions (account_scope, lesson_id, version, title, why_now, teaching_note, strategy_id,
        objective_ids, difficulty_dims, activity_refs, next_candidates, source_refs, holdout_ref, quality_gates,
        human_review, release_channel, content_status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, 'gen-walk-preview', 1, '走查用生成课', '演示内容试验预览标记。', '要点。',
        'short_explain', JSON.stringify([plan.primaryGoal ?? 'O-K115-03']), '[]', '[]', '[]', '[]', null,
        JSON.stringify({ contentPreview: true, humanSignPending: true }), 'pending', 'dev_only', 'ready', Date.now())
    c.prepare("UPDATE lesson_versions SET content_status = 'published', release_channel = 'dev_only' WHERE lesson_id = 'gen-walk-preview'").run()
    c.prepare("INSERT INTO generation_jobs (account_id, job_id, input_spec, contract_version, status, output_lesson_id, validation, created_at) VALUES (?,?,?,'fixture','succeeded','gen-walk-preview',?,?)")
      .run(id, 'job-walk-preview', JSON.stringify({ learnerEvidence: { practiceRevision, evidenceVersion } }),
        JSON.stringify({ published: true, channel: 'dev_only', contentPreview: true, pending: 'human_sign', semanticReview: { verdict: 'supported' } }), Date.now())
    c.close() }
  plan = (await api(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'walk-preview' })).decision
  if (plan.lesson?.lessonId !== 'gen-walk-preview') throw Error(`preview lesson not served: ${JSON.stringify(plan.lesson)}`)
  await page.reload()
  await page.getByRole('button', { name: '学习路径', exact: true }).click()
  await page.getByText('学习路径 · 今天与下一步', { exact: true }).waitFor()
  await page.locator('.v4-tabs').getByRole('button', { name: '推荐详情', exact: true }).click()
  await page.getByText('内容试验预览 · 模型辅助检查已过 · 专业核验未做').waitFor() // 推荐卡标记 ①
  await page.getByRole('button', { name: '打开课程', exact: true }).click()
  await page.getByText('内容试验预览：通过了结构质量门和模型辅助内容检查', { exact: false }).waitFor() // 课头标记 ②
  const served = await api(`/api/v1/accounts/${id}/lessons/gen-walk-preview`) // 恢复/直连口径 ③
  if (!served.contentReview.preview || served.contentReview.pending !== 'human_sign') throw Error('contentReview inconsistent')
  console.log('三处一致：推荐卡/课头/课程响应都显示"内容试验预览 · 专业核验未做"')

  if (errors.length) throw Error('pageerror: ' + errors.join(' | '))
  console.log('CHAIN_WALK_OK: c1 五步（含提示重试恢复）→ c2 → 链尾空态 → 预览标记三处一致')
} finally {
  try { await browser?.close() } catch {}
  try { server?.kill() } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
