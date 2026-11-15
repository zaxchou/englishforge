'use strict';
/* 数字听写浏览器回归：真实页面 + 隔离 records，合成语音用测试桩，不访问外部 TTS。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pw = require('C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');

const base = process.env.NT_BASE || 'http://127.0.0.1:8019';
const out = path.resolve(__dirname, '../build/qa/number-trainer');
fs.mkdirSync(out, { recursive: true });
const result = { ok: false, checks: [], errors: [], blocked: [], screenshots: [] };

async function sessionOf(page) {
  const raw = await page.evaluate(() => sessionStorage.getItem('nt:run'));
  if (!raw) return null;
  const saved = JSON.parse(raw);
  const r = await page.request.get(base + '/api/number-trainer/sessions/' + saved.id);
  if (!r.ok()) throw new Error('session fetch ' + r.status());
  return { saved, session: await r.json() };
}

async function typeValue(page, value) {
  for (const ch of String(value)) await page.locator(`[data-digit="${ch}"]`).click();
}

(async () => {
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const [w, h] of [[1440, 900], [390, 844], [320, 740]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript(() => {
        window.__spoken = [];
        window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
        Object.defineProperty(window, 'speechSynthesis', {
          configurable: true,
          value: {
            speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 25); },
            cancel() { },
          },
        });
      });
      await ctx.route('**/*', route => {
        const u = new URL(route.request().url()), method = route.request().method();
        const own = u.origin === base;
        const writeOk = method === 'POST' && u.pathname.startsWith('/api/number-trainer/');
        if (!own || (method !== 'GET' && !writeOk)) { result.blocked.push(method + ' ' + u.href); return route.abort(); }
        return route.continue();
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));

      await page.goto(base + '/#/number-trainer');
      await page.locator('.nt-h1').waitFor();
      assert.match(await page.locator('.nt-h1').textContent(), /数字敏感度训练/);

      // 10 题一轮，全部输入正确答案
      await page.locator('[data-count="10"]').click();
      await page.locator('[data-act="start"]').click();
      await page.locator('.nt-bars').waitFor();
      let roundId = null;
      for (let i = 0; i < 10; i++) {
        await page.waitForFunction(() => /输入你听到的数值|点播放开始|本题不计/.test(document.querySelector('.nt-state')?.textContent || ''));
        const { saved, session } = await sessionOf(page);
        roundId = session.id;
        assert.equal(saved.index, i);
        const q = session.questions[i];
        if (i === 3) {
          // 故意答错，检查反馈与错误归因
          await typeValue(page, '7');
          await page.locator('[data-act="confirm"]').click();
          await page.locator('.nt-result.bad').waitFor();
          assert.match(await page.locator('.nt-result').textContent(), /这次不对/);
          assert.match(await page.locator('.nt-result').textContent(), new RegExp(q.value));
        } else {
          await typeValue(page, q.value);
          await page.locator('[data-act="confirm"]').click();
          try {
            await page.locator('.nt-result.ok').waitFor({ timeout: 6000 });
          } catch (e) {
            const dump = await page.locator('#v-number-trainer').textContent();
            await page.screenshot({ path: path.join(out, 'fail-' + w + '-q' + i + '.png') });
            throw new Error('q' + i + ' expected ok, got: ' + dump.replace(/\s+/g, ' ').slice(0, 400));
          }
          assert.match(await page.locator('.nt-result').textContent(), /答对了/);
        }
        assert.equal(await page.locator('#search').count(), 0);
        await page.locator('[data-act="next"]').click();
      }
      await page.locator('.nt-h1').waitFor();
      assert.match((await page.locator('#v-number-trainer').textContent()), /本轮完成/);
      await page.waitForFunction(() => !/—/.test(document.querySelector('.nt-tiles b')?.textContent || '') && /%/.test(document.querySelector('.nt-tiles b')?.textContent || ''));
      const score = await page.locator('.nt-tiles b').first().textContent();
      assert.match(score, /%|—/);

      // 服务端应正好 10 条（1 错 9 对），且与摘要一致
      const day = await (await page.request.get(base + '/api/number-trainer/attempts?date=' + new Date().toISOString().slice(0, 10))).json();
      const mine = day.events.filter(e => e.sessionId === roundId);
      assert.equal(mine.length, 10, 'one stored event per question');
      assert.equal(mine.filter(e => !e.correct && !e.skip).length, 1, 'exactly one wrong in this round');
      assert.equal(new Set(mine.map(e => e.questionId)).size, 10, 'no duplicated question records');
      const timed = mine.filter(e => e.timingValid && Number.isFinite(e.submitMs) && e.submitMs >= 0);
      assert(timed.length >= 8, 'timing recorded for answered questions: ' + timed.length);
      const sum = await (await page.request.get(base + '/api/number-trainer/summary?days=90')).json();
      assert(sum.summary.total.settled >= 10);
      assert(sum.advice.length > 0);

      // 刷新续做：新一轮做 2 题后刷新，应回到第 3 题并保留草稿
      await page.locator('[data-act="again"]').click();
      await page.locator('.nt-bars').waitFor();
      for (let i = 0; i < 2; i++) {
        await page.waitForFunction(() => /输入你听到的数值|本题不计/.test(document.querySelector('.nt-state')?.textContent || ''));
        const { session } = await sessionOf(page);
        await typeValue(page, session.questions[i].value);
        await page.locator('[data-act="confirm"]').click();
        await page.locator('.nt-result').waitFor();
        await page.locator('[data-act="next"]').click();
      }
      await page.waitForFunction(() => /输入你听到的数值|本题不计/.test(document.querySelector('.nt-state')?.textContent || ''));
      await typeValue(page, '12'); // 未提交的草稿
      await page.reload();
      await page.locator('.nt-bars').waitFor();
      await page.waitForFunction(() => /输入你听到的数值|本题不计/.test(document.querySelector('.nt-state')?.textContent || ''));
      const resumed = await sessionOf(page);
      assert.equal(resumed.saved.index, 2, 'refresh resumes at the same question');
      assert.equal(await page.locator('.nt-digits').textContent(), '12', 'draft restored');

      // 键盘输入与删除
      await page.locator('[data-act="del"]').click();
      assert.equal(await page.locator('.nt-digits').textContent(), '1');
      await page.locator('[data-act="del"]').click();

      // 重听不应把题目标记为单听
      const before = (await sessionOf(page)).session.questions[2].value;
      await page.locator('.nt-keys [data-act="replay"]').click();
      await page.waitForFunction(() => (document.querySelector('.nt-stage')?.textContent || '').includes('已重听'));
      await typeValue(page, before);
      await page.locator('[data-act="confirm"]').click();
      await page.locator('.nt-result').waitFor();
      const replayEvent = await (await page.request.get(base + '/api/number-trainer/attempts?date=' + new Date().toISOString().slice(0, 10))).json();
      const ev = replayEvent.events.find(e => e.questionId === 'q3' && e.sessionId === resumed.saved.id);
      assert(ev && ev.assisted === true && ev.replay === true, 'replay recorded as assisted');

      const overflow = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }));
      assert(overflow.s <= overflow.w, 'horizontal overflow ' + JSON.stringify(overflow));
      const shot = path.join(out, 'ui-' + w + '.png');
      await page.screenshot({ path: shot });
      result.screenshots.push(shot);
      assert.deepEqual(errors, []);
      await ctx.close();
      result.checks.push(w + ': 10题一轮/答对与答错反馈/刷新续做与草稿/删除/重听标记/摘要/无溢出无异常');
    }
    assert.deepEqual(result.blocked, []);
    result.ok = true;
  } finally {
    await browser.close();
  }
})().catch(e => { result.errors.push(e.stack || String(e));process.exitCode = 1; })
  .finally(() => {
    result.exit_code = result.ok ? 0 : 1;
    fs.writeFileSync(path.join(out, 'browser-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  });
