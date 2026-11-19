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
    start() {if(opts.startError)throw Error('synthetic start failure'); assert.equal(this.state, 'inactive'); assert.equal(this.stream.track.stopped, false); this.state = 'recording';}
    stop() {
      if (this.state === 'inactive') throw Object.assign(Error('inactive'), {name: 'InvalidStateError'});
      this.state = 'inactive';
      schedule(() => {
        this.ondataavailable?.({data: new Blob(opts.empty ? [] : ['synthetic audio only'])});
        Promise.resolve(this.onstop?.()).catch(e => {calls.push({uncaught: e.message});});
      }, 0);
    }
  }
  class AC {
    constructor() {this.state = opts.suspended ? 'suspended' : 'running';}
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
  load('function epSavedResult(', 'function epVoiceFeedback(');
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
    assert.equal(h.st.wpTake.code, 'too-short');
    assert.match(h.st.wpTake.error, /不足原音时长的 90%/);
    assert.match(h.st.wpTake.error, /至少 5/);   // 测试桩 fmtDur 原样输出秒数, 应用里渲染为 0:01/0:05
    assert.match(h.node('ep-whole').innerHTML, /这次没有计入/);
    assert.equal(h.recorders[0].state, 'inactive');
    assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.intervals(), 0);
    const h2 = harness();
    h2.st.d.dialogue = [{text: 'Short line.', t0: 0, t1: 0.6}, {text: 'Another one.', t0: 1, t1: 1.2}];
    await h2.ctx.epWholeToggle(); await h2.advance(1200); await h2.ctx.epWholeToggle(); await h2.advance(0);
    assert.equal(h2.calls.filter(c => c.route === '/api/eplod/asr').length, 1, 'near-source take still goes to scoring');
    assert.equal(h2.st.wpTake.phase, 'result');
  });
  await run('R11 silent whole take keeps an explicit error panel instead of silently returning to the entry card', async () => {
    const h = harness(undefined, {silent: true});
    await h.ctx.epWholeToggle(); await h.advance(1200); await h.ctx.epWholeToggle(); await h.advance(0);
    assert.equal(h.st.wpTake.phase, 'error');
    assert.equal(h.st.wpTake.code, 'silent-audio');
    assert.match(h.st.wpTake.error, /麦克风可能没开|没有检测到声音/);
    const panel = h.node('ep-whole').innerHTML;
    assert.match(panel, /这次没有计入/);
    assert.match(panel, /role="alert"/);
    assert.equal(h.calls.filter(c => c.route).length, 0, 'silent take never reaches ASR');
    assert.equal(h.recorders[0].state, 'inactive');
    assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.intervals(), 0);
  });
  await run('R19 whole empty/start/interruption failures stay visible and write no score; diagnostics note the cause', async () => {
    for (const [opts, code, trigger] of [
      [{empty: true}, 'empty-audio', 'stop'],
      [{startError: true}, 'capture-start', 'start'],
      [{}, 'capture-interrupted', 'recerror'],
    ]) {
      const h = harness(undefined, opts);
      const diagnostics = [];
      h.ctx.localStorage.setItem = (key, value) => diagnostics.push({key, value: JSON.parse(value)});
      await h.ctx.epWholeToggle(); await h.advance(4900);
      if (trigger === 'stop') await h.ctx.epWholeToggle();
      else if (trigger === 'recerror') h.recorders[0].onerror({error: {message: 'synthetic device lost'}});
      await h.advance(0);
      assert.equal(h.st.wpTake.phase, 'error', code);
      assert.equal(h.st.wpTake.code, code, code);
      assert.match(h.node('ep-whole').innerHTML, /这次没有计入/, code);
      assert.match(h.node('ep-whole').innerHTML, /重新背诵/, code);
      assert.equal(h.calls.filter(c => c.route).length, 0, code);
      assert.equal(h.st.p.drill.wp, undefined, code);
      assert.equal(h.streams[0].track.stopped, true, code);
      assert.equal(h.intervals(), 0, code);
      const last = diagnostics.at(-1);
      assert.equal(last?.value.code, code, 'failure reason persisted for diagnosis');
      assert.equal(last?.value.lesson, h.st.l.id);
      assert.equal(last.value.text, undefined, 'diagnostics contain no transcript');
      assert.equal(last.value.audio, undefined, 'diagnostics contain no audio');
    }
  });
  await run('R20 suspended analyser does not label a valid whole recording as silent', async () => {
    const h = harness(undefined, {silent: true, suspended: true});
    await h.ctx.epWholeToggle(); await h.advance(4900); await h.ctx.epWholeToggle(); await h.advance(0);
    assert.equal(h.st.wpTake.phase, 'result', 'suspended meter is not evidence of silence');
    assert.equal(h.calls.filter(c => c.route === '/api/eplod/asr').length, 1);
    assert.equal(h.streams[0].track.stopped, true);
  });
  await run('R21 live mic hint appears after ~2s of silence and clears with sound', async () => {
    const h = harness(undefined, {silent: true});
    await h.ctx.epWholeToggle(); await h.advance(400);
    const hintEl = () => h.node('ep-whole').querySelector('.wp-live-hint');
    assert.equal(hintEl().hidden, true, 'hidden right after start');
    await h.advance(1800);
    assert.equal(hintEl().hidden, false, 'shown after ~2s without sound');
    // 有声时不弹: 用正常(非 silent)harness 验证整段录音期间提示保持隐藏。
    const h2 = harness();
    await h2.ctx.epWholeToggle(); await h2.advance(2000);
    assert.equal(h2.node('ep-whole').querySelector('.wp-live-hint').hidden, true, 'no hint when sound is present');
  });
  await run('R22 whole error survives Space (no accidental clear) and repeat-Space cannot trigger the focused stop', async () => {
    const h = harness(undefined, {empty: true});
    h.load('EP.keyHandler=e=>{', "document.addEventListener('keydown',EP.keyHandler)");
    await h.ctx.epWholeToggle(); await h.advance(4900); await h.ctx.epWholeToggle(); await h.advance(0);
    const failure = h.st.wpTake;
    for (const repeat of [true, false]) {
      let prevented = false;
      h.ctx.EP.keyHandler({key: ' ', code: 'Space', repeat, target: {tagName: 'BODY'}, preventDefault() {prevented = true;}});
      assert.equal(prevented, true);
      assert.equal(h.st.wpTake, failure, 'error panel survives Space');
    }
    // Esc 收起后, 「重新背诵」按钮直接开录而不是只回入口卡。
    h.ctx.EP.keyHandler({key: 'Escape', target: {tagName: 'BODY'}, preventDefault() {}});
    assert.equal(h.st.wpTake, null);
    const streamsBefore = h.streams.length;
    h.node('ep-whole').querySelector('#ep-whole-retry').onclick();
    await flush();
    assert.equal(h.st.wpTake.phase, 'rec', 'retry button starts a fresh capture');
    assert.equal(h.streams.length, streamsBefore + 1);
    await h.advance(400);
    h.ctx.epCancelRecording(h.st); await h.advance(0);
  });
  await run('R23 Esc-closed whole recitation: Space reopens the panel instead of playing audio; other keys restore default Space', async () => {
    const h = harness();
    h.load('EP.keyHandler=e=>{', "document.addEventListener('keydown',EP.keyHandler)");
    await h.ctx.epWholeToggle(); await h.advance(1200); await h.ctx.epWholeToggle(); await h.advance(0);
    h.st.wpTake = {phase: 'result', result: {id: 'x', at: 1, mode: 'whole', text: 'The decor is beautiful. Please wait here.', acc: 1, dur: 9, per: [{i: 0, acc: 1}, {i: 1, acc: 1}], extra: []}};
    h.ctx.epWholeUpdate();
    h.ctx.EP.keyHandler({key: 'Escape', target: {tagName: 'BODY'}, preventDefault() {}});
    assert.equal(h.st.wpTake, null);
    assert.equal(h.st.wpReopen, true, 'Esc marks the reopen intent');
    const stopBefore = h.streams.length;
    h.ctx.EP.keyHandler({key: ' ', code: 'Space', repeat: false, target: {tagName: 'BODY'}, preventDefault() {}});
    await h.advance(400);
    assert.equal(h.st.wpReopen, false, 'Space consumed the reopen intent');
    assert.equal(h.st.wpTake?.phase, 'rec', 'Space reopened the recitation panel');
    assert.equal(h.streams.length, stopBefore + 1, 'a fresh capture started');
    // 第二份 harness: Esc 收起后按其他键(如方向键)清除意图, 空格回到默认语义(这里仅断言意图清除, 播放分支不在本测试装配内)。
    const h2 = harness();
    h2.load('EP.keyHandler=e=>{', "document.addEventListener('keydown',EP.keyHandler)");
    h2.ctx.epGo = () => {};   // 方向键分支只需要「意图被清除」这一断言
    await h2.ctx.epWholeToggle(); await h2.advance(1200); await h2.ctx.epWholeToggle(); await h2.advance(0);
    h2.st.wpTake = {phase: 'result', result: {id: 'y', at: 2, mode: 'whole', text: 'The decor is beautiful. Please wait here.', acc: 1, dur: 9, per: [{i: 0, acc: 1}, {i: 1, acc: 1}], extra: []}};
    h2.ctx.epWholeUpdate();
    h2.ctx.EP.keyHandler({key: 'Escape', target: {tagName: 'BODY'}, preventDefault() {}});
    h2.ctx.EP.keyHandler({key: 'ArrowLeft', target: {tagName: 'BODY'}, preventDefault() {}});
    assert.equal(h2.st.wpReopen, false, 'other keys drop the reopen intent');
  });
  await run('R24 selecting the current lesson preserves an active whole capture and pending ASR', async () => {
    const h = harness(); h.ctx.csSel = {l: 0};
    h.ctx.EP.cache = {}; h.ctx.EP.loadId = 0;   // renderEplodMain 的装配缓存
    const start = html.indexOf('window.renderEplodMain=async function(c){');
    const end = html.indexOf('function epWire(', start);
    assert.ok(end > start);
    vm.runInContext(html.slice(html.indexOf('function epWholeLocked('), html.indexOf('function epWholeIsolation(')), h.ctx);   // 守卫引用
    vm.runInContext(html.slice(start, end), h.ctx);
    const course = {lessons: [{id: h.st.l.id}]};
    await h.ctx.epWholeToggle(); await h.advance(400);
    const take = h.st.wpTake;
    await h.ctx.window.renderEplodMain(course);
    assert.equal(h.st.wpTake, take); assert.equal(take.rec.state, 'recording');
    h.st.wpTake = {phase: 'processing', from: take};
    await h.ctx.window.renderEplodMain(course);
    assert.equal(h.st.wpTake.from, take);
    h.st.wpTake = take; h.ctx.epCancelRecording(h.st); await h.advance(0);
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
    h.load('function epSyncOrigHint(', '/* ---- 覆盖式背诵');
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
  await run('R14 far-sighted/farsighted and OK/Okay render clean whole feedback', async () => {
    const h = harness();
    h.st.d.dialogue = [{text: 'Sounds like you may be far-sighted. OK, then, cover your left eye and read the chart in front of you.'}];
    const text = 'Sounds like you may be farsighted. Okay, then cover your left eye and read the chart in front of you';
    const score = h.ctx.epWholeScore(h.st, text);
    assert.equal(score.acc, 1);
    assert.equal(h.ctx.epWholeDetail(h.st, {text}).clean, true);
    h.st.wpTake = {phase: 'result', result: {id: 'compound', at: 1, mode: 'whole', text, ...score}};
    h.ctx.epWholeUpdate();
    const panel = h.node('ep-whole').innerHTML;
    assert.match(panel, /#1 100%/);
    assert.doesNotMatch(panel, /wp-sent|class="miss"|class="extra"/);
  });
  await run('R15 explicit sentence cancel stops capture without ASR or archive upload', async () => {
    const h = harness(), card = new Element(); card.dataset.i = '0'; card.dataset.mode = 'voice';
    await h.ctx.epRecToggle(0, card); await h.advance(400);
    assert.equal(h.recorders[0].state, 'recording');
    h.ctx.epCancelRecording(h.st); await h.advance(0);
    assert.equal(h.recorders[0].state, 'inactive');
    assert.equal(h.streams[0].track.stopped, true);
    assert.equal(h.st.recording, null);
    assert.equal(h.intervals(), 0, 'level timer released');
    assert.equal(h.calls.filter(c => c.route).length, 0, 'cancelled take uploads neither ASR nor archive');
    assert.equal(h.calls.some(c => c.uncaught), false, 'cancel path leaves no uncaught error');
    assert.equal(h.ctx.EP.takes['eplod-9998/0']?.status, 'cancelled', 'take stays local and unscored');
  });
  await run('R16 原文 hint hides once the result already shows the original', async () => {
    const h = harness();
    h.load('function epSyncOrigHint(', 'function epWireCard(');
    const card = new Element(); card.dataset.mode = 'voice';
    const hint = new Element(), orig = new Element();
    card.children.set('.h2', hint); card.children.set('.rorig', orig);
    h.ctx.epSyncOrigHint(card, h.st, 0);
    assert.equal(hint.hidden, false, 'without a result the staged hint still exists');
    h.st.p.drill.rd[0] = {acc: 1, voice: {id: 'v', at: 1, mode: 'voice', text: 'synthetic', acc: 1}};
    h.ctx.epSyncOrigHint(card, h.st, 0);
    assert.equal(hint.hidden, true, 'a rendered result already contains the original');
    orig.style.display = 'none';
    h.ctx.epSyncOrigHint(card, h.st, 0);
    assert.equal(orig.style.display, 'none', 'no duplicate panel is left open');
    card.dataset.mode = 'type';
    h.st.p.drill.rd[0].typed = {id: 't', at: 2, mode: 'type', text: 'synthetic', acc: 1};
    h.ctx.epSyncOrigHint(card, h.st, 0);
    assert.equal(hint.hidden, true, 'typed results hide it too');
    delete h.st.p.drill.rd[0].typed;
    h.ctx.epSyncOrigHint(card, h.st, 0);
    assert.equal(hint.hidden, false, 'switching to a mode without a result restores the hint');
  });
  await run('R17 sentence cancel button is reachable only while recording or waiting for permission', async () => {
    const h = harness();
    h.load('function epRecLabel(', 'function epTrainWire(');
    const list = h.node('ep-blist');
    const rec = new Element(); rec.dataset.i = '0';
    const cancel = new Element(); cancel.hidden = true;
    list.children.set('.ep-bcard .ep-rec', rec);
    list.children.set('.ep-bcard .ep-rec-cancel', cancel);
    h.ctx.epRecButton();
    assert.equal(cancel.hidden, true, 'idle state has no cancel');
    h.st.recPending = {i: 0};
    h.ctx.epRecButton();
    assert.equal(cancel.hidden, false, 'permission wait can be cancelled');
    h.st.recPending = null; h.st.recording = {i: 0};
    h.ctx.epRecButton();
    assert.equal(cancel.hidden, false, 'active recording can be cancelled');
    h.st.recording = null;
    h.ctx.epRecButton();
    assert.equal(cancel.hidden, true, 'cancel disappears once the take ends');
  });
  console.log('DONE review-fix regressions: all scenarios assert the fixed behavior.');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
