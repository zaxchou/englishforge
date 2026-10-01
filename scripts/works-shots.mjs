// 49 号验收素材：成长作品页同视口截图（自有临时库，真实规划器走课产生真实配对）。
// 产出 docs/curriculum-v4/design-review-2026-10-02/zcode-49/*.png：
//   growth-light.png（有配对，1280×900 亮色）/ growth-empty.png（零作品）/
//   growth-dark.png（暗色同结构）/ growth-mobile.png（390 宽）
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'ef-works-shot-'))
const dbPath = join(dir, 'walk.db')
const port = 5205
const base = `http://127.0.0.1:${port}`
const outDir = join(repo, 'docs', 'curriculum-v4', 'design-review-2026-10-02', 'zcode-49')
mkdirSync(outDir, { recursive: true })
let server, browser, logs = ''
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(path, body) {
  const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json()
  if (!r.ok) throw Error(`${r.status} ${path}: ${JSON.stringify(data)}`)
  return data
}
const registry = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../server/data/v3-activities.json', import.meta.url), 'utf8'))
const regById = (aid) => registry.activities.find((x) => x.activityId === aid)
const TEXT_OK = {
  les_l1_sensor_read: '出问题的是实验室里看起来准、在舞台灯下不稳的那颗传感器；现在还可以继续在室内测试用它；先不安装到公开活动现场——这不是永久禁用。',
  rep_film_postpone_read: '我们保留了视觉序列，推迟了配音测试；小放映室好看、大堂难跟上，不能推出影片差。',
}
const DIAG = { D1: '他们做了一个展览。', D1b: '工具在小房间安静的时候可用，在吵闹的大房间失败。', D2: 'AI 助手很有用。', D2b: '但使用前必须自己读来源核查；摘要漏掉了原论文的重要限制。', D3: '它能帮我们找到论文，但摘要可能漏掉限制，所以使用前必须自己读。' }

try {
  const { chromium } = await import(process.env.EF_PLAYWRIGHT_IMPORT || 'playwright')
  server = spawn(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: repo, env: { ...process.env, ENGLISHFORGE_DB: dbPath, ENGLISHFORGE_V4_GENERATION: '0', ENGLISHFORGE_V4_AI_GRADER: '0', ENGLISHFORGE_TLS_KEY: '', ENGLISHFORGE_TLS_CERT: '' }, windowsHide: true })
  server.stdout.on('data', (b) => { logs += b }); server.stderr.on('data', (b) => { logs += b })
  let health
  for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw Error(`server failed ${logs}`); try { health = await api('/api/health'); break } catch { await pause(250) } }
  if (!health || health.path !== dbPath) throw Error('REFUSE_NONISOLATED_DATABASE')
  const id = (health.accounts[0] ?? (await api('/api/accounts', { name: 'works-shot' })).account).id
  let d = await api(`/api/v1/accounts/${id}/diagnostics`, { requestId: 'ws-diag' })
  for (let i = 0; d.status === 'open' && i < 8; i++) {
    const a = d.activity
    if (a.audio) { const dl = await api(`/api/v1/accounts/${id}/tasks/${a.taskId}/media/${a.audio.mediaId}`); await api(`/api/v1/accounts/${id}/support/play`, { taskId: a.taskId, deliveryId: dl.deliveryId, eventId: crypto.randomUUID(), activityId: a.activityId, mediaId: a.audio.mediaId }) }
    d = (await api(`/api/v1/accounts/${id}/attempts`, { attemptId: `ws-${d.step}`, sessionId: d.diagnosticId, taskId: a.taskId, activityId: a.activityId, response: { kind: 'text', text: DIAG[d.step] ?? '' }, conditions: { firstExposure: true, hintLevel: 0, transcriptShown: d.step === 'D2b', playCount: a.audio ? 2 : 0, lookupUsed: false, responseMode: 'typed_summary' } })).diagnostic
  }
  // 真实完成第一课，第一题先"需要提示"再独立通过（产生真实配对）
  const plan = (await api(`/api/v1/accounts/${id}/plan`)).decision
  const lessonId = plan.lesson.lessonId
  let pkg = await api(`/api/v1/accounts/${id}/lessons/${lessonId}`)
  const first = pkg.activities[0]
  const slots = regById(first.activityId)?.evaluationContract?.slots
  if (slots) {
    for (const s of slots) { /* 先答错一轮（模拟需要帮助） */ }
  }
  const mkAttempt = (act, tag, hintLevel, overrideAnswers) => api(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `ws-${lessonId}-${act.activityId}-${tag}`, taskId: act.taskId, activityId: act.activityId,
    response: slots ? { kind: 'choice', text: '', answers: overrideAnswers ?? Object.fromEntries(slots.map((s) => [s.slotId, s.accept])) } : { kind: 'text', text: TEXT_OK[act.activityId] ?? '按材料回答。' },
    conditions: { firstExposure: hintLevel === 0, hintLevel, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  })
  if (first) {
    const reg = regById(first.activityId)
    const s0 = reg?.evaluationContract?.slots
    if (s0) {
      const wrong = Object.fromEntries(s0.map((s) => [s.slotId, s.options.find((o) => o !== s.accept) ?? s.accept]))
      await mkAttempt(first, 'bad', 0, wrong)
      await mkAttempt(first, 'good', 0)
    } else {
      await mkAttempt(first, 'bad', 0)
      await mkAttempt(first, 'good', 0)
    }
  }
  for (let step = 0; step < 8; step++) {
    const act = pkg.activities.find((x) => !x.resume)
    if (!act) break
    if (act !== first) {
      const reg = regById(act.activityId)
      const s0 = reg?.evaluationContract?.slots
      const response = s0 ? { kind: 'choice', text: '', answers: Object.fromEntries(s0.map((s) => [s.slotId, s.accept])) } : { kind: 'text', text: TEXT_OK[act.activityId] ?? '按材料回答：先说结论，再说限制。' }
      await api(`/api/v1/accounts/${id}/attempts`, { attemptId: `ws-${lessonId}-${act.activityId}`, taskId: act.taskId, activityId: act.activityId, response, conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' } })
    }
    pkg = await api(`/api/v1/accounts/${id}/lessons/${lessonId}`)
    if (pkg.activities.some((x) => !x.resume)) await pause(100)
  }
  await api(`/api/v1/accounts/${id}/lessons/${lessonId}/complete`, {})

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(15000)
  await page.goto(base)
  await page.getByRole('button', { name: '学习路径', exact: true }).click()
  await page.getByText('学习路径 · 今天与下一步', { exact: true }).waitFor()
  await page.getByRole('button', { name: '成长作品', exact: true }).click()
  await page.getByText('进步是这句话', { exact: false }).waitFor()
  await pause(400)
  await page.screenshot({ path: join(outDir, 'growth-light.png'), fullPage: false })
  // 暗色
  await page.getByRole('button', { name: /暗色/ }).click()
  await pause(400)
  await page.screenshot({ path: join(outDir, 'growth-dark.png'), fullPage: false })
  await page.getByRole('button', { name: /亮色/ }).click()
  // 零作品（新账户）
  const { account: acct2 } = await api('/api/accounts', { name: 'works-empty' })
  await page.getByRole('button', { name: '设置与存档', exact: true }).click().catch(() => {})
  await page.evaluate((accId) => { localStorage.setItem('forge-account', accId) }, acct2.id).catch(() => {})
  // 直接以第二账户开新页（账户切换走应用存储；截图用独立上下文最稳）
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page2.addInitScript(() => { try { localStorage.clear() } catch {} })
  await page2.goto(base)
  await page2.getByRole('button', { name: '学习路径', exact: true }).click()
  await page2.getByText('学习路径 · 今天与下一步', { exact: true }).waitFor()
  const hasWorksTab = await page2.getByRole('button', { name: '成长作品', exact: true }).count()
  if (hasWorksTab) {
    await page2.getByRole('button', { name: '成长作品', exact: true }).click()
    await page2.waitForTimeout(2500) // 等作品数据与空态渲染（新账户可能弹账户引导）
    await page2.screenshot({ path: join(outDir, 'growth-empty.png'), fullPage: false })
  }
  // 手机宽（有配对账户）
  const page3 = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page3.goto(base)
  await page3.waitForTimeout(800)
  const lp3 = page3.getByRole('button', { name: '学习路径', exact: true })
  if (await lp3.count()) await lp3.click()
  await page3.waitForTimeout(800)
  const wt3 = page3.getByRole('button', { name: '成长作品', exact: true })
  if (await wt3.count()) await wt3.click()
  await page3.waitForTimeout(1500)
  await page3.getByText('进步是这句话', { exact: false }).waitFor()
  await pause(300)
  await page3.screenshot({ path: join(outDir, 'growth-mobile.png'), fullPage: false })
  console.log('WORKS_SHOTS_OK →', outDir)
} finally {
  try { await browser?.close() } catch {}
  try { server?.kill() } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
}
