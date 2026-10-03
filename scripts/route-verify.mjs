// 本地路由验证：默认进托福、每页有 hash、刷新可定位、深链直达。
import { mkdirSync, writeFileSync } from 'node:fs'
const pwPath = process.env.EF_PLAYWRIGHT_IMPORT
if (!pwPath) { console.error('需要 EF_PLAYWRIGHT_IMPORT'); process.exit(1) }
const { chromium } = await import(pwPath)
const BASE = 'http://localhost:4173'
const OUT = 'docs/curriculum-v4/toefl-formal-2026-10-03'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
const ev = { checks: [] }

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.toefl-app', { timeout: 20000 })
let hash = await page.evaluate(() => location.hash)
ev.checks.push({ check: '默认进入托福', hash, ok: hash.startsWith('#/toefl') })
console.log('默认视图 hash:', hash)

// 确保有账户（本地库可能有账户；没有就建一个并刷新）
const acct = await page.evaluate(async () => {
  const r = await fetch('/api/accounts'); const j = await r.json()
  return j.accounts[0]?.id ?? null
})
if (!acct) {
  const id = await page.evaluate(async () => (await (await fetch('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '路由走查' }) })).json()).account.id)
  await page.goto(BASE + '/#toefl', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000)
}
await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500)

// 逐页点击 + hash 断言
const cases = [
  ['错题本', '#/toefl/errors'],
  ['个人学习档案', '#/toefl/profile'],
  ['独立真题测试', '#/toefl/test'],
  ['资料库', '#/toefl/resources'],
  ['首页总览', '#/toefl/dashboard'],
]
for (const [label, want] of cases) {
  await page.locator('.side button', { hasText: label }).first().click()
  await page.waitForTimeout(500)
  const h = await page.evaluate(() => location.hash)
  ev.checks.push({ check: label, hash: h, ok: h === want })
  console.log(label, '→', h, h === want ? 'OK' : 'MISMATCH')
}
// 课程 + 科目
await page.locator('.side button', { hasText: '阅读课程' }).first().click()
await page.waitForTimeout(600)
const courseHash = await page.evaluate(() => location.hash)
ev.checks.push({ check: '课程页带科目', hash: courseHash, ok: courseHash === '#/toefl/course/reading' })
console.log('课程页 →', courseHash)

// 深链直达：直接开 #/toefl/errors
await page.goto(BASE + '/#/toefl/errors', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
const deep = await page.locator('.toefl-app h1').first().innerText().catch(() => '(未找到)')
ev.checks.push({ check: '深链直达错题本', h1: deep, ok: deep.includes('错题本') })
console.log('深链直达:', deep)
await page.screenshot({ path: `${OUT}/15-local-routes.png`, fullPage: false })

// 刷新定位：刷新后仍在错题本
await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500)
const after = await page.locator('.toefl-app h1').first().innerText().catch(() => '(未找到)')
ev.checks.push({ check: '刷新后仍定位', h1: after, ok: after.includes('错题本') })
console.log('刷新后:', after)

// 设置与存档 → 历史系统（launcher）可达旧系统
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000)
const setBtn = page.locator('button', { hasText: '设置与存档' })
if (await setBtn.count()) {
  await setBtn.first().click(); await page.waitForTimeout(800)
  const legacyH1 = await page.locator('h1').first().innerText().catch(() => '')
  ev.checks.push({ check: '设置与存档 → 历史系统', h1: legacyH1, ok: legacyH1.includes('历史系统') })
  console.log('设置深处 h1:', legacyH1)
} else { ev.checks.push({ check: '设置与存档按钮', ok: false, note: '当前视图找不到（托福外壳内）' }); console.log('（当前在托福外壳，侧栏无设置按钮——历史系统入口在旧外壳内）') }

writeFileSync(`${OUT}/route-verification.json`, JSON.stringify({ date: new Date().toISOString(), checks: ev.checks, consoleErrors: errors }, null, 1) + '\n')
console.log('console errors:', errors.length ? errors.slice(0, 3) : '无')
await browser.close()
