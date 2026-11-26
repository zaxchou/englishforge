import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import StudyPause from '../web/study-pause.js';

const {EMPTY, projectDue, projectDay} = StudyPause;

test('elapsed projection counts only paused milliseconds between practice and now', () => {
  const state = {revision: 7, windows: [
    {start: 1000, end: 2000},
    {start: 3000, end: 5000},
    {start: 7000, end: 8000},
    {start: 9000, end: null},
  ]};
  assert.equal(projectDue(EMPTY, 6000, 4000, 9500), 6000);
  assert.equal(projectDue(state, 6000, 4000, 4500), 6500);
  assert.equal(projectDue(state, 6000, 4000, 8500), 8000);
  assert.equal(projectDue(state, 6000, 4000, 9500), 8500);
  assert.equal(projectDue(state, 6000, 9250, 9500), 6250);
  assert.equal(projectDue(state, 0, 4000, 9500), 0);
});

test('calendar projection uses Shanghai midnight and excludes the resume date', () => {
  const stamp = '2026-11-01', due = '2026-11-05';
  const start = Date.parse('2026-11-02T15:59:00Z');
  const end = Date.parse('2026-11-02T16:00:00Z');
  const open = {revision: 1, windows: [{start, end: null}]};
  const closed = {revision: 2, windows: [{start, end}]};
  const sameDay = {revision: 2, windows: [{start: start - 60_000, end: start}]};
  assert.equal(projectDay(EMPTY, due, stamp, '2026-11-03'), due);
  assert.equal(projectDay(sameDay, due, stamp, '2026-11-03'), due);
  assert.equal(projectDay(open, due, stamp, '2026-11-02'), due);
  assert.equal(projectDay(open, due, stamp, '2026-11-03'), '2026-11-06');
  assert.equal(projectDay(open, due, stamp, '2026-11-04'), '2026-11-07');
  assert.equal(projectDay(closed, due, stamp, '2026-11-04'), '2026-11-06');
  assert.equal(projectDay(closed, due, '2026-11-03', '2026-11-04'), due);
});

const root = fileURLToPath(new URL('../', import.meta.url));

async function stopServer(server) {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  await exited;
}

async function startServer(dir, records) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const {port} = probe.address();
  await new Promise(resolve => probe.close(resolve));

  const server = spawn(process.execPath, [path.join(root, 'server.mjs'),
    '--port', String(port), '--records', records, '--build', path.join(dir, 'build'),
    '--data', path.join(dir, 'data'), '--root', dir], {
    cwd: root,
    env: {...process.env, TFL_SKIP_ENV_LOCAL: '1', TFL_SIBLING_ROOT: dir,
      TFL_TLS_KEY: '', TFL_TLS_CERT: '', TFL_AI_KEY: '', TFL_ASR_KEY: '',
      TFL_TTS_KEY: '', QWEN_TTS_API_KEY: ''},
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out\n${output}`)), 10_000);
      server.once('error', error => {clearTimeout(timer); reject(error);});
      server.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Server exited (${code ?? signal})\n${output}`));
      });
      const onData = chunk => {
        output += chunk;
        if (output.includes(`http://localhost:${port} `)) {
          clearTimeout(timer);
          resolve();
        }
      };
      server.stdout.on('data', onData);
      server.stderr.on('data', onData);
    });
  } catch (error) {
    await stopServer(server);
    throw error;
  }
  return {server, base: `http://127.0.0.1:${port}`};
}

async function call(base, route, status, input) {
  const init = input === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  };
  const response = await fetch(base + route, {...init, signal: AbortSignal.timeout(5000)});
  const body = await response.json();
  assert.equal(response.status, status, `${init.method ?? 'GET'} ${route} ${JSON.stringify(body)}`);
  return body;
}

function assertPause(body, expected) {
  const {now, ...state} = body;
  assert.ok(Number.isSafeInteger(now) && now > 0);
  assert.deepEqual(state, expected);
}

test('study pause API keeps server-owned history across conflicts, save failures and restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-study-pause-'));
  const records = path.join(dir, 'records');
  const file = path.join(records, 'records.json');
  const route = '/api/study-pause';
  let app;
  const get = () => call(app.base, route, 200);
  const post = (paused, expectedRevision, status = 200) =>
    call(app.base, route, status, {paused, expectedRevision});
  const readDisk = () => fs.readFileSync(file, 'utf8');

  try {
    for (const name of ['records', 'build', 'data']) fs.mkdirSync(path.join(dir, name));
    app = await startServer(dir, records);
    assertPause(await get(), {revision: 0, windows: [], paused: false});

    const opened = await post(true, 0);
    const active = {revision: 1, windows: [{start: opened.now, end: null}], paused: true};
    assertPause(opened, active);
    const {error: conflict, ...current} = await post(false, 0, 409);
    assert.ok(typeof conflict === 'string' && conflict.length > 0);
    assertPause(current, active);
    assertPause(await get(), active);

    const snapshot = await call(app.base, '/api/records', 200);
    const saved = await call(app.base, '/api/records', 200, {
      ...snapshot, writing: snapshot.writing ?? {}, attemptProtocol: 2,
      studyPause: {revision: 99, windows: []},
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.revision, snapshot.revision + 1);
    assertPause(await get(), active);
    const beforeFailure = readDisk();
    assert.deepEqual(JSON.parse(beforeFailure).studyPause, {revision: 1, windows: active.windows});

    // Opening a directory as the atomic-write staging file fails on Windows and Unix.
    const blocker = file + '.tmp';
    fs.mkdirSync(blocker);
    assertPause(await post(true, 1), active);
    assert.equal(readDisk(), beforeFailure);
    const failed = await post(false, 1, 503);
    assert.ok(typeof failed.error === 'string' && failed.error.length > 0);
    assertPause(await get(), active);
    assert.equal(readDisk(), beforeFailure);
    fs.rmdirSync(blocker);

    await stopServer(app.server);
    app = await startServer(dir, records);
    assertPause(await get(), active);
    const resumed = await post(false, 1);
    const closed = {revision: 2, windows: [{start: opened.now, end: Math.max(opened.now, resumed.now)}]};
    assertPause(resumed, {...closed, paused: false});
    assert.deepEqual(JSON.parse(readDisk()).studyPause, closed);
    assertPause(await get(), {...closed, paused: false});
  } finally {
    await stopServer(app?.server);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
