import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = x => createHash('sha256').update(x).digest('hex');
export function englishEtymology(text, title = '') {
  const match = /^==English==\s*$/m.exec(text);
  if (!match) throw Error('NO_ENGLISH ' + title);
  const start = match.index + match[0].length;
  const rest = text.slice(start), end = /^==[^=\n][^\n]*==\s*$/m.exec(rest);
  const english = rest.slice(0, end ? end.index : rest.length);
  const ety = /^===Etymology[^\n]*===\s*\n/m.exec(english);
  if (!ety) throw Error('NO_ENGLISH_ETYMOLOGY ' + title);
  return english.slice(ety.index + ety[0].length).split(/^===/m)[0].trim();
}
export function practiceChoices(answer, alternatives, seed) {
  const choices = [...new Set([answer, ...alternatives].filter(Boolean))].slice(0, 3);
  // The seed fixes the order across refreshes, while different words have different positions.
  return choices.sort((a, b) => hash(seed + a).localeCompare(hash(seed + b)));
}
export function createRootPractice(directory, io = fs) {
  const entries = new Map();
  let mapToken = null, map = null, lessonToken = null, lessons = new Map();
  function load() {
    let names;
    try { names = io.readdirSync(directory).sort(); } catch { return { token: '', versions: [] }; }
    const versions = [], tokens = [];
    for (const name of names) {
      const pointer = path.join(directory, name, 'current.json');
      try {
        const st = io.statSync(pointer), raw = io.readFileSync(pointer, 'utf8');
        const p = JSON.parse(raw);
        if (p.id !== name || !/^[a-f0-9]{64}$/.test(p.version)) throw Error('invalid pointer');
        const file = path.join(directory, name, 'versions', p.version, 'entry.json');
        const est = io.statSync(file), token = hash(raw) + ':' + est.size + ':' + est.mtimeMs;
        let cached = entries.get(name);
        if (!cached || cached.token !== token) {
          const bytes = io.readFileSync(file);
          if (hash(bytes) !== p.version) throw Error('entry hash mismatch');
          const entry = JSON.parse(bytes);
          if (entry.id !== name || entry.schema_version !== '1.1.0' || !entry.alliance) throw Error('invalid entry');
          cached = { token, entry, version: p.version }; entries.set(name, cached);
        }
        versions.push({ name, ...cached }); tokens.push(name + ':' + token);
      } catch { entries.delete(name); tokens.push(name + ':unavailable'); }
    }
    return { token: tokens.join(';'), versions };
  }
  function rootMap() {
    const data = load();
    if (map && mapToken === data.token) return map;
    const words = {}, alliances = [];
    for (const { name, entry: e } of data.versions) {
      alliances.push({ id: e.alliance.id || name, title: e.alliance.title });
      const full = new Map(e.words.map(w => [w.word.toLowerCase(), w]));
      for (const aw of e.alliance.words) {
        const key = aw.word.toLowerCase(); if (words[key]) continue;
        const w = full.get(key), root = e.roots.find(r => w.root_ids?.includes(r.id));
        words[key] = { root: root?.label || '', rootMeaning: root?.meaning || '', clue: aw.clue || w.explanation || '',
          relation: w.relation_kind, lesson: aw.lesson, allianceTitle: e.alliance.title,
          node: w.sense_id || `L${name}:${key}`, example: w.example?.en ? { en: w.example.en, zh: w.example.zh || '' } : null };
      }
    }
    mapToken = data.token; map = { ok: true, token: hash(data.token), alliances, words }; return map;
  }
  function lesson(n) {
    if (!Number.isInteger(n) || n < 1 || n > 36) return null;
    const data = load();
    if (lessonToken !== data.token) { lessons = new Map(); lessonToken = data.token; }
    if (lessons.has(n)) return lessons.get(n);
    const id = 'cfcm-' + String(n).padStart(2, '0'), profile = data.versions.find(x => x.name === id);
    if (!profile) { lessons.set(n, null); return null; }
    const result = project(profile, n);
    lessons.set(n, result); return result;
  }
  // Read only a hash-verified published revision, never a client supplied question body.
  function lessonVersion(n, version) {
    if (!Number.isInteger(n) || n < 1 || n > 36 || !/^[a-f0-9]{64}$/.test(version || '')) return null;
    const id = 'cfcm-' + String(n).padStart(2, '0');
    try {
      const bytes = io.readFileSync(path.join(directory, id, 'versions', version, 'entry.json'));
      if (hash(bytes) !== version) return null;
      const entry = JSON.parse(bytes);
      if (entry.id !== id || entry.schema_version !== '1.1.0' || !entry.alliance) return null;
      return project({ entry, version }, n);
    } catch { return null; }
  }
  function project(profile, n) {
    const id = 'cfcm-' + String(n).padStart(2, '0');
    const { entry: e, version } = profile, full = new Map(e.words.map(w => [w.id, w]));
    const quiz = { v: 2, src: 'root', course: 'cfcm-01', lessonNo: n, at: 0, contentVersion: version, questions: [] };
    const branches = [];
    for (const b of e.alliance.branches) {
      const members = b.word_ids.map(id => full.get(id)).filter(Boolean);
      for (let offset = 0; offset < members.length; offset += 8) {
        const chunk = members.slice(offset, offset + 8), part = offset / 8 + 1, count = Math.ceil(members.length / 8);
        const group = { id: b.id + ':' + part, title: b.title + (count > 1 ? ' · ' + part + '/' + count : ''), idea: b.idea, words: [] };
        for (const w of chunk) {
          const word = { word: w.word, def: w.meaning, clue: w.explanation, explanation: w.explanation,
            example: w.example?.en ? { en: w.example.en, zh: w.example.zh || '' } : null, recall: w.recall,
            node: w.sense_id || `L${id}:${w.word.toLowerCase()}`, questions: [] };
          const choices = practiceChoices(w.meaning, e.words.filter(x => x.word !== w.word).map(x => x.meaning), w.id);
          const options = Object.fromEntries(choices.map((c, i) => ['ABC'[i], c]));
          const meaning = { id: 'q' + (quiz.questions.length + 1), word: w.word, group: group.id, kind: 'meaning',
            stem: `${w.word} 在本课中的意思是？`, options, answer: Object.keys(options).find(k => options[k] === w.meaning), explanation: w.explanation };
          quiz.questions.push(meaning); word.questions.push(meaning);
          if (w.recall) {
            const recall = { id: 'q' + (quiz.questions.length + 1), word: w.word, group: group.id, kind: 'recall',
              stem: w.recall.prompt, answer: w.recall.answer, explanation: w.recall.explanation };
            quiz.questions.push(recall); word.questions.push(recall);
          }
          group.words.push(word);
        }
        branches.push(group);
      }
    }
    const result = { ok: true, lesson: n, lessonId: 'cfcm-01-' + String(n).padStart(2, '0'), id, version, title: e.alliance.title, branches, quiz };
    return result;
  }
  function quizzes() {
    const data = load(), out = {};
    for (const { name } of data.versions) {
      const m = /^cfcm-(\d{2})$/.exec(name); if (!m) continue;
      const p = lesson(Number(m[1])); if (p) out[p.lessonId] = p.quiz;
    }
    return out;
  }
  return { load, rootMap, lesson, lessonVersion, quizzes };
}
