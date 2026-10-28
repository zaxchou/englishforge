'use strict';

// Run with: node pipeline/test_eplod_recording.cjs
// Execute production function bodies in isolation: no page boot, devices or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const EplodRecords = require('../web/eplod-records.js');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function sourceBetween(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `Missing production source: ${start}`);
  assert.equal(html.indexOf(start, from + start.length), -1, `Ambiguous source: ${start}`);
  const to = html.indexOf(end, from + start.length);
  assert.ok(to > from, `Missing end marker: ${end}`);
  return html.slice(from, to);
}
const production = [
  sourceBetween('function recApply(next)', 'function recBackup('),
  sourceBetween('function epDiff(official,mine)', '/* ---- 四步训练'),
  sourceBetween('function epDay()', 'function epRecoverCover('),
  sourceBetween('function epStamp(i,st=EP.st)', 'function epCoverUpdate('),
  sourceBetween('function epTakeKey(st,i)', 'function epHasReplay('),
  sourceBetween('function epCancelRecording(st=EP.st)', 'function epLeave('),
  sourceBetween('function epSettleTake(take)', 'function epTrainWire(')
].join('\n');
const keyboard = sourceBetween('  EP.keyHandler=e=>{', "  document.addEventListener('keydown',EP.keyHandler);");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function makeHarness({delayMedia = false} = {}) {
  let now = Date.parse('2026-10-26T02:00:00Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const lesson = () => ({drill: {dd: {}, rd: {}, sd: {}, playsS: {}, stampDays: {}}});
  const REC = {course: {'eplod-0001': lesson(), 'eplod-0002': lesson()}};
  REC.course['eplod-0001'].drill.rd[1] = {acc: 0.25, at: 1, last: 'old attempt'};
  REC.course['eplod-0002'].drill.rd[0] = {acc: 0.6, at: 2, rec: 'b-existing.webm', recAt: 2};
  REC.course['eplod-0002'].drill.stampDays['2026-10-25'] = [0];
  const state = (ep, text) => ({
    l: {id: `eplod-${String(ep).padStart(4, '0')}`, ep},
    p: REC.course[`eplod-${String(ep).padStart(4, '0')}`],
    d: {dialogue: [{text: 'unused first sentence', t0: 0, t1: 3}, {text, t0: 3, t1: 6}]},
    active: true, tab: 'train', ai: 1, amode: {1: 'voice'}, lastMode: 'voice', doneOf: () => false
  });
  const A = state(1, 'alpha recording belongs to lesson');
  const B = state(2, 'completely different words over here');
  const EP = {st: A};
  const media = deferred(), asr = deferred(), archive = deferred();
  const asrRequested = deferred(), archiveRequested = deferred();
  const requests = [], recorders = [], saves = [], uiCalls = [], intervals = new Map(), timeouts = new Map();
  const localUrls = [], revokedUrls = [];
  const asrSettled = deferred();
  const tracks = [{stops: 0, stop() { this.stops++; }}, {stops: 0, stop() { this.stops++; }}];
  const stream = {getTracks: () => tracks};
  const response = {innerHTML: ''};
  const card = {isConnected: true, dataset: {i: '1'}, querySelector(selector) {
    if(selector === '.bvoice .dr')return response;
    assert.ok(['.ep-rec .lv i', '.ep-rec .rt'].includes(selector), `Unexpected card selector: ${selector}`);
    return null;
  }};
  let mediaCalls = 0, timerId = 0, closed = 0;
  class Recorder {
    static isTypeSupported(mime) { return mime === 'audio/webm;codecs=opus'; }
    constructor(input, options) {
      assert.equal(input, stream);
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() {
      assert.equal(this.state, 'recording');
      this.state = 'inactive';
      this.ondataavailable({data: new Blob(['in-memory recording'], {type: this.mimeType})});
      // Keep the actual async onstop promise, so assertions cannot race its completion.
      this.finished = this.onstop();
    }
  }
  class AudioContext {
    resume() {}
    createMediaStreamSource() { return {connect() {}}; }
    createAnalyser() {
      return {frequencyBinCount: 256, getByteTimeDomainData(buffer) { buffer.fill(150); }};
    }
    async close() { closed++; }
  }
  class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(bytes => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
        this.onload();
      });
    }
  }
  const ui = name => {
    assert.equal(EP.st, A, `Late A callback updated B UI: ${name}`);
    uiCalls.push(name);
  };
  const box = {
    REC, EP, EplodRecords, Date: Clock, Blob, FileReader, MediaRecorder: Recorder,
    URL: {
      createObjectURL: blob => { const url = `blob:test-recording-${localUrls.length + 1}`;localUrls.push({url, blob});return url; },
      revokeObjectURL: url => revokedUrls.push(url)
    },
    // Do not create real timeout signals or timers in this isolated VM.
    AbortSignal: {timeout: ms => ({timeout: ms})},
    window: {MediaRecorder: Recorder, AudioContext},
    navigator: {mediaDevices: {getUserMedia: async options => {
      assert.deepEqual(clone(options), {audio: true});
      mediaCalls++;
      return delayMedia ? media.promise : stream;
    }}},
    setInterval: fn => { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => {
      assert.equal(ms, 90000, 'Only the recorder safety limit may schedule a timeout');
      const id = ++timerId;timeouts.set(id, fn);return id;
    },
    clearTimeout: id => timeouts.delete(id),
    fetch: () => { throw Error('Real fetch is forbidden'); },
    api: async (url, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      requests.push({url, body: JSON.parse(options.body)});
      if (url === '/api/eplod/asr') { asrRequested.resolve(); return asr.promise; }
      if (url === '/api/eplod/recording') { archiveRequested.resolve(); return archive.promise; }
      throw Error(`Unexpected API: ${url}`);
    },
    recSave: () => saves.push(clone(REC)),
    epRecButton: () => ui('recButton'), epCoverUpdate: () => ui('cover'),
    epStopOriginal: st => { assert.equal(st, A);ui('stopOriginal'); },
    epStopReplay: () => ui('stopReplay'), epNote: () => ui('note'),
    epRefreshSentence: (st, i) => {
      // Match the production UI guard, while keeping the actual ASR/archive/session functions.
      if(EP.st === st && st.active){
        ui('refresh');
        const take = EP.takes?.[`${st.l.id}/${i}`];
        response.innerHTML = take?.processing ? '转写中' : take?.status || '';
      }
      const take = EP.takes?.[`${st.l.id}/${i}`];
      if(take?.status === 'done' && !take.processing)asrSettled.resolve();
    },
    epStepsUpdate: () => ui('steps'), epDockNo: () => ui('dock'),
    epGo: () => { throw Error('Late recording navigated B'); },
    $: id => {
      assert.equal(EP.st, A, `Late A callback accessed B DOM: ${id}`);
      return null;
    }
  };
  vm.createContext(box);
  const recButtonStub = box.epRecButton;
  vm.runInContext(production, box, {filename: 'index.html:recording-functions', timeout: 1000});
  box.epRecButton = recButtonStub;
  const run = code => vm.runInContext(code, box, {timeout: 1000});
  box.card = card;
  return {
    box, REC, EP, A, B, card, response, tracks, recorders, requests, saves, uiCalls,
    media, asr, archive, asrRequested, archiveRequested, asrSettled, intervals, timeouts, localUrls, revokedUrls, run,
    advance: ms => { now += ms; }, mediaCalls: () => mediaCalls, closed: () => closed,
    switchToB() { run('epCancelRecording(EP.st)');A.active = false;EP.st = B;card.isConnected = false; },
    sync(remote) { box.remote = remote; run('recApply(remote)'); }
  };
}

async function delayedRecording() {
  const h = makeHarness();
  const {REC, A, B} = h;
  const originalA = A.p, originalDrill = A.p.drill, originalRd = originalDrill.rd;
  const bBefore = clone(B.p);
  // This snapshot predates ASR and is applied again while archival is pending.
  const staleRemote = clone(REC);
  staleRemote.course[A.l.id].drill.dd[0] = {acc: 0.7, at: 3};
  await h.run('epRecToggle(1, card)');
  assert.equal(h.recorders.length, 1);
  assert.equal(h.mediaCalls(), 1);
  assert.equal(A.recording.rec, h.recorders[0]);
  h.advance(2000);
  for (const tick of h.intervals.values()) tick(); // A non-silent level sample.
  await h.run('epRecToggle(1, card)');
  await Promise.all([h.asrRequested.promise, h.archiveRequested.promise]);
  assert.equal(A.recording, null);
  assert.ok(h.tracks.every(track => track.stops === 1), 'Recording released every track');
  assert.equal(h.closed(), 1);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.requests.length, 2, 'ASR and archive start independently before either resolves');
  assert.equal(originalDrill.rd[1].acc, 0.25, 'ASR is still pending');
  const take = h.EP.takes['eplod-0001/1'];
  assert.equal(take.processing, true);
  assert.equal(take.archived, undefined);
  assert.match(take.id, /^[a-z0-9]{1,16}-[a-z0-9]{1,32}$/);
  assert.equal(take.url, h.localUrls[0].url, 'Local replay is available before ASR or archive');
  assert.equal(h.localUrls[0].blob.size, Buffer.byteLength('in-memory recording'));
  assert.match(h.response.innerHTML, /转写中/);

  h.switchToB();
  h.sync(staleRemote);
  assert.equal(REC.course[A.l.id], originalA, 'recApply preserved A lesson reference');
  assert.equal(REC.course[A.l.id].drill, originalDrill, 'recApply preserved A drill reference');
  assert.equal(originalDrill.rd, originalRd, 'recApply preserved A rd reference');
  assert.equal(A.p.drill.dd[0].acc, 0.7, 'Real remote reconciliation ran');
  const uiBefore = h.uiCalls.length, domBefore = h.response.innerHTML;
  h.asr.resolve({ok: true, text: A.d.dialogue[1].text});
  await h.asrSettled.promise;
  const day = h.run('epDay()');
  assert.equal(day, '2026-10-26');
  assert.equal(REC.course[A.l.id].drill.rd[1].acc, 1, 'Accuracy belongs to A');
  assert.equal(A.p.drill.rd[1].last, A.d.dialogue[1].text, 'Compared with A dialogue');
  assert.equal(A.p.drill.rd[1].mode, 'voice');
  assert.equal(A.p.drill.rd[1].dur, 2);
  assert.equal(A.p.drill.sd[1].dur, 2, 'Same-speed result belongs to A');
  assert.deepEqual(clone(A.p.drill.stampDays), {[day]: [1]}, 'Stamp belongs to A');
  assert.deepEqual(clone(B.p), bBefore, 'B unchanged after delayed ASR');

  const asrRequest = h.requests.find(request => request.url === '/api/eplod/asr');
  const recordingRequest = h.requests.find(request => request.url === '/api/eplod/recording');
  assert.equal(recordingRequest.body.ep, '0001', 'Archive request uses A episode');
  assert.equal(recordingRequest.body.i, 1);
  assert.equal(recordingRequest.body.takeId, take.id);
  assert.equal(A.p.drill.rd[1].latest.id, take.id);
  assert.equal(A.p.drill.rd[1].voice.id, take.id);
  assert.equal(A.p.drill.sd[1].id, take.id);
  assert.equal(A.p.drill.sd[1].verified, true);
  assert.equal(A.p.drill.sd[1].acc, 1);
  assert.match(asrRequest.body.audio, /^data:audio\/webm;codecs=opus;base64,/);
  assert.equal(recordingRequest.body.audio, asrRequest.body.audio);
  assert.equal(Buffer.from(asrRequest.body.audio.split(',')[1], 'base64').toString(), 'in-memory recording');

  h.sync(staleRemote);
  assert.equal(A.p.drill, originalDrill);
  assert.equal(A.p.drill.rd[1].acc, 1, 'Stale sync preserves completed ASR');
  assert.deepEqual(clone(A.p.drill.stampDays[day]), [1]);
  const archivedFile = `eplod-0001-1-${take.id}.webm`;
  h.archive.resolve({ok: true, file: archivedFile});
  await h.recorders[0].finished;
  assert.equal(REC.course[A.l.id].drill.rd[1].rec, archivedFile, 'Archive reference belongs to A');
  assert.equal(REC.course[A.l.id].drill.rd[1].recAt, take.at);
  assert.equal(REC.course[A.l.id].drill.rd[1].recAttemptId, take.id);
  assert.equal(take.archived, true);
  assert.deepEqual(clone(REC.course[B.l.id]), bBefore, 'B unchanged after archive and sync');
  assert.equal(B.p, REC.course[B.l.id]);
  assert.equal(h.saves.at(-1).course[A.l.id].drill.rd[1].rec, archivedFile);
  assert.deepEqual(h.saves.at(-1).course[B.l.id], bBefore);
  assert.equal(h.uiCalls.length, uiBefore, 'No late A updates to B UI');
  assert.equal(h.response.innerHTML, domBefore, 'Detached card untouched');
  assert.equal(h.requests.length, 2);
  console.log('PASS delayed ASR + recApply: A accuracy, stampDays, speed, recording reference and request ep; B unchanged');
}

async function mediaWaitSwitch() {
  const h = makeHarness({delayMedia: true});
  const before = clone(h.REC);
  const starting = h.run('epRecToggle(1, card)');
  assert.equal(h.mediaCalls(), 1);
  assert.equal(h.recorders.length, 0);
  const pending = h.A.recPending;
  assert.equal(pending.i, 1);
  await h.run('epRecToggle(1, card)');
  assert.equal(h.mediaCalls(), 1, 'A second click cannot create another pending microphone request');
  h.switchToB();
  assert.equal(pending.cancelled, true, 'Real cancellation marks the original microphone request');
  assert.equal(h.A.recPending, null);
  h.media.resolve({getTracks: () => h.tracks});
  await starting;
  assert.ok(h.tracks.every(track => track.stops === 1), 'Late permission stream released all tracks');
  assert.equal(h.recorders.length, 0, 'No recorder created after switching lessons');
  assert.equal(h.A.recording, undefined);
  assert.equal(h.B.recording, undefined);
  assert.equal(h.requests.length, 0);
  assert.equal(h.saves.length, 0);
  assert.deepEqual(clone(h.REC), before);
  console.log('PASS getUserMedia pending + lesson switch: stream released, no recorder, API or record changes');
}

function keyboardTabs() {
  const calls = [];
  const st = {tab: 'listen', ai: 3};
  const box = {
    EP: {st}, st, document: {querySelector: () => ({})},
    $: id => { assert.equal(id, 'ep-audio'); return {}; },
    epGo: (...args) => calls.push(args)
  };
  vm.createContext(box);
  vm.runInContext(keyboard, box, {filename: 'index.html:keyboard-handler', timeout: 1000});
  for (const tab of ['listen', 'chunks', 'train']) {
    st.tab = tab;
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      let prevented = false;
      box.EP.keyHandler({key, target: {tagName: 'DIV'}, preventDefault() { prevented = true; }});
      assert.equal(prevented, tab === 'train', `${tab}: ${key} prevention`);
    }
    assert.equal(calls.length, tab === 'train' ? 2 : 0, `${tab}: navigation count`);
  }
  assert.deepEqual(calls, [[2, true], [4, true]], 'Train navigation remains functional');
  console.log('PASS real keyboard handler: non-train arrows never call epGo; train arrows navigate');
}

// Bound failures from missing callbacks: pending in-memory promises must not silently exit successfully.
const watchdog = setTimeout(() => {
  console.error('FAIL recording regression timed out waiting for a production callback');
  process.exit(1);
}, 5000);
(async () => {
  await delayedRecording();
  await mediaWaitSwitch();
  keyboardTabs();
  console.log('EnglishPod recording regression: all 3 checks passed (memory stubs only)');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => clearTimeout(watchdog));
