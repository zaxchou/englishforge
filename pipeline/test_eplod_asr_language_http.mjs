import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const APP_PORT = 8189, FAKE_PORT = 8190;
const seen = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let j = {}; try { j = JSON.parse(body); } catch {}
    const um = j?.messages?.find(m => m?.role === 'user');
    const audio = um?.content?.[0]?.input_audio?.data || '';
    const sys = j?.messages?.find(m => m?.role === 'system');
    const raw = Buffer.from(String(audio).split(',').pop() || '', 'base64').toString('utf8');
    const hint = j?.asr_options?.language || '';
    const ctx = typeof sys?.content === 'string' ? sys.content : '';
    seen.push({ raw, hint, ctx });
    const send = (status, content) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(content));
    };
    if (raw === 'ja') return send(200, { choices: [{ message: { content: 'ここで左に曲がってください' } }] });
    if (raw === 'fallback') {
      if (hint) return send(400, { error: { message: 'unsupported parameter: language' } });
      return send(200, { choices: [{ message: { content: 'Turn left here' } }] });
    }
    if (raw === 'noctx') {
      if (ctx) return send(400, { error: { message: 'unsupported parameter: system context' } });
      return send(200, { choices: [{ message: { content: 'Arthur, that\'s the bathroom.' } }] });
    }
    return send(200, { choices: [{ message: { content: 'Turn left here' } }] });
  });
});
let app, tmp;
const wait = async url => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('server did not start');
};
test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-asr-lang-'));
  const build = path.join(tmp, 'build');
  fs.mkdirSync(path.join(build, 'eplod'), { recursive: true });
  fs.writeFileSync(path.join(build, 'manifest.json'), JSON.stringify({ sets: [] }));
  fs.writeFileSync(path.join(build, 'eplod', '0016.json'), JSON.stringify({ dialogue: [{ spk: 'A', text: "Arthur, that's the bathroom.", t0: 1, t1: 3 }] }));
  await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
  app = spawn(process.execPath, ['server.mjs', '--port', String(APP_PORT), '--records', tmp, '--build', build], {
    cwd: ROOT,
    env: { ...process.env, TFL_ASR_KEY: 'test-key', TFL_ASR_URL: `http://127.0.0.1:${FAKE_PORT}/api/v1/services/aigc/multimodal-generation/generation` },
    stdio: 'ignore',
  });
  await wait(`http://127.0.0.1:${APP_PORT}/api/health`);
});
test.after(async () => {
  try { app?.kill(); } catch {}
  await new Promise(r => fake.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
const asr = (raw, extra = {}) => fetch(`http://127.0.0.1:${APP_PORT}/api/eplod/asr`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ audio: 'data:audio/wav;base64,' + Buffer.from(raw).toString('base64'), ...extra }),
});
test('English audio returns text and the request carries an English hint', async () => {
  seen.length = 0;
  const r = await asr('ok');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, 'Turn left here');
  assert.equal(seen[0].hint, 'en');
  assert.equal(seen[0].ctx, '', 'No context without ep/i');
});
test('Japanese transcription is rejected as a language miss, not scored text', async () => {
  seen.length = 0;
  const r = await asr('ja');
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.equal(j.code, 'asr_not_english');
  assert.equal(j.text, undefined);
});
test('endpoint rejecting the language parameter still works on retry', async () => {
  seen.length = 0;
  const r = await asr('fallback');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, 'Turn left here');
  assert.deepEqual(seen.map(x => x.hint), ['en', '']);
});
test('recording with ep/i biases the ASR with the official sentence as context', async () => {
  seen.length = 0;
  const r = await asr('ok', { ep: '0016', i: 0 });
  assert.equal(r.status, 200);
  assert.equal(seen[0].ctx, '"Arthur, that\'s the bathroom."', 'System context carries the official line');
  assert.equal(seen[0].hint, 'en');
  assert.equal(seen.length, 1, 'Accepted context needs no retry');
});
test('endpoint rejecting context falls back to a plain request and still transcribes', async () => {
  seen.length = 0;
  const r = await asr('noctx', { ep: '0016', i: 0 });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, 'Arthur, that\'s the bathroom.');
  assert.deepEqual(seen.map(x => x.ctx), ['"Arthur, that\'s the bathroom."', '']);
  assert.deepEqual(seen.map(x => x.hint), ['en', 'en']);
});
test('invalid ep/i is ignored instead of breaking recognition', async () => {
  seen.length = 0;
  const r = await asr('ok', { ep: '16', i: 999 });
  assert.equal(r.status, 200);
  assert.equal(seen[0].ctx, '');
  assert.equal(seen.length, 1);
});
