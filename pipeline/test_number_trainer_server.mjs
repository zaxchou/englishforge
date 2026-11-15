/* 数字听写服务端回归：隔离目录、假音频合成（不调用外部TTS）、幂等与重启持久化。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNumberTrainer } from '../number-trainer.mjs';
import { createStore } from '../number-trainer-store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-srv-'));
const wav = path.join(dir, 'fake.wav');
{
  // 44 字节头 + 0.1s 静音 16bit 单声道 8kHz
  const data = Buffer.alloc(1600);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);h.writeUInt32LE(36 + data.length, 4);h.write('WAVE', 8);h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);h.writeUInt16LE(1, 20);h.writeUInt16LE(1, 22);h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);h.writeUInt16LE(2, 32);h.writeUInt16LE(16, 34);h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(wav, Buffer.concat([h, data]));
}
let synthCalls = 0;
const synth = async () => { synthCalls++;return wav; };

function mkRes() {
  const res = { status: 0, body: null, headers: {}, writeHead(c, h) { this.status = c;Object.assign(this.headers, h || {}); return this; }, end(b) { this.body = b; }, setHeader(k, v) { this.headers[k] = v; } };
  return res;
}
async function call(nt, method, p, body) {
  const res = mkRes();
  const req = { method, headers: { host: '127.0.0.1:8019', 'content-type': 'application/json' }, url: p };
  const sendJSON = (r, code, obj) => { r.writeHead(code);r.end(JSON.stringify(obj)); };
  const sendFile = (rq, r, file) => { r.writeHead(200);r.end(fs.readFileSync(file)); };
  const readBody = async () => Buffer.from(JSON.stringify(body || {}));
  const handled = await nt.handle(req, res, new URL(p, 'http://127.0.0.1').pathname, readBody, sendJSON, sendFile);
  assert.equal(handled, true, 'route handled: ' + p);
  const parsed = (() => { try { return JSON.parse(res.body?.toString() || 'null'); } catch { return null; } })();
  return { status: res.status, data: parsed, raw: res.body };
}

let pass = 0;
const ok = n => { pass++;console.log('ok', n); };

const now = () => Date.parse('2026-11-16T10:00:00Z');
let nt = createNumberTrainer({ recordsDir: dir, ttsConfigured: true, ttsSynth: synth, now, random: (() => { let s = 42;return () => { s = (s * 1664525 + 1013904223) % 4294967296;return s / 4294967296; }; })() });

const cfg = await call(nt, 'GET', '/api/number-trainer/config');
assert.equal(cfg.status, 200);assert.equal(cfg.data.digitMax, 6);assert.equal(cfg.data.tts, true);
ok('config: 能力与版本');

const created = await call(nt, 'POST', '/api/number-trainer/sessions', { mode: 'fixed', digits: 3, count: 10 });
assert.equal(created.status, 200);
assert.equal(created.data.questions.length, 10);
for (const q of created.data.questions) { assert.equal(q.value.length, 3);assert.equal(q.digits, 3);assert.match(q.audioUrl, /^\/api\/number-trainer\/audio\?/); }
ok('session: 固定3位、题数、音频地址');

const sid = created.data.id, qs = created.data.questions;
const audio = await call(nt, 'GET', qs[0].audioUrl);
assert.equal(audio.status, 200);assert.equal(synthCalls, 1);
const badAudio = await call(nt, 'GET', '/api/number-trainer/audio?s=' + sid + '&q=q99');
assert.equal(badAudio.status, 404);
const otherAudio = await call(nt, 'GET', '/api/number-trainer/audio?s=nosuchsession&q=q1');
assert.equal(otherAudio.status, 404);
ok('audio: 仅会话内题目、未知题/会话拒绝');

const wrong = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ev-0001', sessionId: sid, questionId: 'q1', raw: '1', plays: 1, submitMs: 1500, timingValid: true });
assert.equal(wrong.status, 200);assert.equal(wrong.data.result.correct, false);assert(wrong.data.result.errorTags.length > 0);
const dup = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ev-0001', sessionId: sid, questionId: 'q1', raw: '1', plays: 1, submitMs: 1500, timingValid: true });
assert.equal(dup.data.duplicate, true);
const conflict = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ev-0001', sessionId: sid, questionId: 'q1', raw: '2', plays: 1 });
assert.equal(conflict.status, 409);
ok('attempt: 判错归因、同ID幂等、异载荷409');

const right = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ev-0002', sessionId: sid, questionId: 'q2', raw: qs[1].value, plays: 1, submitMs: 2000, timingValid: true });
assert.equal(right.data.result.correct, true);
const assisted = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ev-0003', sessionId: sid, questionId: 'q3', raw: qs[2].value, replay: true, plays: 2, submitMs: 5000, timingValid: true });
assert.equal(assisted.data.result.correct, true);
const skip = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ev-0004', sessionId: sid, questionId: 'q4', skip: true, plays: 1, timingValid: true });
assert.equal(skip.data.result.skip, true);
const format = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ev-0005', sessionId: sid, questionId: 'q5', raw: '1.5' });
assert.equal(format.status, 400);
const empty = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ev-0006', sessionId: sid, questionId: 'q6', raw: '  ' });
assert.equal(empty.status, 400);
ok('attempt: 正确/重听辅助/跳过/非法格式与空答案');

const sum = await call(nt, 'GET', '/api/number-trainer/summary');
assert.equal(sum.data.summary.total.settled, 4, 'settled=错1+对1+辅助1+跳过1');
assert.equal(sum.data.summary.total.independent, 1);
assert.equal(sum.data.summary.total.assisted, 1);
assert.equal(sum.data.summary.total.skipped, 1);
assert.equal(sum.data.summary.total.samples, 1, '只有无辅助的正确题进入时间样本');
assert(sum.data.advice.length > 0);
ok('summary: 分母口径与时间样本分离');

// 错题重练：只出指定错因的新数字
const retry = await call(nt, 'POST', '/api/number-trainer/sessions', { mode: 'fixed', digits: 3, count: 10, focus: ['teenTy', 'zeroGap'] });
assert.equal(retry.status, 200);
assert.equal(retry.data.questions.length, 10);
assert(retry.data.questions.every(q => q.source === 'focus'), 'retry slots are focus');
assert(retry.data.questions.every(q => ['teenTy', 'zeroGap'].includes(q.feature)), 'retry only uses requested features');
assert.equal(new Set(retry.data.questions.map(q => q.value)).size, 10, 'retry uses fresh values');
const mapped = await call(nt, 'POST', '/api/number-trainer/sessions', { mode: 'fixed', digits: 3, count: 5, focus: ['zeroDrop', 'transposition'] });
assert(mapped.data.questions.every(q => ['zeroGap', 'distinctDigits'].includes(q.feature)), 'error tags map to features: ' + mapped.data.questions.map(q => q.feature));
const ignored = await call(nt, 'POST', '/api/number-trainer/sessions', { mode: 'fixed', digits: 2, count: 5, focus: ['not-a-feature'] });
assert.equal(ignored.status, 200);
assert(!ignored.data.questions.every(q => q.source === 'focus'), 'unknown feature falls back to normal plan');
ok('retry: 只出指定错因、新数字、未知特征回退');

// 重启（新实例）后仍能读到
nt = createNumberTrainer({ recordsDir: dir, ttsConfigured: true, ttsSynth: synth, now, random: Math.random });
const sum2 = await call(nt, 'GET', '/api/number-trainer/summary');
assert.equal(sum2.data.summary.total.settled, 4);
const view = await call(nt, 'GET', '/api/number-trainer/sessions/' + sid);
assert.equal(view.status, 200);assert.equal(Object.keys(view.data.answered).length, 4);
ok('restart: 作答与摘要持久化、会话可恢复');

const fin = await call(nt, 'POST', '/api/number-trainer/sessions/' + sid + '/finish', {});
assert.equal(fin.status, 200);assert.equal(fin.data.state, 'finished');
const fin2 = await call(nt, 'POST', '/api/number-trainer/sessions/' + sid + '/finish', {});
assert.equal(fin2.status, 200);
ok('finish: 幂等结束并返回本轮摘要');

const setOk = await call(nt, 'POST', '/api/number-trainer/settings', { mode: 'smart', count: 99, digits: 0 });
assert.equal(setOk.status, 200);assert.equal(setOk.data.config.count, 60);assert.equal(setOk.data.config.digits, 1);
ok('settings: 越界值收敛');

// 坏分卷：明确报错并保留原件
const store = createStore({ recordsDir: dir, now });
const dayFile = path.join(dir, 'number-trainer', 'attempts', '2026-01-01.json');
fs.mkdirSync(path.dirname(dayFile), { recursive: true });
fs.writeFileSync(dayFile, '{broken');
assert.throws(() => store.readDay('2026-01-01'), /NUMBER_TRAINER_STORE_CORRUPT/);
const kept = fs.readdirSync(path.dirname(dayFile)).filter(f => f.includes('corrupt'));
assert.equal(kept.length, 1, '损坏文件被改名保留');
ok('store: 坏分卷报错且保留原件');

// 电话号：逐位播放素材、前导零判分、统计与整数互不污染
const phoneSession = await call(nt, 'POST', '/api/number-trainer/sessions', { mode: 'phone', count: 6, phoneMin: 7, phoneMax: 7 });
assert.equal(phoneSession.status, 200);
assert.equal(phoneSession.data.questions.length, 6);
for (const q of phoneSession.data.questions) {
  assert.equal(q.mode, 'phone');
  assert.equal(q.value.length, 7);
  assert(q.display.includes(' '));
  assert.match(q.audioUrl, /^\/api\/number-trainer\/audio\?s=/);
  assert.match(q.text, /^(zero|one|two|three|four|five|six|seven|eight|nine)( (zero|one|two|three|four|five|six|seven|eight|nine))+$/);
}
for (const d of [0, 5, 9]) {
  const clip = await call(nt, 'GET', '/api/number-trainer/digit-audio?d=' + d);
  assert.equal(clip.status, 200);
  assert.equal(clip.raw.subarray(0, 4).toString('ascii'), 'RIFF');
}
const phoneAudio = await call(nt, 'GET', phoneSession.data.questions[0].audioUrl);
assert.equal(phoneAudio.status, 200);
assert.equal(phoneAudio.raw.subarray(0, 4).toString('ascii'), 'RIFF');
assert(phoneAudio.raw.length > 20000, 'assembled phone audio has content: ' + phoneAudio.raw.length);
assert.equal((await call(nt, 'GET', '/api/number-trainer/digit-audio?d=10')).status, 400);
const pq = phoneSession.data.questions[0];
const phoneOk = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ph-0001', sessionId: phoneSession.data.id, questionId: pq.id, raw: [...pq.value].join(' '), plays: 1, submitMs: 2400, timingValid: true });
assert.equal(phoneOk.data.result.correct, true, '允许空格分隔');
const q2 = phoneSession.data.questions[1];
const phoneBad = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ph-0002', sessionId: phoneSession.data.id, questionId: q2.id, raw: q2.value.slice(0, -1), plays: 1, submitMs: 2600, timingValid: true });
assert.equal(phoneBad.data.result.correct, false, '少一位应判错');
const zeroQ = phoneSession.data.questions.find(q => /^0/.test(q.value));
if (zeroQ) {
  const dropZero = await call(nt, 'POST', '/api/number-trainer/attempt', { eventId: 'ph-0003', sessionId: phoneSession.data.id, questionId: zeroQ.id, raw: zeroQ.value.replace(/^0/, ''), plays: 1, submitMs: 2600, timingValid: true });
  assert.equal(dropZero.data.result.correct, false, '少写前导零应判错');
}
const afterPhone = await call(nt, 'GET', '/api/number-trainer/summary');
assert(afterPhone.data.phone.summary.total.settled >= 2, 'phone stats count');
assert.equal(afterPhone.data.summary.total.settled, sum.data.summary.total.settled, 'integer stats unaffected');
assert(afterPhone.data.phone.advice.length > 0);
ok('电话号: 7位会话、单数字音频、空格容忍、前导零严格、统计分账');

console.log(`\n${pass} groups passed`);
