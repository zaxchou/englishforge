// 59 号 S1/S2 浏览器走查：托福浅色外壳（隔离库 acc_dwtynnrq74）。
// 用法：EF_PLAYWRIGHT_IMPORT="file://.../playwright/index.mjs" node scripts/toefl-ui-walk.mjs
import { mkdirSync, writeFileSync } from 'node:fs'

const pwPath = process.env.EF_PLAYWRIGHT_IMPORT
if (!pwPath) { console.error('需要 EF_PLAYWRIGHT_IMPORT'); process.exit(1) }
const { chromium } = await import(pwPath)

const BASE = 'http://localhost:4199'
const OUT = 'docs/curriculum-v4/toefl-formal-2026-10-03'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)) })

const shot = (name, fullPage = true) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage })
const ev = { steps: [], consoleErrors: [] }

// 1) 旧应用 → 托福入口
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.getByRole('button', { name: '托福课程' }).click({ timeout: 30000 })
await page.waitForSelector('.toefl-app', { timeout: 10000 })
await page.waitForSelector('.courseRow', { timeout: 10000 })
await shot('01-dashboard-desktop')
const progressText = await page.locator('.progressSummary').innerText()
ev.steps.push({ step: 'dashboard', progressText: progressText.replace(/\n/g, ' | ') })
console.log('dashboard 进度:', progressText.replace(/\n/g, ' '))

// 2) 阅读课程：学习页签（视频存在 + 讲义要点 + 标记方法完成）
await page.locator('.side button', { hasText: '阅读课程' }).first().click()
await page.waitForSelector('video', { timeout: 15000 })
const videoSrc = await page.locator('video').getAttribute('src')
ev.steps.push({ step: 'learn-video-src', videoSrc })
await shot('02-reading-learn')
await page.getByRole('button', { name: '我已读懂要点，进入练习' }).click()
await page.waitForSelector('.choices', { timeout: 10000 })
ev.steps.push({ step: 'method-done → practice', ok: true })

// 3) 配套真题：故意错答 r11（选A），r12 对（C）
await page.locator('.choices label').filter({ hasText: 'September 10th' }).first().click()
await page.locator('.choices label').filter({ hasText: 'A protective garment' }).click()
await page.getByRole('button', { name: '提交本组' }).click()
await page.waitForSelector('.teacher', { timeout: 10000 })
await shot('03-reading-review-results')

// 4) 复盘：请老师分析（真实模型 ~3-5s）
await page.locator('#toeflAsk').fill('我看到 September 10th 就选了，没细看问的是哪个事件。')
await page.getByRole('button', { name: '请老师分析' }).click()
await page.waitForSelector('.reviewText', { timeout: 90000 })
await page.waitForTimeout(500)
const teacherText = await page.locator('.reviewText').innerText()
ev.steps.push({ step: 'teacher-analysis', sample: teacherText.slice(0, 220) })
console.log('老师分析(节选):', teacherText.slice(0, 150).replace(/\n/g, ' '))
await shot('04-reading-teacher')

// 5) 错题本：状态机操作（幂等：优先待复盘→已复盘，否则已复盘→等新题验证）
await page.locator('.side button', { hasText: '错题本' }).first().click()
await page.waitForSelector('.records', { timeout: 10000 })
const reviewBtn = page.getByRole('button', { name: '标记：已复盘' })
const checkBtn = page.getByRole('button', { name: '标记：等新题验证' })
if (await reviewBtn.count()) { await reviewBtn.first().click(); ev.steps.push({ step: 'errors-status', transition: 'pending_review→reviewed' }) }
else if (await checkBtn.count()) { await checkBtn.first().click(); ev.steps.push({ step: 'errors-status', transition: 'reviewed→awaiting_new_check' }) }
else ev.steps.push({ step: 'errors-status', transition: 'none-available(全到终态)' })
await page.waitForTimeout(600)
const errText = await page.locator('.content').innerText()
ev.steps.push({ step: 'errors-status', hasReviewed: errText.includes('已复盘待重做') })
await shot('05-errors')

// 6) 档案保存
await page.locator('.side button', { hasText: '个人学习档案' }).first().click()
await page.waitForSelector('#targetScore', { timeout: 10000 })
await page.locator('#targetScore').fill('目标未定；先补听读')
await page.getByRole('button', { name: '保存计划' }).click()
await page.waitForSelector('.noteSaved', { timeout: 10000 })
ev.steps.push({ step: 'profile-saved', ok: true })
await shot('06-profile')

// 7) 首页：老师分析卡 + 进度应显示 3/12
await page.locator('.side button', { hasText: '首页总览' }).first().click()
await page.waitForSelector('.courseRow', { timeout: 10000 })
const dash2 = await page.locator('.progressSummary').innerText()
ev.steps.push({ step: 'dashboard-after', progressText: dash2.replace(/\n/g, ' | ') })
console.log('回首页进度:', dash2.replace(/\n/g, ' '))

// 8) 移动端 390：默认首页 + 抽屉导航
await ctx.close()
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const mp = await mctx.newPage()
mp.on('pageerror', (e) => errors.push('m-pageerror: ' + e.message))
await mp.goto(BASE + '/#toefl', { waitUntil: 'domcontentloaded', timeout: 60000 })
await mp.waitForSelector('.courseRow', { timeout: 20000 })
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
ev.steps.push({ step: 'mobile-390-dashboard', horizontalOverflow: overflow })
await mp.screenshot({ path: `${OUT}/07-dashboard-mobile.png`, fullPage: true })
await mp.locator('.top .menu').click()
await mp.waitForSelector('.app.showMenu .side', { timeout: 5000 })
await mp.screenshot({ path: `${OUT}/08-mobile-drawer.png` })
await mp.keyboard.press('Escape')
await mp.waitForTimeout(300)
const drawerClosed = await mp.locator('.app.showMenu').count() === 0
ev.steps.push({ step: 'mobile-drawer-esc', drawerClosed })
console.log('mobile overflow:', overflow, '| drawer esc close:', drawerClosed)

ev.consoleErrors = errors
writeFileSync(`${OUT}/verification.json`, JSON.stringify({ date: new Date().toISOString(), base: BASE, account: 'acc_dwtynnrq74(隔离库)', steps: ev.steps, consoleErrors: errors }, null, 1) + '\n')
console.log('console errors:', errors.length ? errors : '无')
console.log('→', OUT)
await browser.close()
