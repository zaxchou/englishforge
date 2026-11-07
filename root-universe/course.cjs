'use strict';
// Planning data only. Course placement never implies an etymological relationship.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const SCHEMA = 'course-ledger-1.0';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const lookupKey = text => text.toLowerCase(); // No spelling, punctuation or OCR corrections.
const pad = n => String(n).padStart(3, '0');
function fail(code, detail = '') { throw Error(code + (detail ? ': ' + detail : '')); }
function input(spec) {
  if (!spec || typeof spec.file !== 'string' || !spec.file || !Buffer.isBuffer(spec.raw)) fail('INVALID_INPUT');
  let text, value;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(spec.raw); value = JSON.parse(text); }
  catch { fail('INVALID_JSON_OR_UTF8', spec.file); }
  return { file: spec.file, sha256: sha256(spec.raw), bytes: spec.raw.length, value };
}
const HEADING = /^(词根|词缀|前缀|后缀)\s*(\d+)\s*[：:]\s*(.*)$/u;
const WORD = /^[\p{L}][\p{L}\p{M}’'\- ]*$/u;
const declaredCount = text => { const m = text.match(/[（(]\s*(\d+)\s*个\s*[）)]/u); return m ? Number(m[1]) : null; };
function sourceLines(note) {
  const j = note.value;
  if (!j || typeof j.id !== 'string' || !Array.isArray(j.pages) || !j.pages.length) fail('INVALID_NOTE', note.file);
  const seen = new Set(), lines = [];
  let previousPage = 0;
  j.pages.forEach((p, pi) => {
    if (!Number.isInteger(p.page) || p.page <= previousPage || seen.has(p.page) || typeof p.text !== 'string') fail('INVALID_NOTE_PAGE', note.file);
    previousPage = p.page;
    seen.add(p.page);
    let offset = 0;
    const split = p.text.split('\n');
    const printed = /^\d+$/.test(split[1]?.trim() || '') ? Number(split[1].trim()) : null;
    split.forEach((raw, li) => {
      const size = Buffer.byteLength(raw, 'utf8');
      lines.push({ raw, text: raw.trim(), page_index: pi, page: p.page, printed_page: printed, line: li + 1,
        text_byte_start: offset, text_byte_end: offset + size });
      offset += size + 1;
    });
  });
  return lines;
}
function locate(note, line) {
  return { file: note.file, sha256: note.sha256, json_pointer: `/pages/${line.page_index}/text`,
    note_page: line.page, handout_printed_page: line.printed_page, line: line.line,
    text_utf8_byte_start: line.text_byte_start, text_utf8_byte_end: line.text_byte_end };
}
function chineseNumber(text) {
  const digits = '零一二三四五六七八九';
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  if (text.includes('十')) { const [a, b] = text.split('十'); return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0); }
  return digits.indexOf(text);
}
function parseNotes(notes) {
  const lines = notes.flatMap(note => sourceLines(note).map(line => ({ ...line, note })));
  const groups = [], occurrences = [], unparsed = [], line_accounting = [], titles = new Map();
  let group = null, entry = null, inIpa = false, lessonOrder = 0, lesson = null;
  function account(line, kind, id = null) {
    line_accounting.push({ source: locate(line.note, line), kind, owner_id: id });
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], note = line.note, t = line.text, match = t.match(HEADING);
    const title = t.match(/万词班第([零一二三四五六七八九十\d]+)课讲义/u);
    if (title) {
      const n = chineseNumber(title[1]);
      if (n !== note.lesson || titles.has(n)) fail('INVALID_LESSON_TITLE', note.file);
      titles.set(n, { text: t, source: locate(note, line) });
      lesson = n; group = null; entry = null; inIpa = false; lessonOrder = 0;
      account(line, 'lesson_title'); continue;
    }
    if (!t) { account(line, 'blank'); continue; }
    if (/^小红书[：:]/.test(t) || (line.line <= 2 && /^\d+$/.test(t)) || /万词班.*课讲义/.test(t)) {
      account(line, 'page_metadata'); continue;
    }
    if (match) {
      if (lesson === null) fail('GROUP_WITHOUT_LESSON_TITLE', note.file);
      const position = groups.filter(g => g.lesson === lesson).length + 1;
      group = { id: `CG-${pad(lesson)}-${pad(position)}`, lesson, position, printed_number: Number(match[2]),
        printed_kind: match[1], heading: line.raw, heading_lines: [{ raw: line.raw, source: locate(note, line) }],
        label: match[3], declared_count: declaredCount(t), source: locate(note, line), occurrence_ids: [],
        role_review: 'pending', root_identity_ids: [], alliance_ids: [], relation_review: 'pending' };
      groups.push(group); entry = null; inIpa = false; account(line, 'group_heading', group.id); continue;
    }
    const next = lines[i + 1];
    const followedByIpa = next && next.note === note && next.page_index === line.page_index && next.text.startsWith('/');
    // IPA can wrap over several lines (including a line containing only '/').
    if (inIpa && entry) {
      if (!/^(?:n|v|adj|adv|prep|pron|conj|int|num|aux|vt|vi|modal|det)\s*[.．/]/i.test(t) && !followedByIpa) {
        entry.ipa_lines.push({ raw: line.raw, source: locate(note, line) });
        account(line, 'phonetic', entry.id);
        if (t.endsWith('/')) inIpa = false;
        continue;
      }
      entry.parse_issues.push('UNCLOSED_IPA'); inIpa = false;
    }
    if (!t.startsWith('/') && (followedByIpa || WORD.test(t))) {
      if (!group) fail('WORD_WITHOUT_GROUP', `${note.file} page ${line.page} line ${line.line}`);
      const order = group.occurrence_ids.length + 1;
      entry = { id: `CO-${pad(lesson)}-${pad(group.position)}-${pad(order)}`, lesson,
        lesson_word_order: ++lessonOrder, course_group_id: group.id, group_position: group.position,
        printed_group_number: group.printed_number, group_word_order: order, raw_word: line.raw, word: t,
        source: locate(note, line), source_document: note.value.source_file || null,
        ppt_locator: null, ipa_lines: [], definition_lines: [], parse_issues: [],
        headword_id: null, alignment: 'unresolved', unresolved_reason: null,
        course_target_sense: { status: 'pending', sense_id: null, raw_definition: '' } };
      if (!WORD.test(t)) entry.parse_issues.push('INVALID_WORD_FORM');
      if (!followedByIpa) entry.parse_issues.push('MISSING_IPA');
      group.occurrence_ids.push(entry.id); occurrences.push(entry); account(line, 'word', entry.id); continue;
    }
    if (t.startsWith('/')) {
      if (entry && !entry.ipa_lines.length) {
        entry.ipa_lines.push({ raw: line.raw, source: locate(note, line) });
        inIpa = !(t.length > 1 && t.endsWith('/')); account(line, 'phonetic', entry.id); continue;
      }
      unparsed.push({ reason: 'ORPHAN_IPA', raw: line.raw, source: locate(note, line) });
      account(line, 'unparsed'); continue;
    }
    if (group && !entry && group.declared_count === null && declaredCount(t) !== null) {
      group.heading_lines.push({ raw: line.raw, source: locate(note, line) });
      group.label += '\n' + t; group.declared_count = declaredCount(t);
      account(line, 'group_heading_continuation', group.id); continue;
    }
    if (entry && entry.ipa_lines.length && !/^词[根缀]/.test(t)) {
      entry.definition_lines.push({ raw: line.raw, source: locate(note, line) }); account(line, 'definition', entry.id); continue;
    }
    unparsed.push({ reason: 'UNCLASSIFIED_LINE', raw: line.raw, source: locate(note, line) }); account(line, 'unparsed');
  }
  if (inIpa && entry) entry.parse_issues.push('UNCLOSED_IPA');
  for (const o of occurrences) {
    if (!o.definition_lines.length) o.parse_issues.push('MISSING_DEFINITION');
    o.ipa = o.ipa_lines.map(l => l.raw.trim()).join('\n');
    o.course_target_sense.raw_definition = o.definition_lines.map(l => l.raw).join('\n');
  }
  return notes.map(note => {
    const title = titles.get(note.lesson), gs = groups.filter(g => g.lesson === note.lesson);
    if (!title || !gs.length) fail('NOTE_WITHOUT_TITLE_OR_GROUPS', note.file);
    return { lesson: note.lesson, note: { file: note.file, sha256: note.sha256, bytes: note.bytes },
      declared_count: declaredCount(title.text), title_source: title.source,
      groups: gs, occurrences: occurrences.filter(o => o.lesson === note.lesson),
      unparsed: unparsed.filter(l => l.source.file === note.file),
      line_accounting: line_accounting.filter(l => l.source.file === note.file) };
  });
}
function parseNote(note, lesson) { return parseNotes([{ ...note, lesson }])[0]; }
function buildCourseLedger({ course: courseSpec, notes: noteSpecs, expected = {} }) {
  const course = input(courseSpec), j = course.value;
  if (!j || typeof j.course !== 'string' || !Array.isArray(j.batches) || !j.batches.length) fail('INVALID_COURSE');
  if (expected.course_sha256 && course.sha256 !== expected.course_sha256) fail('FROZEN_COURSE_HASH_CHANGED');
  if (!Array.isArray(noteSpecs) || !noteSpecs.length) fail('NOTES_REQUIRED');
  const headwords = [], rawIndex = new Map(), keyIndex = new Map(), batchIds = new Set();
  j.batches.forEach((b, bi) => {
    if (!b || typeof b.id !== 'string' || batchIds.has(b.id) || !Number.isInteger(b.lesson) || b.lesson < 1 || !Array.isArray(b.words) || !b.words.length) fail('INVALID_BATCH');
    batchIds.add(b.id);
    b.words.forEach((w, wi) => {
      if (!w || typeof w.w !== 'string' || !w.w.trim() || w.w !== w.w.trim() || rawIndex.has(w.w) || w.lesson !== b.lesson || (w.also !== undefined && (!Array.isArray(w.also) || w.also.some(n => !Number.isInteger(n) || n < 1)))) fail('INVALID_OR_DUPLICATE_HEADWORD', w?.w);
      const key = lookupKey(w.w), h = { id: 'CH-' + sha256(Buffer.from(w.w)).slice(0, 24),
        raw_headword: w.w, lookup_key: key, approved_aliases: [],
        source: { file: course.file, sha256: course.sha256, json_pointer: `/batches/${bi}/words/${wi}` },
        first_placement: { lesson: w.lesson, batch_id: b.id, batch_word_position: wi + 1, course_label: b.root || null },
        additional_lesson_hints: w.also || [], raw_definition: w.def || '', occurrence_ids: [],
        alignment: 'unresolved', etymology_review: 'pending' };
      headwords.push(h); rawIndex.set(w.w, h);
      if (!keyIndex.has(key)) keyIndex.set(key, []); keyIndex.get(key).push(h);
    });
  });
  const noteIds = new Set(), files = new Set([course.file]);
  const noteInputs = noteSpecs.map(spec => {
    if (!Number.isInteger(spec.lesson) || spec.lesson < 1 || noteIds.has(spec.lesson) || files.has(spec.file)) fail('INVALID_OR_DUPLICATE_NOTE');
    noteIds.add(spec.lesson); files.add(spec.file);
    return { ...input(spec), lesson: spec.lesson };
  }).sort((a, b) => a.lesson - b.lesson);
  const parsed = parseNotes(noteInputs);
  for (const h of headwords) if (![h.first_placement.lesson, ...h.additional_lesson_hints].every(n => noteIds.has(n))) fail('HEADWORD_LESSON_WITHOUT_NOTE', h.raw_headword);
  const groups = parsed.flatMap(n => n.groups), occurrences = parsed.flatMap(n => n.occurrences);
  for (const o of occurrences) {
    const exact = rawIndex.get(o.word), keyed = keyIndex.get(lookupKey(o.word)) || [];
    const h = exact || (keyed.length === 1 ? keyed[0] : null);
    if (o.parse_issues.length) o.unresolved_reason = 'SOURCE_ROW_STRUCTURE';
    else if (h) {
      o.headword_id = h.id; o.alignment = exact ? 'exact' : 'casefold'; h.occurrence_ids.push(o.id);
    } else o.unresolved_reason = keyed.length > 1 ? 'LOOKUP_KEY_COLLISION' : 'NO_EXACT_OR_CASEFOLD_HEADWORD';
  }
  for (const h of headwords) h.alignment = h.occurrence_ids.length ? 'located' : 'unresolved';
  const occurrenceIndex = new Map(occurrences.map(o => [o.id, o]));
  const collisions = [...keyIndex].filter(([, hs]) => hs.length > 1).map(([key, hs]) => ({ lookup_key: key, headword_ids: hs.map(h => h.id), raw_headwords: hs.map(h => h.raw_headword) }));
  const groupDifferences = groups.filter(g => g.declared_count === null || g.declared_count !== g.occurrence_ids.length).map(g => ({
    course_group_id: g.id, lesson: g.lesson, position: g.position, printed_number: g.printed_number, heading: g.heading,
    source: g.source, declared_count: g.declared_count, recovered_count: g.occurrence_ids.length,
    delta: g.declared_count === null ? null : g.occurrence_ids.length - g.declared_count,
    reason: g.declared_count === null ? 'MISSING_PRINTED_COUNT' : 'PRINTED_VS_EXTRACTED_COUNT', status: 'unresolved',
    disposition: 'Preserve all extracted rows; verify the original handout before freezing the denominator.' }));
  const duplicateNumbers = parsed.flatMap(n => [...new Set(n.groups.map(g => g.printed_number))].flatMap(number => {
    const gs = n.groups.filter(g => g.printed_number === number);
    return gs.length > 1 ? [{ lesson: n.lesson, printed_number: number, group_ids: gs.map(g => g.id), sources: gs.map(g => g.source) }] : [];
  }));
  const lessons = parsed.map(n => ({ lesson: n.lesson, note: n.note, declared_count: n.declared_count,
    recovered_count: n.occurrences.length, group_count: n.groups.length,
    mapped_count: n.occurrences.filter(o => o.headword_id).length, unresolved_count: n.occurrences.filter(o => !o.headword_id).length,
    title_source: n.title_source }));
  const missingHeadwords = headwords.filter(h => !h.occurrence_ids.length).map(h => ({ headword_id: h.id, raw_headword: h.raw_headword,
    source: h.source, first_placement: h.first_placement, reason: 'NO_MATCHING_SOURCE_ROW', status: 'unresolved',
    disposition: 'Retain the original headword; spelling/OCR reconciliation requires explicit evidence and approval.' }));
  const unresolvedOccurrences = occurrences.filter(o => !o.headword_id).map(o => ({ occurrence_id: o.id, word: o.word,
    course_group_id: o.course_group_id, group_word_order: o.group_word_order, source: o.source,
    reason: o.unresolved_reason, parse_issues: o.parse_issues, status: 'unresolved',
    disposition: 'Keep this source occurrence in order; do not guess a spelling alias.' }));
  const repeated = headwords.filter(h => h.occurrence_ids.length > 1).map(h => ({ headword_id: h.id, word: h.raw_headword, occurrence_ids: h.occurrence_ids }));
  const hintDifferences = headwords.flatMap(h => {
    const actual = [...new Set(h.occurrence_ids.map(id => occurrenceIndex.get(id).lesson))];
    const hinted = [...new Set([h.first_placement.lesson, ...h.additional_lesson_hints])];
    const missing = hinted.filter(n => !actual.includes(n)), additional = actual.filter(n => !hinted.includes(n));
    return missing.length || additional.length ? [{ headword_id: h.id, word: h.raw_headword, hinted_lessons: hinted, recovered_lessons: actual,
      hinted_without_exact_row: missing, recovered_without_hint: additional, source: h.source }] : [];
  });
  const unparsed = parsed.flatMap(n => n.unparsed);
  const summary = { headwords: headwords.length, lessons: lessons.length, groups: groups.length, practice_batches: j.batches.length,
    recovered_occurrences: occurrences.length, mapped_occurrences: occurrences.filter(o => o.headword_id).length,
    exact_occurrences: occurrences.filter(o => o.alignment === 'exact').length, casefold_occurrences: occurrences.filter(o => o.alignment === 'casefold').length,
    unresolved_occurrences: unresolvedOccurrences.length, located_headwords: headwords.length - missingHeadwords.length,
    unlocated_headwords: missingHeadwords.length, repeated_headwords: repeated.length,
    duplicate_printed_number_sets: duplicateNumbers.length, group_count_differences: groupDifferences.length,
    lesson_count_differences: lessons.filter(l => l.declared_count === null || l.declared_count !== l.recovered_count).length,
    lookup_key_collisions: collisions.length, unparsed_lines: unparsed.length,
    accounted_source_lines: parsed.reduce((s, n) => s + n.line_accounting.length, 0),
    source_alignment_complete: !unresolvedOccurrences.length && !missingHeadwords.length && !unparsed.length,
    denominator_frozen: false, published_complete: false };
  for (const [name, actual] of [['headwords', summary.headwords], ['lessons', summary.lessons], ['groups', summary.groups]]) {
    if (expected[name] !== undefined && expected[name] !== actual) fail('EXPECTED_COUNT_CHANGED', `${name} ${actual} != ${expected[name]}`);
  }
  const result = { schema_version: SCHEMA, course_id: j.course,
    inputs: [{ file: course.file, sha256: course.sha256, bytes: course.bytes }, ...parsed.map(n => n.note)],
    summary, headwords, groups, occurrences, lessons,
    coverage: { summary, missing_headwords: missingHeadwords, unresolved_occurrences: unresolvedOccurrences,
      group_count_differences: groupDifferences,
      lesson_count_differences: lessons.filter(l => l.declared_count === null || l.declared_count !== l.recovered_count),
      duplicate_printed_numbers: duplicateNumbers, lookup_key_collisions: collisions, repeated_headwords: repeated,
      lesson_hint_differences: hintDifferences, unparsed_lines: unparsed,
      denominator_status: 'provisional-until-original-source-differences-reviewed',
      policy: 'Notes are extracted evidence. All rows and count differences remain visible; hints and group labels do not prove occurrence, spelling equivalence, or etymology.' },
    line_accounting: parsed.flatMap(n => n.line_accounting),
    identities: { root_identities: [], alliance_registry: [], state: 'pending-evidence-review',
      course_group_links: groups.map(g => ({ course_group_id: g.id, root_identity_ids: [], alliance_ids: [], status: 'pending' })) } };
  validateLedger(result);
  return result;
}
function validateLedger(ledger) {
  const unique = (rows, name) => { const ids = new Set(); for (const r of rows) { if (ids.has(r.id)) fail('DUPLICATE_ID', name); ids.add(r.id); } return ids; };
  const heads = unique(ledger.headwords, 'headwords'), groups = unique(ledger.groups, 'groups'); unique(ledger.occurrences, 'occurrences');
  const occurrences = new Map(ledger.occurrences.map(o => [o.id, o])), headIndex = new Map(ledger.headwords.map(h => [h.id, h]));
  const groupIndex = new Map(ledger.groups.map(g => [g.id, g]));
  for (const g of ledger.groups) g.occurrence_ids.forEach((id, i) => {
    const o = occurrences.get(id); if (!o || o.course_group_id !== g.id || o.group_word_order !== i + 1) fail('BROKEN_GROUP_ORDER', id);
  });
  for (const o of ledger.occurrences) {
    if (!groups.has(o.course_group_id) || !groupIndex.get(o.course_group_id).occurrence_ids.includes(o.id)) fail('ORPHAN_OCCURRENCE', o.id);
    if (o.headword_id ? !heads.has(o.headword_id) || !headIndex.get(o.headword_id).occurrence_ids.includes(o.id) : !o.unresolved_reason) fail('BROKEN_ALIGNMENT', o.id);
  }
  for (const h of ledger.headwords) {
    if (new Set(h.occurrence_ids).size !== h.occurrence_ids.length) fail('DUPLICATE_HEADWORD_EDGE', h.id);
    for (const id of h.occurrence_ids) if (occurrences.get(id)?.headword_id !== h.id) fail('BROKEN_HEADWORD_EDGE', h.id);
  }
  return true;
}
function createCourseIndex(ledger) {
  validateLedger(ledger);
  const headwords = new Map(ledger.headwords.map(h => [h.id, h]));
  const groups = new Map(ledger.groups.map(g => [g.id, g]));
  const occurrences = new Map(ledger.occurrences.map(o => [o.id, o]));
  const lookup = new Map();
  for (const h of headwords.values()) { if (!lookup.has(h.lookup_key)) lookup.set(h.lookup_key, []); lookup.get(h.lookup_key).push(h); }
  return { headwords, groups, occurrences,
    findHeadwords(query) { return lookup.get(lookupKey(query)) || []; },
    occurrencesForHeadword(id) { return (headwords.get(id)?.occurrence_ids || []).map(key => occurrences.get(key)); },
    occurrencesForGroup(id) { return (groups.get(id)?.occurrence_ids || []).map(key => occurrences.get(key)); } };
}
module.exports = { SCHEMA, sha256, jsonBytes, lookupKey, parseNote, buildCourseLedger, validateLedger, createCourseIndex };
