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
    ['The décor, de\u0301cor and d \u0301ecor.', 'The decor decor and decor.']
  ]) {
    assert.deepEqual(E.normTokens(a), E.normTokens(b), a);
    assert.equal(E.lcsAcc(a, b), 1);
  }
  assert.deepEqual(E.scoreTokens("I'm gonna call.", "I'm gonna to call.", true), {
    acc: 1, marks: [true, true, true, true], extras: ['to'],
    matched: [true, true, false, true, true], pairs: [[0, 0], [1, 1], [2, 3], [3, 4]]
  }, 'The extra to remains visible after slang expansion');
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
