'use strict';
// R1–R9(审查 2026-11-02) 修复回归: 产品源码切片在 VM/合成媒体中执行。
// 每个场景断言「修复后的正确行为」; 全部媒体/时钟/localStorage/records 均为合成。
// Run: node pipeline/test_eplod_review_fixes.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const cpSource = fs.readFileSync(path.join(root, 'web/course-plan-ui.js'), 'utf8');
const E = require(path.join(root, 'web/eplod-records.js'));
function sourceBetween(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return html.slice(a, b);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {resolve = a; reject = b;});
  return {promise, resolve, reject};
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Element {
  constructor() {
    this.style = {}; this.dataset = {}; this.hidden = false; this.inert = false; this.innerHTML = '';
    this.textContent = ''; this.value = ''; this.isConnected = true; this.disabled = false;
    this.children = new Map(); this.listeners = new Map(); this.attrs = {};
    this.classList = {add() {}, remove() {}, toggle() {}};
  }
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  querySelectorAll() {return [];}
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {this.listeners.get(type)?.delete(fn);}
  emit(type, event = {}) {for (const fn of [...(this.listeners.get(type) || [])]) fn(event);}
  setAttribute(k, v) {this.attrs[k] = v;}
  matches() {return false;}
  getClientRects() {return [];}
  focus() {}
  before() {}
  append() {}
  prepend() {}
  remove() {this.isConnected = false;}
}
function lesson(id = 'eplod-9998') {
  const dialogue = [{text: 'The decor is beautiful.', t0: 0, t1: 3}, {text: 'Please wait here.', t0: 5, t1: 7}];
  return {active: true, tab: 'train', ai: 0, amode: {0: 'voice'}, lastMode: 'voice',
    seg: 'dg', i: -1, restorePosition: false, l: {id, ep: 9998},
    d: {asr: true, dialogue, explanation: [], chunks: [], audio: {dg: '/synthetic/dg.mp3', pb: '/synthetic/pb.mp3'}},
    p: {marks: {}, collected: {}, drill: {mode: 'free', dd: {}, rd: {0: {acc: 1}, 1: {acc: 1}}, sd: {}, playsS: {}}},
    doneOf: () => true};
}
function harness(st = lesson(), opts = {}) {
  const clock = {now: 0, next: 1, jobs: new Map()};
  const schedule = (fn, delay, period = 0) => {
    const id = clock.next++; clock.jobs.set(id, {fn, at: clock.now + delay, period}); return id;
  };
  const stopTimer = id => clock.jobs.delete(id);
  const nodes = new Map();
  const node = id => {if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id);};
  const streams = [], recorders = [], graphs = [], calls = [], fetches = [], audios = [], urls = [];
  let gumDeferred = null;
  const gum = () => {
    const track = {stopped: false, stop() {this.stopped = true;}};
    const stream = {track, getTracks: () => [track]}; streams.push(stream);
    return gumDeferred ? gumDeferred.promise.then(() => stream) : Promise.resolve(stream);
  };
  class Recorder {
    static isTypeSupported() {return true;}
    constructor(stream) {this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this);}
    start() {assert.equal(this.state, 'inactive'); assert.equal(this.stream.track.stopped, false); this.state = 'recording';}
    stop() {
      if (this.state === 'inactive') throw Object.assign(Error('inactive'), {name: 'InvalidStateError'});
      this.state = 'inactive';
      schedule(() => {
        this.ondataavailable?.({data: new Blob(['synthetic audio only'])});
        Promise.resolve(this.onstop?.()).catch(e => {calls.push({uncaught: e.message});});
      }, 0);
    }
  }
  class AC {
    constructor() {this.state = 'running';}
    createAnalyser() {return {frequencyBinCount: 256, getByteTimeDomainData(a) {a.fill(opts.silent ? 128 : 145);}};}
    createMediaStreamSource(stream) {
      const graph = {stream, connected: false, connect() {this.connected = true;}, disconnect() {this.connected = false;}};
      graphs.push(graph); return graph;
    }
  }
  class AudioElement extends Element {
    constructor(src = '') {super(); this.src = src; this.currentSrc = ''; this.currentTime = 0; this.duration = 30;
      this.paused = true; this.readyState = 1; this.networkState = 1; this.playCalls = 0; this.loads = 0; audios.push(this);}
    play() {this.paused = false; this.playCalls++; this.emit('play'); return Promise.resolve();}
    pause() {const changed = !this.paused; this.paused = true; if (changed) this.emit('pause');}
    load() {this.loads++;}
  }
  const mainAudio = new AudioElement('/synthetic/dg.mp3'); nodes.set('ep-audio', mainAudio);
  const doc = new Element(); doc.body = new Element(); doc.hidden = false;
  doc.querySelector = selector => selector === '#v-course.on' ? (doc.courseVisible === false ? null : node('v-course')) : node(selector);
  doc.createElement = () => new Element(); doc.getElementById = id => nodes.get(id) || null;
  const ctx = {EP: {st}, EplodRecords: E, console, Blob, Uint8Array, Math, JSON,
    Date: class extends Date {static now() {return 1793606400000 + clock.now;}},
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: stopTimer,
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: stopTimer,
    navigator: {mediaDevices: {getUserMedia: gum}},
    MediaRecorder: Recorder, window: {MediaRecorder: Recorder, AudioContext: AC}, Audio: AudioElement,
    document: doc, $: node, STU: false, TICK: null, studyTick() {}, REC: {study: {total: 0}},
    localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    requestAnimationFrame() {}, matchMedia: () => ({matches: true}),
    AbortSignal: {timeout: ms => ({syntheticTimeout: ms})},
    URL: {createObjectURL(blob) {const url = 'blob:synthetic-' + urls.length; urls.push({url, blob, revoked: false}); return url;},
      revokeObjectURL(url) {const row = urls.find(x => x.url === url); if (row) row.revoked = true;}},
    FileReader: class {
      readAsDataURL() {this.result = 'data:audio/webm;base64,c3ludGhldGlj'; queueMicrotask(() => this.onload?.());}
    },
    fetch: (src, opts) => {const d = deferred(); fetches.push({src, opts, d}); return d.promise;},
    api: async (route, opts) => {calls.push({route, body: JSON.parse(opts.body)}); return {ok: true, text: st.d.dialogue.map(x => x.text).join(' ')};},
    esc: s => String(s), fmtDur: s => String(s),
    recSave: () => calls.push({saved: true}),
    epRecButton() {}, epRefreshSentence() {}, epCoverUpdate() {}, epStepsUpdate() {}, epDockNo() {},
    epSavePos() {}, epHighlight() {}, epSyncCur() {}, epTrainWire() {}, epTab() {},
    epFitInput() {}, epPlaybackCountUpdate() {}, epDay: () => '2026-11-02', epSyncProgressToggle() {},
    epStamp: (i, state) => calls.push({stamp: state.l.id, i}),
  };
  vm.createContext(ctx);
  const load = (start, end) => vm.runInContext(sourceBetween(start, end), ctx);
  load('function epDiff(', '/* ---- 四步训练(用户定案');
  load('function epNote(', 'function epResultHTML(');
  load('function epResultHTML(', 'function epSavedResult(');
  load('function epRdPassed(', 'function epStamp(');
  load('function epSettleTake(', 'async function epRecToggle(');
  load('async function epRecToggle(', 'function epRecLabel(');
  load('function epSeg(', 'function epHighlight(');
  async function advance(ms) {
    const end = clock.now + ms;
    for (let count = 0; count < 100000; count++) {
      let selected = null;
      for (const [id, job] of clock.jobs) if (job.at <= end && (!selected || job.at < selected[1].at)) selected = [id, job];
      if (!selected) break;
      const [id, job] = selected; clock.now = job.at;
      if (job.period) job.at += job.period; else clock.jobs.delete(id);
      job.fn(); await flush();
    }
    clock.now = end; await flush();
  }
  return {ctx, st, node, doc, streams, recorders, graphs, calls, fetches, audios, urls, clock, mainAudio, advance, load,
    delayPermission() {gumDeferred = deferred(); return gumDeferred;},
    intervals: () => [...clock.jobs.values()].filter(j => j.period).length};
}
async function run(name, fn) {
  await fn(); console.log('PASS ' + name);
}
async function main() {
  await run('R1 sentence rapid stop: recorder never starts, resources fully released, leave is a no-op', async () => {
    const h = harness(), card = new Element();
    await h.ctx.epRecToggle(0, card); await h.advance(100);
    await h.ctx.epRecToggle(0, card);
    assert.equal(h.st.recording, null); assert.equal(h.recorders[0].state, 'inactive');
    assert.equal(h.streams[0].track.stopped, true);
    await h.advance(200);
    assert.equal(h.recorders[0].state, 'inactive', 'late start timer must not start a stopped take');
    assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.intervals(), 0);
    h.ctx.epLeave();
    assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.calls.filter(c => c.route).length, 0);
  });
  await run('C1s sentence normal stop still scores once with ep/i context', async () => {
    const h = harness(), card = new Element();
    await h.ctx.epRecToggle(0, card); await h.advance(400);
    assert.equal(h.recorders[0].state, 'recording');
    await h.ctx.epRecToggle(0, card); await h.advance(0);
    const routes = h.calls.filter(c => c.route);
    assert.deepEqual(routes.map(c => c.route).sort(), ['/api/eplod/asr', '/api/eplod/recording'], 'sentence stop scores and archives');
    const asr = routes.find(c => c.route === '/api/eplod/asr');
    assert.deepEqual(Object.keys(asr.body).sort(), ['audio', 'ep', 'i']);
    assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.intervals(), 0);
  });
  await run('R2 whole rapid stop: no orphan interval, source disconnected, ASR never called', async () => {
    const h = harness(); await h.ctx.epWholeToggle(); await h.advance(100); await h.ctx.epWholeToggle();
    h.ctx.epLeave(); await h.advance(240001);
    assert.equal(h.recorders[0].state, 'inactive'); assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.intervals(), 0); assert.equal(h.graphs[0].connected, false);
    assert.equal(h.calls.filter(c => c.route).length, 0);
  });
  await run('C1 whole normal stop sends exactly one unbiased synthetic ASR and stamps the day', async () => {
    const h = harness(); await h.ctx.epWholeToggle(); await h.advance(4900); await h.ctx.epWholeToggle(); await h.advance(0);
    const routes = h.calls.filter(c => c.route);
    assert.equal(routes.length, 1); assert.equal(routes[0].route, '/api/eplod/asr');
    assert.deepEqual(Object.keys(routes[0].body), ['audio']);
    assert.equal(h.streams[0].track.stopped, true); assert.equal(h.graphs[0].connected, false); assert.equal(h.intervals(), 0);
    assert.equal(h.st.p.drill.wp.best.acc, 1);
    assert.equal(h.st.p.drill.wp.best.scoringVersion, E.SCORING_VERSION, 'whole result carries the strict scoring version');
    const stamps = h.calls.filter(c => c.stamp);
    assert.equal(stamps.length, h.st.d.dialogue.length);
    assert.ok(stamps.every(c => c.stamp === h.st.l.id));
  });
  await run('R10 whole take clearly shorter than the source fails fast without ASR; near-source length still scores', async () => {
    const h = harness(); await h.ctx.epWholeToggle(); await h.advance(1200); await h.ctx.epWholeToggle(); await h.advance(0);
    assert.equal(h.calls.filter(c => c.route).length, 0, 'short take never reaches ASR');
    assert.equal(h.st.p.drill.wp, undefined, 'short take writes no score');
    assert.equal(h.st.wpTake.phase, 'error');
    assert.match(h.st.wpTake.error, /短太多/);
    assert.match(h.st.wpTake.error, /录音 1，比原文 5 短太多/);   // 测试桩 fmtDur 原样输出秒数, 应用里渲染为 0:01/0:05
    assert.equal(h.recorders[0].state, 'inactive');
    assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.intervals(), 0);
    const h2 = harness();
    h2.st.d.dialogue = [{text: 'Short line.', t0: 0, t1: 0.6}, {text: 'Another one.', t0: 1, t1: 1.2}];
    await h2.ctx.epWholeToggle(); await h2.advance(1200); await h2.ctx.epWholeToggle(); await h2.advance(0);
    assert.equal(h2.calls.filter(c => c.route === '/api/eplod/asr').length, 1, 'near-source take still goes to scoring');
    assert.equal(h2.st.wpTake.phase, 'result');
  });
  await run('R11 silent whole take returns to the entry card instead of hanging at 正在转写', async () => {
    const h = harness(undefined, {silent: true});
    await h.ctx.epWholeToggle(); await h.advance(1200); await h.ctx.epWholeToggle(); await h.advance(0);
    assert.equal(h.st.wpTake, null, 'panel state handed back after the silence guard');
    assert.match(h.node('ep-whole').innerHTML, /整篇背诵 · 最后一遍|重新背诵/, 'entry card is back');
    assert.equal(h.calls.filter(c => c.route).length, 0, 'silent take never reaches ASR');
    assert.equal(h.recorders[0].state, 'inactive');
    assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.intervals(), 0);
  });
  await run('C2 pending permission and active whole cancel both release resources without ASR', async () => {
    for (const kind of ['whole', 'sentence']) {
      const h = harness(), permission = h.delayPermission();
      const start = kind === 'whole' ? h.ctx.epWholeToggle() : h.ctx.epRecToggle(0, new Element());
      h.ctx.epLeave(); permission.resolve(); await start;
      assert.equal(h.streams[0].track.stopped, true); assert.equal(h.recorders.length, 0);
    }
    const h = harness(); await h.ctx.epWholeToggle(); await h.advance(1200); h.ctx.epLeave(); await h.advance(0);
    assert.equal(h.calls.filter(c => c.route).length, 0); assert.equal(h.intervals(), 0); assert.equal(h.graphs[0].connected, false);
  });
  await run('R3 whole recording isolates hints: list/tools hidden+inert, restored after cancel', async () => {
    const h = harness(), card = new Element(); card.dataset.i = '0';
    h.ctx.epItems = () => h.st.d.dialogue;
    h.load('function epWireCard(', '/* ---- 覆盖式背诵');
    const original = card.querySelector('.rorig'); original.innerHTML = h.st.d.dialogue[0].text; original.style.display = 'none';
    const clue = card.querySelector('.rclue'); clue.textContent = '合成中文线索'; clue.style.display = '';
    const list = h.node('ep-blist'); list.querySelector = () => card;
    h.ctx.epWireCard(card); card.querySelector('.h2').onclick();
    assert.equal(original.style.display, '');
    await h.ctx.epWholeToggle(); await h.advance(300);
    assert.equal(h.recorders[0].state, 'recording');
    assert.equal(list.hidden, true, 'sentence list hidden during the no-hint take');
    assert.equal(list.inert, true, 'sentence list inert during the no-hint take');
    assert.equal(h.node('ep-tabs').hidden, true);
    assert.equal(h.node('ep-materials').hidden, true);
    assert.equal(h.node('.ep-stage').hidden, true, 'player dock hidden during the take');
    assert.match(h.node('ep-whole').innerHTML, /停止并检测/);
    assert.match(h.node('ep-whole').innerHTML, /取消/);
    assert.doesNotMatch(h.node('ep-whole').innerHTML, /原文已隐藏/);
    h.ctx.epCancelRecording(h.st);
    assert.equal(list.hidden, false); assert.equal(list.inert, false);
    assert.equal(h.node('.ep-stage').hidden, false);
  });
  await run('R4 stale blob fallback cannot overwrite a switched source; guard resets per source', async () => {
    const h = harness(); h.load('function epWire(', 'function epTab(');
    h.load('function epStartPlayback(', 'function epTogglePlayback(');
    h.ctx.epWire();
    h.ctx.epStartPlayback({seg: 'dg', i: 0, t0: 0, t1: 3});
    h.mainAudio.error = {code: 2}; h.mainAudio.emit('error');
    assert.equal(h.fetches[0].src, '/synthetic/dg.mp3');
    h.ctx.epSeg('pb'); h.ctx.epStartPlayback({seg: 'pb', i: 0, t0: 8, t1: 12});
    assert.equal(h.mainAudio.src, '/synthetic/pb.mp3');
    h.fetches[0].d.resolve({ok: true, blob: async () => new Blob(['old dg content'])}); await flush();
    assert.equal(h.st.seg, 'pb');
    assert.equal(h.mainAudio.src, '/synthetic/pb.mp3', 'stale response must not replace the switched source');
    assert.equal(h.urls.length, 0, 'discarded response never creates an object URL');
    h.ctx.epSeg('dg'); h.mainAudio.emit('error');
    assert.equal(h.fetches.length, 2, 'source switch resets the fallback guard so later failures retry');
    h.ctx.epLeave();
    assert.equal(h.st.blobRequest, null, 'leave aborts the pending fallback request');
    assert.equal(h.urls.filter(x => !x.revoked).length, 0);
  });
  await run('C4 fresh blob fallback still resumes the interrupted playback', async () => {
    const h = harness(); h.load('function epWire(', 'function epTab(');
    h.load('function epStartPlayback(', 'function epTogglePlayback(');
    h.ctx.epWire();
    h.ctx.epStartPlayback({seg: 'dg', i: 0, t0: 0, t1: 3});
    h.mainAudio.error = {code: 2}; h.mainAudio.emit('error');
    h.fetches[0].d.resolve({ok: true, blob: async () => new Blob(['fresh dg content'])}); await flush(); await h.advance(0);
    assert.match(h.mainAudio.src, /^blob:/);
    assert.equal(h.mainAudio.paused, false, 'playback resumes from the sentence start');
    assert.ok(h.mainAudio.playCalls >= 1);
    assert.equal(h.urls.filter(x => !x.revoked).length, 1);
    h.ctx.epLeave();
    assert.equal(h.urls.filter(x => !x.revoked).length, 0, 'leave revokes the fallback URL');
  });
  await run('R4b stale blob callback cannot cancel a newer whole recite', async () => {
    const h = harness(); h.load('function epWire(', 'function epTab(');
    h.load('function epStartPlayback(', 'function epTogglePlayback(');
    h.ctx.epWire(); h.ctx.epStartPlayback({seg: 'dg', i: 0, t0: 0, t1: 3});
    h.mainAudio.error = {code: 2}; h.mainAudio.emit('error');
    await h.ctx.epWholeToggle(); await h.advance(500);
    assert.equal(h.recorders[0].state, 'recording');
    h.fetches[0].d.resolve({ok: true, blob: async () => new Blob(['old playback intent'])}); await flush(); await h.advance(0);
    assert.equal(h.streams[0].track.stopped, false, 'whole take keeps recording');
    assert.equal(h.st.wpTake.rec, h.recorders[0], 'whole take identity preserved');
    assert.equal(h.mainAudio.paused, true, 'original audio stays stopped during the recite');
    assert.equal(h.calls.filter(c => c.route).length, 0);
    h.ctx.epLeave();
    assert.equal(h.streams[0].track.stopped, true);
  });
  await run('C3 out-of-order whole ASR results remain attached to originating lessons', async () => {
    const h = harness(), a = h.st, b = lesson('eplod-9999'), requests = [];
    b.l.ep = 9999; b.d.dialogue = [{text: 'Different synthetic lesson words.', t0: 0, t1: 3}];
    b.p.drill.rd = {0: {acc: 1}};
    h.ctx.api = () => {const d = deferred(); requests.push(d); return d.promise;};
    const oldRequest = h.ctx.epWholeProcess(a, {id: 'older-a', at: 1, dur: 5, audio: 'synthetic-a'});
    h.ctx.EP.st = b;
    const newRequest = h.ctx.epWholeProcess(b, {id: 'newer-b', at: 2, dur: 5, audio: 'synthetic-b'});
    requests[1].resolve({ok: true, text: b.d.dialogue[0].text}); await newRequest;
    requests[0].resolve({ok: true, text: a.d.dialogue.map(x => x.text).join(' ')}); await oldRequest;
    assert.equal(a.p.drill.wp.latest.id, 'older-a'); assert.equal(a.p.drill.wp.latest.acc, 1);
    assert.equal(b.p.drill.wp.latest.id, 'newer-b'); assert.equal(b.p.drill.wp.latest.acc, 1);
    assert.equal(h.ctx.EP.st.wpTake.result.id, 'newer-b');
  });
  await run('R5 replay blob fallback after cancel/leave stays silent and unreachable audio is gone', async () => {
    const h = harness(); h.st.p.drill.rd[0].rec = 'synthetic-recording.webm';
    await h.ctx.epReplay(0); const replay = h.ctx.EP.replay;
    const fallback = replay.onerror(); assert.equal(h.fetches.length, 1);
    h.ctx.epLeave(); assert.equal(h.ctx.EP.replay, null); assert.equal(replay.paused, true);
    h.fetches[0].d.resolve({ok: true, blob: async () => new Blob(['synthetic old recording'])}); await fallback;
    assert.equal(replay.paused, true, 'stale fallback must not resume a cancelled replay');
    assert.equal(replay.playCalls, 1, 'no second play after leave');
    assert.equal(h.urls.length, 0, 'discarded replay fallback never creates a URL');
    h.ctx.epStopReplay();
    assert.equal(replay.paused, true, 'stop cannot be tricked into resuming');
  });
  await run('R6 numeric learning errors stay exact; only confirmed name variants are forgiven', async () => {
    const official = 'I have fifteen dollars.', mine = 'I have fifty dollars.';
    assert.equal(E.lcsAcc(official, mine), .75);
    assert.equal(E.lcsAccFuzzy(official, mine), .75, 'fifteen/fifty is a real mistake, not a name slur');
    const h = harness(); h.st.d.dialogue = [{text: official, t0: 0, t1: 3}];
    assert.equal(h.ctx.epWholeScore(h.st, mine).acc, .75);
    const syntheticRecords = {course: {'eplod-9998': {drill: {rd: {0: {acc: .75, mode: 'voice', last: mine}}}}}};
    E.repairVoiceFuzzyScores(syntheticRecords, () => [{text: official}]);
    const row = syntheticRecords.course['eplod-9998'].drill.rd[0];
    assert.equal(row.acc, .75, 'repair never raises the unevidenced aggregate');
    assert.equal(row.lastAcc, .75, 'legacy mirror is recomputed from its own transcript');
    assert.equal(E.repairVoiceFuzzyScores(syntheticRecords, () => [{text: official}]), 0, 'repair is idempotent');
    assert.equal(E.lcsAccFuzzy('I am Julianne Horton.', 'I am Julian Horton.'), 1, 'confirmed variant still forgiven');
    assert.equal(E.lcsAccFuzzy('please collect the prints', 'please correct the prints'), .75, 'collect/correct stays a miss');
  });
  await run('R7 word display shares tokenization: omitted word flagged, artifact word not split', async () => {
    const official = 'The d \u0301ecor is beautiful.', mine = 'The decor beautiful.';
    const segs = E.tokenSegments(official);
    assert.equal(segs.map(s => s.text).join(''), official, 'segments preserve the source text');
    assert.deepEqual(segs.flatMap(s => s.tokens), E.normTokens(official), 'segment tokens equal whole-text tokens');
    const r = E.scoreTokens(official, mine);
    assert.equal(r.acc, .75);
    const h = harness();
    const out = h.ctx.epResultHTML(official, {mode: 'type', text: mine});
    assert.match(out, /class="miss">is<\/span>/, 'the omitted word is flagged');
    assert.match(out, /class="ok">d \u0301ecor<\/span>/, 'the artifact word is one ok segment');
    assert.doesNotMatch(out, /class="miss">[\u0301]ecor<\/span>/);
    const plain = E.tokenSegments('Le décor est beau.');
    assert.equal(plain.map(s => s.text).join(''), 'Le décor est beau.');
    assert.deepEqual(plain.flatMap(s => s.tokens), ['le', 'decor', 'est', 'beau']);
    assert.ok(plain.some(s => s.text === 'décor' && s.tokens.length === 1), 'precomposed accent stays one word segment');
  });
  await run('R8 multi-tab snooze keeps every same-day entry across tabs', async () => {
    const store = new Map();
    const mkStorage = () => ({getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k), get length() {return store.size;}, key: i => [...store.keys()][i] ?? null});
    const tabs = [];
    for (let i = 0; i < 2; i++) {
      const ctx = {localStorage: mkStorage(), Date, CP: {snooze: {}}, console}; vm.createContext(ctx);
      vm.runInContext(cpSource.slice(cpSource.indexOf('function cpTodayKey('), cpSource.indexOf('function cpBadgeUpdate(')), ctx);
      tabs.push(ctx);
    }
    tabs[0].cpSnooze('ndf-01-01');
    assert.equal(tabs[1].cpDuePick(['ndf-01-01', 'ndf-01-02'], tabs[1].cpSnoozeLoad(), tabs[1].cpTodayKey()), 'ndf-01-02');
    tabs[1].cpSnooze('ndf-01-02');
    assert.equal(tabs[0].cpDuePick(['ndf-01-01', 'ndf-01-02'], tabs[0].cpSnoozeLoad(), tabs[0].cpTodayKey()), null,
      'both same-day snoozes survive the concurrent write');
    tabs[0].cpSnooze('ndf-01-01');
    assert.equal(tabs[1].cpDuePick(['ndf-01-01', 'ndf-01-02'], tabs[1].cpSnoozeLoad(), tabs[1].cpTodayKey()), null, 're-snooze is idempotent');
  });
  await run('R9 failed silence detection skips the episode, exits non-zero, persists nothing', async () => {
    const fixture = fs.mkdtempSync(path.join(root, 'build', 'qa', 'review-20261102', 'anchor-gate-'));
    const build = path.join(fixture, 'project', 'build'), epDir = path.join(build, 'eplod');
    const audioDir = path.join(fixture, 'EnglishPod音频库', '9999');
    fs.mkdirSync(epDir, {recursive: true}); fs.mkdirSync(audioDir, {recursive: true});
    fs.writeFileSync(path.join(audioDir, 'dg.mp3'), Buffer.from('not an mp3: synthetic detection failure'));
    const file = path.join(epDir, '9999.json');
    const dialogue = [
      {text: 'First synthetic line.', t0: 0, t1: 1},
      {text: 'A short synthetic line.', t0: 3, t1: 6},
    ];
    fs.writeFileSync(file, JSON.stringify({dialogue}));
    const result = spawnSync(process.execPath, [path.join(root, 'pipeline/fix_eplod_anchors.mjs'), build],
      {cwd: __dirname, encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 2, 'detection failure must not report success');
    assert.match(result.stderr, /静音检测失败/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).dialogue[1].t0, 3, 't0 untouched without evidence');
    const cacheRaw = fs.existsSync(path.join(build, 'eplod-silence.json')) ? fs.readFileSync(path.join(build, 'eplod-silence.json'), 'utf8') : '{}';
    assert.ok(!JSON.parse(cacheRaw)['9999'], 'failed detection is not cached as valid data');
    const dry = spawnSync(process.execPath, [path.join(root, 'pipeline/fix_eplod_anchors.mjs'), build, '--dry'],
      {cwd: __dirname, encoding: 'utf8', timeout: 15000});
    assert.equal(dry.status, 2);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).dialogue[1].t0, 3, 'dry run never writes');
  });
  await run('R12 whole feedback attributes misses/extras to sentences word-by-word', async () => {
    const h = harness();
    h.st.d.dialogue = [
      {text: 'Please book me a flight.', t0: 0, t1: 2},
      {text: 'Window seat please.', t0: 3, t1: 4},
      {text: 'Thank you so much.', t0: 5, t1: 6},
    ];
    const transcript = 'Please book me flight. Window seat please. Thank you so much buddy.';
    const score = E.scoreTokens(h.st.d.dialogue.map(x => x.text).join(' '), transcript, true);
    assert.ok(Array.isArray(score.matched) && Array.isArray(score.pairs), 'scoreTokens exposes match flags and pairs');
    const scored = h.ctx.epWholeScore(h.st, transcript);
    const det = h.ctx.epWholeDetail(h.st, {text: transcript, ...scored});
    assert.equal(det.clean, false);
    assert.equal(det.sents.length, 3);
    const s0 = det.sents[0];
    assert.ok(s0.wordsHtml === undefined, 'detail exposes data, rendering stays in the UI layer');
    assert.deepEqual(Array.from(s0.words.filter(w => !w.ok), w => w.t), ['a'], 'the dropped word is flagged on sentence 1');
    assert.equal(s0.miss, 1);
    assert.deepEqual(Array.from(s0.extras), [], 'sentence 1 has no extra words');
    const s1 = det.sents[1];
    assert.equal(s1.words.some(w => !w.ok), false);
    assert.deepEqual(Array.from(s1.extras), [], 'sentence 2 stays clean');
    const s2 = det.sents[2];
    assert.deepEqual(Array.from(s2.extras), ['buddy'], 'the spoken extra lands on sentence 3');
    assert.equal(s2.acc, 1, 'extra words do not change the existing scoring rule');
  });
  await run('R12b clean whole pass renders no detail blocks; imperfect pass renders word rows', async () => {
    const h = harness();
    h.st.d.dialogue = [
      {text: 'Please book me a flight.', t0: 0, t1: 2},
      {text: 'Window seat please.', t0: 3, t1: 4},
      {text: 'Thank you so much.', t0: 5, t1: 6},
    ];
    const full = h.st.d.dialogue.map(x => x.text).join(' ');
    h.st.wpTake = {phase: 'result', result: {id: 'clean', at: 1, mode: 'whole', text: full, acc: 1, dur: 9, per: [{i: 0, acc: 1}, {i: 1, acc: 1}, {i: 2, acc: 1}]}};
    h.ctx.epWholeUpdate();
    let panel = h.node('ep-whole').innerHTML;
    assert.match(panel, /✓ 整篇通过/);
    assert.doesNotMatch(panel, /wp-sent/, 'clean pass stays a single quiet line');
    const transcript = 'Please book me flight. Window seat please. Thank you so much buddy.';
    h.st.wpTake = {phase: 'result', result: {id: 'rough', at: 2, mode: 'whole', text: transcript, dur: 9, ...h.ctx.epWholeScore(h.st, transcript)}};
    h.ctx.epWholeUpdate();
    panel = h.node('ep-whole').innerHTML;
    assert.match(panel, /这几句没完全对上/);
    assert.match(panel, /class="wp-sent/);
    assert.match(panel, /class="miss">a</, 'the missing word is flagged in the rendered row');
    assert.match(panel, /class="extra">buddy</, 'the extra word is flagged under 我说');
    assert.match(panel, /第 3 句/);
    assert.match(panel, /Please<\/span> <span class="ok">book/, 'raw word spacing and case remain readable');
    assert.match(panel, /归属按相邻命中位置估算/);
  });
  await run('R12c detail preserves every raw segment across omissions, replacements, aliases and expansions', async () => {
    const cases = [
      {lines: ['Alpha beta.', 'Gamma delta.', 'Epsilon zeta.'], text: 'Alpha beta. Epsilon zeta.', misses: [0, 2, 0]},
      {lines: ['Please book me a flight.', 'Window seat please.'], text: 'Please book me a train. Window seat please.', misses: [1, 0], extras: ['train']},
      {lines: ['Alpha beta.', 'Gamma delta.'], text: 'Hey Alpha really beta. Gamma delta buddy.', extras: ['hey', 'really', 'buddy']},
      {lines: ['Alpha beta.', 'Gamma delta.'], text: 'Alpha beta umm Gamma delta.', extras: ['hmm']},
      {lines: ['Alpha beta.', 'Gamma delta.'], text: 'Nothing matches here.', misses: [2, 2]},
      {lines: ['Alpha beta.', 'Gamma delta.'], text: '', misses: [2, 2]},
      {lines: ['Yes yes.', 'Yes again.'], text: 'Yes. Yes again.', misses: [1, 0]},
      {lines: ['Julianne is here.', 'McNealy says hello.'], text: 'Julian is here. Mclean says hello.', clean: true},
      {lines: ['Julianne says hello.', 'McNealy waits.'], text: 'Mclean says hello. Julian waits.', clean: false},
      {lines: ['Julianne waits.'], text: 'waits Julian.', clean: true},
      {lines: ["I'm gonna book 24 seats.", 'The décor is nice.'], text: "I'm going to book twenty four seats. The decor is nice.", clean: true},
      {lines: ['The d \u0301ecor is nice.', 'Okay, go!'], text: 'The decor is nice. OK, go!', clean: true},
      {lines: ["I see... so you're calling in sick?"], text: 'I see. So you are calling in sick?', clean: true},
      {lines: ["You're calling in sick."], text: 'You calling in sick.', misses: [1]},
      {lines: ['Book 24 seats.'], text: 'Book twenty seats.', misses: [1]},
      {lines: ['We are going to leave.'], text: 'We are gonna to leave.', extras: ['to']},
      {lines: ['Go.', 'To work.'], text: 'gonna work.'},
    ];
    for (const c of cases) {
      const h = harness();
      h.st.d.dialogue = c.lines.map(text => ({text}));
      const before = JSON.stringify(h.st);
      const det = h.ctx.epWholeDetail(h.st, {text: c.text});
      assert.equal(JSON.stringify(h.st), before, 'feedback never mutates progress');
      assert.equal(det.sents.map(s => s.words.map(w => w.t).join('')).join('|'), c.lines.join('|'), 'official text is lossless');
      assert.equal(det.sents.map(s => s.mine.map(w => w.t).join('')).join(''), c.text, 'transcript is lossless, including punctuation and trailing extras');
      const score = h.ctx.epWholeScore(h.st, c.text);
      assert.deepEqual(Array.from(det.sents, s => s.acc), Array.from(score.per, p => p.acc), 'display and existing per-sentence scores agree');
      const flat = E.scoreTokens(c.lines.join(' '), c.text, true);
      assert.equal(flat.pairs.length, flat.marks.filter(Boolean).length, 'alias hits have pairs too');
      assert.equal(new Set(flat.pairs.map(p => p[1])).size, flat.pairs.length, 'transcript tokens are matched at most once');
      assert.equal(det.sents.reduce((n, s) => n + s.extras.length, 0), flat.matched.filter(v => !v).length, 'no extra word is lost');
      if (c.misses) assert.deepEqual(Array.from(det.sents, s => s.miss), c.misses, c.text);
      if (c.extras) assert.deepEqual(Array.from(det.sents.flatMap(s => s.extras)), c.extras, c.text);
      if (c.clean !== undefined) assert.equal(det.clean, c.clean, c.text);
    }
  });
  await run('R13 expanded you are renders a clean 100% seventh sentence', async () => {
    const h = harness();
    h.st.d.dialogue = Array.from({length: 6}, (_, i) => ({text: 'Synthetic line number ' + (i + 1) + '.'}));
    h.st.d.dialogue.push({text: "I see... so you're calling in sick?"});
    const text = h.st.d.dialogue.map(x => x.text).join(' ').replace("you're", 'you are');
    const score = h.ctx.epWholeScore(h.st, text);
    assert.equal(score.per[6].acc, 1);
    h.st.wpTake = {phase: 'result', result: {id: 'contraction', at: 1, mode: 'whole', text, ...score}};
    h.ctx.epWholeUpdate();
    const panel = h.node('ep-whole').innerHTML;
    assert.match(panel, /#7 100%/);
    assert.doesNotMatch(panel, /wp-sent|class="miss"|class="extra"/, 'equivalent contraction creates no false error row');
  });
  console.log('DONE review-fix regressions: all scenarios assert the fixed behavior.');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
