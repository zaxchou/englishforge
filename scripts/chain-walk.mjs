// 40 号验收走查 v2：**真实规划器 + 真实入口**（不再改 served_lesson_id 制造链路）。
// 流程：真实诊断 → 循环{ 取当前 plan → 有课就走课（真实 UI 点击）→ 完成；无课看备用任务
// 卡（打开→走完→完成）；两者皆无 → 诚实空态（生成入口可见）}。
// 断言的不变量：已完成课不再被推；备用卡有理由且能走完；走查报告**实际经过的课程**；
// 只有 C1 与 C2 都真实走过才打印"全链成功"，否则如实打印跳过与原因。
// 自有临时库，不碰真实数据；不调用收费模型（生成开关关闭）。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'ef-chain-walk2-'))
const dbPath = join(dir, 'walk.db')
const port = 5201
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

// 开放题/理由栏回答（不认识的题给通用句——判为失败也算反馈，可继续完成）
const TEXT_OK = {
  g3c_principle_pick: '这句话只是对照：地图按设计正常工作，不完整的是团队对访客想要什么的预期。',
  g3c_rehearsal_locate: '团队保留了手势控制，推迟了语音控制——限制是先在展厅实测再决定，不是永久放弃。',
  g3c_paraphrase_recover: '我们留下了手势控制，语音先缓一缓——先在展厅让人多的时候试过再决定，不是永久放弃。',
  g3c_write_limit: '语音当时失灵是因为人多、好几个观众同时说话；所以先推迟到展厅测过再定。这只是先测再定，不代表语音方案不行。',
  g3c_film_transfer: '第一句只是对照（小房间好用、大厅难跟上）；第二句只是推迟配音测试，不是影片不行。',
  g4c_claim_limit_slots: '地图没坏，是团队对访客想要什么的预期不完整。',
  g4c_recap_write: '地图一直按设计在运行；不完整的是我们对访客想要什么的假设。下一步先去问访客为什么这样选路线，再决定要不要改。',
  m1_projector_locate: 'A 的 which 是补充（去掉不影响所指）；B 的 which 指"在展览中停摆"这件事，在说明后果。',
  m1_transfer_write: '去掉 who 部分，句子指的还是那位助手——所以是补充信息：她是五月来的。说话人已经确定是哪位助手。',
  // 43 号听力/口头链（开放题；听后选择题的 accept 从注册表自动取）
  l1e_oral_respond: 'I agree with the change, as long as reminders come back before exam week.',
  o1a_schedule_decision: "We're moving the stand-up to Saturday morning because Wednesday evenings conflict with class. If someone can't come, we will record it and share notes.",
  o1b_followup_reply: "OK, good point. He can watch the recording and add notes async — he's still in, we are not cancelling him.",
  les_l1_sensor_read: '出问题的是实验室里看起来准、在舞台灯下不稳的那颗传感器；现在还可以继续在室内测试用它；但在公开活动前的灯光环境检查之前，先不安装到现场——这不是永久禁用。',
  rep_film_postpone_read: '我们保留了视觉序列，推迟了配音测试；同一部片在小放映室里好看，到吵闹的大堂就难跟上；不能因此推出影片本身差。',
  les_l2b_museum_transcript: 'that tells visitors 修饰 map；because 解释游客走向拥挤展厅的动机；but 对照"地图按设计工作"与"假设不完整"。',
  les_l3_followup: 'A shorter route is not always better: several new students found the instructions hard to follow, so we will revise the instructions before recommending the app.',
}
const DIAG = {
  D1: '他们做了一个展览。',
  D1b: '工具在小房间安静的时候可用，在吵闹的大房间失败。',
  D2: 'AI 助手很有用，能帮助设计项目找灵感。',
  D2b: '这个工具可以帮我们找论文，但使用前必须自己读来源核查；摘要漏掉了原论文的重要限制。',
  D3: '它能帮我们找到值得读的论文，但摘要可能漏掉原文的重要限制，所以使用前必须自己读。我的项目会用它找材料，但会核查来源。',
}

try {
  const { chromium } = await import(process.env.EF_PLAYWRIGHT_IMPORT || 'playwright')
  server = spawn(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: repo, env: { ...process.env, ENGLISHFORGE_DB: dbPath, ENGLISHFORGE_V4_GENERATION: '0', ENGLISHFORGE_V4_AI_GRADER: '0', ENGLISHFORGE_TLS_KEY: '', ENGLISHFORGE_TLS_CERT: '' }, windowsHide: true })
  server.stdout.on('data', (b) => { logs += b })
  server.stderr.on('data', (b) => { logs += b })
  let health
  for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw Error(`server failed ${logs}`); try { health = await api('/api/health'); break } catch { await pause(250) } }
  if (!health || health.path !== dbPath) throw Error('REFUSE_NONISOLATED_DATABASE')
  const id = (health.accounts[0] ?? (await api('/api/accounts', { name: 'chain-walk2' })).account).id
  // 真实入口诊断（与界面同 API）：真实规划器从这里开始接管
  let d = await api(`/api/v1/accounts/${id}/diagnostics`, { requestId: 'walk2-diag' })
  for (let i = 0; d.status === 'open' && i < 8; i++) {
    const a = d.activity
    if (!a) throw Error('diagnostic missing activity')
    if (a.audio) {
      const delivery = await api(`/api/v1/accounts/${id}/tasks/${a.taskId}/media/${a.audio.mediaId}`)
      await api(`/api/v1/accounts/${id}/support/play`, { taskId: a.taskId, deliveryId: delivery.deliveryId, eventId: crypto.randomUUID(), activityId: a.activityId, mediaId: a.audio.mediaId })
    }
    const r = await api(`/api/v1/accounts/${id}/attempts`, {
      attemptId: `w2-${d.step}-${i}`, sessionId: d.diagnosticId, taskId: a.taskId, activityId: a.activityId,
      response: { kind: 'text', text: DIAG[d.step] ?? '' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: d.step === 'D2b', playCount: a.audio ? 2 : 0, lookupUsed: false, responseMode: 'typed_summary' },
    })
    d = r.diagnostic
  }
  if (d.status !== 'completed') throw Error('DIAGNOSTIC_GUARD_EXHAUSTED')

  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  const page = await browser.newPage({ permissions: ['microphone'], viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(12000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base)
  await page.getByRole('button', { name: '学习路径', exact: true }).click()
  await page.getByText('学习路径 · 今天与下一步', { exact: true }).waitFor()

  const walked = []
  let claimExercised = false, revealExercised = false, fallbackCardSeen = false

  // 提交当前活动（slots/open/oral），并顺带验证申诉按钮与揭晓面板（各一次）
  async function submitCurrent(act, pkg, viaFallbackLessonId) {
    const area = page.locator('.v4-act')
    const reg = regById(act.activityId)
    const slots = reg?.evaluationContract?.slots
    if (act.audio) {
      await area.locator('audio').waitFor()
      const played = page.waitForResponse((r) => r.url().includes('/support/play') && r.request().method() === 'POST')
      await area.locator('audio').evaluate((el) => el.play())
      if ((await played).status() !== 200) throw Error('play rejected')
    }
    if (act.oralTask) {
      await area.getByRole('button', { name: /开始录音/ }).click()
      await pause(1100)
      await area.getByRole('button', { name: /停止录音/ }).click()
      await area.getByRole('button', { name: '提交口语作答', exact: true }).waitFor()
    } else if (slots) {
      for (const s of slots) await area.locator('.v4-slot', { hasText: s.prompt }).getByRole('button', { name: s.accept, exact: true }).click()
      if (reg?.evaluationContract?.reason) {
        const ta = area.locator('.v4-slots textarea')
        if (await ta.count()) await ta.fill(TEXT_OK[act.activityId] ?? '理由：按材料里的对照和限制说的。')
      }
    } else {
      await area.locator('textarea').first().fill(TEXT_OK[act.activityId] ?? '按材料回答：先说结论，再说限制；没有划范围就如实说。')
    }
    const resp = page.waitForResponse((r) => r.url().includes(`/accounts/${id}/attempts`) && r.request().method() === 'POST')
    await area.getByRole('button', { name: act.oralTask ? '提交口语作答' : '提交', exact: true }).click()
    if ((await resp).status() !== 200) throw Error(`attempt rejected at ${act.activityId}`)
    await pause(250)
    if (!claimExercised && !act.oralTask && !slots) {
      const claimBtn = area.getByRole('button', { name: /我觉得我说得对/ })
      if (await claimBtn.count()) {
        await claimBtn.click()
        await page.getByText('已记下', { exact: false }).waitFor()
        claimExercised = true
      }
    }
    if (!revealExercised) {
      const reveal = page.getByText('看看参考说法', { exact: false })
      if (await reveal.count()) {
        await reveal.first().click()
        await page.getByText('可以这样说：', { exact: false }).waitFor()
        await page.getByText(/开放追问/).first().waitFor()
        revealExercised = true
      }
    }
    const lessonId = viaFallbackLessonId ?? pkg.lessonId
    return api(`/api/v1/accounts/${id}/lessons/${lessonId}`)
  }

  async function walkAllActivities(lessonId) {
    let pkg = await api(`/api/v1/accounts/${id}/lessons/${lessonId}`)
    await page.getByRole('heading', { name: pkg.title, exact: true }).waitFor({ timeout: 15000 })
    for (let step = 0; step < 8; step++) {
      const act = pkg.activities.find((x) => !x.resume)
      if (!act) break
      pkg = await submitCurrent(act, pkg, lessonId)
      if (pkg.activities.some((x) => !x.resume)) await page.getByRole('button', { name: '下一步', exact: true }).click()
      await pause(200)
    }
    if (pkg.activities.some((x) => !x.resume)) throw Error(`STEP_GUARD_EXHAUSTED at ${lessonId}`)
    await page.getByRole('button', { name: '完成这一课', exact: true }).click()
    await page.getByRole('button', { name: '看下一步学什么', exact: true }).click()
    await pause(500)
  }

  for (let step = 1; step <= 14; step++) {
    const plan = (await api(`/api/v1/accounts/${id}/plan`)).decision
    if (!plan) throw Error('no plan after diagnostic')
    if (plan.lesson?.lessonId) {
      if (walked.includes(plan.lesson.lessonId)) throw Error(`已完成课被复推：${plan.lesson.lessonId}`)
      console.log(`第 ${step} 步 · 主推荐课 ${plan.lesson.lessonId}（主目标 ${plan.primaryGoal}）`)
      await page.getByRole('button', { name: /^(开始训练|继续上一段)$/ }).click()
      await walkAllActivities(plan.lesson.lessonId)
      walked.push(plan.lesson.lessonId)
      continue
    }
    if (plan.fallback) {
      fallbackCardSeen = true
      // 备用卡必须真实显示在今日页（40-P1 的真实入口）
      await page.getByText('先练这个也行', { exact: false }).waitFor()
      await page.getByText(plan.fallback.title, { exact: false }).first().waitFor()
      console.log(`第 ${step} 步 · 主目标 ${plan.primaryGoal} 无课 → 备用任务 ${plan.fallback.lessonId}（理由：${String(plan.fallback.reason).slice(0, 36)}…）`)
      await page.getByRole('button', { name: '打开备用任务', exact: true }).click()
      await walkAllActivities(plan.fallback.lessonId)
      walked.push(plan.fallback.lessonId)
      continue
    }
    // 无课也无备用：诚实空态——生成入口必须可见（不要求真的付费生成）
    if (!(await page.getByRole('button', { name: /让 AI 现在做一课/ }).count())) {
      throw Error(`第 ${step} 步：无课、无备用、无生成入口（死角）`)
    }
    console.log(`第 ${step} 步 · 主目标 ${plan.primaryGoal} 无课无备用 → 诚实空态（生成入口可见）`)
    break
  }

  console.log(`实际经过的课程（${walked.length}）：${walked.join(' → ') || '（无）'}`)
  const c1Walked = walked.includes('les-claim-limit-c1')
  const c2Walked = walked.includes('les-claim-limit-c2')
  if (!fallbackCardSeen) throw Error('整个走查没出现一次备用任务卡（40-P1 入口未验证）')
  if (!claimExercised) throw Error('表达申诉按钮没有被验证到')
  if (!revealExercised) throw Error('提交后揭晓面板没有被验证到')
  if (c1Walked && c2Walked) {
    console.log('CHAIN_WALK_OK：真实规划器 + 真实入口走完整链（C1→C2 都实际经过）；申诉与揭晓面板已验证')
  } else {
    console.log(`CHAIN_WALK_PARTIAL：C1 ${c1Walked ? '已走' : '未经过'}，C2 ${c2Walked ? '已走' : '未经过（如实跳过）'}——不声称全链成功`)
    process.exit(1)
  }
  if (errors.length) throw Error('pageerror: ' + errors.join(' | '))
} finally {
  try { await browser?.close() } catch {}
  try { server?.kill() } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
}
