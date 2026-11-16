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
      page.on('dialog', d => d.accept().catch(() => { }));

      await page.goto(base + '/#/number-trainer');
      await page.locator('.nt-h1').waitFor();
      assert.match(await page.locator('.nt-h1').textContent(), /数字敏感度训练/);

      // 亮色主题：默认亮色，可切换到深色、持久化，并真实改变配色；不留溢出
      assert.equal(await page.locator('#v-number-trainer').getAttribute('data-theme'), 'light', 'default theme is light');
      const lightBg = await page.locator('.nt').evaluate(el => getComputedStyle(el).backgroundColor);
      const shotLight = path.join(out, 'light-' + w + '.png');
      await page.screenshot({ path: shotLight });
      result.screenshots.push(shotLight);
      const lightOverflow = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }));
      assert(lightOverflow.s <= lightOverflow.w, 'light theme no horizontal overflow ' + JSON.stringify(lightOverflow));
      await page.locator('[data-act="theme"]').click();
      assert.equal(await page.locator('#v-number-trainer').getAttribute('data-theme'), 'dark', 'theme toggled to dark');
      assert.equal(await page.evaluate(() => localStorage.getItem('nt:theme')), 'dark', 'theme saved to localStorage');
      const darkBg = await page.locator('.nt').evaluate(el => getComputedStyle(el).backgroundColor);
      assert.notEqual(lightBg, darkBg, 'theme changes panel background: ' + lightBg + ' -> ' + darkBg);
      await page.reload();
      await page.locator('.nt-h1').waitFor();
      assert.equal(await page.locator('#v-number-trainer').getAttribute('data-theme'), 'dark', 'theme survives reload');
      await page.locator('[data-act="theme"]').click();
      assert.equal(await page.locator('#v-number-trainer').getAttribute('data-theme'), 'light', 'theme toggled back to light');

      // 10 题一轮，全部输入正确答案
      await page.locator('[data-count="10"]').click();
      await page.locator('[data-auto="off"]').click();   // 先用手动确认，便于逐题断言
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

      // 错题重练：有可映射的错因时，按同一特征出新数字
      if (await page.locator('[data-act="retry"]').count()) {
        await page.locator('[data-act="retry"]').click();
        await page.locator('.nt-bars').waitFor();
        const r2 = await sessionOf(page);
        const feats = [...new Set(r2.session.questions.map(q => q.feature).filter(Boolean))];
        assert.equal(feats.length, 1, 'retry drills a single feature: ' + feats);
        assert(r2.session.questions.every(q => ['focus', 'probe'].includes(q.source)), 'retry only uses focus or probe fill');
        assert(r2.session.questions.filter(q => q.source === 'focus').length >= Math.min(5, r2.session.questions.length));
        assert.equal(new Set(r2.session.questions.map(q => q.value)).size, r2.session.questions.length, 'retry values are fresh');
        await page.locator('[data-act="back"]').click();
        await page.locator('[data-act="home"]').click({ timeout: 3000 }).catch(() => { });
        await page.locator('.nt-h1').waitFor();
      }

      // 刷新续做：新一轮做 2 题后刷新，应回到第 3 题并保留草稿
      if (await page.locator('[data-act="again"]').count()) await page.locator('[data-act="again"]').click();
      else await page.locator('[data-act="start"]').click();
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

      // 音频失败：明确报错并可重试，不静默切换引擎
      if (w === 1440) {
        if (await page.locator('[data-act="back"]').count()) {
          await page.locator('[data-act="back"]').click();
        }
        await page.locator('.nt-h1').waitFor();
        let failAudio = true;
        await page.route('**/api/number-trainer/audio?*', route => failAudio ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"TTS_NOT_CONFIGURED"}' }) : route.continue());
        await page.locator('[data-act="start"]').click();
        await page.locator('.nt-bars').waitFor();
        await page.locator('[data-act="retryAudio"]').waitFor({ timeout: 25000 });
        assert.match(await page.locator('.nt-state').textContent(), /音频/);
        failAudio = false;
        await page.locator('[data-act="retryAudio"]').click();
        await page.waitForFunction(() => /输入你听到的数值/.test(document.querySelector('.nt-state')?.textContent || ''), null, { timeout: 25000 });
        await page.unroute('**/api/number-trainer/audio?*');
        await page.locator('[data-act="back"]').click();
        await page.locator('.nt-h1').waitFor();
      }

      // 键盘直控：不点输入区，R/C/退格/Delete/方向键/Enter，以及答对自动进入下一题
      if (w === 390) {
        await page.locator('[data-act="back"]').click();
        await page.locator('.nt-h1').waitFor();
        await page.locator('[data-auto="on"]').click();
        await page.locator('[data-act="start"]').click();
        await page.locator('.nt-bars').waitFor();
        await page.waitForFunction(() => /输入你听到的数值|本题不计/.test(document.querySelector('.nt-state')?.textContent || ''));
        const k = await sessionOf(page);
        const v = String(k.session.questions[0].value);
        await page.keyboard.type(v + '9');
        assert.equal(await page.locator('.nt-digits').textContent(), v + '9', 'digits typed without focusing an input');
        await page.keyboard.press('Backspace');
        assert.equal(await page.locator('.nt-digits').textContent(), v);
        await page.keyboard.press('Home');
        await page.keyboard.press('Delete');
        assert.equal(await page.locator('.nt-digits').textContent(), v.slice(1), 'forward delete at caret');
        await page.keyboard.press('c');
        assert.equal(await page.locator('.nt-digits').textContent(), '');
        await page.keyboard.press('r');
        await page.waitForFunction(() => (document.querySelector('.nt-stage')?.textContent || '').includes('已重听'));
        await page.keyboard.type(v);
        await page.keyboard.press('Enter');
        await page.locator('.nt-result.ok').waitFor();
        await page.waitForFunction(() => (document.querySelector('.nt-meta-row')?.textContent || '').trim().startsWith('2 /'), null, { timeout: 6000 });
        assert.equal(await page.locator('.nt-result').count(), 0, 'auto-advance leaves no stale result');
        await page.locator('[data-act="back"]').click();
        await page.locator('.nt-h1').waitFor();
        await page.locator('[data-auto="off"]').click();
      }

      // 电话号模式：逐位播放、前导零、分组反馈
      if (w === 390) {
        const audioRes = [];
        page.on('response', r => { if (new URL(r.url()).pathname === '/api/number-trainer/audio') audioRes.push(r.status()); });
        await page.locator('[data-kind="phone"]').click();
        await page.locator('[data-phone="7:7"]').click();
        await page.locator('[data-act="start"]').click();
        await page.locator('.nt-bars').waitFor();
        await page.waitForFunction(() => /输入你听到的数值/.test(document.querySelector('.nt-state')?.textContent || ''), null, { timeout: 40000 });
        const ps = await sessionOf(page);
        assert(ps.session.questions.every(q => q.mode === 'phone'), 'phone session');
        assert(ps.session.questions.every(q => String(q.value).length === 7), '7-digit numbers');
        const pv = String(ps.session.questions[0].value);
        await page.keyboard.type(pv);
        assert.equal((await page.locator('.nt-digits').textContent()).replace(/\s/g, ''), pv, 'leading zeros typeable');
        await page.keyboard.press('Enter');
        await page.locator('.nt-result.ok').waitFor();
        const grouped = pv.slice(0, 3) + ' ' + pv.slice(3);
        assert((await page.locator('.nt-result').textContent()).includes(grouped), 'grouped display in feedback');
        assert(audioRes.filter(x => x === 200 || x === 206).length >= 1, 'phone audio served: ' + JSON.stringify(audioRes));
        await page.locator('[data-act="back"]').click();
        await page.locator('.nt-h1').waitFor();
        await page.locator('[data-kind="number"]').click();
      }

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
