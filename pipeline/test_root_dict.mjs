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
(async () => {
  await start();
  // Static page + assets, same-origin relative paths, CSP parity with the approved preview.
  const page = await get('/dict/');
  assert.equal(page.status, 200); assert.match(page.body, /href="style\.css"/); assert.match(page.body, /src="app\.js"/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await get('/dict/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await get('/dict/style.css')).status, 200);
  assert.equal((await get('/dict/nope.js')).status, 404);
  // API surface mirrors the 8036 preview, namespaced under /dict/api.
  const health = await json('/dict/api/health');
  assert.equal(health.status, 200); assert.ok(health.data.ok); assert.match(health.data.version, /^v-[a-f0-9]{64}$/);
  const graph = await json('/dict/api/graph');
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
  const evidence = graph.data.nodes.find(n => n.type === 'senses');
  const source = await json('/dict/api/source?id=' + encodeURIComponent(evidence.evidence_ids?.[0] || 'e0001'));
  assert([200, 404].includes(source.status), 'source endpoint responds');
  const neighbors = await json('/dict/api/neighbors?id=' + encodeURIComponent('P0001:s0001'));
  assert.equal(neighbors.status, 200); assert.equal(neighbors.data.found, true);
  // Read-only + parameter discipline.
  assert.equal((await get('/dict/api/graph', { method: 'POST' })).status, 405);
  assert.equal((await json('/dict/api/search?q=a&q=b')).status, 400);
  assert.equal((await json('/dict/api/search?q=a&extra=1')).status, 400);
  assert.equal((await json('/dict/api/nope')).status, 404);
  assert.equal((await json('/dict/api/learning?id=' + encodeURIComponent('x').repeat(90))).status, 400);
  assert.equal((await get('/dict/api/search?q=' + '%00')).status, 400);
  // Main app unchanged and carries the new sidebar entry.
  const home = await get('/');
  assert.equal(home.status, 200); assert.match(home.body, /href="\/dict\/"[^>]*rel="noopener"/);
  assert.equal((await json('/api/health')).data.ok, true);
  results.checks.push('http: /dict/ static+CSP, api surface, search/learning fallback, node/neighbors/source, read-only + params, main app intact');
  // Real browser over the mounted page: API base rewrite must reach /dict/api.
  const pw = require(process.env.TFL_PLAYWRIGHT || 'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
  browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    const page = await ctx.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.stack || e.message));
    await page.route('**/api/vocab/tts**', r => r.abort());
    await page.goto(base + '/dict/?node=' + encodeURIComponent('Ldict:contradict') + '&view=lookup');
    await page.locator('.word-title h2').waitFor();
    assert.equal(await page.locator('.word-title h2').textContent(), 'contradict');
    assert((await page.locator('.root-answer').textContent()).includes('dict'));
    assert(await page.locator('.alliance-word.clickable').count() >= 78);
    const requests = [];
    page.on('request', r => { if (r.url().includes('/api/')) requests.push(r.url()); });
    await page.evaluate(() => document.querySelectorAll('.alliance-branch').forEach(d => d.open = true));
    await page.locator('.alliance-word.clickable:visible').first().click();
    await page.locator('.word-title h2').waitFor();
    assert(requests.every(u => u.includes('/dict/api/')), 'all calls stay under /dict/api');
    await page.locator(width <= 700 ? '.mobile-tabs [data-view="graph"]' : '.sidebar [data-view="graph"]').click();
    await page.locator('.map-node').first().waitFor();
    const overflow = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }));
    assert(overflow.s <= overflow.w, JSON.stringify(overflow));
    const shot = path.join(root, 'build/qa/root-universe/fix-20261107/dict-' + width + '.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot }); results.screenshots.push(shot);
    assert.deepEqual(errors, []);
    await ctx.close();
    results.checks.push(width + ': /dict/ lookup, graph panorama, cross-word click under /dict/api, no overflow/errors');
  }
  // Sidebar entry opens the dictionary from the main app.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const shell = await ctx.newPage();
  await shell.goto(base + '/#/home');
  await shell.locator('.nav a.nav-ext[href="/dict/"]').waitFor();
  assert.equal(await shell.locator('.nav a.nav-ext .nv-t').textContent(), '词根词典');
  await ctx.close();
  results.checks.push('main app sidebar carries the dictionary entry');
  results.ok = true;
})().catch(e => { results.errors.push(e.stack || e.message); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) { server.kill(); await once(server, 'exit').catch(() => {}); }
    results.exit_code = results.ok ? 0 : 1;
    const out = path.join(root, 'build/qa/root-universe/fix-20261107');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'dict-result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
    process.exitCode = results.exit_code;
  });
