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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-exam-'));
const records = path.join(dir, 'records'), build = path.join(dir, 'build'), data = path.join(dir, 'data');
for (const d of [records, build, data, path.join(build, 'exams')]) fs.mkdirSync(d, {recursive: true});

const lessons = Array.from({length: 48}, (_, i) => ({no: i + 1, id: 'ndf-01-' + String(i + 1).padStart(2, '0'), title: 'Synthetic ' + (i + 1)}));
const questions = Array.from({length: 10}, (_, i) => ({
  id: 'e' + String(i + 1).padStart(2, '0'),
  number: i + 1,
  source: i < 6 ? 'bank' : 'new',
  lessonNo: (i % 48) + 1,
  lessonId: lessons[i % 48].id,
  lessonTitle: lessons[i % 48].title,
  type: ['root', 'meaning', 'collocation', 'cloze'][i % 4],
  stem: 'Synthetic question ' + (i + 1) + '?',
  options: {
    A: {t: 'alpha' + i, note: 'wrong'}, B: {t: 'beta' + i, note: 'right'},
    C: {t: 'gamma' + i, note: 'wrong'}, D: {t: 'delta' + i, note: 'wrong'},
  },
  answer: 'B',
  explain: 'Synthetic explanation ' + (i + 1),
  tags: ['synthetic'], covers: ['alpha' + i],
}));
const paper = {
  version: 1, id: 'ndf-01-final', course: 'ndf-01', courseTitle: 'Synthetic course', title: 'Synthetic final',
  generatedAt: new Date().toISOString(), unlock: {lessons: 48, rule: 'course-complete'},
  rules: {total: 10, untimed: true, types: {root: 3, meaning: 3, collocation: 2, cloze: 2}, options: 4},
  lessons, questions,
};
fs.writeFileSync(path.join(build, 'exams', 'ndf-01-final.json'), JSON.stringify(paper));
fs.writeFileSync(path.join(records, 'records.json'), JSON.stringify({
  version: 1, revision: 1, attempts: {}, qtimes: {}, mistakes: {}, families: {}, writing: {}, drafts: {},
  study: {}, course: Object.fromEntries(lessons.map(l => [l.id, {done: true}])), feedback: [],
}));

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
    server.once('exit', code => {clearTimeout(timer); reject(Error('startup exit ' + code + ': ' + logs));});
    const onData = b => {
      logs += b;
      const m = logs.match(/http:\/\/localhost:(\d+)/);
      if (m) {clearTimeout(timer); base = 'http://127.0.0.1:' + m[1]; resolve();}
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
async function call(route, input) {
  const res = await fetch(base + route, input === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  });
  return {status: res.status, data: await res.json()};
}

test('exam API: unlock, hidden answers, resume, server grading, idempotency and records', async () => {
  await start();
  try {
    const list = await call('/api/exams');
    assert.equal(list.status, 200);
    assert.equal(list.data.exams.length, 1);
    assert.deepEqual(list.data.exams[0].unlock, {done: 48, need: 48, ready: true});
    assert.equal(list.data.exams[0].active, null);

    const paperRes = await call('/api/exams/ndf-01-final');
    assert.equal(paperRes.status, 200);
    assert.equal(paperRes.data.questions.length, 10);
    for (const q of paperRes.data.questions) {
      assert.equal(q.answer, undefined, 'answers are withheld before submit');
      assert.equal(q.explain, undefined, 'explanations are withheld before submit');
      for (const o of Object.values(q.options)) assert.deepEqual(Object.keys(o), ['t'], 'option notes are withheld');
    }

    const started = await call('/api/exams/ndf-01-final/start', {});
    assert.equal(started.status, 200);
    const runId = started.data.run.id;

    const resumed = await call('/api/exams/ndf-01-final/start', {});
    assert.equal(resumed.data.run.id, runId, 'same active run resumes');
    assert.equal(resumed.data.resumed, true);

    for (let i = 0; i < 10; i++) {
      const letter = i < 8 ? 'B' : 'A';
      const r = await call('/api/exams/ndf-01-final/answer', {runId, qid: 'e' + String(i + 1).padStart(2, '0'), letter});
      assert.equal(r.status, 200);
      assert.equal(r.data.saved, true);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.correct, undefined, 'no correctness during the exam');
    }
    const rejected = await call('/api/exams/ndf-01-final/answer', {runId, qid: 'nope', letter: 'A'});
    assert.equal(rejected.status, 400);

    const submitted = await call('/api/exams/ndf-01-final/submit', {runId});
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.result.correct, 8);
    assert.equal(submitted.data.result.total, 10);
    assert.equal(submitted.data.result.score, 0.8);
    assert.equal(submitted.data.result.items[8].ok, false);
    assert.equal(submitted.data.result.items[8].answer, 'B');
    assert.ok(submitted.data.result.items[8].explain.includes('Synthetic'));

    const again = await call('/api/exams/ndf-01-final/submit', {runId});
    assert.equal(again.status, 200);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.result.correct, 8, 'idempotent submit');

    const after = JSON.parse(fs.readFileSync(path.join(records, 'records.json'), 'utf8'));
    assert.equal(Object.keys(after.attempts).length, 10);
    assert.equal(Object.keys(after.mistakes).length, 2);
    const wrong = after.mistakes['exam/ndf-01-final/e09'];
    assert.equal(wrong.stem, 'Synthetic question 9?');
    assert.equal(wrong.set, 'exam');
    assert.equal(wrong.lessonId, 'ndf-01-09');
    assert.equal(wrong.n_wrong, 1);
    assert.ok(wrong.due > wrong.added);

    const listed = await call('/api/exams');
    assert.equal(listed.data.exams[0].last.correct, 8);
    assert.equal(listed.data.exams[0].active, null);

    const runsFile = JSON.parse(fs.readFileSync(path.join(records, 'exam-runs.json'), 'utf8'));
    assert.equal(runsFile.exams['ndf-01-final'].runs.length, 1);
    assert.equal(runsFile.exams['ndf-01-final'].active, null);

    const detail = await call('/api/exams/ndf-01-final/runs/' + runId);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.result.items.length, 10);
    assert.equal(detail.data.result.items[0].options.A.note, 'wrong');
  } finally {
    await stop();
  }
});

test('exam API: draft survives restart, locked course refuses to start, snapshots cannot wipe runs', async () => {
  await start();
  try {
    const second = await call('/api/exams/ndf-01-final/start', {});
    const runId = second.data.run.id;
    await call('/api/exams/ndf-01-final/answer', {runId, qid: 'e01', letter: 'B', unsure: true});
    await stop();
    await start();
    const resumed = await call('/api/exams/ndf-01-final');
    assert.equal(resumed.data.active.id, runId);
    assert.deepEqual(resumed.data.active.answers, {e01: 'B'});
    assert.deepEqual(resumed.data.active.unsure, {e01: true});

    /* 全量快照不能清掉考试草稿/成绩(独立文件) */
    const snapshot = await call('/api/records', {
      ...JSON.parse(fs.readFileSync(path.join(records, 'records.json'), 'utf8')), attemptProtocol: 2, revision: 2,
    });
    assert.equal(snapshot.status, 200);
    const stillThere = await call('/api/exams/ndf-01-final');
    assert.equal(stillThere.data.active.id, runId);

    /* 学完 47 节 → 未解锁 */
    const rec = JSON.parse(fs.readFileSync(path.join(records, 'records.json'), 'utf8'));
    delete rec.course['ndf-01-47'];
    rec.attemptProtocol = 2;
    rec.revision = 3;
    await call('/api/records', rec);
    const locked = await call('/api/exams/ndf-01-final/start', {});
    assert.equal(locked.status, 409);
    assert.equal(locked.data.code, 'exam_locked');
    assert.deepEqual(locked.data.unlock, {done: 47, need: 48, ready: false});
  } finally {
    await stop();
  }
});
