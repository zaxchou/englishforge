#!/usr/bin/env node
/**
 * 组一套 ndf-01 期末卷（50 题，四种题型）。
 * - 30 题来自现有课后练题库（优先历史错题，排除 bad / 扩展题）
 * - 20 题按逐字稿为本节未考过的词新出（缓存，可重跑）
 * 输出：build/exams/ndf-01-final.json + 同名 .audit.md
 * 只读题库与学习记录；题目与逐字稿都不进公开仓库。
 *
 * 用法：
 *   node pipeline/build_exam.mjs                 # 用生产题库组卷（默认）
 *   node pipeline/build_exam.mjs --quizzes <path> --records <path>
 *   node pipeline/build_exam.mjs --no-ai         # 只组已有题（调试）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PROD = path.resolve(ROOT, '../data/toefl-lab-production/records');
const QUIZZES = path.resolve(arg('--quizzes', path.join(PROD, 'generated-quizzes.json')));
const RECORDS = path.resolve(arg('--records', path.join(PROD, 'records.json')));
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'build/exams')));
const COURSE = 'ndf-01';
const TOTAL = 50;
const TYPES = ['root', 'meaning', 'collocation', 'cloze'];
const TYPE_LABEL = {root: '词根词缀', meaning: '词义', collocation: '搭配', cloze: '语境填空'};
const NEW_PER_TYPE = {root: 5, meaning: 5, collocation: 5, cloze: 5};
const BANK_PER_TYPE = {root: 9, meaning: 9, collocation: 6, cloze: 6};
const NO_AI = args.includes('--no-ai');
const CACHE_FILE = path.join(OUT_DIR, '_new-questions.cache.json');
const PAPER_ID = 'ndf-01-final';

class Refuse extends Error {}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function pad(n) {
  return String(n).padStart(2, '0');
}
function hash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}
function normStem(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}
function letters(q) {
  return Object.keys(q.options || {}).sort();
}
function optionText(q, letter) {
  const v = q?.options?.[letter];
  return typeof v === 'string' ? v : v?.t || '';
}
function questionValid(q) {
  if (!q || typeof q.stem !== 'string') return false;
  const L = letters(q);
  if (L.join('') !== 'ABCD') return false;
  if (!L.includes(q.answer)) return false;
  const texts = L.map(l => optionText(q, l).trim());
  if (texts.some(t => !t)) return false;
  if (new Set(texts.map(t => t.toLowerCase())).size !== 4) return false;
  if (typeof q.explain !== 'string' || !q.explain.trim()) return false;
  for (const l of L) {
    const note = q.options[l]?.note;
    if (typeof note !== 'string' || !note.trim()) return false;
  }
  return true;
}

/* ---------- 题库与学习记录 ---------- */
const store = readJson(QUIZZES);
const items = store.items || store;
const records = readJson(RECORDS);
const attempts = records.attempts || {};
const mistakes = records.mistakes || {};

const qidOf = (lessonNo, q) => `gen/${COURSE}/${lessonNo}/quiz/${Number(String(q.id).replace(/^q/, ''))}`;
const lessons = [];
for (let no = 1; no <= 48; no++) {
  const key = `${COURSE}-${pad(no)}`;
  const entry = items[key];
  if (!entry) continue;
  const bad = new Set(entry.bad || []);
  const wordsFile = path.join(ROOT, 'build/scripts-reviewed', COURSE, `${key}.words.json`);
  const meta = fs.existsSync(wordsFile) ? readJson(wordsFile) : {words: [], roots: [], affixes: [], phrases: []};
  const transcriptFile = path.join(ROOT, 'build/scripts-reviewed', COURSE, `${key}.md`);
  const transcript = fs.existsSync(transcriptFile) ? fs.readFileSync(transcriptFile, 'utf8') : '';
  const eligible = [];
  for (const q of entry.questions || []) {
    if (bad.has(q.id) || bad.has(String(q.id).replace(/^q/, 'q'))) continue;
    if (q.tier === 'ext') continue;
    if (entry.v !== 2 && entry.v !== 1) continue;
    if (!questionValid(q)) continue;
    const qid = qidOf(no, q);
    const at = attempts[qid];
    const m = mistakes[qid];
    const priority = (m ? 100 + Number(m.n_wrong || 0) * 10 : 0) + (at && at.n ? (at.n - (at.right || 0)) * 3 : 0);
    eligible.push({q, qid, type: q.type || 'meaning', priority, history: {attempts: at?.n || 0, right: at?.right || 0, wrong: m?.n_wrong || 0}});
  }
  const covered = new Set();
  for (const q of entry.questions || []) {
    for (const c of q.covers || []) covered.add(String(c).toLowerCase());
    for (const t of q.tags || []) covered.add(String(t).toLowerCase());
    for (const t of String(q.stem).toLowerCase().match(/[a-z][a-z'-]+/g) || []) covered.add(t);
  }
  const contentWords = (meta.words || [])
    .filter(w => /^[a-z][a-z-]+$/.test(String(w)) && String(w).length >= 4)
    .filter(w => !covered.has(w.toLowerCase()));
  const freq = w => {
    const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    return (transcript.match(re) || []).length;
  };
  contentWords.sort((a, b) => freq(b) - freq(a) || b.length - a.length || a.localeCompare(b));
  lessons.push({no, key, entry, title: entry.title || key, words: meta, transcript, eligible, contentWords});
}
if (lessons.length !== 48) throw new Refuse(`预期 48 节，实际 ${lessons.length} 节`);
const byNo = new Map(lessons.map(l => [l.no, l]));
const lessonId = no => `${COURSE}-${pad(no)}`;

/* ---------- 组卷：谁出新题、每题什么题型 ---------- */
const wrongTotal = no => byNo.get(no).eligible.reduce((n, e) => n + e.history.wrong, 0);
const newLessons = [...lessons]
  .sort((a, b) => b.contentWords.length - a.contentWords.length || wrongTotal(b.no) - wrongTotal(a.no) || a.no - b.no)
  .slice(0, 20)
  .map(l => l.no)
  .sort((a, b) => a - b);
const newSet = new Set(newLessons);
const slots = [];
newLessons.forEach((no, i) => slots.push({no, source: 'new', type: TYPES[i % 4]}));
const bankLessons = lessons.filter(l => !newSet.has(l.no)).map(l => l.no);
const bankQuota = {...BANK_PER_TYPE};
const availableTypes = no => {
  const set = new Set(byNo.get(no).eligible.map(e => e.type));
  return TYPES.filter(t => set.has(t) && bankQuota[t] > 0);
};
const bankOrder = [...bankLessons].sort((a, b) => {
  const ca = new Set(byNo.get(a).eligible.map(e => e.type)).size;
  const cb = new Set(byNo.get(b).eligible.map(e => e.type)).size;
  return ca - cb || wrongTotal(b) - wrongTotal(a) || a - b;
});
const bankSlots = [];
for (const no of bankOrder) {
  const options = availableTypes(no);
  options.sort((a, b) => bankQuota[b] - bankQuota[a] || TYPES.indexOf(a) - TYPES.indexOf(b));
  if (!options.length) {   // 该节没有合适题型：允许其它题型兜底，配额稍后由审计暴露
    const any = TYPES.filter(t => byNo.get(no).eligible.some(e => e.type === t));
    if (!any.length) throw new Refuse(`第 ${no} 节没有可用题`);
    bankSlots.push({no, source: 'bank', type: any[0]});
    continue;
  }
  const type = options[0];
  bankQuota[type]--;
  bankSlots.push({no, source: 'bank', type});
}
/* 30 道题库题：28 节各一题 + 错题最多的两节再加一题 */
const extraNeeded = TOTAL - bankSlots.length - newLessons.length;
const extraCandidates = [...bankSlots]
  .sort((a, b) => wrongTotal(b.no) - wrongTotal(a.no) || byNo.get(b.no).eligible.length - byNo.get(a.no).eligible.length || a.no - b.no);
for (let i = 0; i < extraNeeded; i++) {
  const base = extraCandidates[i % extraCandidates.length];
  const left = TYPES.filter(t => bankQuota[t] > 0 && byNo.get(base.no).eligible.some(e => e.type === t));
  const type = left.sort((a, b) => bankQuota[b] - bankQuota[a])[0] || base.type;
  if (bankQuota[type] > 0) bankQuota[type]--;
  slots.push({no: base.no, source: 'bank', type, extra: true});
}
for (const s of bankSlots) slots.push(s);
/* 类型配额检查：以实际可选题型为准，最多允许 1 题偏差 */
const expected = Object.fromEntries(TYPES.map(t => [t, NEW_PER_TYPE[t] + BANK_PER_TYPE[t]]));

/* ---------- 题库题选择 ---------- */
const usedQid = new Set();
const usedStem = new Set();
const deterministic = (a, b) => hash(a) .localeCompare(hash(b));
function pickBank(slot) {
  const l = byNo.get(slot.no);
  const pool = l.eligible.filter(e => e.type === slot.type && !usedQid.has(e.qid) && !usedStem.has(normStem(e.q.stem)));
  if (!pool.length) return null;
  pool.sort((a, b) => b.priority - a.priority || deterministic(a.qid, b.qid));
  return pool[0];
}

/* ---------- AI 新题 ---------- */
function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const AI = {
  key: process.env.TFL_AI_KEY || env.TFL_AI_KEY,
  base: process.env.TFL_AI_BASE_URL || env.TFL_AI_BASE_URL || 'https://api.deepseek.com',
  model: process.env.TFL_AI_MODEL || env.TFL_AI_MODEL || 'deepseek-chat',
};
let cache = fs.existsSync(CACHE_FILE) ? readJson(CACHE_FILE) : {};

async function callAI(messages, maxTokens = 1800) {
  const url = AI.base.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + AI.key},
    body: JSON.stringify({model: AI.model, messages, temperature: 0.3, max_tokens: maxTokens, response_format: {type: 'json_object'}}),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error('AI HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  return String(j.choices?.[0]?.message?.content || '');
}
function parseJsonLoose(text) {
  const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
  throw Error('AI 未返回 JSON');
}
const TYPE_RULE = {
  root: '考词根/词缀的构词逻辑：给出本节讲过的一个词，问哪个选项与它的构词逻辑一致（同一后缀/词根/尾辅音变化）。题干用“根据课堂讲的…”。四项都必须是英文词。',
  meaning: '考词义：用课堂原话或本节例句，问某个词/短语在这节里的意思，或老师说某个中文对应哪个英文词。四项用英文词/短语。',
  collocation: '考搭配：问本节讲过的固定搭配/短语，例如“下列哪个搭配表示…”。四项是英文搭配。',
  cloze: '考语境填空：给一个英文句子，用 ______ 留空，题干中文说明空格要表达的意思。四项是可填入的词。',
};
function exampleFor(type) {
  for (const l of lessons) {
    const e = l.eligible.find(x => x.type === type);
    if (e) return {type, stem: e.q.stem, options: e.q.options, answer: e.q.answer, explain: e.q.explain};
  }
  return null;
}
const EXAMPLES = Object.fromEntries(TYPES.map(t => [t, exampleFor(t)]));

function validateNew(q, targets, lesson) {
  if (!questionValid(q)) return '格式不合规（需 A-D 四项、唯一答案、每项 note、explain）';
  if (q.answer !== q.answer.toUpperCase() || !'ABCD'.includes(q.answer)) return '答案不是 A-D';
  const stem = String(q.stem);
  if (stem.length < 10 || stem.length > 320) return '题干长度不合适';
  const texts = letters(q).map(l => optionText(q, l).toLowerCase());
  const answerNote = String(q.options?.[q.answer]?.note || '');
  if (/^\s*(错误|不对|不正确|×)/.test(answerNote)) return '答案选项的 note 标成了错误';
  for (const l of letters(q)) {
    if (l === q.answer) continue;
    if (/^\s*(正确|✓)/.test(String(q.options?.[l]?.note || ''))) return `干扰项 ${l} 的 note 标成了正确`;
  }
  const covers = (q.covers || []).map(x => String(x).toLowerCase());
  if (!targets.some(t => covers.includes(t) || texts.includes(t))) return '未覆盖目标词';
  if (!(q.type || '') && false) return '缺少题型';
  if (q.type === 'cloze' && !/_{3,}/.test(stem)) return '语境填空缺少 ______';
  if (q.type !== 'cloze' && !/[?？]/.test(stem) && !/下列|哪一/.test(stem)) return '题干不像选择题';
  if (new RegExp('正确(答案)?[是为:：]?\\s*[ABCD]', 'i').test(stem)) return '题干泄题';
  const held = texts[letters(q).indexOf(q.answer)];
  if (held && stem.toLowerCase().includes(held) && q.type !== 'root') return '答案出现在题干';
  /* 构词题必须真有唯一答案：题干自称“都含/同一个…”，干扰项 note 却承认同一特征 → 不唯一 */
  if (/都含|同一个?(前缀|后缀|词根)|同一(前缀|后缀|词根)/.test(stem)) {
    for (const l of letters(q)) {
      if (l === q.answer) continue;
      const note = String(q.options[l]?.note || '');
      if (/虽含|也含|同样含|同样以|同样有|都含|同为|也是/.test(note)) return `干扰项 ${l} 也具备题干特征，答案不唯一`;
    }
  }
  /* 答案不能只是题干关键词的屈折变形（moisturize 之于 moisturizing 是同一词，不是同一构词逻辑） */
  const keyword = stem.match(/与\s*([a-z][a-z-]{2,})\s*的?构词/) || stem.match(/与\s*[“"]([a-z][a-z-]{2,})[”"]/);
  if (keyword && q.type === 'root') {
    const kw = keyword[1].toLowerCase(), ans = texts[letters(q).indexOf(q.answer)];
    /* 只比较屈折变化（ing/ed/es/s/ly + 去 e），派生后缀不同仍可算并列构词 */
    const infl = w => w.replace(/(ing|ed|es|s|ly)$/, '').replace(/e$/, '');
    if (ans === kw || (ans.length >= 4 && kw.length >= 4 && infl(ans) === infl(kw))) return '答案与题干关键词是同一词的屈折变化，不构成并列构词';
  }
  for (const t of targets) {
    if (!lesson.words.words.map(w => String(w).toLowerCase()).includes(t) && !new RegExp('\\b' + t + '\\b', 'i').test(lesson.transcript)) return `目标词 ${t} 不在本节材料中`;
  }
  return '';
}
async function generateNew(slot) {
  const l = byNo.get(slot.no);
  /* 构词题不用 -ing/-ed 这类屈折形式当题干词：它们容易引出“同一词变化”的伪选项 */
  const pool = slot.type === 'root' ? l.contentWords.filter(w => !/(ing|ed)$/.test(w)) : l.contentWords;
  const targets = (pool.length ? pool : l.contentWords).slice(0, 3);
  if (!targets.length) throw new Refuse(`第 ${slot.no} 节没有未考词`);
  const key = `${lessonId(slot.no)}|${slot.type}|${targets.join(',')}|v1`;
  if (cache[key] && questionValid(cache[key])) return {...cache[key], cached: true};
  if (NO_AI) throw new Refuse('--no-ai');
  const prompt = [
    '你是托福词汇课出题老师。只能依据下面这节逐字稿与词汇清单出题，不要引入本节没有的内容。',
    `课程：${COURSE} 第 ${slot.no} 节《${l.title}》`,
    `题型：${slugType(slot.type)}。${TYPE_RULE[slot.type]}`,
    ...(slot.type === 'root' ? ['硬性要求：正确选项不能是题干所给词的屈折变化（不能只是加/去 -ing、-ed、-es、-ly 或 -e），必须是另一个词；四项应当来自不同的词根/词缀家族，且只有一个选项满足题干特征。'] : []),
    `必须考察这些本节未考过的词之一（优先第一个）：${targets.join(' / ')}`,
    '要求：中文题干，英文选项；4 个选项 A-D；每项 option 对象含 t（选项文本）和 note（为什么对/错，中文）；答案唯一；explain 说明课堂依据；covers 列出考察的本节词（小写）；tags 列出相关词根/词缀。',
    '风格参考（同题型旧题，不要照抄）：',
    JSON.stringify(EXAMPLES[slot.type]),
    '只输出 JSON：{"type":"' + slot.type + '","stem":"...","options":{"A":{"t":"...","note":"..."},"B":{"t":"...","note":"..."},"C":{"t":"...","note":"..."},"D":{"t":"...","note":"..."}},"answer":"A","explain":"...","tags":["..."],"covers":["..."]}',
    '逐字稿节选：',
    l.transcript.slice(0, 7000),
    '本节词汇清单：' + (l.words.words || []).slice(0, 160).join(', '),
  ].join('\n\n');
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callAI([
        {role: 'system', content: '你是严谨的托福词汇课出题人，只输出 JSON，不编造课堂没讲的内容。'},
        {role: 'user', content: prompt + (lastError ? `\n\n上一次的问题：${lastError}，请修正。` : '')},
      ]);
      const q = parseJsonLoose(raw);
      q.type = slot.type;
      const bad = validateNew(q, targets, l);
      if (bad) { lastError = bad; continue; }
      cache[key] = q;
      return {...q, cached: false};
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Refuse(`第 ${slot.no} 节 ${slot.type} 新题失败：${lastError}`);
}
function slugType(t) {
  return {root: '词根词缀', meaning: '词义', collocation: '搭配', cloze: '语境填空'}[t] || t;
}

/* ---------- 组卷执行 ---------- */
const questions = [];
const shortfalls = [];
for (const slot of slots.sort((a, b) => a.no - b.no || (a.source === 'bank' ? 1 : -1))) {
  if (slot.source === 'bank') {
    const picked = pickBank(slot);
    if (!picked) { shortfalls.push({...slot, reason: '题库无可用题'}); continue; }
    usedQid.add(picked.qid);
    usedStem.add(normStem(picked.q.stem));
    questions.push({
      id: null,
      source: 'bank',
      originQid: picked.qid,
      lessonId: lessonId(slot.no),
      lessonNo: slot.no,
      lessonTitle: byNo.get(slot.no).title,
      type: picked.type,
      stem: picked.q.stem,
      options: picked.q.options,
      answer: picked.q.answer,
      explain: picked.q.explain,
      tags: picked.q.tags || [],
      covers: picked.q.covers || [],
      history: picked.history,
    });
    continue;
  }
  try {
    const q = await generateNew(slot);
    const stemKey = normStem(q.stem);
    if (usedStem.has(stemKey)) { shortfalls.push({...slot, reason: '与本卷已有题重复'}); continue; }
    usedStem.add(stemKey);
    questions.push({
      id: null,
      source: 'new',
      lessonId: lessonId(slot.no),
      lessonNo: slot.no,
      lessonTitle: byNo.get(slot.no).title,
      type: slot.type,
      stem: q.stem,
      options: q.options,
      answer: q.answer,
      explain: q.explain,
      tags: q.tags || [],
      covers: q.covers || [],
      cached: q.cached,
    });
    fs.mkdirSync(OUT_DIR, {recursive: true});
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
  } catch (e) {
    /* 新题失败时保住本节覆盖：改从同一节题库取一题（仍算题库来源） */
    const l = byNo.get(slot.no);
    const backup = [...l.eligible]
      .filter(x => !usedQid.has(x.qid) && !usedStem.has(normStem(x.q.stem)))
      .sort((a, b) => b.priority - a.priority || deterministic(a.qid, b.qid))[0];
    if (backup) {
      usedQid.add(backup.qid); usedStem.add(normStem(backup.q.stem));
      questions.push({
        id: null, source: 'bank', originQid: backup.qid, lessonId: lessonId(slot.no), lessonNo: slot.no,
        lessonTitle: l.title, type: backup.type, stem: backup.q.stem, options: backup.q.options,
        answer: backup.q.answer, explain: backup.q.explain, tags: backup.q.tags || [],
        covers: backup.q.covers || [], history: backup.history, fallbackFrom: e.message,
      });
    }
    shortfalls.push({...slot, reason: e.message, replacedByBank: !!backup});
  }
}

/* 缺口：用同一课的其它题型题库题补齐，保证 50 题 */
if (questions.length < TOTAL) {
  for (const l of lessons) {
    for (const e of [...l.eligible].sort((a, b) => b.priority - a.priority || deterministic(a.qid, b.qid))) {
      if (questions.length >= TOTAL) break;
      if (usedQid.has(e.qid) || usedStem.has(normStem(e.q.stem))) continue;
      usedQid.add(e.qid); usedStem.add(normStem(e.q.stem));
      questions.push({
        id: null, source: 'bank', originQid: e.qid, lessonId: lessonId(l.no), lessonNo: l.no,
        lessonTitle: l.title, type: e.type, stem: e.q.stem, options: e.q.options, answer: e.q.answer,
        explain: e.q.explain, tags: e.q.tags || [], covers: e.q.covers || [], history: e.history,
      });
    }
    if (questions.length >= TOTAL) break;
  }
}
if (questions.length > TOTAL) questions.length = TOTAL;
questions.sort((a, b) => a.lessonNo - b.lessonNo || TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || String(a.stem).localeCompare(String(b.stem)));
questions.forEach((q, i) => { q.id = 'e' + String(i + 1).padStart(2, '0'); });
questions.forEach((q, i) => { q.number = i + 1; });

/* 答案位置均衡：整体旋转选项顺序（note/explain 跟着选项走，不引用字母，已验证安全）。
   只改选项次序与答案字母，不改题意。 */
{
  const order = ['A', 'B', 'C', 'D'];
  questions.forEach((q, i) => {
    const target = order[i % 4];
    if (q.answer === target) return;
    const correct = q.options[q.answer];
    const others = order.filter(l => l !== q.answer).map(l => q.options[l]);
    const out = [...others];
    out.splice(order.indexOf(target), 0, correct);
    q.options = Object.fromEntries(order.map((l, k) => [l, out[k]]));
    q.answer = target;
  });
}


/* ---------- 审计 ---------- */
const typeCount = Object.fromEntries(TYPES.map(t => [t, questions.filter(q => q.type === t).length]));
const sourceCount = {bank: questions.filter(q => q.source === 'bank').length, new: questions.filter(q => q.source === 'new').length};
const answerCount = Object.fromEntries('ABCD'.split('').map(l => [l, questions.filter(q => q.answer === l).length]));
const coveredLessons = [...new Set(questions.map(q => q.lessonNo))].sort((a, b) => a - b);
const missingLessons = lessons.map(l => l.no).filter(n => !coveredLessons.includes(n));
const dupStems = questions.length - new Set(questions.map(q => normStem(q.stem))).size;
const invalid = questions.filter(q => !questionValid(q)).map(q => q.number);
const warnings = [];
if (missingLessons.length) warnings.push('未覆盖课节：' + missingLessons.join(','));
if (dupStems) warnings.push('重复题干：' + dupStems);
if (invalid.length) warnings.push('格式不合格题号：' + invalid.join(','));
for (const t of TYPES) {
  if (typeCount[t] !== expected[t]) warnings.push(`题型 ${TYPE_LABEL[t]} 期望 ${expected[t]} 实际 ${typeCount[t]}`);
}
if (shortfalls.length) warnings.push('组卷缺口：' + shortfalls.map(s => `第${s.no}节/${s.source}/${s.reason}`).join('；'));
if (sourceCount.bank !== 30 || sourceCount.new !== 20) warnings.push(`来源配额：题库 ${sourceCount.bank}，新题 ${sourceCount.new}`);

const paper = {
  version: 1,
  id: PAPER_ID,
  course: COURSE,
  courseTitle: '新东方词汇课 · 托福词汇课 孙曦',
  title: '托福词汇课 · 期末',
  generatedAt: new Date().toISOString(),
  unlock: {lessons: 48, rule: 'course-complete'},
  rules: {total: questions.length, untimed: true, types: typeCount, options: 4},
  lessons: lessons.map(l => ({no: l.no, id: lessonId(l.no), title: l.title})),
  questions,
};
const audit = [
  `# ndf-01 期末卷审计`,
  '',
  `生成时间：${paper.generatedAt}`,
  `题目：${questions.length}（题库 ${sourceCount.bank} · 新出 ${sourceCount.new}）`,
  `题型：${TYPES.map(t => `${TYPE_LABEL[t]} ${typeCount[t]}`).join(' · ')}`,
  `答案分布：${Object.entries(answerCount).map(([l, n]) => `${l} ${n}`).join(' · ')}`,
  `覆盖课节：${coveredLessons.length}/48${missingLessons.length ? `（缺 ${missingLessons.join(',')}）` : ''}`,
  `重复题干：${dupStems}`,
  '',
  '## 警告',
  ...(warnings.length ? warnings.map(w => '- ' + w) : ['- 无']),
  '',
  '## 分课清单',
  '| 节 | 标题 | 题号 | 来源 | 题型 | 目标词 |',
  '|---|---|---|---|---|---|',
  ...lessons.map(l => {
    const qs = questions.filter(q => q.lessonNo === l.no);
    return `| ${pad(l.no)} | ${l.title.replace(/\|/g, '/')} | ${qs.map(q => q.number).join(',') || '—'} | ${qs.map(q => q.source === 'new' ? '新' : '库').join(',') || '—'} | ${qs.map(q => TYPE_LABEL[q.type] || q.type).join(',') || '—'} | ${qs.flatMap(q => (q.covers || []).slice(0, 3)).slice(0, 3).join(', ') || '—'} |`;
  }),
  '',
  '## 新题溯源',
  ...questions.filter(q => q.source === 'new').map(q => `- #${q.number} 第${pad(q.lessonNo)}节 ${q.lessonTitle}：${(q.covers || []).join(', ')} — ${q.stem.slice(0, 80)}`),
].join('\n');

fs.mkdirSync(OUT_DIR, {recursive: true});
fs.writeFileSync(path.join(OUT_DIR, `${PAPER_ID}.json`), JSON.stringify(paper, null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, `${PAPER_ID}.audit.md`), audit + '\n');
console.log(JSON.stringify({paper: path.join(OUT_DIR, `${PAPER_ID}.json`), questions: questions.length, sourceCount, typeCount, answerCount, coveredLessons: coveredLessons.length, warnings}, null, 2));
if (warnings.length) process.exitCode = 2;
