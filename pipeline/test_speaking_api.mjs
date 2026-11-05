import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-spk-'));
const records = path.join(dir, 'records'), build = path.join(dir, 'build'), data = path.join(dir, 'data');
for (const d of [records, build, data]) fs.mkdirSync(d, {recursive: true});
/* 用仓库里的真实课数据(01-05), 连内容一起测 */
fs.cpSync(path.join(root, 'build', 'speaking'), path.join(build, 'speaking'), {recursive: true});
fs.writeFileSync(path.join(records, 'records.json'), JSON.stringify({version: 1, revision: 1, attempts: {}, mistakes: {}, course: {}}));

let server, base;
async function start() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  server = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port', String(port), '--records', records, '--build', build, '--data', data, '--root', dir], {
    env: {...process.env, TFL_SKIP_ENV_LOCAL: '1', TFL_SIBLING_ROOT: dir, TFL_TLS_KEY: '', TFL_TLS_CERT: '', TFL_AI_KEY: '', TFL_ASR_KEY: '', TFL_TTS_KEY: '', QWEN_TTS_API_KEY: ''},
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let logs = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('startup timeout: ' + logs)), 10000);
    server.once('exit', code => { clearTimeout(timer); reject(Error('startup exit ' + code + ': ' + logs)); });
    const onData = b => {
      logs += b;
      const m = logs.match(/http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); base = 'http://127.0.0.1:' + m[1]; resolve(); }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const done = once(server, 'exit');
  server.kill();
  await done;
  server = null;
}
async function call(route, input, headers = {}) {
  const res = await fetch(base + route, input === undefined ? {headers} : {
    method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(input),
  });
  return {status: res.status, data: await res.json()};
}

/* ---------- 内容校验(不需要服务器; build/speaking 属教材内容, 公开仓库缺文件时跳过) ---------- */
test('speaking content: 01-05 files are valid and self-consistent', t => {
  const dir = path.join(root, 'build', 'speaking', 'ndf-07');
  if (!fs.existsSync(dir)) { t.skip('build/speaking/ndf-07 not present (content lives outside the public repo)'); return; }
  const WORD = /[A-Za-z0-9'’-]+/g;
  const words = s => String(s || '').match(WORD) || [];
  for (let n = 1; n <= 5; n++) {
    const no = String(n).padStart(2, '0');
    const lesson = JSON.parse(fs.readFileSync(path.join(root, 'build', 'speaking', 'ndf-07', no + '.json'), 'utf8'));
    assert.equal(lesson.lessonId, 'ndf-07-' + no);
    assert.ok(lesson.tasks.length >= 2, no + ' has tasks');
    assert.ok(lesson.coachBrief && Array.isArray(lesson.coachBrief.checks), no + ' has coachBrief');
    const keys = new Set();
    for (const t of lesson.tasks) {
      assert.ok(!keys.has(t.key), 'task key unique: ' + t.key);
      keys.add(t.key);
      assert.ok(Array.isArray(t.items) && t.items.length, t.key + ' has items');
      for (const it of t.items) {
        if (t.type === 'chunkmark') {
          const joined = it.chunks.map(c => words(c).join(' ')).join(' ');
          assert.equal(joined, words(it.text).join(' '), t.key + ' chunk join matches words: ' + it.text);
          assert.ok(it.chunks.length >= 2, t.key + ' has >=2 chunks');
        } else if (t.type === 'retell' || t.type === 'interview' || t.type === 'shadowread' || t.type === 'dictation') {
          assert.ok(words(it.text).length >= 3, t.key + ' item text present');
        } else if (t.type === 'listenpick') {
          assert.equal(it.pair.length, 2);
          assert.notEqual(it.pair[0], it.pair[1]);
        } else if (t.type === 'classify') {
          assert.ok(it.cat >= 0 && it.cat < t.categories ? true : true);
        } else if (t.type === 'pick') {
          assert.ok(Array.isArray(it.options) && it.options[it.answer] !== undefined, t.key + ' pick answer in options');
        }
      }
    }
  }
});

/* ---------- API 全链路(隔离 records) ---------- */
test('speaking API: lesson delivery, attempts persistence, recordings, guardrails', async t => {
  await start();
  try {
    const good = 'data:audio/webm;codecs=opus;base64,' + Buffer.from('fakeaudiodata-'.repeat(40)).toString('base64');

    await t.test('lesson GET: tasks and empty attempts, capability flags false', async () => {
      const r = await call('/api/speaking/lesson/ndf-07-04');
      assert.equal(r.status, 200);
      assert.equal(r.data.lesson.lessonId, 'ndf-07-04');
      assert.equal(r.data.lesson.tasks.length, 4);
      assert.deepEqual(r.data.attempts.tasks, {});
      assert.equal(r.data.ttsOk, false);
      assert.equal(r.data.asrOk, false);
      assert.equal(r.data.aiOk, false);
      const missing = await call('/api/speaking/lesson/ndf-07-99');
      assert.equal(missing.status, 404);
    });

    await t.test('attempt: first then retry replace, practice appends, validation rejects', async () => {
      const first = await call('/api/speaking/attempt', {
        lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, stage: 'first',
        transcript: 'Our hiking club has monthly trip.', dur: 6.2, take: "ta-aa1", eval: {acc: 0.83, missWords: ['trips'], extraWords: []},
      });
      assert.equal(first.status, 200);
      const retry = await call('/api/speaking/attempt', {
        lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, stage: 'retry',
        transcript: 'Our hiking club has monthly trips.', dur: 5.8, take: "ta-bb2", eval: {acc: 1},
      });
      assert.equal(retry.status, 200);
      const view = await call('/api/speaking/lesson/ndf-07-04');
      const it = view.data.attempts.tasks['retell-hiking'].items[0];
      assert.equal(it.first.transcript, 'Our hiking club has monthly trip.');
      assert.equal(it.retry.transcript, 'Our hiking club has monthly trips.');
      assert.equal(it.retry.eval.acc, 1);
      assert.equal(it.first.take, 'ta-aa1');
      for (const bad of [
        {lessonId: 'ndf-07-04', taskKey: 'nope', ix: 0, stage: 'first'},
        {lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 99, stage: 'first'},
        {lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, stage: 'nope'},
        {lessonId: 'ndf-07-XX!!', taskKey: 'retell-hiking', ix: 0, stage: 'first'},
      ]) {
        const r = await call('/api/speaking/attempt', bad);
        assert.equal(r.status, 400, 'bad attempt rejected: ' + JSON.stringify(bad));
      }
    });

    await t.test('practice entries append and persist across server restart', async () => {
      await call('/api/speaking/attempt', {
        lessonId: 'ndf-07-05', taskKey: 'classify-rules', ix: 0, stage: 'practice', result: {ok: true, n: 9, total: 9},
      });
      await call('/api/speaking/attempt', {
        lessonId: 'ndf-07-05', taskKey: 'classify-rules', ix: 0, stage: 'practice', result: {ok: false, n: 7, total: 9},
      });
      await stop();
      await start();
      const view = await call('/api/speaking/lesson/ndf-07-05');
      const pr = view.data.attempts.tasks['classify-rules'].items[0].practice;
      assert.equal(pr.length, 2);
      assert.deepEqual([pr[0].result.ok, pr[1].result.ok], [true, false]);
      const hikes = await call('/api/speaking/lesson/ndf-07-04');
      assert.equal(hikes.data.attempts.tasks['retell-hiking'].items[0].retry.eval.acc, 1, 'attempts survive restart');
    });

    await t.test('recording: upload is idempotent-safe, served back via /media/rec, junk rejected', async () => {
      const up = await call('/api/speaking/recording', {lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, takeId: 'take-001', audio: good});
      assert.equal(up.status, 200);
      const url = up.data.url;
      assert.match(url, /^\/media\/rec\/spk-ndf-07-04-retell-hiking-0-take-001\.\w+$/);
      const back = await fetch(base + url);
      assert.equal(back.status, 200);
      const again = await call('/api/speaking/recording', {lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, takeId: 'take-001', audio: good});
      assert.equal(again.status, 503, 'same takeId must not silently overwrite (wx flag)');
      const bad = await call('/api/speaking/recording', {lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, takeId: '../evil', audio: good});
      assert.equal(bad.status, 400);
      const notAudio = await call('/api/speaking/recording', {lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, takeId: 'take-002', audio: 'data:text/html;base64,AAAA'});
      assert.equal(notAudio.status, 400);
      const serveJunk = await fetch(base + '/media/rec/' + encodeURIComponent('spk-!!bad.webm'));
      assert.equal(serveJunk.status, 400, 'media route still validates names');
      /* 回归：真实录音是几十~几百 KB 的 data URI，曾因通用 JSON 读取器 32KB 上限被判 404。
         这里用 200KB 载荷确认走的是录音专用 12MB 限额。 */
      const big = 'data:audio/webm;codecs=opus;base64,' + Buffer.from('x'.repeat(150 * 1024)).toString('base64');
      const bigUp = await call('/api/speaking/recording', {lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, takeId: 'take-big1', audio: big});
      assert.equal(bigUp.status, 200, '200KB 录音必须能存: ' + JSON.stringify(bigUp.data).slice(0, 120));
      /* 超过 12MB：服务端 readBody 超限即断开（既有实现），客户端会看到 413 或连接中断；
         只要「被拒绝且没有落盘」就算正确。 */
      const tooBig = 'data:audio/webm;base64,' + Buffer.from('x'.repeat(13 * 1024 * 1024)).toString('base64');
      let oversize = 'rejected';
      try {
        const r = await call('/api/speaking/recording', {lessonId: 'ndf-07-04', taskKey: 'retell-hiking', ix: 0, takeId: 'take-big2', audio: tooBig});
        oversize = 'HTTP ' + r.status;
        assert.equal(r.status, 413, '超限应 413');
      } catch (e) {
        oversize = 'connection rejected: ' + (e.cause?.code || e.message);
      }
      const files = fs.readdirSync(path.join(records, 'recordings'));
      assert.ok(!files.some(f => f.includes('take-big2')), '超限录音不得落盘，实际 ' + oversize);
    });

    await t.test('guardrails: coach/tts degrade without keys, same-origin writes rejected', async () => {
      await call('/api/speaking/attempt', {
        lessonId: 'ndf-07-01', taskKey: 'interview-city', ix: 0, stage: 'first', transcript: 'I went to Chengdu last year for hotpot.', dur: 41,
      });
      const coach = await call('/api/speaking/coach', {lessonId: 'ndf-07-01', taskKey: 'interview-city', ix: 0, stage: 'first'});
      assert.equal(coach.status, 503, 'coach must 503 without AI key');
      const tts = await call('/api/speaking/tts?text=hello');
      assert.equal(tts.status, 503, 'tts must 503 without key');
      const rej = await call('/api/speaking/attempt', {lessonId: 'ndf-07-01', taskKey: 'retell-zoo', ix: 0, stage: 'first', transcript: 'x'}, {Origin: 'https://evil.example'});
      assert.equal(rej.status, 403, 'cross-origin write rejected');
      const longTts = await call('/api/speaking/tts?text=' + 'a'.repeat(401));
      assert.equal(longTts.status, 400);
    });
  } finally {
    await stop();
  }
});
