import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-root-dict-'));
const out = path.resolve(process.env.TFL_ROOT_QA || path.join(root, 'build/qa/root-universe/review-20261108'));
const previews = [];
let server, base, browser;
const results = { ok: false, checks: [], errors: [], blocked: [], screenshots: [], records: dir };
async function start() {
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  server = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port', String(port), '--records', dir], {
    cwd: root, env: { ...process.env, TFL_TLS_KEY: '', TFL_TLS_CERT: '', TFL_AI_KEY: '', TFL_ASR_KEY: '', TFL_TTS_KEY: '', QWEN_TTS_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('startup timeout ' + logs)), 20000);
    server.stdout.on('data', b => { logs += b; if (logs.includes('http://localhost:')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', b => logs += b);
    server.once('exit', n => { clearTimeout(timer); reject(Error('startup exit ' + n + ': ' + logs)); });
  });
  base = 'http://127.0.0.1:' + logs.match(/http:\/\/localhost:(\d+)/)[1];
}
const get = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, headers: r.headers, body: await r.text() }; };
const json = async p => { const r = await get(p); return { status: r.status, data: JSON.parse(r.body) }; };
const previewURL = s => 'http://127.0.0.1:' + s.address().port;
async function preview(deskUrl) {
  const previous = process.env.TFL_DESK_URL;
  let s;
  try {
    if (deskUrl === undefined) delete process.env.TFL_DESK_URL;
    else process.env.TFL_DESK_URL = deskUrl;
    s = require('../root-universe/server.cjs').createServer();
  } finally {
    if (previous === undefined) delete process.env.TFL_DESK_URL;
    else process.env.TFL_DESK_URL = previous;
  }
  previews.push(s);
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  return s;
}
async function context(viewport, origins) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await ctx.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    const paid = /\/(?:tts|asr|ai|coach|payment|pay)(?:[/?]|$)/i.test(url.pathname);
    if (!origins.includes(url.origin) || !['GET', 'HEAD'].includes(request.method()) || paid) {
      results.blocked.push({ method: request.method(), url: request.url() });
      return route.abort();
    }
    return route.continue();
  });
  return ctx;
}
async function clickReturn(page, selector, target) {
  const link = page.locator(selector);
  assert.equal(await link.isVisible(), true, 'return link is visible');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await link.getAttribute('rel'), /\bnoopener\b/);
  const [desk] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await desk.waitForURL(target);
  assert.equal(desk.url(), target);
  await desk.locator('#nav-burger').waitFor({ state: 'attached' });
  await desk.close();
}
(async () => {
  await start();
  // Assert the canonical redirect without automatically following it, including its query string.
  for (const query of ['', '?node=Ldict%3Acontradict&view=lookup']) {
    const redirect = await get('/dict' + query, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/dict/' + query);
  }
  for (const pathname of ['/dict', '/dict/', '/dict/app.js', '/dict/index.html', '/dict/api/graph']) {
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
      const response = await get(pathname, { method, redirect: 'manual' });
      assert.equal(response.status, 405, method + ' ' + pathname);
      assert.equal(response.headers.get('location'), null, 'writes must not redirect');
    }
  }
  const page = await get('/dict/');
  assert.equal(page.status, 200); assert.match(page.body, /href="style\.css"/); assert.match(page.body, /src="app\.js"/);
  assert.equal((page.body.match(/href="\/#\/home" data-desk-link/g) || []).length, 2);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await get('/dict/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await get('/dict/style.css')).status, 200);
  assert.equal((await get('/dict/nope.js')).status, 404);
  const health = await json('/dict/api/health');
  assert.equal(health.status, 200); assert.ok(health.data.ok); assert.match(health.data.version, /^v-[a-f0-9]{64}$/);
  const graph = await json('/dict/api/graph');
  assert.equal(graph.status, 200);
  const learningWords = graph.data.nodes.filter(n => n.type === 'learning_word');
  assert(learningWords.length >= 690, 'learning words in graph, got ' + learningWords.length);
  assert(graph.data.families.some(f => f.id === 'alliance:dict') && graph.data.families.some(f => f.id === 'alliance:cfcm-01'));
  assert(graph.data.nodes.some(n => n.type === 'senses'), 'fact senses remain available');
  const hit = await json('/dict/api/search?q=contradict');
  assert(hit.data.results.some(x => x.id === 'Ldict:contradict'));
  const partial = await json('/dict/api/search?q=contradi&max=5');
  assert(partial.data.results.length > 0 && partial.data.results.length <= 5);
  const profile = await json('/dict/api/learning?id=Ldict:contradict');
  assert.equal(profile.status, 200); assert.equal(profile.data.status, 'reviewed'); assert.equal(profile.data.alliance.id, 'dict');
  const fallback = await json('/dict/api/learning?id=' + encodeURIComponent('P0001:s0001'));
  assert.equal(fallback.status, 200); assert.equal(fallback.data.status, 'reviewed'); assert.equal(fallback.data.word.word, 'predict');
  const detail = await json('/dict/api/node?id=' + encodeURIComponent('P0001:s0001'));
  assert.equal(detail.status, 200); assert.ok(detail.data.node || detail.data.id || detail.data.word);
  const evidence = graph.data.nodes.find(n => n.type === 'senses' && n.evidence_ids?.length);
  assert(evidence, 'published fact sense must expose evidence');
  const evidenceId = evidence.evidence_ids[0];
  assert.match(evidenceId, /^P\d{4}:[a-z][a-z0-9_-]*$/);
  const source = await json('/dict/api/source?id=' + encodeURIComponent(evidenceId));
  assert.equal(source.status, 200); assert.equal(source.data.id, evidenceId);
  assert(source.data.url && source.data.original_text, 'source returns real evidence content');
  const neighbors = await json('/dict/api/neighbors?id=' + encodeURIComponent('P0001:s0001'));
  assert.equal(neighbors.status, 200); assert.equal(neighbors.data.found, true);
  assert.equal((await json('/dict/api/search?q=a&q=b')).status, 400);
  assert.equal((await json('/dict/api/search?q=a&extra=1')).status, 400);
  assert.equal((await json('/dict/api/nope')).status, 404);
  assert.equal((await json('/dict/api/learning?id=' + encodeURIComponent('x').repeat(90))).status, 400);
  assert.equal((await get('/dict/api/search?q=' + '%00')).status, 400);
  const home = await get('/');
  assert.equal(home.status, 200); assert.match(home.body, /href="\/dict\/"[^>]*rel="noopener"/);
  assert.equal((await json('/api/health')).data.ok, true);
  const roots = await json('/dict/api/roots');
  assert(roots.data.results.length >= 41);
  assert(roots.data.results.some(r => r.id === 'cfcm-03:Rbio'));
  const dictRoot = (await json('/dict/api/root?id=dict%3ARdict')).data;
  assert.equal(dictRoot.members.length, dictRoot.count);
  assert.equal(dictRoot.truncated, false);
  assert(dictRoot.members.some(w => w.word === 'condition'));
  assert(dictRoot.members.some(w => w.word === 'teach'));
  assert(!dictRoot.members.some(w => w.word === 'digit'), 'different root stays separate');
  for (const q of ['dict-', 'dic-', '说']) {
    assert((await json('/dict/api/search?q=' + encodeURIComponent(q))).data.roots.some(r => r.id === 'dict:Rdict'));
  }
  const ped = (await json('/dict/api/roots?q=ped')).data.results;
  assert(ped.some(r => r.root_id === 'RpedFoot') && ped.some(r => r.root_id === 'RpedChild'));
  assert.equal((await json('/dict/api/roots?q=' + encodeURIComponent('生命'))).data.results.length, 2);
  assert.equal((await json('/dict/api/root?id=missing')).status, 404);
  assert.equal((await json('/dict/api/roots?q=%00')).status, 400);
  assert.equal((await json('/dict/api/roots?q=a&q=b')).status, 400);
  assert.equal((await get('/dict/api/root?id=dict%3ARdict', { method: 'POST' })).status, 405);
  results.checks.push('http: canonical redirect, read-only APIs, root aliases/meanings, distinct ped identities, complete membership beyond spelling, existing desk');

  // Standalone preview injects an explicit desk address instead of resolving /#/home on port 8036.
  const standalone = require('../root-universe/server.cjs');
  for (const deskUrl of ['', '/#/home', 'javascript:alert(1)', 'data:text/html,test', 'ftp://desk.example/']) {
    assert.throws(() => standalone.createServer({ deskUrl }), /TFL_DESK_URL_INVALID/);
  }
  const defaultPreview = await preview();
  const defaultHTML = await (await fetch(previewURL(defaultPreview) + '/')).text();
  assert.equal((defaultHTML.match(/href="https:\/\/192\.168\.31\.246:8018\/#\/home" data-desk-link/g) || []).length, 2);
  assert(!defaultHTML.includes('href="/#/home" data-desk-link'));
  const configuredDesk = new URL(base + "/?from=dict&label='quoted'#/home").href;
  const configuredPreview = await preview(configuredDesk);
  const standaloneBase = previewURL(configuredPreview);
  const configuredHTML = await (await fetch(standaloneBase + '/')).text();
  assert.equal((configuredHTML.match(/data-desk-link/g) || []).length, 2);
  assert(configuredHTML.includes('&amp;label=%27quoted%27'), 'HTML attribute is escaped after URL normalization');
  assert(!configuredHTML.includes('href="/#/home" data-desk-link'));
  assert.deepEqual(await (await fetch(standaloneBase + '/api/roots?q=ped')).json(), (await json('/dict/api/roots?q=ped')).data);
  assert.deepEqual(await (await fetch(standaloneBase + '/api/root?id=dict%3ARdict')).json(), dictRoot);
  results.checks.push('standalone: same discovery APIs, default NAS desk, configured return, protocol rejection and escaping');

  const pw = require(process.env.TFL_PLAYWRIGHT || 'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
  browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  for (const [width, height] of [[1440, 900], [390, 844], [320, 740]]) {
    const ctx = await context({ width, height }, [base, standaloneBase]);
    const page = await ctx.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.stack || e.message));
    await page.goto(base + '/dict?node=' + encodeURIComponent('Ldict:contradict') + '&view=lookup');
    assert.equal(new URL(page.url()).pathname, '/dict/');
    assert.equal(new URL(page.url()).searchParams.get('node'), 'Ldict:contradict');
    await page.locator('.word-title h2').waitFor();
    assert.equal(await page.locator('.word-title h2').textContent(), 'contradict');
    assert((await page.locator('.root-answer').textContent()).includes('dict'));
    assert(await page.locator('.alliance-word.clickable').count() >= 78);
    const requests = [];
    page.on('request', r => { if (r.url().includes('/api/')) requests.push(r.url()); });
    await page.evaluate(() => document.querySelectorAll('.alliance-branch').forEach(d => d.open = true));
    const target = page.locator('.alliance-word.clickable:not(.selected):visible').first();
    const targetId = await target.getAttribute('data-word');
    const targetWord = await target.locator('b').textContent();
    assert(targetId && targetId !== 'Ldict:contradict');
    assert(targetWord && targetWord !== 'contradict');
    const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/dict/api/learning' && new URL(r.url()).searchParams.get('id') === targetId && r.status() === 200);
    await target.click(); await loaded;
    await page.waitForFunction(word => document.querySelector('.word-title h2')?.textContent === word, targetWord);
    assert.equal(await page.locator('.word-title h2').textContent(), targetWord);
    assert(requests.length > 0, 'cross-word click must make API requests');
    assert(requests.every(u => new URL(u).pathname.startsWith('/dict/api/')), 'all calls stay under /dict/api');
    assert(requests.some(u => new URL(u).searchParams.get('id') === targetId), 'request targets the clicked word');
    const returnSelector = width <= 700 ? '.mobile-brand .mobile-desk-link[data-desk-link]' : '.side-footer [data-desk-link]';
    assert.equal(await page.locator(returnSelector).getAttribute('href'), '/#/home');
    await clickReturn(page, returnSelector, base + '/#/home');
    await page.locator(width <= 700 ? '.mobile-tabs [data-view="graph"]' : '.sidebar [data-view="graph"]').click();
    await page.locator('.map-node').first().waitFor();
    assert(await page.locator('#root-select option').count() >= 42);
    await page.locator('#root-select').selectOption('dict:Rdict');
    await page.waitForFunction(() => document.querySelectorAll('[data-root-word]').length === 73 && new URL(location.href).searchParams.get('root') === 'dict:Rdict');
    assert.equal(await page.locator('[data-root-word="Ldict:teach"]').count(), 1);
    assert.equal(await page.locator('[data-root-word="Ldict:condition"]').count(), 1);
    await page.locator('[data-root-word="Ldict:condition"]').click();
    await page.waitForFunction(() => document.querySelector('.word-title h2')?.textContent === 'condition');
    const lookupNav = width <= 700 ? '.mobile-tabs' : '.sidebar';
    await page.locator('#search').fill('dict-');
    await page.locator('#search-form button').click();
    await page.locator('.search-results [data-pick-root="dict:Rdict"]').waitFor();
    await page.locator('.search-results [data-pick-root="dict:Rdict"]').click();
    await page.waitForFunction(() => !document.querySelector('#graph-view').hidden && document.querySelectorAll('[data-root-word]').length === 73);
    await page.reload();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('root') === 'dict:Rdict' && document.querySelectorAll('[data-root-word]').length === 73 && !document.querySelector('#graph-view').hidden);
    await page.locator('#root-search').fill('ped');
    await page.locator('#root-search-form button').click();
    await page.waitForFunction(() => document.querySelectorAll('#root-select option').length === 3);
    await page.locator('#root-select').selectOption('cfcm-02:RpedFoot');
    await page.waitForFunction(() => document.querySelectorAll('[data-root-word]').length === 18 && document.querySelector('#alliance-root-select')?.value === 'RpedFoot');
    assert.match(await page.locator('#root-members').textContent(), /脚/);
    await page.locator('#root-search').fill('no-such-root');
    await page.locator('#root-search-form button').click();
    await page.waitForFunction(() => document.querySelector('#root-members').textContent.includes('暂未收录'));
    assert.equal(new URL(page.url()).searchParams.get('root'), null);
    assert.equal(await page.locator('.graph-grid').isVisible(), false);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root-members').textContent.includes('暂未收录'));
    assert.equal(await page.locator('.graph-grid').isVisible(), false);
    assert.equal(await page.locator('#root-search').inputValue(), 'no-such-root');
    await page.locator('.family-directory summary').click();
    for (const n of [1, 2, 3]) {
      const family = 'alliance:cfcm-0' + n;
      await page.locator('[data-family="' + family + '"]').click();
      await page.waitForFunction(id => document.querySelector('#family-switch button.active')?.dataset.family === id && document.querySelector('#alliance-root-select')?.value === '@all', family);
      assert((await page.locator('#graph-detail').textContent()).includes('第' + n + '课'));
    }
    // A pending filter must not reopen its root after the user switches course.
    let releaseFilter;
    const filterGate = new Promise(resolve => { releaseFilter = resolve; });
    await page.route('**/dict/api/roots?q=fix', async route => { await filterGate; await route.continue(); });
    await page.locator('#root-search').fill('fix');
    await Promise.all([page.waitForRequest(r => r.url().endsWith('/dict/api/roots?q=fix')), page.locator('#root-search-form button').click()]);
    await page.locator('[data-family="alliance:cfcm-03"]').click();
    await page.waitForFunction(() => document.querySelector('#family-switch button.active')?.dataset.family === 'alliance:cfcm-03' && !document.querySelector('#graph-view').hidden);
    const filterDone = page.waitForResponse(r => r.url().endsWith('/dict/api/roots?q=fix'));
    releaseFilter();await filterDone;
    assert((await page.locator('#graph-detail').textContent()).includes('第3课'));
    await page.unroute('**/dict/api/roots?q=fix');
    // A slow earlier root selection must not replace a newer one.
    let releaseRoot;
    const rootGate = new Promise(resolve => { releaseRoot = resolve; });
    await page.route('**/dict/api/root?id=cfcm-01%3ARfix', async route => { await rootGate; await route.continue(); });
    await page.locator('#root-search').fill('');
    await page.locator('#root-search-form button').click();
    await page.waitForFunction(() => document.querySelectorAll('#root-select option').length >= 42);
    await page.locator('#root-select').selectOption('cfcm-01:Rfix');
    await page.locator('#root-select').selectOption('cfcm-03:Rbio');
    await page.waitForFunction(() => document.querySelectorAll('[data-root-word]').length === 29 && document.querySelector('#alliance-root-select')?.value === 'Rbio');
    const rootDone = page.waitForResponse(r => r.url().endsWith('/dict/api/root?id=cfcm-01%3ARfix'));
    releaseRoot();await rootDone;
    await page.unroute('**/dict/api/root?id=cfcm-01%3ARfix');
    assert.match(await page.locator('#root-members h2').textContent(), /bios/);
    // An old member callback must not switch a newer root view back to lookup.
    await page.locator('#root-select').selectOption('dict:Rdict');
    await page.waitForFunction(() => document.querySelectorAll('[data-root-word]').length === 73 && !document.querySelector('#graph-view').hidden);
    let releaseMember;
    const memberGate = new Promise(resolve => { releaseMember = resolve; });
    await page.route('**/dict/api/learning?id=Ldict%3Acondition', async route => { await memberGate; await route.continue(); });
    await Promise.all([page.waitForRequest(r => r.url().endsWith('/dict/api/learning?id=Ldict%3Acondition')), page.locator('[data-root-word="Ldict:condition"]').click()]);
    await page.locator(lookupNav + ' [data-view="graph"]').click();
    await page.locator('#root-select').selectOption('cfcm-03:Rbio');
    await page.waitForFunction(() => document.querySelector('#alliance-root-select')?.value === 'Rbio' && !document.querySelector('#graph-view').hidden);
    const memberDone = page.waitForResponse(r => r.url().endsWith('/dict/api/learning?id=Ldict%3Acondition'));
    releaseMember();await memberDone;
    await page.unroute('**/dict/api/learning?id=Ldict%3Acondition');
    assert.equal(await page.locator('#graph-view').isVisible(), true);
    assert.match(await page.locator('#root-members h2').textContent(), /bios/);
    const overflow = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }));
    assert(overflow.s <= overflow.w, JSON.stringify(overflow));
    const shot = path.join(out, 'dict-' + width + '.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot }); results.screenshots.push(shot);
    assert.deepEqual(errors, []);

    const shell = await ctx.newPage();
    await shell.goto(base + '/#/home');
    // boot() calls route() after loading records/checkpoints; wait before opening the menu.
    await shell.waitForFunction(() => typeof document.getElementById('cp-bell')?.onclick === 'function');
    const entry = shell.locator('.nav a.nav-ext[href="/dict/"]');
    assert.equal(await entry.locator('.nv-t').textContent(), '词根词典');
    assert.equal(await entry.getAttribute('target'), '_blank');
    if (width <= 700) {
      await shell.locator('#nav-burger').click();
      assert.equal(await shell.locator('#nav-burger').getAttribute('aria-expanded'), 'true');
      assert.equal(await shell.locator('.top').evaluate(el => el.classList.contains('nav-open')), true);
    }
    const [dictionary] = await Promise.all([shell.waitForEvent('popup'), entry.click()]);
    await dictionary.waitForURL(base + '/dict/');
    await dictionary.locator('#search-form').waitFor();
    assert.equal(shell.url(), base + '/#/home', 'main desk remains open');
    if (width <= 700) {
      assert.equal(await shell.locator('#nav-burger').getAttribute('aria-expanded'), 'false');
      assert.equal(await shell.locator('.top').evaluate(el => el.classList.contains('nav-open')), false);
    }
    await clickReturn(dictionary, returnSelector, base + '/#/home');

    const previewPage = await ctx.newPage();
    await previewPage.goto(standaloneBase + '/?node=Ldict%3Acontradict&view=lookup');
    await previewPage.locator('.word-title h2').waitFor();
    assert.equal(await previewPage.locator(returnSelector).getAttribute('href'), configuredDesk);
    await clickReturn(previewPage, returnSelector, configuredDesk);
    await ctx.close();
    results.checks.push(width + ': no-slash deep link, real cross-word request+title, visible desk return, dictionary entry popup' + (width <= 700 ? '+menu collapse' : '') + ', standalone configured return, no overflow/errors');
  }
  results.ok = true;
})().catch(e => { results.errors.push(e.stack || e.message); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    for (const s of previews) await new Promise(resolve => { s.close(resolve); s.closeAllConnections(); });
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill(); await exited.catch(() => {});
    }
    results.exit_code = results.ok ? 0 : 1;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'dict-result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
    process.exitCode = results.exit_code;
  });
