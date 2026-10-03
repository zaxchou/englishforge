// 三任务浏览器走查：入口页（双历史+托福）→ 真题模考（真实 AI 讲解）→ 错题重训/打勾。
import { mkdirSync, writeFileSync } from 'node:fs'

const pwPath = process.env.EF_PLAYWRIGHT_IMPORT
if (!pwPath) { console.error('需要 EF_PLAYWRIGHT_IMPORT'); process.exit(1) }
const { chromium } = await import(pwPath)

const BASE = 'http://localhost:4199'
const OUT = 'docs/curriculum-v4/toefl-formal-2026-10-03'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 150)) })
const ev = { steps: [] }

// 0) 创建账户（隔离库为空）
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(2500)
// 首次进入可能是空账户 → 通过侧栏账户卡新建
const hasAccount = await page.locator('.toefl-app, .launcher-cards, h1').first().isVisible().catch(() => false)
ev.steps.push({ step: 'app-loaded', hasAccount })

// 建账户走 API（浏览器 UI 建户流程不在本走查范围）
const acct = await page.evaluate(async () => {
  const r = await fetch('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '模考走查' }) })
  return (await r.json()).account.id
})
ev.steps.push({ step: 'account-created', acct })
console.log('账户:', acct)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// 1) 任务1：默认入口页显示三套系统
await page.screenshot({ path: `${OUT}/10-launcher.png`, fullPage: false })
const launcherText = await page.locator('body').innerText()
ev.steps.push({ step: 'launcher', hasLegacy: launcherText.includes('刷题训练'), hasV4: launcherText.includes('学习路径'), hasToefl: launcherText.includes('托福课程') })
console.log('入口页三系统:', launcherText.includes('刷题训练'), launcherText.includes('学习路径'), launcherText.includes('托福课程'))

// 2) 进入托福 → 真题测试 → 开考 pack1
await page.getByRole('button', { name: /进入托福课程/ }).click()
await page.waitForSelector('.toefl-app', { timeout: 15000 })
await page.locator('.side button', { hasText: '独立真题测试' }).first().click()
await page.waitForSelector('text=像真的考试一样', { timeout: 15000 })
await page.screenshot({ path: `${OUT}/11-exam-library.png`, fullPage: true })
const libText = await page.locator('.content, .body, .toefl-app').first().innerText()
ev.steps.push({ step: 'exam-library', hasSnapshot: libText.includes('真题库快照'), packs: (libText.match(/待录入/g) ?? []).length })
await page.getByRole('button', { name: '开始这套模考' }).click()
await page.waitForSelector('text=阅读部分', { timeout: 15000 })

// 3) 做阅读：全卷作答（填空乱填 + 全选 A，两题按官方键答对）
const inputs = page.locator('input[placeholder="缺失字母"]')
const n = await inputs.count()
for (let i = 0; i < n; i++) await inputs.nth(i).fill('zz')
// 官方键两题：第1空 ght（ reading-m1-c-1 是页面第一个填空）
await inputs.nth(0).fill('ght')
const radios = page.locator('input[type=radio]')
const rn = await radios.count()
for (let i = 0; i < rn; i++) await radios.nth(i).check()
ev.steps.push({ step: 'reading-answered', blanks: n, radios: rn })
console.log('阅读作答:', n, '空 +', rn, '选择')
await page.screenshot({ path: `${OUT}/12-exam-reading.png`, fullPage: false })

// 4) 交卷 → 真实 AI 讲解
await page.getByRole('button', { name: /交卷 · 阅读部分/ }).click()
await page.waitForSelector('text=AI 老师讲评', { timeout: 120000 })
await page.waitForTimeout(800)
const score = await page.locator('.result').first().innerText()
console.log('阅读结果:', score.replace(/\n/g, ' ').slice(0, 80))
await page.screenshot({ path: `${OUT}/13-exam-reading-results.png`, fullPage: false })
ev.steps.push({ step: 'reading-submitted', score: score.slice(0, 60) })

// 5) 错题本：重训一道（重做 → 答错显示正确答案 → 打勾结业）
await page.locator('.side button', { hasText: '错题本' }).first().click()
await page.waitForSelector('text=训练中', { timeout: 10000 })
const cnt = await page.locator('.statline').first().innerText()
console.log('错题统计:', cnt.replace(/\n/g, ' '))
await page.getByRole('button', { name: '重做这道题' }).first().click()
await page.waitForSelector('.choices', { timeout: 10000 })
await page.locator('.choices input[type=radio]').first().check()
await page.getByRole('button', { name: '提交答案' }).click()
await page.waitForSelector('.noteSaved', { timeout: 10000 })
const trainMsg = await page.locator('.noteSaved').last().innerText()
console.log('重训反馈:', trainMsg.slice(0, 70))
await page.screenshot({ path: `${OUT}/14-error-retrain.png`, fullPage: false })
await page.getByRole('button', { name: /打勾 · 不再训练/ }).first().click()
await page.waitForTimeout(800)
const afterDismiss = await page.locator('.statline').first().innerText()
ev.steps.push({ step: 'error-retrain-dismiss', trainMsg: trainMsg.slice(0, 80), statAfter: afterDismiss.replace(/\n/g, ' ') })
console.log('打勾后统计:', afterDismiss.replace(/\n/g, ' '))

ev.consoleErrors = errors
writeFileSync(`${OUT}/walk-tasks-verification.json`, JSON.stringify({ date: new Date().toISOString(), steps: ev.steps, consoleErrors: errors }, null, 1) + '\n')
console.log('console errors:', errors.length ? errors.slice(0, 3) : '无')
await browser.close()
