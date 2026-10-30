import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-course-plan-'));
const records = path.join(dir, 'records'), build = path.join(dir, 'build'), data = path.join(dir, 'data');
for (const d of [records, build, data]) fs.mkdirSync(d);
const now = Date.now();
const qz = { v: 2, course: 'ndf-01', lessonNo: 1, at: now - 100000, bad: ['q4'], questions: [
  { id: 'q1', stem: 'one', options: { A: 'yes', B: 'no' }, answer: 'A' },
  { id: 'q2', stem: 'two', options: { A: 'yes', B: 'no' }, answer: 'B' },
  { id: 'q3', tier: 'ext', stem: 'extension', options: { A: 'yes', B: 'no' }, answer: 'A' },
  { id: 'q4', stem: 'bad', options: { A: 'yes', B: 'no' }, answer: 'A' }] };
const quizzes = { 'ndf-01-01': qz, 'cfcm-01-01': { ...structuredClone(qz), course: 'cfcm-01', src: 'official' } };
const quizFile = path.join(records, 'generated-quizzes.json');
fs.writeFileSync(quizFile, JSON.stringify({ items: quizzes }));
fs.writeFileSync(path.join(records, 'records.json'), JSON.stringify({ version: 1, attempts: { 'gen/ndf-01/1/quiz/4': { n: 1, history: [] } }, course: { 'ndf-01-01': { done: true } }, study: {}, qtimes: {}, mistakes: {}, families: {}, writing: {}, drafts: {}, feedback: [] }));
let server, base;
async function start() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  server = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port', String(port), '--records', records, '--build', build, '--data', data, '--root', dir], {
    env: { ...process.env, TFL_SIBLING_ROOT: dir, TFL_TLS_KEY: '', TFL_TLS_CERT: '', TFL_AI_KEY: '', TFL_ASR_KEY: '', TFL_TTS_KEY: '', QWEN_TTS_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('startup timeout: ' + logs)), 10000);
    server.once('exit', code => { clearTimeout(timer); reject(Error('startup exit ' + code + ': ' + logs)); });
    server.stderr.on('data', b => { logs += b; });
    server.stdout.on('data', b => { logs += b; const m = logs.match(/http:\/\/localhost:(\d+)/); if (m) { clearTimeout(timer); base = 'http://127.0.0.1:' + m[1]; resolve(); } });
  });
}
async function stop() { if (!server || server.exitCode !== null) return; const done = once(server, 'exit'); server.kill(); await done; server = null; }
async function call(route, input, headers = {}) {
  const res = await fetch(base + route, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  return { status: res.status, data: await res.json() };
}
const get = () => call('/api/course-plan');
const startRound = lid => call('/api/course-plan/start', { lessonId: lid });
const finish = (id, rating = 'good') => call('/api/course-plan/finish', { lessonId: 'ndf-01-01', roundId: id, rating });
let seq = 0;
function attempt(round, no, letter, phase = 'main', extra = {}) {
  return { id: 'course-plan-event-' + ++seq, ref: { qid: 'gen/ndf-01/1/quiz/' + no, set: 'gen', subj: 'ndf-01', mk: '1', gkey: 'quiz' },
    planRound: round, planPhase: phase, answer: letter, ok: letter !== 'A', t: now - 5000, secs: 2, ...extra };
}
async function fault(action) {
  const file = path.join(records, 'records.json'), held = file + '.held';
  fs.renameSync(file, held); fs.mkdirSync(file);
  try { return await action(); } finally { fs.rmdirSync(file); fs.renameSync(held, file); }
}
test('isolated course-plan HTTP lifecycle, concurrency, conflicts, persistence and snapshots', async () => {
  try {
    await start();
    // GET migration itself follows persist-before-ack.
    assert.equal((await fault(get)).status, 503);
    assert.equal((await call('/api/records')).data.coursePlan, undefined);
    let res = await get(); assert.equal(res.status, 200); assert.equal(res.data.settings.target, 3);
    assert.deepEqual(res.data.recommendations, ['ndf-01-01']); assert.deepEqual(res.data.availableLessonIds.sort(), ['cfcm-01-01', 'ndf-01-01']);
    const activation = res.data.activationAt;
    assert.equal((await startRound('vince-01-01')).status, 404);
    assert.equal((await call('/api/course-plan/start', { lessonId: 'ndf-01-01' }, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await startRound('__proto__')).status, 404);
    assert.equal((await fault(() => startRound('ndf-01-01'))).status, 503);
    assert.equal((await get()).data.plans['ndf-01-01'].active, null);
    const starters = await Promise.all([startRound('ndf-01-01'), startRound('ndf-01-01')]);
    const id = starters[0].data.plan.active.id; assert.equal(starters[1].data.plan.active.id, id);
    assert.deepEqual(starters[0].data.plan.active.order, ['q1', 'q2']); assert.equal(starters[0].data.plan.active.step, 'q1');
    assert.equal((await finish(id)).status, 409);
    const first = attempt(id, 1, 'B', 'main', { ok: true });
    assert.equal((await fault(() => call('/api/records/attempt', first))).status, 503);
    assert.equal((await call('/api/records')).data.attempts[first.ref.qid], undefined);
    const parallel = await Promise.all([call('/api/records/attempt', first), call('/api/records/attempt', first)]);
    assert.ok(parallel.every(r => r.status === 200 && r.data.attempt.n === 1));
    assert.equal(parallel[0].data.plan.active.answers.q1.ok, false); assert.equal(parallel[0].data.attempt.right, 0);
    assert.equal((await call('/api/records/attempt', { ...first, answer: 'A' })).status, 409);
    const otherDevice = await call('/api/records/attempt', attempt(id, 1, 'A'));
    assert.equal(otherDevice.data.attempt.n, 2); assert.equal(otherDevice.data.plan.active.answers.q1.letter, 'B');
    const autonomous = attempt(undefined, 2, 'B'); delete autonomous.planRound; delete autonomous.planPhase;
    const before = (await call('/api/records')).data.coursePlan;
    assert.equal((await call('/api/records/attempt', autonomous)).status, 200);
    assert.deepEqual((await call('/api/records')).data.coursePlan, before);
    assert.equal((await finish(id)).data.code, 'round_incomplete');
    const ext = attempt(id, 3, 'A'); res = await call('/api/records/attempt', ext);
    assert.equal(res.status, 409); assert.equal(res.data.attemptSaved, true); assert.equal(typeof res.data.planError, 'string'); assert.equal(res.data.attempt.n, 1);
    assert.equal((await call('/api/records/attempt', ext)).data.attempt.n, 1);
    res = await call('/api/records/attempt', attempt(id, 2, 'B', 'main', { unsure: true, ok: false }));
    assert.equal(res.data.plan.active.phase, 'correction'); assert.equal(res.data.attempt.right, 2); // ordinary autonomous answer plus this answer
    await stop(); await start();
    res = await startRound('ndf-01-01'); assert.equal(res.data.plan.active.id, id); assert.equal(res.data.plan.active.step, 'q1');
    assert.equal((await call('/api/records/attempt', first)).data.plan.active.phase, 'correction');
    await call('/api/records/attempt', attempt(id, 1, 'B', 'correction'));
    res = await call('/api/records/attempt', attempt(id, 2, 'A', 'correction'));
    assert.equal(res.data.plan.active.phase, 'finish'); assert.equal(res.data.plan.active.step, null);
    assert.equal((await fault(() => finish(id))).status, 503);
    assert.equal((await get()).data.plans['ndf-01-01'].stamps.length, 0);
    const ends = await Promise.all([finish(id, 'hard'), finish(id, 'easy')]);
    assert.ok(ends.every(x => x.status === 200 && x.data.plan.stamps.length === 1));
    const stamp = ends[0].data.plan.stamps[0]; assert.equal(stamp.right, 1); assert.equal(stamp.total, 2); assert.ok(['hard', 'easy'].includes(stamp.rating)); assert.equal(ends[1].data.plan.stamps[0].rating, stamp.rating);
    assert.ok(stamp.at >= now); assert.equal(ends[0].data.plan.due, stamp.at + 3 * 86400000);
    assert.equal((await startRound('ndf-01-01')).data.code, 'plan_not_due');
    res = await get(); assert.equal(res.data.todayCompleted, 1); assert.equal(res.data.remainingToday, 0);
    let snap = (await call('/api/records')).data; const realPlan = structuredClone(snap.coursePlan);
    snap = { ...snap, attemptProtocol: 2, snapshotId: 'course-plan-snapshot-1', coursePlan: { settings: { target: 99 }, plans: {} } };
    assert.equal((await call('/api/records', snap)).status, 200);
    assert.deepEqual((await call('/api/records')).data.coursePlan, realPlan);
    const cfg = { target: 1, intervals: [], mode: 'fixed', daily: 5, revision: 0 };
    assert.equal((await fault(() => call('/api/course-plan/settings', cfg))).status, 503);
    assert.equal((await get()).data.settings.revision, 0);
    const edits = await Promise.all([call('/api/course-plan/settings', cfg), call('/api/course-plan/settings', cfg)]);
    assert.deepEqual(edits.map(x => x.status).sort(), [200, 409]);
    assert.equal((await get()).data.plans['ndf-01-01'].complete, true);
    assert.equal((await finish(id)).data.plan.stamps.length, 1);
    assert.equal((await call('/api/course-plan/settings', { ...cfg, revision: 1, target: 3, intervals: [1, 60] })).status, 200);
    assert.equal((await call('/api/course-plan/settings', { ...cfg, revision: 2, daily: 0 })).status, 400);
    // A stale round saves ordinary exercise evidence exactly once and returns the current plan on replay.
    const stale = attempt(id, 1, 'A'); res = await call('/api/records/attempt', stale);
    assert.equal(res.status, 409); assert.equal(res.data.attemptSaved, true); assert.equal(res.data.code, 'round_mismatch');
    const n = res.data.attempt.n; assert.equal((await call('/api/records/attempt', stale)).data.attempt.n, n);
    // Reconcile a live round after a question update, retaining earned stamps and discarding its answers.
    const cf = await startRound('cfcm-01-01'); const cfId = cf.data.plan.active.id;
    const cfEvent = { ...attempt(cfId, 1, 'A'), ref: { qid: 'gen/cfcm-01/1/quiz/1' } };
    assert.equal((await call('/api/records/attempt', cfEvent)).status, 200);
    await stop(); quizzes['cfcm-01-01'].questions[0].answer = 'B';
    fs.writeFileSync(quizFile, JSON.stringify({ items: quizzes })); await start();
    res = await call('/api/records/attempt', { ...cfEvent, id: 'course-plan-drift-event-001' });
    assert.equal(res.status, 409); assert.equal(res.data.attemptSaved, true); assert.notEqual(res.data.plan.active.id, cfId);
    assert.deepEqual(res.data.plan.active.answers, {}); assert.equal(res.data.attempt.history.at(-1).ok, false);
    const driftId = res.data.plan.active.id;
    assert.equal((await get()).data.plans['cfcm-01-01'].active.id, driftId);
    assert.equal((await get()).data.plans['ndf-01-01'].stamps.length, 1);
    await stop(); await start(); assert.equal((await get()).data.activationAt, activation);
    assert.equal((await get()).data.plans['cfcm-01-01'].active.id, driftId);
    assert.equal((await call('/api/records/attempt', stale)).status, 409);
    assert.equal((await call('/api/records/attempt', stale)).data.attempt.n, n);
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
