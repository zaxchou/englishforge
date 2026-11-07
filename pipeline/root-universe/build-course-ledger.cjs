'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildCourseLedger, sha256, jsonBytes, SCHEMA } = require('../../root-universe/course.cjs');
const PROJECT = path.resolve(__dirname, '../..');
const REVIEW = 'build/qa/root-universe/review-20261107';
const BASELINE_FILES = ['planning-manifest.json', 'course-queue.json', 'word-ledger.json'];
const PROVENANCE_FILES = [
  'docs/word-root-universe/09-全量词根联盟工作计划.md',
  `${REVIEW}/audit-course.cjs`, `${REVIEW}/freeze-plan.cjs`, `${REVIEW}/course-audit.json`,
  ...BASELINE_FILES.map(name => `${REVIEW}/${name}`),
  'root-universe/course.cjs', 'pipeline/root-universe/build-course-ledger.cjs'
];
function loadProjectInputs(projectRoot = PROJECT) {
  const read = file => ({ file, raw: fs.readFileSync(path.join(projectRoot, file)) });
  const provenance = PROVENANCE_FILES.map(read);
  const frozen = JSON.parse(provenance.find(s => s.file === `${REVIEW}/planning-manifest.json`).raw);
  const queue = JSON.parse(provenance.find(s => s.file === `${REVIEW}/course-queue.json`).raw);
  if (frozen.headwords !== 13151 || frozen.lessons !== 36 || frozen.handout_group_occurrences !== 526 ||
      frozen.course_file !== 'build/vocab/cfcm-words.json' || frozen.course_sha256 !== 'aaafb238ec3c4b3971173cb74fbeb59af64763da5ec20359ec7aad70278d7672' ||
      !Array.isArray(queue) || queue.length !== 36) throw Error('INVALID_FROZEN_BASELINE');
  const notes = queue.map((q, i) => {
    const expectedFile = `build/courses/notes/cfcm-01-${String(i + 1).padStart(2, '0')}.json`;
    if (q.lesson !== i + 1 || q.note_file !== expectedFile) throw Error('INVALID_FROZEN_NOTE_QUEUE');
    const spec = read(q.note_file);
    if (sha256(spec.raw) !== q.note_sha256) throw Error('FROZEN_NOTE_HASH_CHANGED: ' + q.note_file);
    return { ...spec, lesson: q.lesson };
  });
  return { course: read(frozen.course_file), notes, provenance, queue,
    expected: { headwords: 13151, lessons: 36, groups: 526, course_sha256: frozen.course_sha256 } };
}
function buildProjectLedger(projectRoot = PROJECT) {
  const loaded = loadProjectInputs(projectRoot);
  const ledger = buildCourseLedger(loaded);
  ledger.coverage.historical_queue_corrections = loaded.queue.flatMap(q => q.groups.flatMap(old => {
    const group = ledger.groups.find(g => g.source.file === q.note_file && g.source.note_page === old.note_page && g.heading === old.heading);
    if (!group) throw Error('HISTORICAL_GROUP_SOURCE_MISSING: ' + old.course_group_id);
    return group.id !== old.course_group_id ? [{ historical_group_id: old.course_group_id, historical_lesson: q.lesson,
      corrected_group_id: group.id, corrected_lesson: group.lesson, heading: group.heading, source: group.source,
      reason: 'Logical lesson follows the original handout title, not the extracted note filename.' }] : [];
  }));
  ledger.coverage.cross_file_continuations = ledger.occurrences.filter(o => {
    const note = loaded.notes.find(n => n.file === o.source.file); return note.lesson !== o.lesson;
  }).map(o => ({ occurrence_id: o.id, word: o.word, lesson: o.lesson, course_group_id: o.course_group_id,
    physical_note_lesson: loaded.notes.find(n => n.file === o.source.file).lesson, source: o.source,
    reason: 'Continuation before the next lesson title in an extracted note file.' }));
  ledger.coverage.historical_lesson_counts = loaded.queue.map(q => ({ lesson: q.lesson,
    historical_groups_by_filename: q.group_count, recovered_groups_by_title: ledger.lessons.find(l => l.lesson === q.lesson).group_count,
    historical_first_placement_words: q.first_placement_word_count,
    recovered_occurrences_by_title: ledger.lessons.find(l => l.lesson === q.lesson).recovered_count,
    recovered_occurrences_by_physical_file: ledger.occurrences.filter(o => o.source.file === q.note_file).length }));
  const dict = ledger.groups.find(g => g.lesson === 20 && g.printed_number === 6 && /^dic，/.test(g.label));
  if (!dict || dict.occurrence_ids.length !== 58 || ledger.occurrences.filter(o => o.course_group_id === dict.id).some(o => !o.headword_id)) throw Error('DICT_CLASSROOM_SCOPE_INCOMPLETE');
  return { ledger, loaded };
}
function artifactValues(ledger) {
  const prefix = { schema_version: SCHEMA, course_id: ledger.course_id };
  const dict = ledger.groups.find(g => g.lesson === 20 && g.printed_number === 6 && /^dic，/.test(g.label));
  const headIndex = new Map(ledger.headwords.map(h => [h.id, h]));
  const scope = dict ? ledger.occurrences.filter(o => o.course_group_id === dict.id).map(o => ({ ...o,
    course_word_key: o.headword_id ? headIndex.get(o.headword_id).raw_headword : null,
    lookup_key: o.headword_id ? headIndex.get(o.headword_id).lookup_key : null,
    headword_source: o.headword_id ? headIndex.get(o.headword_id).source : null })) : [];
  return {
    'course-headwords.json': { ...prefix, headwords: ledger.headwords },
    'course-groups.json': { ...prefix, groups: ledger.groups, lessons: ledger.lessons },
    'course-occurrences.json': { ...prefix, occurrences: ledger.occurrences },
    'coverage.json': { ...prefix, ...ledger.coverage },
    'historical-reconciliation.json': { ...prefix,
      historical_queue_corrections: ledger.coverage.historical_queue_corrections || [],
      cross_file_continuations: ledger.coverage.cross_file_continuations || [],
      lesson_counts: ledger.coverage.historical_lesson_counts || [],
      policy: 'Original lesson titles determine logical course placement; historical review snapshots are retained byte-for-byte.' },
    'dict-classroom-scope.json': { ...prefix, course_group_id: dict?.id || null, heading: dict?.heading || null,
      declared_count: dict?.declared_count || null, occurrence_count: scope.length,
      status: 'classroom-scope-only-etymology-and-sense-review-pending', occurrences: scope },
    'source-line-accounting.json': { ...prefix, lines: ledger.line_accounting },
    'root-identities.json': { ...prefix, identities: ledger.identities.root_identities, state: ledger.identities.state },
    'alliance-registry.json': { ...prefix, alliances: ledger.identities.alliance_registry, course_group_links: ledger.identities.course_group_links, state: ledger.identities.state }
  };
}
function writePlanningVersion({ ledger, loaded }, planningRoot = path.join(PROJECT, 'build/root-universe/planning')) {
  const sources = [...ledger.inputs, ...loaded.provenance.map(s => ({ file: s.file, sha256: sha256(s.raw), bytes: s.raw.length }))];
  const version = 'v-' + sha256(jsonBytes({ schema_version: SCHEMA, sources, expected: loaded.expected }));
  const files = new Map(Object.entries(artifactValues(ledger)).map(([name, value]) => [name, jsonBytes(value)]));
  for (const name of BASELINE_FILES) files.set('review-baseline/' + name, loaded.provenance.find(s => s.file === `${REVIEW}/${name}`).raw);
  const manifest = { schema_version: SCHEMA, kind: 'course-occurrence-planning', version, course_id: ledger.course_id,
    status: 'recovered-with-explicit-unresolved', inputs: sources, frozen_expected: loaded.expected, summary: ledger.summary,
    denominator_frozen: false, published_complete: false,
    artifacts: [...files].map(([file, raw]) => ({ file, sha256: sha256(raw), bytes: raw.length })) };
  files.set('manifest.json', jsonBytes(manifest));
  const target = path.join(planningRoot, 'course-ledger', version);
  if (fs.existsSync(target)) {
    for (const [file, raw] of files) {
      const existing = path.join(target, file);
      if (!fs.existsSync(existing) || !fs.readFileSync(existing).equals(raw)) throw Error('IMMUTABLE_VERSION_CONFLICT: ' + file);
    }
    return { version, directory: target, reused: true, manifest };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.course-ledger-stage-'));
  try {
    for (const [file, raw] of files) {
      const destination = path.join(stage, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, raw, { flag: 'wx' });
    }
    fs.renameSync(stage, target);
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  return { version, directory: target, reused: false, manifest };
}
function main() {
  if (process.argv.length > 2) throw Error('UNEXPECTED_ARGUMENTS');
  const built = buildProjectLedger();
  const result = writePlanningVersion(built);
  console.log(JSON.stringify({ ok: true, version: result.version, directory: result.directory, reused: result.reused, summary: built.ledger.summary }, null, 2));
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = { PROJECT, REVIEW, loadProjectInputs, buildProjectLedger, artifactValues, writePlanningVersion };
