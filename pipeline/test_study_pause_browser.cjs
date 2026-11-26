'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const playwright = process.env.TFL_PLAYWRIGHT || 'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright';
const { chromium } = require(playwright);
const { expect } = require(path.join(playwright, 'test'));

const root = path.resolve(__dirname, '..');
const lessonId = 'ndf-01-01';
const reviewUrl = '/#/course/review';
const fixtureQuiz = {
  v: 2, src: 'official', course: 'ndf-01', lessonNo: 1,
  questions: [{ id: 'q1', stem: 'Fixture question', options: { A: 'Yes', B: 'No' }, answer: 'A' }],
};
const safeReads = new Set([
  '/api/ai/quiz', '/api/catalog', '/api/course-plan', '/api/courses', '/api/exams',
  '/api/health', '/api/records', '/api/records/committed', '/api/speaking/summary', '/api/study-pause',
  '/api/vocab/lessons', `/api/lesson-script/${lessonId}`, '/api/handout/ndf-01-h1',
]);
const evidence = process.env.PAUSE_SCREENSHOTS && path.resolve(process.env.PAUSE_SCREENSHOTS);

async function localServer(t, withDueLesson) {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-study-pause-'));
  let server;
  t.after(async () => {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    fs.rmSync(records, { recursive: true, force: true });
  });
  // Remember the default lesson tab so mounting the course view does not autosave it.
  const fixture = { version: 1, course: { [lessonId]: { tab: 'practice' } } };
  if (withDueLesson) {
    fs.writeFileSync(path.join(records, 'generated-quizzes.json'), JSON.stringify({ items: { [lessonId]: fixtureQuiz } }));
    // A legacy answer with no timestamp counts as begun and creates a due first round.
    fixture.attempts = { 'gen/ndf-01/1/quiz/1': { n: 1, history: [] } };
  }
  fs.writeFileSync(path.join(records, 'records.json'), JSON.stringify(fixture));

  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  server = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port', String(port), '--records', records], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env, TFL_SKIP_ENV_LOCAL: '1', TFL_TLS_KEY: '', TFL_TLS_CERT: '',
      TFL_AI_KEY: '', TFL_ASR_KEY: '', TFL_TTS_KEY: '', QWEN_TTS_API_KEY: '',
    },
  });
  await new Promise((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(new Error(`Server startup timed out\n${logs}`)), 15000);
    server.stderr.on('data', chunk => { logs += chunk; });
    server.stdout.on('data', chunk => {
      logs += chunk;
      if (logs.includes(`http://localhost:${port} `)) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code})\n${logs}`)); });
  });
  return `http://127.0.0.1:${port}`;
}

async function browserContext(t, browser, base, viewport, allowPauseWrite = false) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600, serviceWorkers: 'block' });
  const errors = [];
  context.on('page', page => {
    page.on('pageerror', error => errors.push(`${page.url()} ${error.stack || error.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(`${msg.location().url || page.url()} ${msg.text()}`);
    });
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], 'browser errors and unexpected network requests');
  });
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const safeGet = method === 'GET' && (!url.pathname.startsWith('/api/') || safeReads.has(url.pathname));
    const localWrite = method === 'POST' && (url.pathname === '/api/records' ||
      (allowPauseWrite && url.pathname === '/api/study-pause'));
    if (url.origin === base && (safeGet || localWrite)) return route.continue();
    // The course view prefetches cached questions via POST. Serve the fixture locally.
    if (url.origin === base && allowPauseWrite && method === 'POST' && url.pathname === '/api/ai/quiz' &&
      request.postDataJSON()?.lessonId === lessonId && !request.postDataJSON().force) {
      return route.fulfill({ json: { ok: true, cached: true, quiz: fixtureQuiz } });
    }
    errors.push(`Blocked ${method} ${url.href}`);
    return route.abort();
  });
  return context;
}

async function screenshot(page, name) {
  if (!evidence) return;
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `${name}.png`) });
}

function center(page) {
  return page.getByRole('heading', { name: '复习中心', exact: true });
}

async function expectBell(page, { name, count = '', stateClass }) {
  const bell = page.locator('#cp-bell');
  await expect(bell).toBeVisible();
  await expect(bell).toBeInViewport({ ratio: 1 });
  await expect(bell).toHaveAccessibleName(name);
  await expect(bell.locator('#cp-bell-n')).toHaveText(count);
  if (stateClass === 'is-paused') {
    const label = bell.getByText('复习已暂停', { exact: true });
    await expect(label).toBeVisible();
    await expect(label).toBeInViewport({ ratio: 1 });
  }
  for (const state of ['has-due', 'has-opt', 'is-paused']) {
    const marker = new RegExp(`(?:^|\\s)${state}(?:\\s|$)`);
    if (state === stateClass) await expect(bell).toHaveClass(marker);
    else await expect(bell).not.toHaveClass(marker);
  }
}

async function expectDueLesson(page) {
  const action = page.locator(`.cp-lessons [data-cp-open="${lessonId}"]`);
  await expect(action).toBeVisible();
  await expect(action).toBeEnabled();
  await expect(action).toHaveText(/复习本课/);
}

test('global study pause browser regression', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const emptyBase = await localServer(t, false);
  const dueBase = await localServer(t, true);
  const dueBell = { name: /今天必做/, count: '1', stateClass: 'has-due' };
  const pausedBell = { name: /复习已暂停/, stateClass: 'is-paused' };

  const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }];
  for (const viewport of viewports) {
    const { width } = viewport;
    await t.test(`${width}px neutral bell opens the review center with no due items`, async subtest => {
      const context = await browserContext(subtest, browser, emptyBase, viewport);
      const page = await context.newPage();
      await page.goto(`${emptyBase}/`);
      await expectBell(page, { name: '复习中心' });
      await screenshot(page, `${width}-neutral`);
      await page.getByRole('button', { name: '复习中心', exact: true }).click();
      await expect(page).toHaveURL(`${emptyBase}${reviewUrl}`);
      await expect(center(page)).toBeVisible();
      await expect(page.getByRole('button', { name: '暂停复习', exact: true })).toBeEnabled();
      await screenshot(page, `${width}-neutral-review-center`);
    });

    await t.test(`${width}px pause, due lesson retention, reload, cross-tab updates and resume`, async subtest => {
      const context = await browserContext(subtest, browser, dueBase, viewport, true);
      const page = await context.newPage();
      const other = await context.newPage();
      const reminder = other.locator('#cp-due-mask');
      await page.goto(`${dueBase}${reviewUrl}`);
      await expect(center(page)).toBeVisible();
      await expectDueLesson(page);
      await expectBell(page, dueBell);
      await screenshot(page, `${width}-due-review-center`);

      await other.goto(`${dueBase}/`);
      await expect(other.getByRole('dialog', { name: '复习到期提醒' })).toBeVisible();
      await screenshot(other, `${width}-due-reminder`);

      await page.getByRole('button', { name: '暂停复习', exact: true }).click();
      await expect(page.getByRole('heading', { name: '复习已暂停', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '恢复复习', exact: true })).toBeEnabled();
      await expectBell(page, pausedBell);
      await expectDueLesson(page);
      await expect(page.locator('#cp-dashboard-today')).toHaveText('可选练习');
      await screenshot(page, `${width}-paused`);
      await expectBell(other, pausedBell);
      await expect(reminder).toHaveCount(0);
      await screenshot(other, `${width}-second-tab-paused`);

      // The second course-plan read during boot belongs to the reminder check.
      let planReads = 0;
      const reminderChecked = other.waitForResponse(response => response.ok() &&
        new URL(response.url()).pathname === '/api/course-plan' && ++planReads === 2);
      await other.reload();
      await (await reminderChecked).finished();
      await expectBell(other, pausedBell);
      await expect(reminder).toHaveCount(0);
      await screenshot(other, `${width}-reloaded-paused`);
      await other.getByRole('button', { name: /复习已暂停.*复习中心/ }).click();
      await expect(center(other)).toBeVisible();
      await expect(other.getByRole('heading', { name: '复习已暂停', exact: true })).toBeVisible();
      await expectDueLesson(other);
      await screenshot(other, `${width}-reloaded-review-center`);

      await other.getByRole('button', { name: '恢复复习', exact: true }).click();
      await expect(other.getByRole('button', { name: '暂停复习', exact: true })).toBeEnabled();
      await expectBell(other, dueBell);
      await expectDueLesson(other);
      await screenshot(other, `${width}-resumed`);
      await expect(page.getByRole('button', { name: '暂停复习', exact: true })).toBeEnabled();
      await expectBell(page, dueBell);
      await expectDueLesson(page);
      await screenshot(page, `${width}-second-tab-resumed`);
    });
  }
});
