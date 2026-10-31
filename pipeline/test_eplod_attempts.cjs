'use strict';

// Dedicated recording/attempt regressions. All writes and HTTP traffic stay in an OS temp directory.
// Run with: node pipeline/test_eplod_attempts.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const E = require('../web/eplod-records.js');
const clone = value => JSON.parse(JSON.stringify(value));
const source = {text: 'please read every word in this sentence aloud', t0: 4, t1: 7};
const voice = (id, at, acc, text = source.text) => ({id, at, mode: 'voice', text, acc, dur: 3, speed: true});
const typed = (id, at, acc, text = 'typed answer') => ({id, at, mode: 'type', text, acc});
const mergeRow = (a, b) => E.mergeDrill({rd: {2: a}}, {rd: {2: b}}).rd[2];

function memoryChecks() {
  const initial = {
    acc: 1, at: 5, mode: 'type', last: 'historical best',
    rec: 'eplod-0016-2-old-a.webm', recAt: 10, recAttemptId: 'old-a',
    draft: 'keep draft', extra: {keep: true}
  };
  const saved = E.saveAttempt(initial, voice('take-b', 20, .4, 'please'));
  assert.deepEqual(initial.extra, {keep: true});
  assert.equal(initial.at, 5, 'saveAttempt does not mutate its input');
  assert.equal(saved.acc, 1, 'Historical best stays independent from this take');
  assert.equal(saved.lastAcc, .4);
  assert.equal(saved.latest.acc, .4);
  assert.equal(saved.voice.acc, .4);
  assert.equal(saved.typed.text, 'historical best');
  assert.equal(saved.rec, initial.rec);
  assert.equal(saved.recAt, 10);
  assert.equal(saved.draft, initial.draft);
  saved.extra.keep = false;
  assert.equal(initial.extra.keep, true, 'Nested unknown fields are cloned');

  const afterType = E.saveAttempt(saved, typed('type-c', 30, .8));
  assert.equal(afterType.latest.mode, 'type');
  assert.equal(afterType.typed.acc, .8);
  assert.equal(afterType.voice.id, 'take-b');
  assert.equal(afterType.rec, initial.rec, 'Typing preserves archived audio');
  assert.equal(afterType.last, 'typed answer');
  assert.equal(afterType.at, 30);
  assert.equal(afterType.mode, 'type');
  assert.equal(afterType.lastAcc, .8);
  assert.ok(!Object.hasOwn(afterType, 'dur'), 'A typed result does not inherit voice duration');
  assert.ok(!Object.hasOwn(afterType, 'speed'));
  const lateVoice = E.saveAttempt(afterType, voice('take-c', 25, .95));
  assert.equal(lateVoice.latest.id, 'type-c', 'Late ASR never replaces newer typed latest');
  assert.equal(lateVoice.voice.id, 'take-c', 'Voice advances independently from latest');
  assert.equal(lateVoice.typed.id, 'type-c');
  assert.equal(lateVoice.acc, 1);
  assert.equal(E.saveAttempt(lateVoice, voice('take-a', 15, 1)).voice.id, 'take-c');
  assert.equal(E.saveAttempt(lateVoice, typed('type-a', 29, 1)).typed.id, 'type-c');
  const tied = E.saveAttempt(lateVoice, typed('type-z', 30, .7));
  assert.equal(tied.latest.id, 'type-z', 'Equal timestamps use deterministic id ordering');
  assert.equal(E.saveAttempt(tied, typed('type-a', 30, .9)).latest.id, 'type-z');
  const dict = E.saveAttempt({}, {id: 'dict-a', at: 40, mode: 'dict', text: source.text, acc: .95});
  assert.equal(dict.latest.mode, 'dict');
  assert.equal(dict.voice, undefined);
  assert.equal(dict.typed, undefined);

  const oldTake = {...E.saveAttempt({}, voice('take-a', 10, 1)), rec: 'old.webm', recAt: 10, recAttemptId: 'take-a'};
  const newTake = {...E.saveAttempt({}, voice('take-b', 20, .6)), rec: 'new.webm', recAt: 20, recAttemptId: 'take-b'};
  for (const row of [mergeRow(oldTake, newTake), mergeRow(newTake, oldTake)]) {
    assert.equal(row.rec, 'new.webm');
    assert.equal(row.latest.id, 'take-b');
    assert.equal(row.voice.id, 'take-b');
    assert.equal(row.acc, 1);
  }
  const newerResult = E.saveAttempt(oldTake, typed('type-d', 100, .4));
  const independent = mergeRow(newTake, newerResult);
  assert.equal(independent.latest.id, 'type-d');
  assert.equal(independent.voice.id, 'take-b');
  assert.equal(independent.rec, 'new.webm', 'Newer result timestamp cannot promote old audio');
  assert.equal(mergeRow(independent, {rec: 'older-response.webm', recAt: 15, recAttemptId: 'take-a'}).rec, 'new.webm');
  assert.equal(mergeRow(newTake, {rec: 'same-time.webm', recAt: 20, recAttemptId: 'take-z'}).rec, 'same-time.webm');
  assert.equal(mergeRow(independent, {rec: 'future-audio.webm', recAt: 200, recAttemptId: 'take-z'}).latest.id, 'type-d');
  assert.equal(mergeRow(independent, {latest: typed('later', 300, .2)}).rec, 'new.webm');
  const legacy = {acc: .95, last: source.text, mode: 'voice', at: 10, dur: 3, rec: 'legacy.webm'};
  const legacyTyped = E.saveAttempt(legacy, typed('type-z', 100, .5));
  assert.equal(legacyTyped.recAt, 10, 'Capture legacy audio timestamp before latest changes');
  assert.equal(legacyTyped.voice.text, source.text);
  assert.equal(legacyTyped.voice.acc, undefined, 'Legacy best is not fabricated as voice accuracy');
  assert.equal(mergeRow(legacyTyped, {rec: 'new-archive.webm', recAt: 20}).rec, 'new-archive.webm');

  const first = {rd: {2: newTake}, dd: {0: dict}, sd: {}, playsS: {1: 5}, stampDays: {day: [0, 1]}, unknown: {keep: true}};
  const second = {rd: {3: afterType}, dd: {1: dict}, sd: {1: {dur: 2, at: 20}}, playsS: {1: 2, 2: 3}, stampDays: {day: [1, 2]}};
  const drill = E.mergeDrill(first, second);
  assert.deepEqual(Object.keys(drill.rd), ['2', '3']);
  assert.deepEqual(Object.keys(drill.dd), ['0', '1']);
  assert.deepEqual(drill.playsS, {1: 5, 2: 3});
  assert.deepEqual(drill.stampDays.day, [0, 1, 2]);
  assert.deepEqual(drill.unknown, {keep: true});
  assert.deepEqual(E.mergeDrill(drill, second), drill, 'Merge retries are idempotent');

  const speed = {id: 'take-b', at: 20, acc: .95, dur: 3, sourceDur: 3, verified: true};
  assert.equal(E.speedPassed(speed), true);
  assert.equal(E.speedPassed({...speed, dur: speed.sourceDur * 1.15 + .5}), true, 'Inclusive speed threshold');
  for (const patch of [{acc: .89}, {acc: NaN}, {dur: 0}, {dur: -1}, {dur: Infinity}, {dur: 3.96}, {sourceDur: 0}, {sourceDur: -1}, {verified: false}]) {
    assert.equal(E.speedPassed({...speed, ...patch}, {acc: 1}), false);
  }
  assert.equal(E.speedPassed({dur: 3, at: 10}, legacy), false, 'Legacy score needs source evidence');
  assert.equal(E.speedPassed({dur: 3, at: 10}, legacy, source), true, 'Legacy transcript is re-scored against source');
  assert.equal(E.speedPassed({dur: 3, at: 10}, {...legacy, last: 'please', acc: 1}, source), false, 'Type historical best cannot validate insufficient voice content');
  assert.equal(E.speedPassed({dur: 3, at: 10}, {...legacy, mode: 'type'}, source), false);
  assert.equal(E.speedPassed({dur: 3, at: 10}, {...legacy, last: ''}, source), false);
  assert.equal(E.speedPassed({dur: 3, at: 9}, legacy, source), false, 'An old speed take cannot borrow a later voice');
  assert.equal(E.speedPassed({dur: 3, at: 2030}, legacyTyped, source), false, 'Unrelated timestamp does not borrow evidence');
  assert.equal(E.speedPassed({dur: 3, at: 10}, legacy, {...source, t1: 4}), false);
  assert.equal(E.speedPassed({dur: 3, at: 10}, legacy, {...source, t1: Infinity}), false);
  assert.equal(E.speedPassed({id: 'take-c', dur: 3, at: 25}, lateVoice, source), true, 'Independent voice survives a newer type');
  assert.equal(E.speedPassed({id: 'other', dur: 3, at: 25}, lateVoice, source), false);

  const lowSpeed = {...speed, at: 30, id: 'later-speed', acc: .2};
  const mergedSpeed = E.mergeDrill({sd: {0: speed}}, {sd: {0: lowSpeed}}).sd[0];
  assert.equal(mergedSpeed.acc, .2, 'sd accuracy is per take, not best');
  assert.equal(E.speedPassed(mergedSpeed), false);
  assert.deepEqual(E.mergeDrill({sd: {0: mergedSpeed}}, {sd: {0: speed}}).sd[0], mergedSpeed);
  const legacySpeed = E.mergeDrill({sd: {0: speed}}, {sd: {0: {dur: 3, at: 50}}}).sd[0];
  assert.equal(E.speedPassed(legacySpeed), false, 'Different legacy take does not inherit verified evidence');

  const records = {course: {'eplod-0016': {drill: {
    rd: {0: clone(legacy), 1: {...legacy, last: 'please', acc: 1}, 2: {...legacy, mode: 'type'}, 3: clone(legacy)},
    sd: {0: {dur: 3, at: 10}, 1: {dur: 3, at: 10}, 2: {dur: 3, at: 10}, 3: {dur: 3, at: 10, verified: false}},
    stampDays: {old: [0, 1, 2]}
  }}}};
  const unchanged = clone(records);
  assert.equal(E.repairSpeedScores(records, () => [source, source, source, source]), 1);
  assert.equal(E.speedPassed(records.course['eplod-0016'].drill.sd[0]), true);
  assert.deepEqual(records.course['eplod-0016'].drill.rd, unchanged.course['eplod-0016'].drill.rd);
  assert.deepEqual(records.course['eplod-0016'].drill.stampDays, unchanged.course['eplod-0016'].drill.stampDays);
  assert.deepEqual(records.course['eplod-0016'].drill.sd[1], unchanged.course['eplod-0016'].drill.sd[1]);
  assert.equal(E.repairSpeedScores(records, () => [source, source, source, source]), 0, 'Repair is idempotent');
  assert.equal(typeof E.repairOkayScores, 'function');
  assert.equal(typeof E.repairNumberScores, 'function');

  // r20 美英拼写互通: cancelled 归一到 canceled(两侧同变换), 白名单外的形近词不动。
  assert.equal(E.usSpelling('cancelled'), 'canceled');
  assert.equal(E.usSpelling('travelling'), 'traveling');
  assert.equal(E.usSpelling('traveller'), 'traveler');
  assert.equal(E.usSpelling('marvellous'), 'marvelous');
  assert.equal(E.usSpelling('realised'), 'realized');
  assert.equal(E.usSpelling('organisation'), 'organization');
  assert.equal(E.usSpelling('analyse'), 'analyze');
  assert.equal(E.usSpelling('colour'), 'color');
  assert.equal(E.usSpelling('favourite'), 'favorite');
  assert.equal(E.usSpelling('neighbourhood'), 'neighborhood');
  assert.equal(E.usSpelling('behaviour'), 'behavior');
  assert.equal(E.usSpelling('behavioural'), 'behavioral');
  assert.equal(E.usSpelling('centre'), 'center');
  assert.equal(E.usSpelling('centred'), 'centered');
  assert.equal(E.usSpelling('practise'), 'practice');
  assert.equal(E.usSpelling('learnt'), 'learned');
  assert.equal(E.usSpelling('judgement'), 'judgment');
  assert.equal(E.usSpelling('programme'), 'program');
  assert.equal(E.usSpelling('grey'), 'gray');
  assert.equal(E.usSpelling('canceled'), 'canceled', 'US forms pass through unchanged');
  for (const near of ['called', 'filled', 'wise', 'surprise', 'exercise', 'advise', 'hour', 'four', 'tour', 'your', 'flour', 'advertise', 'specialist', 'finalist', 'emphasis', 'dialogue', 'catalogue']) {
    assert.equal(E.usSpelling(near), near, 'Near-shaped word is not a variant: ' + near);
  }
  const cancelledLine = 'Oh great! Does this mean that the reception is cancelled?';
  assert.equal(E.lcsAcc('Oh great! Does this mean that the reception is canceled?', cancelledLine), 1);
  assert.deepEqual(E.normTokens('The colour is grey'), E.normTokens('the color is gray'));
  assert.notEqual(E.lcsAcc('wise choice', 'wize choice'), 1, 'Real typos still count as wrong');

  const spellDialogue = [
    {text: 'Oh great! Does this mean that the reception is canceled?'},
    {text: source.text},
    {text: source.text}
  ];
  const spellRecords = {course: {'eplod-0016': {drill: {
    dd: {
      0: {acc: .9, mode: 'dict', last: cancelledLine, at: 10},
      1: {acc: .5, mode: 'dict', last: source.text, at: 11},
      2: {acc: 1, mode: 'dict', last: source.text, at: 12}
    }
  }}}};
  assert.equal(E.repairSpellingScores(spellRecords, () => spellDialogue), 1, 'Only the variant entry is corrected');
  assert.equal(spellRecords.course['eplod-0016'].drill.dd[0].acc, 1);
  assert.equal(spellRecords.course['eplod-0016'].drill.dd[1].acc, .5, 'Entries without variants stay untouched');
  assert.equal(spellRecords.course['eplod-0016'].drill.dd[2].acc, 1, 'Already-best entry is not rewritten');
  assert.equal(E.repairSpellingScores(spellRecords, () => spellDialogue), 0, 'Spelling repair is idempotent');
  assert.equal(E.repairSpellingScores({course: {'eplod-0016': {drill: {dd: {0: {acc: .5, mode: 'dict', last: cancelledLine, at: 1}}}}}}, () => null), 0, 'Missing dialogue cannot invent a correction');

  // r6(2026-10-31) 人名走音赦免: 语音路径对同前两字母+小编辑距离的词对视为同一词; 默写保持精确。
  assert.equal(E.fuzzyEqual('julianne', 'julian'), true, 'reported case: Julianne read as Julian');
  assert.equal(E.fuzzyEqual('mcnealy', 'mclean'), true, 'reported case: McNealy heard as McLean');
  for (const [a, b] of [['morning', 'warning'], ['seven', 'eleven'], ['thinking', 'drinking'], ['letter', 'better'], ['quick', 'quit'], ['called', 'call']]) {
    assert.equal(E.fuzzyEqual(a, b), false, 'near-miss stays wrong: ' + a + '/' + b);
  }
  assert.deepEqual([...E.normTokens('Miss McNealy')], ['ms', 'mcnealy'], 'Miss/Ms homophone titles unify');
  assert.deepEqual([...E.normTokens('I miss you')], ['i', 'ms', 'you'], 'verb miss transforms identically on both sides');
  const nameOfficial = 'Yes, this is Julianne Horton, and I\'m calling to arrange an appointment with Ms. McNealy.';
  const nameTyped = 'Yes, this is Julian Horton, and I\'m calling to arrange an appointment with Miss McLean.';
  assert.ok(E.lcsAcc(nameOfficial, nameTyped) < 0.9, 'exact scoring still punishes the slur');
  assert.equal(E.lcsAccFuzzy(nameOfficial, nameTyped), 1, 'fuzzy scoring forgives the ASR name slur');
  const nameRecords = { course: { 'eplod-0016': { drill: {
    rd: {
      0: { acc: .867, mode: 'voice', last: nameTyped, at: 10 },
      1: { acc: .6, mode: 'type', last: nameTyped, at: 11 }
    }
  }}}};
  assert.equal(E.repairVoiceFuzzyScores(nameRecords, () => [{ text: nameOfficial }, { text: nameOfficial }]), 1, 'only the voice entry is raised');
  assert.equal(nameRecords.course['eplod-0016'].drill.rd[0].acc, 1);
  assert.equal(nameRecords.course['eplod-0016'].drill.rd[1].acc, .6, 'typed entries stay exact');
  assert.equal(E.repairVoiceFuzzyScores(nameRecords, () => [{ text: nameOfficial }, { text: nameOfficial }]), 0, 'fuzzy repair is idempotent');

  // r2(2026-10-30) NUM1 补 20: 官方 "20/20" 须展开成 twenty twenty 才配得上用户读法。
  assert.deepEqual(E.normTokens('20/20'), ['twenty', 'twenty']);
  assert.deepEqual(E.normTokens('2020'), ['two', 'thousand', 'twenty']);
  assert.deepEqual(E.normTokens('5:58'), ['five', 'fifty', 'eight'], 'r19 time reading unchanged');
  const docOfficial = 'Hey doc. Well, I think I might need glasses. I\'m getting headaches, and I really struggle to see things that are far away. But I have always had 20/20 vision.';
  const docTyped = 'Hey doc, well I think I might need glasses. I\'m getting headache, and I really struggle to see things that are far away, but I have always had twenty twenty vision.';
  assert.equal(E.lcsAcc(docOfficial, docTyped).toFixed(3), '0.968', '20/20 matches; only the genuine plural difference remains');

  // r3(2026-10-31) 语气词互通: Mmm/Hmm/Um/Uh… 全家族归一为 'hmm', 真词不受影响。
  for (const filler of ['hmm', 'hmmm', 'hm', 'mmm', 'mm', 'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'eh', 'huh', 'aha', 'ugh', 'ah', 'mhm', 'mhmm', 'mmhmm']) {
    assert.deepEqual([...E.normTokens(filler)], ['hmm'], 'filler -> hmm: ' + filler);
  }
  assert.deepEqual([...E.normTokens('Mmm. . .')], ['hmm'], '官方 Mmm 与转写 Hmm 互通');
  assert.deepEqual([...E.normTokens('ham'), ...E.normTokens('hum'), ...E.normTokens('mum'), ...E.normTokens('her')].join(' '), 'ham hum mum her', 'real words stay untouched');
  assert.equal(E.normTokens('oh').join(' '), 'zero', 'oh remains the digit-zero reading');
  const mmmOfficial = 'Mmm. . . X, E, R, 3, a question mark, and I can\'t quite make out the other symbol but I think it\'s the peace sign.';
  const hmmTyped = 'Hmm. X e r three a question mark and I can\'t quite make out the other symbol, but I think it\'s the peace sign.';
  assert.equal(E.lcsAcc(mmmOfficial, hmmTyped), 1, 'reported case scores full once fillers unify');
  assert.equal(typeof E.repairFillerScores, 'function');
  const fillerDialogue = [{ text: mmmOfficial }, { text: source.text }];
  const fillerRecords = { course: { 'eplod-0016': { drill: {
    dd: {
      0: { acc: .93, mode: 'dict', last: hmmTyped, at: 10 },
      1: { acc: .6, mode: 'dict', last: 'no fillers in this one at all', at: 11 }
    }
  }}}};
  assert.equal(E.repairFillerScores(fillerRecords, () => fillerDialogue), 1, 'only the filler entry is corrected');
  assert.equal(fillerRecords.course['eplod-0016'].drill.dd[0].acc, 1);
  assert.equal(fillerRecords.course['eplod-0016'].drill.dd[1].acc, .6, 'entries without fillers stay untouched');
  assert.equal(E.repairFillerScores(fillerRecords, () => fillerDialogue), 0, 'filler repair is idempotent');
  assert.equal(E.repairFillerScores({ course: { 'eplod-0016': { drill: { dd: { 0: { acc: .5, mode: 'dict', last: hmmTyped, at: 1 } } } } } }, () => null), 0, 'missing dialogue cannot invent a correction');
  console.log('Attempt identities, independent modes/audio, merge unions and speed evidence passed');
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
function startServer(args, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '../server.mjs'), ...args], {
    cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Temporary server startup timed out: ' + logs)), 15000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(Error('Temporary server exited ' + code + ': ' + logs)));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      logs += chunk.toString();
      if (logs.includes('[toefl-lab] http://')) { clearTimeout(timer); resolve(); }
    });
  });
  return {child, ready};
}
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Temporary server did not exit')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}
async function endpointChecks() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eplod-attempts-'));
  let child;
  try {
    const dirs = Object.fromEntries(['records', 'build', 'data', 'web', 'source'].map(name => [name, path.join(temp, name)]));
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, {recursive: true});
    fs.mkdirSync(path.join(dirs.web, 'review'));
    fs.writeFileSync(path.join(dirs.web, 'review', 'question-map.json'), JSON.stringify({mappings: []}));
    fs.mkdirSync(path.join(dirs.build, 'eplod'));
    fs.writeFileSync(path.join(dirs.build, 'manifest.json'), JSON.stringify({sets: []}));
    fs.writeFileSync(path.join(dirs.build, 'eplod', '0016.json'), JSON.stringify({dialogue: [source, source]}));
    const seed = {version: 1, attempts: {}, course: {'eplod-0016': {drill: {
      rd: {0: {acc: 1, mode: 'voice', last: source.text, at: 10, dur: 3}, 1: {acc: 1, mode: 'voice', last: 'please', at: 10, dur: 3}},
      sd: {0: {dur: 3, at: 10}, 1: {dur: 3, at: 10}}, stampDays: {old: [0, 1]}
    }}}, study: {}, qtimes: {}, mistakes: {}, families: {}, feedback: []};
    fs.writeFileSync(path.join(dirs.records, 'records.json'), JSON.stringify(seed));
    const port = await freePort();
    const run = startServer(['--port', String(port), ...Object.entries(dirs).filter(([name]) => name !== 'source').flatMap(([name, dir]) => ['--' + name, dir]), '--root', dirs.source], {
      ...process.env, TFL_SIBLING_ROOT: dirs.source, TFL_TLS_KEY: '', TFL_TLS_CERT: '', TFL_ASR_KEY: '', TFL_ASR_URL: '', TFL_TTS_KEY: '', TFL_TTS_URL: '', TFL_AI_KEY: ''
    });
    child = run.child;
    await run.ready;
    const base = `http://127.0.0.1:${port}`;
    const json = async (url, init) => {
      const response = await fetch(base + url, {...init, signal: AbortSignal.timeout(5000)});
      return {status: response.status, body: await response.json()};
    };
    const post = (body, headers = {}) => json('/api/eplod/recording', {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)});
    const audio = content => 'data:audio/webm;codecs=opus;base64,' + Buffer.from(content).toString('base64');
    const payload = {ep: '0016', i: 2, audio: audio('old take bytes')};
    const oldId = 'mher4a00-oldabc';
    const newId = 'mher4b00-newabc';
    // Newer upload finishes first. A late old upload must get its own immutable file.
    const newer = await post({...payload, takeId: newId, audio: audio('new take bytes')});
    const older = await post({...payload, takeId: oldId});
    assert.equal(newer.status, 200);
    assert.equal(older.status, 200);
    assert.equal(newer.body.file, `eplod-0016-2-${newId}.webm`);
    assert.equal(older.body.file, `eplod-0016-2-${oldId}.webm`);
    for (const [file, bytes] of [[older.body.file, 'old take bytes'], [newer.body.file, 'new take bytes']]) {
      const response = await fetch(base + '/media/rec/' + file);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), bytes);
    }
    const duplicate = await post({...payload, takeId: newId, audio: audio('changed duplicate bytes')});
    assert.equal(duplicate.status, 200);
    assert.equal(await (await fetch(base + '/media/rec/' + duplicate.body.file)).text(), 'new take bytes');
    // r22 保留策略: 同句最多两份 take(按落盘时间), 第三份出现时最旧一份被清理
    const third = await post({...payload, takeId: 'mhe99900-thirdab'});
    assert.equal(third.status, 200);
    await new Promise(r => setTimeout(r, 30));
    const kept = fs.readdirSync(path.join(dirs.records, 'recordings')).filter(f => f.startsWith('eplod-0016-2-')).sort();
    assert.deepEqual(kept, [`eplod-0016-2-${oldId}.webm`, 'eplod-0016-2-mhe99900-thirdab.webm'].sort());   // mtime 最新两份=第三份+晚写入的 old
    assert.equal((await fetch(base + '/media/rec/eplod-0016-2-mhe99900-thirdab.webm')).status, 200);
    const range = await fetch(base + '/media/rec/' + older.body.file, {headers: {Range: 'bytes=0-2'}});
    assert.equal(range.status, 206);
    assert.equal(await range.text(), 'old');   // newId 已被保留策略清理, Range 用存活的 oldId 文件验证
    const legacy = await post(payload);
    assert.equal(legacy.body.file, 'eplod-0016-2.webm');
    assert.equal((await post({...payload, audio: audio('legacy replacement')})).status, 200);
    assert.equal(await (await fetch(base + '/media/rec/' + legacy.body.file)).text(), 'legacy replacement');
    for (const takeId of ['', null, 123, '../escape', 'a/b', 'a\\b', 'a-b.webm', 'a%2fb', 'A-b', '-random', 'time-', 'x'.repeat(17) + '-a', 'time-' + 'x'.repeat(33)]) {
      assert.equal((await post({...payload, takeId})).status, 400, 'Reject unsafe take id: ' + takeId);
    }
    assert.equal((await post({...payload, takeId: 'z'.repeat(16) + '-' + 'x'.repeat(32)})).status, 200, 'Bounded maximum safe id');
    assert.equal((await post(null)).status, 400);
    assert.equal((await post({...payload, i: 100})).status, 400);
    assert.equal((await post({...payload, ep: '../x'})).status, 400);
    assert.equal((await post(payload, {Origin: 'https://other.invalid'})).status, 403);
    fs.writeFileSync(path.join(dirs.records, 'eplod-0016-2-hidden.webm'), 'outside recordings');
    for (const rel of ['eplod-0016-2-unsafe.webm', 'eplod-0016-2-a_b-c.webm', 'eplod-0016-2-a%2fb-c.webm', '..%5ceplod-0016-2-hidden.webm', '%2e%2e%2feplod-0016-2-hidden.webm']) {
      assert.equal((await fetch(base + '/media/rec/' + rel)).status, 400, 'Protect recording path: ' + rel);
    }
    assert.equal((await fetch(base + '/media/rec/eplod-0016-2-missing-safe.webm')).status, 404);
    const records = (await json('/api/records')).body;
    assert.equal(E.speedPassed(records.course['eplod-0016'].drill.sd[0]), true, 'Server boot persists valid legacy evidence');
    assert.equal(E.speedPassed(records.course['eplod-0016'].drill.sd[1]), false);
    assert.deepEqual(records.course['eplod-0016'].drill.rd, seed.course['eplod-0016'].drill.rd);
    assert.deepEqual(records.course['eplod-0016'].drill.stampDays, {old: [0, 1]});
    const persisted = JSON.parse(fs.readFileSync(path.join(dirs.records, 'records.json'), 'utf8'));
    assert.equal(persisted.course['eplod-0016'].drill.sd[0].verified, true);
    console.log('Isolated server take archives, idempotency, legacy routes, path guards and boot repair passed');
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(temp, {recursive: true, force: true});
  }
}
memoryChecks();
endpointChecks().catch(error => { console.error(error); process.exitCode = 1; });
