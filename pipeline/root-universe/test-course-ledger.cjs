'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildCourseLedger, createCourseIndex, validateLedger, sha256, jsonBytes } = require('../../root-universe/course.cjs');
const { PROJECT, buildProjectLedger, loadProjectInputs, artifactValues, writePlanningVersion } = require('./build-course-ledger.cjs');
const qa = path.join(PROJECT, 'build/qa/root-universe', 'course-ledger-' + crypto.randomUUID());
fs.mkdirSync(qa, { recursive: true });
const results = [];
function test(name, fn) {
  const started = Date.now();
  try { fn(); results.push({ name, passed: true, duration_ms: Date.now() - started }); console.log('PASS ' + name); }
  catch (e) { results.push({ name, passed: false, error: e.stack, duration_ms: Date.now() - started }); console.error('FAIL ' + name + '\n' + e.stack); }
}
function fixture() {
  const course = { course: 'cfcm-01', batches: [{ id: '1-1', lesson: 1, root: 'x', words: [
    { w: 'alpha', lesson: 1, also: [2], def: 'n. 首项' }, { w: 'unreadabl', lesson: 1, also: [], def: 'adj. 难读' }
  ] }] };
  const note = (lesson, text) => ({ lesson, file: `notes/cfcm-01-${String(lesson).padStart(2, '0')}.json`,
    raw: jsonBytes({ id: `cfcm-01-${String(lesson).padStart(2, '0')}`, source_file: 'handout.pdf', pages: [{ page: 1, text }] }) });
  return { course: { file: 'words.json', raw: jsonBytes(course) }, notes: [
    note(1, '小红书：来源\n1\n炒面学姐万词班第一课讲义（3 个）\n词根3：x（1 个）\nalpha\n/ˈæl\nfə/\nn. 首项\n词根3：y（2 个）\nunreadabl\n/ʌn/\nadj. 难读\nunreadable\n/ʌn/\nadj. 难读\n'),
    note(2, '小红书：来源\n2\nalpha\n/æl/\nn. 续页首项\n炒面学姐万词班第二课讲义（1 个）\n词根1：z（1 个）\nalpha\n/æl/\nn. 再现\n')
  ] };
}
function changeNote(spec, transform) {
  const next = structuredClone(spec); next.course.raw = Buffer.from(spec.course.raw);
  next.notes = spec.notes.map(n => ({ ...n, raw: Buffer.from(n.raw) }));
  const j = JSON.parse(next.notes[0].raw); j.pages[0].text = transform(j.pages[0].text); next.notes[0].raw = jsonBytes(j);
  return next;
}
let built;
test('full frozen inputs build with 13,151 heads / 36 lessons / 526 groups', () => {
  built = buildProjectLedger();
  assert.deepEqual([built.ledger.summary.headwords, built.ledger.summary.lessons, built.ledger.summary.groups], [13151, 36, 526]);
  assert.equal(built.ledger.summary.recovered_occurrences, 13459);
  assert.equal(built.ledger.summary.mapped_occurrences, 13451);
  assert.equal(built.ledger.summary.located_headwords, 13151);
});
test('independent source row census equals occurrence ledger without dropping lines', () => {
  const { ledger, loaded } = built;
  let count = 0, totalLines = 0;
  for (const n of loaded.notes) {
    const note = JSON.parse(n.raw);
    for (const p of note.pages) {
      const ls = p.text.split('\n'); totalLines += ls.length;
      for (let i = 0; i < ls.length - 1; i++) {
        if (ls[i].trim() && !ls[i].trim().startsWith('/') && ls[i + 1].trim().startsWith('/')) count++;
      }
    }
  }
  assert.equal(count, 13459); assert.equal(ledger.occurrences.length, count);
  assert.equal(ledger.line_accounting.length, totalLines);
  assert.equal(ledger.coverage.unparsed_lines.length, 0);
  assert.equal(new Set(ledger.line_accounting.map(l => JSON.stringify([l.source.file, l.source.json_pointer, l.source.line]))).size, totalLines);
});
test('every source locator resolves exact original UTF-8 bytes and input hashes', () => {
  const { ledger, loaded } = built;
  const sources = new Map(loaded.notes.map(n => [n.file, { raw: n.raw, value: JSON.parse(n.raw) }]));
  const check = source => {
    const n = sources.get(source.file); assert.equal(source.sha256, sha256(n.raw));
    const pi = Number(source.json_pointer.split('/')[2]), text = n.value.pages[pi].text;
    assert.equal(n.value.pages[pi].page, source.note_page);
    assert.equal(Buffer.from(text).subarray(source.text_utf8_byte_start, source.text_utf8_byte_end).toString(), text.split('\n')[source.line - 1]);
  };
  for (const line of ledger.line_accounting) check(line.source);
  for (const o of ledger.occurrences) { check(o.source); for (const l of [...o.ipa_lines, ...o.definition_lines]) check(l.source); }
  const course = JSON.parse(loaded.course.raw);
  for (const h of ledger.headwords) {
    const p = h.source.json_pointer.split('/'); assert.equal(course.batches[Number(p[2])].words[Number(p[4])].w, h.raw_headword);
    assert.equal(h.source.sha256, sha256(loaded.course.raw));
  }
});
test('duplicate printed group number survives with distinct position IDs and edges', () => {
  const l = buildCourseLedger(fixture());
  assert.deepEqual(l.groups.filter(g => g.lesson === 1).map(g => [g.id, g.printed_number]), [['CG-001-001', 3], ['CG-001-002', 3]]);
  assert.equal(l.coverage.duplicate_printed_numbers.length, 1);
  assert.equal(l.groups[0].occurrence_ids.length, 1); assert.equal(l.groups[1].occurrence_ids.length, 3);
  const real = built.ledger.coverage.duplicate_printed_numbers;
  assert.deepEqual(real[0].group_ids, ['CG-008-003', 'CG-008-004']);
});
test('cross-file continuation belongs to previous lesson and retains physical location', () => {
  const l = buildCourseLedger(fixture());
  const continuation = l.occurrences.find(o => o.course_target_sense.raw_definition === 'n. 续页首项');
  assert.equal(continuation.lesson, 1); assert.equal(continuation.course_group_id, 'CG-001-002');
  assert.equal(continuation.source.file, 'notes/cfcm-01-02.json');
  assert.equal(built.ledger.coverage.cross_file_continuations.length, 93);
  assert.equal(built.ledger.groups.find(g => g.id === 'CG-031-019').source.file, 'build/courses/notes/cfcm-01-32.json');
  assert.equal(built.ledger.groups.find(g => g.id === 'CG-032-001').printed_number, 1);
});
test('cross-course repetitions use one headword and preserve every ordered occurrence', () => {
  const l = buildCourseLedger(fixture()), index = createCourseIndex(l), h = index.findHeadwords('alpha')[0];
  assert.equal(index.occurrencesForHeadword(h.id).length, 3);
  assert.deepEqual(index.occurrencesForHeadword(h.id).map(o => o.lesson), [1, 1, 2]);
  const actual = createCourseIndex(built.ledger), verdict = actual.findHeadwords('verdict')[0];
  assert.deepEqual(actual.occurrencesForHeadword(verdict.id).map(o => o.lesson), [18, 20]);
});
test('unreadabl is preserved and unreadable never becomes an automatic alias', () => {
  const l = buildCourseLedger(fixture()), index = createCourseIndex(l), raw = index.findHeadwords('unreadabl')[0];
  assert.equal(raw.approved_aliases.length, 0); assert.equal(index.findHeadwords('unreadable').length, 0);
  const mismatch = l.occurrences.find(o => o.word === 'unreadable');
  assert.equal(mismatch.headword_id, null); assert.equal(mismatch.unresolved_reason, 'NO_EXACT_OR_CASEFOLD_HEADWORD');
  assert.equal(mismatch.source.line, 15);
  const real = createCourseIndex(built.ledger);
  assert.equal(real.findHeadwords('unreadabl').length, 1); assert.equal(real.findHeadwords('unreadable').length, 0);
});
test('wrapped IPA remains one word and accent/hyphen spelling survives', () => {
  const l = buildCourseLedger(fixture()); assert.equal(l.occurrences[0].ipa, '/ˈæl\nfə/');
  assert.equal(l.occurrences.filter(o => o.word === 'alpha').length, 3);
  assert.equal(built.ledger.occurrences.filter(o => o.word.startsWith('/')).length, 0);
  const unicode = built.ledger.occurrences.find(o => o.word === 'vis-à-vis');
  assert.ok(unicode); assert.equal(unicode.headword_id, null);
});
test('all eight real OCR/spelling differences remain explicit and located', () => {
  const rows = built.ledger.coverage.unresolved_occurrences;
  assert.deepEqual(rows.map(r => r.word), ['three-dimensiona', 'larger-than-life', 'Spanish-speaking', 'interdependen', 'interdependent', 'perpendicular', 'electrocardiogra', 'vis-à-vis']);
  assert.ok(rows.every(r => r.source.sha256 && r.source.line > 0 && r.course_group_id && r.reason));
  assert.equal(built.ledger.summary.denominator_frozen, false);
  assert.equal(built.ledger.summary.published_complete, false);
});
test('dict classroom scope exports all 58 rows and includes cross-course verdict', () => {
  const a = artifactValues(built.ledger)['dict-classroom-scope.json'];
  assert.equal(a.occurrence_count, 58); assert.equal(a.course_group_id, 'CG-020-006');
  assert.deepEqual(a.occurrences.map(o => o.group_word_order), Array.from({ length: 58 }, (_, i) => i + 1));
  assert.ok(a.occurrences.every(o => o.headword_id && o.course_word_key && o.source.sha256 && o.lesson === 20));
  assert.equal(a.occurrences[0].word, 'abdicate'); assert.equal(a.occurrences[57].word, 'betoken');
  assert.ok(a.occurrences.some(o => o.word === 'verdict'));
});
test('printed counts and original title discrepancies stay unresolved without padding', () => {
  const l = built.ledger;
  assert.deepEqual(l.coverage.group_count_differences.map(g => [g.course_group_id, g.declared_count, g.recovered_count]), [
    ['CG-009-003', 96, 101], ['CG-025-009', 26, 21], ['CG-035-001', 11, 12]
  ]);
  assert.equal(l.coverage.lesson_count_differences.length, 17);
  const near = l.groups.find(g => g.lesson === 24 && g.printed_number === 7);
  assert.equal(near.heading_lines.length, 2); assert.equal(near.declared_count, 20);
});
test('casefold can match a unique raw head but preserves case and flags collisions', () => {
  const f = changeNote(fixture(), s => s.replace('alpha\n', 'ALPHA\n'));
  const l = buildCourseLedger(f); assert.equal(l.occurrences[0].alignment, 'casefold'); assert.equal(l.occurrences[0].word, 'ALPHA');
  const c = JSON.parse(f.course.raw); c.batches[0].words.push({ w: 'Alpha', lesson: 1, also: [] }); f.course.raw = jsonBytes(c);
  const collided = buildCourseLedger(f);
  assert.equal(collided.coverage.lookup_key_collisions.length, 1);
  assert.equal(collided.occurrences[0].unresolved_reason, 'LOOKUP_KEY_COLLISION');
});
test('unmatched headword and malformed word rows are retained as unresolved', () => {
  const f = changeNote(fixture(), s => s.replace('alpha\n', 'alpha123\n'));
  const l = buildCourseLedger(f);
  assert.equal(l.occurrences[0].word, 'alpha123'); assert.equal(l.occurrences[0].headword_id, null);
  assert.ok(l.occurrences[0].parse_issues.includes('INVALID_WORD_FORM'));
  const c = JSON.parse(f.course.raw); c.batches[0].words.push({ w: 'missing', lesson: 1, also: [] }); f.course.raw = jsonBytes(c);
  assert.ok(buildCourseLedger(f).coverage.missing_headwords.some(h => h.raw_headword === 'missing'));
});
test('unclassified source line and missing IPA are reported instead of silently dropped', () => {
  const f = changeNote(fixture(), s => s.replace('词根3：x', '待核原文\n词根3：x').replace('alpha\n/ˈæl\nfə/', 'alpha'));
  const l = buildCourseLedger(f);
  assert.equal(l.coverage.unparsed_lines[0].raw, '待核原文');
  assert.ok(l.occurrences[0].parse_issues.includes('MISSING_IPA'));
  assert.equal(l.occurrences[0].headword_id, null);
});
test('invalid JSON and invalid UTF-8 fail closed', () => {
  const f = fixture(); f.course.raw = Buffer.from('{'); assert.throws(() => buildCourseLedger(f), /INVALID_JSON_OR_UTF8/);
  f.course.raw = Buffer.from([0xff]); assert.throws(() => buildCourseLedger(f), /INVALID_JSON_OR_UTF8/);
});
test('duplicate heads/batches/notes and unordered source pages are rejected', () => {
  const f = fixture(), c = JSON.parse(f.course.raw); c.batches[0].words.push({ ...c.batches[0].words[0] }); f.course.raw = jsonBytes(c);
  assert.throws(() => buildCourseLedger(f), /INVALID_OR_DUPLICATE_HEADWORD/);
  const b = fixture(), cb = JSON.parse(b.course.raw); cb.batches.push(cb.batches[0]); b.course.raw = jsonBytes(cb);
  assert.throws(() => buildCourseLedger(b), /INVALID_BATCH/);
  const n = fixture(); n.notes.push(n.notes[0]); assert.throws(() => buildCourseLedger(n), /INVALID_OR_DUPLICATE_NOTE/);
  const p = fixture(), np = JSON.parse(p.notes[0].raw); np.pages.push({ page: 1, text: '' }); p.notes[0].raw = jsonBytes(np);
  assert.throws(() => buildCourseLedger(p), /INVALID_NOTE_PAGE/);
});
test('wrong source title, missing groups and unscoped words reject invalid inputs', () => {
  assert.throws(() => buildCourseLedger(changeNote(fixture(), s => s.replace('第一课', '第三课'))), /INVALID_LESSON_TITLE/);
  assert.throws(() => buildCourseLedger(changeNote(fixture(), s => s.replace(/词根3：[xy]（\d 个）\n/g, ''))), /WORD_WITHOUT_GROUP/);
  const f = fixture(); f.notes[0].raw = jsonBytes({ id: 'cfcm-01-01', pages: [{ page: 1, text: '炒面学姐万词班第一课讲义（0 个）' }] });
  assert.throws(() => buildCourseLedger(f), /NOTE_WITHOUT_TITLE_OR_GROUPS/);
});
test('byte hash catches whitespace-only course and note changes', () => {
  const f = fixture(); f.expected = { course_sha256: sha256(f.course.raw) }; f.course.raw = Buffer.concat([f.course.raw, Buffer.from('\n')]);
  assert.throws(() => buildCourseLedger(f), /FROZEN_COURSE_HASH_CHANGED/);
  const shadow = path.join(qa, 'fixtures/frozen-input');
  for (const s of built.loaded.provenance) { const target = path.join(shadow, s.file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, s.raw); }
  const n = built.loaded.notes[0], target = path.join(shadow, n.file); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat([n.raw, Buffer.from('\n')]));
  assert.throws(() => loadProjectInputs(shadow), /FROZEN_NOTE_HASH_CHANGED/);
});
test('expected denominators and broken reverse mappings fail validation', () => {
  const f = fixture(); f.expected = { headwords: 999 }; assert.throws(() => buildCourseLedger(f), /EXPECTED_COUNT_CHANGED/);
  const l = buildCourseLedger(fixture()); l.headwords[0].occurrence_ids.pop(); assert.throws(() => validateLedger(l), /BROKEN_ALIGNMENT/);
  const duplicate = buildCourseLedger(fixture()); duplicate.groups.push(duplicate.groups[0]); assert.throws(() => validateLedger(duplicate), /DUPLICATE_ID/);
});
test('same bytes yield identical artifacts, including IDs, order and source locators', () => {
  const f = fixture(), a = buildCourseLedger(f), b = buildCourseLedger(f);
  assert.ok(jsonBytes(a).equals(jsonBytes(b)));
  assert.ok(jsonBytes(artifactValues(a)).equals(jsonBytes(artifactValues(b))));
});
test('immutable planning write is idempotent, retains old versions and rejects tampering', () => {
  const ledger = buildCourseLedger(fixture());
  const loaded = { provenance: ['planning-manifest.json', 'course-queue.json', 'word-ledger.json'].map(name => ({ file: 'build/qa/root-universe/review-20261107/' + name, raw: jsonBytes({ name }) })), expected: {} };
  const root = path.join(qa, 'fixtures/planning');
  const first = writePlanningVersion({ ledger, loaded }, root), second = writePlanningVersion({ ledger, loaded }, root);
  assert.equal(first.version, second.version); assert.equal(second.reused, true);
  for (const entry of first.manifest.artifacts) assert.equal(sha256(fs.readFileSync(path.join(first.directory, entry.file))), entry.sha256);
  const changed = buildCourseLedger(changeNote(fixture(), s => s.replace('n. 再现', 'n. 更正')));
  // Change a byte present in the first note to ensure the fixture really changes.
  const changedAgain = buildCourseLedger(changeNote(fixture(), s => s.replace('n. 首项', 'n. 更正')));
  const next = writePlanningVersion({ ledger: changedAgain, loaded }, root);
  assert.notEqual(first.version, next.version); assert.ok(fs.existsSync(first.directory));
  assert.equal(changed.summary.headwords, 2);
  fs.appendFileSync(path.join(first.directory, 'coverage.json'), '\n');
  assert.throws(() => writePlanningVersion({ ledger, loaded }, root), /IMMUTABLE_VERSION_CONFLICT/);
});
const failed = results.filter(r => !r.passed).length;
const report = { ok: failed === 0, passed: results.length - failed, failed, results,
  full_summary: built?.ledger.summary || null, qa_directory: qa };
fs.writeFileSync(path.join(qa, 'result.json'), jsonBytes(report));
fs.writeFileSync(path.join(qa, 'exit-code.json'), jsonBytes({ command: 'node pipeline/root-universe/test-course-ledger.cjs', exit_code: failed ? 1 : 0 }));
console.log(JSON.stringify({ ok: report.ok, passed: report.passed, failed, qa_directory: qa }));
process.exitCode = failed ? 1 : 0;
