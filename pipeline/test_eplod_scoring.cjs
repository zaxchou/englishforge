'use strict';

// All fixtures are synthetic and in memory; no server, ASR, microphone or learning store is used.
// Run with: node pipeline/test_eplod_scoring.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../web/eplod-records.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const voice = (id, at, text, acc, extra = {}) => ({id, at, mode: 'voice', text, acc, dur: 3, ...extra});
const whole = (id, at, text, acc, extra = {}) => ({id, at, mode: 'whole', text, acc, dur: 30, ...extra});
const row = result => ({acc: result.acc, at: result.at, mode: result.mode, last: result.text,
  lastAcc: result.acc, latest: clone(result), voice: clone(result)});

test('R6: ordinary number/content/day words require an exact normalized match', () => {
  for (const [a, b] of [
    ['fifteen', 'fifty'], ['seventeen', 'seventy'], ['thirteen', 'thirty'],
    ['coffee', 'coffin'], ['thinking', 'thinning'], ['customer', 'customers'],
    ['Tuesday', 'Thursday'], ['tuesday', 'tuesdays'], ['Thursday', 'Thirsty']
  ]) {
    assert.equal(E.fuzzyEqual(a.toLowerCase(), b.toLowerCase()), false, a + '/' + b);
    assert.equal(E.fuzzyEqual(a, b), false, 'Capitalization does not identify a name');
    const score = E.scoreTokens(`I said ${a}.`, `I said ${b}.`, true);
    assert.equal(score.acc, 2 / 3, a + '/' + b + ' keeps its wrong content word');
    assert.deepEqual(score.marks, [true, true, false]);
    assert.equal(E.lcsAccFuzzy(`I said ${a}.`, `I said ${b}.`), score.acc);
  }
  for (const [official, mine] of [
    ['I have fifteen dollars.', 'I have fifty dollars.'],
    ['I have 15 dollars.', 'I have 50 dollars.']
  ]) {
    assert.deepEqual(E.scoreTokens(official, mine, true), {
      acc: .75, marks: [true, true, false, true], extras: ['fifty'],
      matched: [true, true, false, true], pairs: [[0, 0], [1, 1], [3, 3]]
    });
  }
  assert.equal(E.fuzzyEqual('because', 'cause'), false, 'Bare cause keeps its separate meaning');
});

test('R6: only confirmed name aliases are forgiven, in both directions and only for voice scoring', () => {
  for (const [a, b] of [['Julianne', 'Julian'], ['McNealy', 'McLean']]) {
    assert.equal(E.fuzzyEqual(a.toLowerCase(), b.toLowerCase()), true);
    assert.equal(E.fuzzyEqual(b.toLowerCase(), a.toLowerCase()), true);
    assert.equal(E.fuzzyEqual(a.toLowerCase(), a.toLowerCase()), false, 'Exact matches need no alias rescue');
    assert.equal(E.lcsAccFuzzy(`${a} is here.`, `${b} is here.`), 1);
    assert.equal(E.lcsAcc(`${a} is here.`, `${b} is here.`), 2 / 3);
    assert.equal(E.scoreTokens(`${a} is here.`, `${b} is here.`).acc, 2 / 3);
  }
  assert.equal(E.lcsAccFuzzy('Julianne calls McNealy.', 'Julian calls McLean.'), 1);
  assert.equal(E.fuzzyEqual('julianne', 'julianna'), false, 'Unconfirmed similar names are not silently added');
});

test('normalization retains spelling, number readings, fillers, slang, accents and apostrophes', () => {
  for (const [a, b] of [
    ['The cancelled programme is grey.', 'The canceled program is gray.'],
    ['At 5:58 I had 20/20 vision.', 'At five fifty eight I had twenty twenty vision.'],
    ['Mmm, okay, oh.', 'Hmm, ok, zero.'],
    ["I'm gonna tell 'em 'bout it.", "I'm going to tell them about it."],
    ["I’m gonna tell ’em ’bout it.", "I'm going to tell them about it."],
    ['The décor, de\u0301cor and d \u0301ecor.', 'The decor decor and decor.'],
    ["He's quite tall, around 6'1\", he's tall.", "He's quite tall, around six one, he's tall."],
    ["around 6\u20191\u201d", 'around six one'],
    ["around 6' 1\"", 'around six one'],
    ["He's really good looking.", 'He is really good looking.'],
    ["What's wrong? Here's the plan.", 'What is wrong? Here is the plan.'],
    ['Geeze! Jeez! Jeeze!', 'Geez! Geez! Geez!']
  ]) {
    assert.deepEqual(E.normTokens(a), E.normTokens(b), a);
    assert.equal(E.lcsAcc(a, b), 1);
  }
  assert.ok(E.lcsAcc("he's got the keys", 'he has got the keys') > E.lcsAcc("he's got the keys", 'he held the keys'), 'has-reading still gains partial matches');
  assert.ok(E.lcsAcc("the boy's book", 'the boys book') < 1, 'possessive or plural confusion is not forgiven');
  assert.ok(E.lcsAcc('its fine', "it's fine") < 1, "its and it's stay distinct");
  assert.equal(E.normTokens("o'clock")[0], "o'clock", 'o-clock is not a feet-inches token');
  assert.equal(E.normTokens("customers'")[0], 'customers', 'trailing possessive apostrophe still strips');
  assert.deepEqual(E.normTokens("'bout"), ['about'], 'slang lookup keeps its leading apostrophe');
  assert.deepEqual(E.scoreTokens("I'm gonna call.", "I'm gonna to call.", true), {
    acc: 1, marks: [true, true, true, true, true], extras: ['to'],
    matched: [true, true, true, false, true, true], pairs: [[0, 0], [1, 1], [2, 2], [3, 4], [4, 5]]
  }, 'The extra to remains visible after slang expansion');
});

test('common contractions equal their full forms without erasing grammar or content errors', () => {
  for (const [short, full] of [
    ["I see... so you're calling in sick?", 'I see. So you are calling in sick?'],
    ["I'm ready and we've booked it.", 'I am ready and we have booked it.'],
    ["'You're calling in sick?'", 'You are calling in sick?'],
    ["They're here; we'll wait.", 'They are here; we will wait.'],
    ["I’ve called; you’ll hear from me.", 'I have called; you will hear from me.'],
    ["Don't call; she isn't ready.", 'Do not call; she is not ready.'],
    ["He doesn't know and they didn't ask.", 'He does not know and they did not ask.'],
    ["I can't go; he won't come.", 'I cannot go; he will not come.'],
    ["Let's go. You shouldn't wait.", 'Let us go. You should not wait.']
  ]) {
    for (const [a, b] of [[short, full], [full, short]]) {
      assert.deepEqual(E.normTokens(a), E.normTokens(b), a);
      assert.equal(E.scoreTokens(a, b, true).acc, 1);
      assert.deepEqual(E.scoreTokens(a, b, true).extras, []);
      const parts = E.tokenSegments(a);
      assert.equal(parts.map(p => p.text).join(''), a, 'display keeps the actual contraction');
      assert.equal(parts.flatMap(p => p.tokens).length, E.scoreTokens(a, b, true).marks.length);
    }
  }
  for (const [a, b] of [
    ["You aren't calling in sick.", 'You are calling in sick.'],
    // r26 2026-11-14: were↔'re 只在语音互认（用户 0024 归档录音重听确认念的是 "We were"、
    // 是 ASR 把弱读写成 We're），打字默写仍判错——下一行移出本表后由 r26 测试正向钉住。
    ["I've called.", 'I called.'],
    ["I'll call.", 'I would call.'],
    ["He's called.", 'He has called.'],
    ["I'd called.", 'I had called.'],
    ["I'd call.", 'I would call.']
  ]) assert.ok(E.scoreTokens(a, b, true).acc < 1, a + ' retains a distinct or ambiguous form');
  // r6 2026-11-07: 代词+'s 从不表示所有格, 按 is 读法两侧展开; 名词所有格与 'd 仍不展开。
  assert.equal(E.lcsAcc("He's called.", 'He is called.'), 1, "pronoun he's equals he is");
  assert.equal(E.lcsAcc("What's wrong? Where's he?", 'What is wrong? Where is he?'), 1);
  assert.ok(E.lcsAcc("James's book", 'James is book') < 1, "possessive James's is not expanded in typing");
  // r24 2026-11-13(0023 实测 Tuesday's/Tuesday is 两处整篇误报): 名词+'s 的 is-缩读与读开的
  // "X is" 同音, 语音路径互认(取代 r6 对名词+'s 的一律不展开——当时没有仅语音的合并分支);
  // 打字默写仍要求正确写法。
  assert.equal(E.scoreTokens("The customer's calling.", 'The customer is calling.', true).acc, 1, "voice: customer's calling equals customer is calling");
  assert.ok(E.scoreTokens("The customer's calling.", 'The customer is calling.', false).acc < 1, 'typing keeps noun +\'s distinct');
});

test('contraction rescoring repairs evidenced voice/whole takes and blocks version-1 snapshots', () => {
  const text = 'I see. So you are calling in sick?', old = whole('contracted-whole', 12, text, 6 / 7,
    {scoringVersion: 1, per: [{i: 0, acc: 6 / 7}], extra: ['you', 'are']});
  const spoken = row(voice('contracted-voice', 10, text, 6 / 7, {scoringVersion: 1}));
  const records = {course: {'eplod-0002': {drill: {rd: {0: spoken}, wp: {best: clone(old), latest: clone(old)}, stampDays: {'2026-11-03': [0]}}}}};
  const audit = E.repairVoiceScores(records, () => [{text: "I see... so you're calling in sick?"}]);
  const drill = records.course['eplod-0002'].drill;
  assert.equal(drill.rd[0].voice.acc, 1);
  assert.equal(drill.wp.latest.acc, 1);
  assert.deepEqual(drill.wp.latest.per, [{i: 0, acc: 1}]);
  assert.deepEqual(drill.wp.latest.extra, []);
  assert.equal(drill.wp.latest.scoringVersion, E.SCORING_VERSION);
  assert.deepEqual(drill.stampDays, {'2026-11-03': [0]});
  assert.ok(audit.changes.some(c => c.reason === 'normalized-whole-transcript'));
  for (const merged of [E.mergeDrill({wp: {latest: old, best: old}}, drill), E.mergeDrill(drill, {wp: {latest: old, best: old}})]) {
    assert.equal(merged.wp.latest.acc, 1);
    assert.equal(merged.wp.best.acc, 1);
  }
  assert.equal(E.repairVoiceScores(records, () => [{text: "I see... so you're calling in sick?"}]).changed, 0);
});

test('alright and all right match without inventing missing words or hiding real extras', () => {
  const official = "Okay... end of the first quarter... Alright, I'm gonna make a beer run.";
  const mine = "Okay, the end of the first quarter. All right, I'm gonna make a beer run.";
  for (const fuzzy of [false, true]) {
    const score = E.scoreTokens(official, mine, fuzzy);
    assert.equal(score.acc, 1);
    assert.ok(score.marks.every(Boolean));
    assert.deepEqual(score.extras, ['the']);
  }
  for (const [a, b] of [['Alright, go.', 'All right, go.'], ['All right, go.', 'Alright, go.']]) {
    assert.equal(E.lcsAcc(a, b), 1);
    assert.deepEqual(E.scoreTokens(a, b, true).extras, []);
    assert.equal(E.tokenSegments(a).map(part => part.text).join(''), a);
  }
  assert.deepEqual(E.tokenSegments('Alright')[0], {text: 'Alright', tokens: ['all', 'right']});
  for (const [a, b] of [['All right.', 'All wrong.'], ['Alright, make a beer run.', 'All right, make a run.'], ['All right.', 'Right.']]) {
    assert.ok(E.lcsAccFuzzy(a, b) < 1, a + '/' + b + ' keeps real content differences');
  }
});

test('alright rescoring upgrades evidenced version-3 results, preserves progress and rejects stale snapshots', () => {
  const official = "Okay... end of the first quarter... Alright, I'm gonna make a beer run.";
  const mine = "Okay, the end of the first quarter. All right, I'm gonna make a beer run.";
  const old = whole('alright-whole', 15, mine, 14 / 15,
    {scoringVersion: 3, per: [{i: 0, acc: 14 / 15}], extra: ['the', 'all', 'right']});
  const spoken = row(voice('alright-voice', 12, mine, 14 / 15, {scoringVersion: 3}));
  const records = {course: {'eplod-0033': {drill: {
    rd: {0: spoken}, wp: {best: clone(old), latest: clone(old)}, stampDays: {'2026-11-06': [0]}
  }}}};
  const source = () => [{text: official}];
  const audit = E.repairVoiceScores(records, source);
  const drill = records.course['eplod-0033'].drill;
  assert.equal(drill.rd[0].latest.acc, 1);
  assert.equal(drill.rd[0].voice.acc, 1);
  assert.equal(drill.rd[0].lastAcc, 1);
  assert.equal(drill.rd[0].acc, 14 / 15, 'Latest text does not prove a historical best aggregate');
  assert.equal(drill.wp.latest.acc, 1);
  assert.equal(drill.wp.best.acc, 1);
  assert.deepEqual(drill.wp.latest.per, [{i: 0, acc: 1}]);
  assert.deepEqual(drill.wp.latest.extra, ['the']);
  assert.equal(drill.wp.latest.scoringVersion, E.SCORING_VERSION);
  assert.deepEqual(drill.stampDays, {'2026-11-06': [0]});
  assert.ok(audit.changes.some(change => change.reason === 'normalized-whole-transcript'));
  for (const merged of [E.mergeDrill({wp: {latest: old, best: old}}, drill), E.mergeDrill(drill, {wp: {latest: old, best: old}})]) {
    assert.equal(merged.wp.latest.acc, 1);
    assert.equal(merged.wp.best.acc, 1);
  }
  assert.equal(E.repairVoiceScores(records, source).changed, 0);
});

test('confirmed sighted compounds match hyphenated forms and preserve original feedback text', () => {
  const official = 'Sounds like you may be far-sighted. OK, then, cover your left eye and read the chart in front of you.';
  const mine = 'Sounds like you may be farsighted. Okay, then cover your left eye and read the chart in front of you';
  for (const [a, b] of [[official, mine], [mine, official]]) {
    const score = E.scoreTokens(a, b, true);
    assert.equal(score.acc, 1, 'user sentence matches completely');
    assert.deepEqual(score.extras, []);
    assert.ok(score.marks.every(Boolean));
    assert.ok(score.matched.every(Boolean));
    assert.equal(E.tokenSegments(a).map(s => s.text).join(''), a);
  }
  for (const prefix of ['far', 'near', 'short', 'long']) {
    for (const suffix of ['sighted', 'sightedness']) {
      const joined = prefix + suffix;
      for (const separator of ['-', ' ', '\u2010', '\u2011', '\u2013']) {
        const split = prefix + separator + suffix;
        assert.deepEqual(E.normTokens(joined), E.normTokens(split));
        assert.equal(E.scoreTokens(joined, split, true).acc, 1);
        assert.equal(E.scoreTokens(split, joined, true).acc, 1);
      }
    }
  }
  assert.deepEqual(E.tokenSegments('Farsighted')[0], {text: 'Farsighted', tokens: ['far', 'sighted']});
  for (const [a, b] of [['far-sighted', 'nearsighted'], ['short-sighted', 'longsighted'], ['re-sign', 'resign'], ['re-cover', 'recover'], ['far-sighted', 'far']]) {
    assert.ok(E.scoreTokens(a, b, true).acc < 1, a + '/' + b + ' must stay distinct');
  }
});

test('r8: compound written-form equivalence matches split and joined spellings in both directions', () => {
  for (const [official, mine] of [
    ['activate my voice mail service', 'activate my voicemail service'],
    ['his Polio, Tetanus and chickenpox shots are done', 'his Polio, Tetanus and chicken pox shots are done'],
    ["it's time now for the tie-breaker round", "it's time now for the tiebreaker round"],
    ['the over head bin', 'the overhead bin'],
    ['particles and anti-particles', 'particles and antiparticles'],
    ['adventurous, outgoing and easy-going', 'adventurous, outgoing and easygoing']
  ]) {
    assert.equal(E.lcsAcc(official, mine), 1, official);
    assert.equal(E.lcsAcc(mine, official), 1, 'symmetric: ' + official);
  }
  // 护栏: 虚词开头的真词拼接不得误并
  assert.ok(E.lcsAcc('I want to get coffee', 'I want together coffee') < 1, 'to+get must not merge into together');
  assert.ok(E.lcsAcc('we did it together', 'we did it to get') < 1, 'reverse direction is guarded too');
  assert.ok(E.lcsAcc('look ahead', 'look a head') < 1, 'a+head must not merge into ahead');
  assert.ok(E.lcsAcc('I have fifteen dollars', 'I have fifty dollars') < 1);
});

test('r9: hyphenated re- compounds equal their joined forms while true homograph verbs stay distinct', () => {
  for (const [official, mine] of [
    ['so I had to re-do the pictures', 'so I had to redo the pictures'],
    ['they were re-decorating the room', 'they were redecorating the room'],
    ['let me re-emphasize that', 'let me reemphasize that']
  ]) {
    assert.equal(E.lcsAcc(official, mine), 1, official);
    assert.equal(E.lcsAcc(mine, official), 1, 'symmetric: ' + official);
  }
  assert.ok(E.lcsAcc('please re-sign the form', 'please resign the form') < 1, 'resign (quit) stays distinct from re-sign');
  assert.ok(E.lcsAcc('please resign the form', 'please re-sign the form') < 1, 'reverse distinction holds too');
});

test('r10: plural tolerance applies only to 2↔1 compound merges, never to single-token plural pairs', () => {
  // 用户整篇背诵实测: 官方 some things vs ASR something(语音不可分)
  const score = E.scoreTokens('But some things were just beyond my control.', 'but something was just beyond my control.', true);
  assert.equal(score.acc, 7 / 8, 'the plural-differing merge matches; were/was stays a real miss');
  assert.deepEqual(score.marks, [true, true, true, false, true, true, true, true]);
  assert.equal(E.lcsAcc('some things happen', 'something happen'), 1, 'plural-differing merge matches');
  assert.ok(E.lcsAcc('some things happen', 'something happens') < 1, 'single-token verb plural still counts');
  // 单 token 对单 token 的复数差异(0016 判据)依旧不算对
  assert.ok(E.lcsAcc('the customer is here', 'the customers is here') < 1);
  assert.ok(E.lcsAcc('my friends call me', 'my friend call me') < 1);
});

test('r12/r21: letter+digit codes read as letters plus number words; ordinal digits read as ordinal words', () => {
  for (const [official, spoken] of [
    ['applying for a B2 visa', 'applying for a B two visa'],
    ['an H1B visa holder', 'an H one B visa holder'],
    ['on an F1 student visa', 'on an F one student visa']
  ]) {
    assert.equal(E.lcsAcc(official, spoken), 1, official);
    assert.equal(E.lcsAcc(spoken, official), 1, 'symmetric: ' + official);
  }
  assert.deepEqual(E.normTokens('the 1st of every month'), ['the', 'first', 'of', 'every', 'month'], 'ordinals read as words');
  assert.deepEqual(E.normTokens('the 56th floor'), ['the', 'fifty', 'sixth', 'floor']);
  assert.deepEqual(E.normTokens('the 21st'), ['the', 'twenty', 'first']);
  assert.deepEqual(E.normTokens('the 70th'), ['the', 'seventieth']);
  assert.deepEqual(E.normTokens('the 100th'), ['the', 'one', 'hundredth']);
  const official = 'Sir this is the 56th floor! We are on the 70th!';
  const spoken = 'Sir, this is the fifty sixth floor. We are on the seventies.';
  const voice = E.scoreTokens(official, spoken, true);
  assert.equal(voice.acc, 1, '0044: ordinal words plus ASR -ies mishearing');
  assert.deepEqual(voice.extras, []);
  assert.ok(E.scoreTokens(official, spoken, false).acc < 1, 'typing still needs a correct written form');
  assert.equal(E.lcsAcc('We are on the seventieth floor', 'We are on the 70th floor'), 1);
  assert.deepEqual(E.normTokens('back in the 70s'), ['back', 'in', 'the', 'seventies']);
  assert.equal(E.scoreTokens('We are on the 70th', 'We are on the 70s', true).acc, 1, 'decade digits equal the ASR-ordinal form');
  const jump = 'It\'s fine! Jump in!';
  assert.equal(E.scoreTokens(jump, 'It\'s fine jumping.', true).acc, 1, 'r23: jump in matches the ASR word form jumping');
  assert.ok(E.scoreTokens(jump, 'It\'s fine jumping.', false).acc < 1, 'typing still needs the real words');
  assert.ok(E.lcsAcc('a B2 visa', 'a B3 visa') < 1, 'different codes stay different');
  assert.equal(E.lcsAcc('your mp3 player', 'your mp3 player'), 1);
});

test('r24: noun +\'s copula readings match their ASR-opened two-word forms in voice only', () => {
  for (const [official, spoken] of [
    ['Sure, Tuesday\'s perfect. May I ask where you\'re calling from?', 'Sure, Tuesday is perfect. May I ask where you\'re calling from?'],
    ['Oh, actually, Tuesday\'s no good. Sorry \'bout that.', 'Oh, actually, Tuesday is no good. Sorry about that.'],
    ['Monday\'s fine.', 'Monday is fine,']
  ]) {
    const voice = E.scoreTokens(official, spoken, true);
    assert.equal(voice.acc, 1, official);
    assert.deepEqual(voice.extras, [], 'no false extras for ' + official);
    assert.ok(E.scoreTokens(official, spoken, false).acc < 1, 'typing keeps the written form distinct: ' + official);
  }
  assert.equal(E.scoreTokens('Oh, actually, Tuesday is no good.', 'Oh, actually, Tuesday\'s no good.', true).acc, 1, 'symmetric: contraction in the transcript too');
  assert.ok(E.scoreTokens('Tuesday\'s meeting moved.', 'Tuesday meeting moved.', false).acc < 1, 'possessive readings still require the \'s in typing');
});

test('r26: reduced were transcribed as re/are matches in voice only (0024)', () => {
  const official = 'We were thinking of checking out a restaurant in the neighborhood. Do you have any suggestions?';
  const spoken = "We're thinking of checking out a restaurant in the neighborhood. Do you have any suggestions?";
  const voice = E.scoreTokens(official, spoken, true);
  assert.equal(voice.acc, 1, 'fast-speech were -> are is an ASR artifact');
  assert.deepEqual(voice.extras, []);
  assert.equal(E.scoreTokens(spoken, official, true).acc, 1, 'symmetric');
  assert.ok(E.scoreTokens(official, spoken, false).acc < 1, 'typing keeps the tense distinct');
  assert.equal(E.scoreTokens('You were late.', 'You are late.', true).acc, 1);
  assert.equal(E.scoreTokens('They were here.', 'They are here.', true).acc, 1);
});
test('r25: -ie/-y homophone spellings match in both voice and typing', () => {
  const official = "Honey, that's my pinkie. The ring goes on the ring finger!";
  const spoken = "Honey, that's my pinky. The ring goes on the ring finger.";
  const voice = E.scoreTokens(official, spoken, true);
  assert.equal(voice.acc, 1, 'pinkie/pinky are the same spoken word');
  assert.deepEqual(voice.extras, []);
  assert.equal(E.lcsAcc(official, spoken), 1, 'dictation accepts the dictionary-variant spelling too');
  assert.ok(E.scoreTokens('the movie', 'the movey', true).acc < 1, 'unrelated words stay strict');
});
test('r11: whole-recite report gives accuracy, speed, fluency and a total', () => {
  const official = 'I know, and I apologize for the delay. But some things were just beyond my control.';
  const perfect = E.wholeReport(official, official, 19, 19);
  assert.deepEqual(perfect, {accuracy: 100, speed: 100, fluency: 100, total: 100});
  // 完美内容但拖沓 + 语气词/复读: 准确与语速流畅分开扣
  const sluggish = E.wholeReport(official, official + ' uh and uh the the end', 38, 19);
  assert.equal(sluggish.accuracy, 100, 'content stays clean');
  assert.ok(sluggish.speed < 85 && sluggish.speed > 50, 'dragging docks speed without hitting the floor at 2x');
  assert.ok(sluggish.fluency < 100, 'fillers and repeats dock fluency');
  assert.ok(sluggish.total < perfect.total);
  // 无原音锚点: speed 为 null, 总分改用准确 65 + 流畅 35 权重
  const noSrc = E.wholeReport(official, official, 19, 0);
  assert.equal(noSrc.speed, null);
  assert.equal(noSrc.total, 100);
  // 内容错词进入准确度(多出词不扣准确度, 与既有判分口径一致)
  const content = E.wholeReport(official, official.replace('control', 'banana'), 19, 19);
  assert.ok(content.accuracy < 100);
  assert.equal(E.wholeReport(official, official + ' banana', 19, 19).accuracy, 100);
  // 速度下限 50, 流畅度下限 50
  assert.equal(E.wholeReport(official, official, 60, 19).speed, 50);
});

test('r22: slow reciters get a finer speed curve instead of a flat 50', () => {
  const official = 'I know, and I apologize for the delay.';
  const speedAt = ratio => E.wholeReport(official, official, Math.round(20 * ratio), 20).speed;
  assert.equal(speedAt(0.8), 100, 'faster than the source is never penalized');
  assert.equal(speedAt(1.15), 100, 'same-speed band stays full marks');
  const slow = [1.5, 1.8, 2.0, 2.3, 2.6, 2.9].map(speedAt);
  assert.deepEqual(slow, [91, 82, 77, 69, 61, 53]);
  for (let k = 1; k < slow.length; k++) assert.ok(slow[k] < slow[k - 1], 'each extra delay lowers the score');
  assert.equal(new Set(slow).size, slow.length, 'values stay distinguishable by tenths of a multiple');
  assert.equal(speedAt(3.0), 50, 'floor only at three times the source length');
  assert.equal(speedAt(4.2), 50, 'beyond the floor stays at 50');
});

test('compound rescoring upgrades version-2 evidence without changing stamps and stays idempotent', () => {
  const old = whole('compound-whole', 15, 'You may be farsighted.', .6,
    {scoringVersion: 2, per: [{i: 0, acc: .6}], extra: ['farsighted']});
  const records = {course: {'eplod-0020': {drill: {wp: {latest: clone(old), best: clone(old)}, stampDays: {'2026-11-03': [0]}}}}};
  const source = () => [{text: 'You may be far-sighted.'}];
  const audit = E.repairVoiceScores(records, source);
  const drill = records.course['eplod-0020'].drill;
  assert.ok(audit.changed > 0);
  assert.equal(drill.wp.latest.acc, 1);
  assert.deepEqual(drill.wp.latest.per, [{i: 0, acc: 1}]);
  assert.deepEqual(drill.wp.latest.extra, []);
  assert.equal(drill.wp.latest.scoringVersion, E.SCORING_VERSION);
  assert.deepEqual(drill.stampDays, {'2026-11-03': [0]});
  for (const merged of [E.mergeDrill({wp: {latest: old, best: old}}, drill), E.mergeDrill(drill, {wp: {latest: old, best: old}})]) assert.equal(merged.wp.latest.acc, 1);
  assert.equal(E.repairVoiceScores(records, source).changed, 0);
});

test('normalization whitelist lookups return string tokens even for dictionary property names and oversized numbers', () => {
  assert.deepEqual(E.normTokens('constructor prototype tostring'), ['constructor', 'prototype', 'tostring']);
  assert.equal(E.lcsAccFuzzy('The constructor calls.', 'The construction calls.'), 2 / 3);
  assert.deepEqual(E.normTokens('21000 22000'), ['21000', '22000'], 'Numbers outside the existing reading table stay distinct');
  assert.equal(E.lcsAccFuzzy('I paid 21000.', 'I paid 22000.'), 2 / 3);
  const huge = '9'.repeat(400);
  assert.deepEqual(E.normTokens(huge), [huge]);
});

test('R7: floating accents map the omitted is to the correct original word segment', () => {
  const official = 'The d \u0301ecor is beautiful.';
  const score = E.scoreTokens(official, 'The decor beautiful.', true);
  const segments = E.tokenSegments(official);
  assert.equal(score.acc, .75);
  assert.deepEqual(score.marks, [true, true, false, true]);
  assert.deepEqual(segments.find(part => part.tokens.includes('decor')), {
    text: 'd \u0301ecor', tokens: ['decor']
  });
  let at = 0;
  const feedback = segments.filter(part => part.tokens.length).map(part => {
    const mark = {text: part.text, ok: score.marks.slice(at, at + part.tokens.length).every(Boolean)};
    at += part.tokens.length;
    return mark;
  });
  assert.deepEqual(feedback, [
    {text: 'The', ok: true}, {text: 'd \u0301ecor', ok: true},
    {text: 'is', ok: false}, {text: 'beautiful', ok: true}
  ]);
  assert.equal(at, score.marks.length, 'Each normalized mark is consumed exactly once');
});

test('R7: segments preserve source order and expand exactly the same tokens as whole-text normalization', () => {
  const samples = [
    '', '   ', '\u0301', "'''", '中文 🧪 — café fiancé cliché!',
    'd \u0301ecor', 'de\u0301cor', 'décor', 'cafe\u0301\u0300',
    'clich  \u0301e', 'd \u0301 \u0300ecor',
    "I'm gonna call customers' friends, 've and 'm.",
    'I’m gonna call ‘em at 5:58 — 20/20, 2020.',
    "'tis c'mon, lemme gimme outta lotta wanna gotta.",
    'Cancelled programmes: Hmm, okay. Ms. McNealy.'
  ];
  for (const text of samples) {
    const segments = E.tokenSegments(text);
    assert.equal(segments.map(part => part.text).join(''), text, 'Exact original text: ' + text);
    assert.deepEqual(segments.flatMap(part => part.tokens), E.normTokens(text), text);
    assert.ok(segments.every(part => typeof part.text === 'string' && Array.isArray(part.tokens)));
  }
  const expanded = E.tokenSegments('58 gonna ‘tis').filter(part => part.tokens.length);
  assert.deepEqual(expanded, [
    {text: '58', tokens: ['fifty', 'eight']},
    {text: 'gonna', tokens: ['going', 'to']},
    {text: '‘tis', tokens: ['it', 'is']}
  ]);
  // Compare against an independent copy of the former whole-text normalization on synthetic combinations.
  const rawTokens = text => text.toLowerCase().normalize('NFD')
    .replace(/ +[\u0300-\u036f]+/g, '').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9']+/g) || [];
  for (const left of ['d', 'The', '🧪', 'clich', 'de\u0301', '']) {
    for (const gap of [' ', ' \u0301', '\u0301', '  \u0301 \u0300', ' — ']) {
      for (const right of ['ecor', 'is', 'café', '']) {
        const text = left + gap + right;
        const segments = E.tokenSegments(text);
        assert.equal(segments.map(part => part.text).join(''), text);
        assert.deepEqual(segments.flatMap(part => part.tokens), rawTokens(text));
      }
    }
  }
});

const dialogue = [
  {text: 'I have fifteen dollars.', t0: 0, t1: 3},
  {text: 'Julianne calls McNealy.', t0: 3, t1: 6},
  {text: 'The d \u0301ecor is beautiful.', t0: 6, t1: 9}
];

test('r5: historical scores for 6\'1" lines rescore to the spoken form six one', () => {
  const height = [{text: "He's quite tall, around 6'1\", he's happy.", t0: 0, t1: 5}];
  const spoken = "He's quite tall, around six one, he's happy.";
  // 语音路径: 旧账按旧引擎只拿 5/7, 新引擎逐词全中
  const records = {course: {'eplod-0039': {drill: {
    rd: {0: {...row(voice('height-take', 20, spoken, 5 / 7)), recAttemptId: 'height-take'}}
  }}}};
  const audit = E.repairVoiceScores(records, () => height);
  assert.ok(audit.changed >= 1, 'voice repair fired');
  assert.equal(records.course['eplod-0039'].drill.rd[0].voice.acc, 1);
  assert.equal(records.course['eplod-0039'].drill.rd[0].latest.acc, 1);
  assert.equal(E.repairVoiceScores(records, () => height).changed, 0, 'idempotent');
  // 听写路径: repairNumberScores 同款只升不降
  const dict = {course: {'eplod-0039': {drill: {dd: {0: {acc: 6 / 7, mode: 'dict', last: spoken, at: 5}}}}}};
  assert.equal(E.repairNumberScores(dict, () => height), 1);
  assert.equal(dict.course['eplod-0039'].drill.dd[0].acc, 1);
});

const bestText = 'I have fifty dollars. Julian calls McLean. The decor is beautiful.';
const latestText = 'I have dollars. Julian calls McLean. The decor beautiful. extra';

function fixture() {
  return {version: 1, revision: 42, saved_at: '2026-10-30T10:00:00.000Z',
    study: {total: 123, days: {'2026-10-30': 123}}, attempts: {other: {keep: true}},
    course: {
      'eplod-0016': {at: 12345, done: true, unknown: 'keep lesson', drill: {
        rd: {
          0: {...row(voice('number-take', 20, 'I have fifty dollars.', 1)),
            rec: 'synthetic-number-take.webm', recAt: 20, recAttemptId: 'number-take',
            typed: {id: 'old-type', at: 10, mode: 'type', text: 'my old answer', acc: .95},
            draft: 'keep draft'},
          1: row(voice('name-take', 30, 'Julian calls McLean.', 1 / 3)),
          2: {acc: 1, mode: 'voice', at: 40, last: 'The decor beautiful.', dur: 3,
            rec: 'synthetic-legacy.webm', unknown: {keep: true}},
          3: {acc: .98, mode: 'voice', at: 50, last: 'no source for this sentence'}
        },
        dd: {0: {acc: 1, mode: 'dict', last: 'I have fifty dollars.', at: 5}},
        sd: {0: {id: 'number-take', at: 20, acc: 1, dur: 3, sourceDur: 3, verified: true}},
        stampDays: {'2026-10-28': [0, 1, 2], '2026-10-29': [0, 1, 2]},
        recoveredCover: {sentences: [0, 1, 2], recognizedAt: 1}, playsS: {0: 7},
        wp: {
          best: whole('whole-best', 11, bestText, 1, {
            per: [{i: 0, acc: 1}, {i: 1, acc: 1}, {i: 2, acc: 1}], extra: []
          }),
          latest: whole('whole-latest', 50, latestText, 1, {
            per: [{i: 0, acc: 1}, {i: 1, acc: 1}, {i: 2, acc: 1}], extra: []
          })
        }
      }},
      'eplod-0024': {drill: {wp: {
        best: {id: 'unproven-history', at: 1, acc: .99, per: [{i: 0, acc: .99}], note: 'no transcript'},
        latest: whole('known-latest', 2, bestText, 1)
      }}},
      'eplod-0030': {drill: {rd: {0: row(voice('no-dialogue', 40, 'I have fifty dollars.', 1))}}},
      'unrelated-course': {drill: {rd: {0: row(voice('unrelated', 1, 'I have fifty dollars.', 1))}}}
    }
  };
}

test('historical correction audits only explicit evidence, preserving best aggregates, records, dates and stamps', () => {
  const records = fixture(), before = clone(records);
  const courseRef = records.course, drillRef = records.course['eplod-0016'].drill;
  const audit = E.repairVoiceScores(records, id => id === 'eplod-0030' ? null : dialogue);
  const drill = records.course['eplod-0016'].drill;
  assert.equal(records.course, courseRef);
  assert.equal(drill, drillRef, 'Existing live object references remain valid');
  assert.ok(audit.changed > 0);
  assert.equal(audit.changed, audit.changes.length);
  assert.equal(drill.rd[0].voice.acc, .75);
  assert.equal(drill.rd[0].latest.acc, .75);
  assert.equal(drill.rd[0].lastAcc, .75);
  assert.equal(drill.rd[0].acc, 1, 'An unproven past best cannot be replaced using latest text');
  assert.equal(drill.rd[1].voice.acc, 1, 'Confirmed aliases still count on this take');
  assert.equal(drill.rd[1].lastAcc, 1);
  assert.equal(drill.rd[1].acc, 1 / 3, 'Even upward aggregate rewrites require provenance');
  assert.equal(drill.rd[2].lastAcc, .75, 'Legacy last has evidence for its own latest accuracy');
  assert.equal(drill.rd[2].acc, 1);
  assert.equal(drill.rd[0].voice.scoringVersion, E.SCORING_VERSION);
  assert.equal(drill.rd[0].latest.scoringVersion, E.SCORING_VERSION);
  assert.equal(drill.rd[2].lastScoringVersion, E.SCORING_VERSION);
  assert.equal(drill.wp.best.acc, 10 / 11);
  assert.deepEqual(drill.wp.best.per, [{i: 0, acc: .75}, {i: 1, acc: 1}, {i: 2, acc: 1}]);
  assert.deepEqual(drill.wp.best.extra, ['fifty']);
  assert.deepEqual(drill.wp.latest.per, [{i: 0, acc: .75}, {i: 1, acc: 1}, {i: 2, acc: .75}]);
  assert.deepEqual(drill.wp.latest.extra, ['extra']);
  assert.equal(drill.wp.latest.acc, 9 / 11);
  assert.equal(drill.wp.best.text, bestText);
  assert.equal(drill.wp.latest.text, latestText, 'Each whole take is scored from its own transcript');
  assert.equal(drill.wp.best.id, 'whole-best');
  assert.equal(drill.wp.best.at, 11);
  assert.deepEqual(records.course['eplod-0024'].drill.wp.best, before.course['eplod-0024'].drill.wp.best,
    'A best without its own transcript is not replaced using the latest transcript');
  assert.deepEqual(records.course['eplod-0030'], before.course['eplod-0030']);
  assert.deepEqual(records.course['unrelated-course'], before.course['unrelated-course']);
  for (const key of ['dd', 'sd', 'stampDays', 'recoveredCover', 'playsS']) {
    assert.deepEqual(drill[key], before.course['eplod-0016'].drill[key], key + ' is retained');
  }
  for (const key of ['typed', 'rec', 'recAt', 'recAttemptId', 'draft']) {
    assert.deepEqual(drill.rd[0][key], before.course['eplod-0016'].drill.rd[0][key], key + ' is retained');
  }
  assert.deepEqual(Object.keys(drill.rd), Object.keys(before.course['eplod-0016'].drill.rd));
  assert.deepEqual(records.study, before.study);
  assert.equal(records.revision, before.revision);
  assert.equal(records.saved_at, before.saved_at);
  assert.ok(audit.skipped.some(item => item.reason === 'unverifiable-historical-best'));
  assert.ok(audit.skipped.some(item => item.path.join('.') === 'course.eplod-0024.drill.wp.best' && item.reason === 'transcript-unavailable'));
  assert.ok(audit.skipped.some(item => item.reason === 'dialogue-unavailable'));
  // The audit must account for every mutation, and must never include a text/date/progress field.
  const replay = clone(before);
  for (const change of audit.changes) {
    assert.match(change.path.join('.'), /\.(?:acc|lastAcc|per|extra|scoringVersion|lastScoringVersion)$/);
    let target = replay;
    for (const key of change.path.slice(0, -1)) target = target[key];
    const key = change.path.at(-1);
    assert.deepEqual(target[key], change.before, 'Audit contains the actual previous value');
    target[key] = clone(change.after);
    assert.ok(change.reason);
  }
  assert.deepEqual(records, replay, 'No unreported record mutation');
  const once = clone(records);
  const retry = E.repairVoiceScores(records, id => id === 'eplod-0030' ? null : dialogue);
  assert.equal(retry.changed, 0);
  assert.deepEqual(retry.changes, []);
  assert.deepEqual(records, once, 'Migration can be repeated without changes');
});

test('historical whole best is reselected only after both takes are verified, retaining replaced evidence in audit', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
  const oldBestText = words.map((word, i) => i % 4 === 0 ? 'fifty' : word).join(' ');
  const newerText = words.slice(0, -1).join(' ');
  const best = whole('old-false-perfect', 10, oldBestText, 1, {note: 'retain full original evidence'});
  const latest = whole('newer-real-95', 20, newerText, .95);
  const records = {course: {'eplod-0016': {drill: {
    wp: {best: clone(best), latest: clone(latest)}, stampDays: {'2026-10-30': [0]}
  }}}};
  const audit = E.repairVoiceScores(records, () => [{text: words.join(' ')}]);
  const drill = records.course['eplod-0016'].drill;
  assert.equal(drill.wp.best.id, latest.id);
  assert.equal(drill.wp.best.acc, .95, 'A verified 95% take stays the best after the old perfect score falls to 75%');
  assert.equal(drill.wp.latest.id, latest.id, 'Reselecting best never rewrites latest identity');
  assert.deepEqual(drill.stampDays, {'2026-10-30': [0]});
  const replacement = audit.changes.find(item => item.reason === 'verified-whole-best-order');
  assert.deepEqual(replacement.path, ['course', 'eplod-0016', 'drill', 'wp', 'best']);
  assert.equal(replacement.before.id, best.id);
  assert.equal(replacement.before.text, best.text);
  assert.equal(replacement.before.note, best.note);
  assert.equal(replacement.before.acc, .75);
  assert.deepEqual(replacement.after, drill.wp.best);
  assert.equal(E.repairVoiceScores(records, () => [{text: words.join(' ')}]).changed, 0);

  const unproven = {id: 'no-transcript', at: 5, acc: 1};
  const keep = {course: {'eplod-0016': {drill: {wp: {best: clone(unproven), latest: clone(latest)}}}}};
  E.repairVoiceScores(keep, () => [{text: words.join(' ')}]);
  assert.deepEqual(keep.course['eplod-0016'].drill.wp.best, unproven, 'An unverified best remains intact');

  const tied = {course: {'eplod-0016': {drill: {wp: {
    best: whole('older', 1, 'I have fifty dollars.', 1),
    latest: whole('newer', 2, 'I have fifty dollars.', 1)
  }}}}};
  E.repairVoiceScores(tied, () => [dialogue[0]]);
  assert.equal(tied.course['eplod-0016'].drill.wp.best.id, 'newer', 'Equal corrected scores retain the existing time/id tie rule');
});

test('historical correction preserves missing/conflicting evidence and future scoring versions', () => {
  const future = E.SCORING_VERSION + 1;
  const mismatch = {...row(voice('mismatch', 10, 'I have fifteen dollars.', .8)),
    last: 'I have fifty dollars.', lastAcc: .91};
  const records = {course: {'eplod-0016': {drill: {rd: {
    0: mismatch,
    1: row(voice('empty', 20, '', 1)),
    2: {...row(voice('future', 30, 'The decor beautiful.', .99, {scoringVersion: future})), lastScoringVersion: future}
  }, wp: {best: whole('empty-whole', 40, ' ', 1), latest: whole('future-whole', 50, bestText, .99, {scoringVersion: future})}}}}};
  const before = clone(records);
  const audit = E.repairVoiceScores(records, () => dialogue);
  const drill = records.course['eplod-0016'].drill;
  assert.equal(drill.rd[0].latest.acc, 1);
  assert.equal(drill.rd[0].lastAcc, .91, 'An inconsistent mirror has no unambiguous attempt binding');
  assert.deepEqual(drill.rd[1], before.course['eplod-0016'].drill.rd[1]);
  assert.deepEqual(drill.rd[2], before.course['eplod-0016'].drill.rd[2]);
  assert.deepEqual(drill.wp, before.course['eplod-0016'].drill.wp);
  assert.ok(audit.skipped.some(item => item.reason === 'conflicting-latest-mirror'));
  assert.ok(audit.skipped.some(item => item.reason === 'newer-scoring-version'));
  const unavailable = fixture(), old = clone(unavailable);
  assert.equal(E.repairVoiceScores(unavailable, () => {throw Error('synthetic unavailable source');}).changed, 0);
  assert.deepEqual(unavailable, old);
});

test('compatibility repair entry point cannot raise fifteen/fifty to a perfect historical score', () => {
  const records = {course: {'eplod-0016': {drill: {rd: {
    0: {acc: .5, at: 10, mode: 'voice', last: 'I have fifty dollars.'}
  }}}}};
  assert.equal(E.repairVoiceFuzzyScores(records, () => dialogue), 2, 'Only lastAcc and its version are written');
  const result = records.course['eplod-0016'].drill.rd[0];
  assert.equal(result.acc, .5, 'Unknown best aggregate is retained');
  assert.equal(result.lastAcc, .75);
  assert.equal(E.repairVoiceFuzzyScores(records, () => dialogue), 0);
});

test('same-attempt voice merges prefer the corrected scoring version in both directions', () => {
  const stale = E.saveAttempt({}, voice('same-take', 10, 'I have fifty dollars.', 1));
  const current = E.saveAttempt({}, voice('same-take', 10, 'I have fifty dollars.', .75,
    {scoringVersion: E.SCORING_VERSION}));
  assert.equal(current.latest.scoringVersion, E.SCORING_VERSION, 'saveAttempt retains the version');
  const merge = (a, b) => E.mergeDrill({rd: {0: a}}, {rd: {0: b}}).rd[0];
  for (const result of [merge(stale, current), merge(current, stale)]) {
    assert.equal(result.latest.acc, .75);
    assert.equal(result.voice.acc, .75);
    assert.equal(result.lastAcc, .75);
    assert.equal(result.lastScoringVersion, E.SCORING_VERSION);
    assert.equal(result.acc, 1, 'Unverifiable historical aggregate is still preserved');
    assert.deepEqual(merge(result, stale), result, 'A retry of the stale snapshot cannot undo the correction');
  }
  const later = E.saveAttempt({}, voice('different-take', 20, 'I have fifteen dollars.', 1));
  assert.equal(merge(current, later).latest.id, 'different-take', 'Versions never reverse real attempt chronology');
  const legacy = {at: 10, mode: 'voice', last: 'I have fifty dollars.', lastAcc: 1, acc: 1};
  const corrected = clone(legacy);
  E.repairVoiceScores({course: {'eplod-0016': {drill: {rd: {0: corrected}}}}}, () => dialogue);
  for (const result of [merge(legacy, corrected), merge(corrected, legacy)]) {
    assert.equal(result.lastAcc, .75, 'Legacy same text/mode/time mirrors keep the corrected version');
  }
});

test('same-attempt whole best/latest merges discard the stale score before best selection', () => {
  const stale = whole('same-whole', 10, bestText, 1, {per: [{i: 0, acc: 1}], extra: []});
  const corrected = {...clone(stale), acc: 10 / 11,
    per: [{i: 0, acc: .75}, {i: 1, acc: 1}, {i: 2, acc: 1}], extra: ['fifty'],
    scoringVersion: E.SCORING_VERSION};
  const merge = (a, b) => E.mergeDrill({wp: a}, {wp: b}).wp;
  for (const result of [
    merge({best: stale, latest: stale}, {best: corrected, latest: corrected}),
    merge({best: corrected, latest: corrected}, {best: stale, latest: stale})
  ]) {
    assert.equal(result.latest.acc, corrected.acc);
    assert.deepEqual(result.best, corrected);
    assert.deepEqual(merge(result, {best: stale, latest: stale}), result);
  }
  const unprovenOtherBest = {id: 'other-history', at: 5, acc: 1};
  const mixed = merge({best: unprovenOtherBest}, {latest: corrected, best: corrected});
  assert.deepEqual(mixed.best, unprovenOtherBest, 'A different historical take without transcript is retained');
  assert.equal(mixed.latest.id, corrected.id);
});
