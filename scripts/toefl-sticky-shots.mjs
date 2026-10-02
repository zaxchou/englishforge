// 03/04 sticky 复验：视口截图（非 fullPage）——顶部状态 + 滚动后状态（sticky 应钉住）。
import { mkdirSync } from 'node:fs'
const pwPath = process.env.EF_PLAYWRIGHT_IMPORT
const { chromium } = await import(pwPath)
const BASE = 'http://localhost:4199'
const OUT = 'docs/curriculum-v4/toefl-formal-2026-10-03'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
await page.goto(BASE + '/#toefl', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.courseRow', { timeout: 20000 })
await page.locator('.side button', { hasText: '阅读课程' }).first().click()
await page.waitForSelector('video', { timeout: 15000 })
await page.getByRole('button', { name: '配套真题' }).click()
await page.waitForTimeout(800)
await page.locator('.tabs button', { hasText: '复盘' }).click()
await page.waitForSelector('.result', { timeout: 10000 })

// 复盘页：顶部 + 滚动 900px（sticky 侧栏/面包屑应保持钉住）
await page.screenshot({ path: `${OUT}/03-reading-review-results.png`, fullPage: false })
await page.mouse.wheel(0, 900)
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/03b-review-scrolled.png`, fullPage: false })

// 老师分析
await page.getByRole('button', { name: /再请老师分析一次|请老师分析/ }).click()
await page.waitForSelector('.reviewText', { timeout: 90000 })
await page.screenshot({ path: `${OUT}/04-reading-teacher.png`, fullPage: false })
await page.mouse.wheel(0, 1200)
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/04b-teacher-scrolled.png`, fullPage: false })
console.log('sticky 视口截图完成')
await browser.close()
