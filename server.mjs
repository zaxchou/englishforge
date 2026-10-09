#!/usr/bin/env node
/* ============================================================
   TOEFL Lab 本地服务入口
   ------------------------------------------------------------
   同源提供：
     /                    web/ 静态页（正式入口 web/index.html）
     /api/catalog         题库目录（真实统计，来自 data 目录下各套 JSON）
     /api/set/<id>        单套结构化题库 JSON
     /api/courses         课程目录（build/courses/catalog.json，scan_courses.py 产物）
     /api/handout/<id>    单课讲义提取文本
     /media/set/<id>/...  真题音频（从源素材目录映射，只读，支持 Range）
     /media/vince/...     vince 课程 mp4 / pptx（只读）
     /media/ndf/<dir>/... 新D方课程 mov / pdf（只读）
     /api/records         GET 学习记录 / POST 合并保存（持久化到 records/）
   ------------------------------------------------------------
   约束：
   - 源素材目录只读；本服务器对它们只做读。
   - 源素材路径只在服务端使用，绝不下发给浏览器（页面只见 /media/...）。
   - 学习记录持久化目录 records/ 与可再生目录 build/ 分离。
   - 素材根可被 --root / TFL_ROOT 覆盖（Windows 映射盘与 NAS 挂载兼容）。
   ============================================================ */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
function argOf(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const PORT = Number(argOf('--port', process.env.TFL_PORT || 8018));
const WEB_DIR = path.resolve(__dirname, argOf('--web', 'web'));
const DATA_DIR = path.resolve(__dirname, argOf('--data', 'data'));
const BUILD_DIR = path.resolve(__dirname, argOf('--build', 'build'));
const RECORDS_DIR = path.resolve(__dirname, argOf('--records', 'records'));
// 兄弟素材基目录：默认项目上一级（vince托福课 / 新D方 / 819新托福真题持续更新 都在那一层）。
// NAS 容器里代码在 /app，素材挂载在别处 → 用 TFL_SIBLING_ROOT 指到挂载点，路径逻辑不变。
const SIB = process.env.TFL_SIBLING_ROOT
  ? path.resolve(process.env.TFL_SIBLING_ROOT)
  : path.resolve(__dirname, '..');
// 素材根：默认取兄弟基目录下的 819新托福真题持续更新
const SOURCE_ROOT = path.resolve(
  SIB,
  argOf('--root', process.env.TFL_ROOT || '819新托福真题持续更新')
);

/* ---------- 套题 → 源目录映射（build/manifest.json） ---------- */
let SET_DIRS = {};           // set_id -> 源目录绝对路径
try {
  const mf = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'manifest.json'), 'utf8'));
  const sets = Array.isArray(mf) ? mf.sets : mf.sets || [];
  for (const s of sets) {
    // TFL_SET_ROOTS_FROM_DIR=1（NAS 容器）：manifest 的 abs_dir 是生成机的 Windows 绝对路径，
    // 跨机无意义 → 一律按 SOURCE_ROOT + dir 重建；dir 里的分隔符可能混 \ /，统一拆开重拼。
    if (process.env.TFL_SET_ROOTS_FROM_DIR === '1') {
      if (!s.dir) continue;
      SET_DIRS[s.set_id] = path.join(SOURCE_ROOT, ...String(s.dir).split(/[\\/]+/).filter(Boolean));
      continue;
    }
    let d = s.abs_dir || (s.dir ? path.join(s.root || '', s.dir) : null);
    if (!d) continue;
    if (s.root && SOURCE_ROOT && path.resolve(s.root) !== path.resolve(SOURCE_ROOT)) {
      // root 被覆盖时，按相对目录重新拼接
      d = path.join(SOURCE_ROOT, s.dir || '');
    }
    SET_DIRS[s.set_id] = d;
  }
} catch (e) {
  console.warn('[server] manifest 读取失败，/media/set 不可用:', e.message);
}

/* ---------- AI 助教配置（错题解析）----------
   密钥只走环境变量；本地开发可放 .env.local（已 gitignore），生产由 compose 注入。
   默认 DeepSeek deepseek-chat：非思考模式、即点即出，符合「关闭思考、速度优先」。 */
try {
  const envLocal = path.join(__dirname, '.env.local');
  if (fs.existsSync(envLocal)) {
    for (const line of fs.readFileSync(envLocal, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) {}
const AI_CFG = {
  key: process.env.TFL_AI_KEY || '',
  base: (process.env.TFL_AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: process.env.TFL_AI_MODEL || 'deepseek-chat',
};
const AI_CACHE = new Map();          // qid -> 解析文本（L1 内存）
const AI_CACHE_MAX = 300;
// 解析版本号：v2 = 注入官方听力转写 + 防编造提示词。旧条目缺 v，
// 可据此识别"升级前生成的旧解析"（GET 返回 legacy 清单，供批量重生成）。
const AI_V = 3;   // v3 = 听力转写同时下发到面板展示
// L2 永久缓存：records 卷里的 ai-explanations.json，随容器更新保留——
// 一道题生成过解析就是这道题的固定解析，不再重复扣费。
const AI_STORE_FILE = path.join(RECORDS_DIR, 'ai-explanations.json');
let AI_STORE = {};
try { AI_STORE = JSON.parse(fs.readFileSync(AI_STORE_FILE, 'utf8')).items || {}; } catch (e) {}
function aiStoreSave() {
  try {
    fs.mkdirSync(RECORDS_DIR, { recursive: true });
    fs.writeFileSync(AI_STORE_FILE, JSON.stringify({ version: 1, items: AI_STORE }));
  } catch (e) { console.error('[ai-store]', e.message); }
}

/* qid(set/subj/mk/type/no) → 题面。与 web/normSet 同一套定位逻辑（duplicate module 的
   mk 加 pN、fill 用 q_range 起点、mc 用 answers 里非 fill 项）。只读题面，不改数据。 */
function findQuestion(set, subj, mk, type, no) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, set, set + '.json'), 'utf8')); }
  catch (e) { return null; }
  const sub = j.subjects && j.subjects[subj];
  if (!sub) return null;
  const modNo = /^m(\d+)/.exec(mk);
  if (sub.modules && modNo) {
    const mod = Number(modNo[1]);
    for (let i = 0; i < sub.modules.length; i++) {
      const m = sub.modules[i];
      const dupM = sub.modules.filter(x => x.module === m.module).length > 1;
      const mk2 = 'm' + m.module + (dupM ? 'p' + (m.part || i + 1) : '');
      if (mk2 !== mk) continue;
      const amk = 'module' + m.module;
      for (const g of (m.groups || [])) {
        if (type === 'fill' && g.kind === 'fill_in_blank') {
          const qStart = parseInt(String(g.q_range || '1').split('-')[0], 10) || 1;
          const ansList = (g.answers && g.answers.length ? g.answers :
            (j.answers?.[subj]?.[amk] || []).filter(a => a.kind === 'fill'));
          const a = ansList.find(x => (x.q != null ? x.q : x.no) === no);
          if (a || (no >= qStart && no < qStart + String(g.passage || '').split(/(?:\s+_)+/).length))
            return { kind: 'fill', set, subj, no, passage: g.passage || '', title: g.title || '',
                     answer: a ? a.a : '' };
        } else if (type !== 'fill') {
          const q = (g.questions || []).find(x => x.no === no);
          if (q) {
            const a = (j.answers?.[subj]?.[amk] || []).find(x => x.kind !== 'fill' && x.q === no);
            return { kind: 'mc', set, subj, no, passage: g.passage || '', title: g.title || '',
                     stem: q.stem || '', options: q.options || {}, answer: (a && a.a) || q.answer || '',
                     _audio: q.audio || g.audio || '' };
          }
        }
      }
    }
    return null;
  }
  if (sub.tasks) {
    for (const t of sub.tasks) {
      const typeMap = { sentence_construction: 'sentence', email: 'email', academic_discussion: 'discussion', TASK1: 's1', TASK2: 's2' };
      const rawKey = t.type || t.task || 'task';
      const tk = (typeMap[rawKey] || String(rawKey).toLowerCase());
      if (tk !== type) continue;
      return { kind: 'task', set, subj, no, prompt: (t.prompt_lines || []).join('\n'), body: (t.body || []).join('\n'),
               reference: t.reference_answer || '' };
    }
  }
  return null;
}

async function aiExplain(qidStr, force) {
  const parts = String(qidStr || '').split('/');
  if (parts.length !== 5) throw new Error('bad qid');
  const [set, subj, mk, type, noS] = parts;
  const no = Number(noS);
  if (!Number.isInteger(no)) throw new Error('bad qid');
  if (set === 'gen') return aiExplainGen(qidStr, subj, mk, no, force);   // 课后练错题: 题面来自 GQ_STORE
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(set) || !/^(listening|reading|writing|speaking)$/.test(subj)
      || !/^[\w.+-]+$/.test(mk) || !/^[\w]+$/.test(type)) throw new Error('bad qid');
  if (!force) {
    if (AI_CACHE.has(qidStr)) {
      return { text: AI_CACHE.get(qidStr), cached: true, q: (AI_STORE[qidStr] && AI_STORE[qidStr].q) || undefined };
    }
    if (AI_STORE[qidStr]) {
      const hit = AI_STORE[qidStr];
      if (AI_CACHE.size >= AI_CACHE_MAX) AI_CACHE.delete(AI_CACHE.keys().next().value);
      AI_CACHE.set(qidStr, hit.text);
      return { text: hit.text, cached: true, q: hit.q };
    }
  }
  const q = findQuestion(set, subj, mk, type, no);
  if (!q) throw new Error('question not found');
  // 学生当时的错误答案（不是最近一次答案——可能已订正）
  const att = RECORDS.attempts && RECORDS.attempts[qidStr];
  const wrongs = att && Array.isArray(att.history)
    ? [...new Set(att.history.filter(h => h.ok === false).map(h => String(h.answer || '').slice(0, 80)))]
    : [];
  const mine = wrongs.join(' / ');
  // 官方听力转写（Answers.docx 的 Listening Transcript, 管线预提取对齐到音频文件）:
  // 只注入 AI 解析, 不在练习界面显示。
  let transcript = '';
  if (subj === 'listening') {
    try {
      const tp = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'transcripts', set + '.json'), 'utf8'));
      const rel = String(q._audio || '').split('\\').join('/').split('/').pop();
      const hit = rel && tp.audios && tp.audios[rel];
      if (hit && hit.lines && hit.lines.length) transcript = hit.lines.join('\n').slice(0, 4000);
    } catch (e) {}
  }
  const noMaterial = !(q.passage || '').trim() && !(q.prompt || '').trim() && !transcript;
  const lines = [];
  if (transcript) lines.push('[听力原文（官方 Transcript，说话人已标注）]\n' + transcript);
  if (q.passage) lines.push('[材料]\n' + String(q.passage).slice(0, 4000));
  if (q.title) lines.push('[材料标题] ' + q.title);
  if (q.prompt || q.body) lines.push('[任务说明]\n' + ((q.prompt + '\n' + (q.body || '')).slice(0, 1500)));
  if (q.stem) lines.push('[题干] ' + q.stem);
  if (q.options && Object.keys(q.options).length)
    lines.push('[选项]\n' + Object.entries(q.options).map(([k, v]) => k + '. ' + v).join('\n'));
  if (q.kind === 'fill') lines.push('[该空所在句的填空形式] 见材料下划线处，第 ' + no + ' 空');
  lines.push('[正确答案] ' + (q.answer || q.reference || '（官方未提供）'));
  if (mine) lines.push('[学生当时的错误答案] ' + mine + (att && att.st === 'done' ? '（后来已订正，但请按当时错选来讲解错因）' : ''));
  if (noMaterial) lines.push('（注意：本题为听力题，对话原文尚未接入，只能基于题干与选项逻辑分析，如信息不足请直说。）');
  const sys = '你是托福助教。用中文解释这道题：先一句话给出本题考查点，再说正确答案为什么对'
    + '（引用材料里的关键短语作为依据）。'
    + (mine
        ? '最后指出学生当时错选（' + mine + '）错在哪里。'
        : '没有学生作答记录，不要编造或猜测学生的选择，只讲正确答案的依据。')
    + '总共不超过 180 字，分 2-3 小段纯文本，不要逐项翻译选项，不要客套话。'
    + (q.kind === 'fill' ? ' 这是词库填空题：从语法搭配和上下文语义解释该空为什么填这个词。' : '');
  const r = await fetch(AI_CFG.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_CFG.key },
    body: JSON.stringify({
      model: AI_CFG.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: lines.join('\n\n') }],
      max_tokens: 500, temperature: 0.2, stream: false,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('AI 接口 ' + r.status + (t ? ': ' + t.slice(0, 120) : ''));
  }
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI 未返回内容');
  const qPub = {
    kind: q.kind, title: q.title || '', passage: q.passage || '', stem: q.stem || '',
    options: q.options || {}, prompt: q.prompt || '', body: q.body || '',
    answer: q.answer || q.reference || '', mine, noMaterial,
    transcript,
  };
  AI_STORE[qidStr] = { text, q: qPub, at: Date.now(), v: AI_V };
  aiStoreSave();
  if (AI_CACHE.size >= AI_CACHE_MAX) AI_CACHE.delete(AI_CACHE.keys().next().value);
  AI_CACHE.set(qidStr, text);
  return { text, cached: false, q: qPub };
}

/* ---------- 课后练（AI 按教材讲义生成题组; 2026-10-06 计划 P1） ----------
   讲义是课程级 PDF（如 ndf-01 一份 33 页覆盖 48 节），生成时全文注入，
   模型按课节标题聚焦对应章节。铁律同 AI 解析：以教材为标准、题目用词必须
   能在讲义文本溯源（机械校验，不达标丢题）、一次生成永久缓存（records 卷）。 */
const GQ_STORE_FILE = path.join(RECORDS_DIR, 'generated-quizzes.json');
let GQ_STORE = {};
try { GQ_STORE = JSON.parse(fs.readFileSync(GQ_STORE_FILE, 'utf8')).items || {}; } catch (e) {}
function gqSave() {
  try {
    fs.mkdirSync(RECORDS_DIR, { recursive: true });
    fs.writeFileSync(GQ_STORE_FILE, JSON.stringify({ version: 1, items: GQ_STORE }));
  } catch (e) { console.error('[gq-store]', e.message); }
}
const AI_QV = 2;                 // v2 = 逐字稿源+覆盖闭环+选项级解析(note)
const GQ_COURSE = 'ndf-01';      // MVP 只开词汇课
/* 原素材只读；优先提供本地文字复核派生稿，状态不等于逐句听音认证。 */
const SCRIPT_DIRS = { 'ndf-01': path.join(SIB, '新D方', '新D方新托福全套', '01 托福词汇课 孙曦', '逐字稿') };
function scriptFileFor(course, lessonNo) {
  const reviewed = path.join(BUILD_DIR, 'scripts-reviewed', course);
  // 已接入复核目录时不悄悄降级到旧稿；缺稿应报错让问题可见。
  const dir = fs.existsSync(reviewed) ? reviewed : SCRIPT_DIRS[course];
  if (!dir) return null;
  try {
    const pref = String(lessonNo).padStart(2, '0');
    const f = fs.readdirSync(dir).find(x => x.startsWith(pref) && x.toLowerCase().endsWith('.md'));
    return f ? { dir, file: f } : null;
  } catch (e) { return null; }
}
const GQ_STOP = new Set(('the,a,an,and,or,of,to,in,on,for,with,from,by,at,as,is,are,was,were,be,been,' +
  'this,that,these,those,it,its,not,but,which,who,whom,whose,what,when,where,how,why,can,could,' +
  'will,would,should,may,might,must,do,does,did,have,has,had,he,she,they,we,you,i,his,her,their,' +
  'our,your,my,me,him,them,us,if,then,than,so,such,also,more,most,very,much,many,some,any,no,one,' +
  'word,words,example,examples,meaning,means,fill,blank,choose,correct,following,sentence').split(','));

function findLesson(lessonId) {
  for (const s of (loadCourses().series || [])) for (const c of (s.courses || []))
    for (let i = 0; i < (c.lessons || []).length; i++)
      if (c.lessons[i].id === lessonId) return { course: c, lesson: c.lessons[i], ix: i };
  return null;
}
async function aiGen(sys, user) {
  const r = await fetch(AI_CFG.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_CFG.key },
    body: JSON.stringify({ model: AI_CFG.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 7800, temperature: 0.3, stream: false }),   // 30 项批次带全 note 约 15k+ 字符, 6k 会被截成残 JSON
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('AI 接口 ' + r.status + (t ? ': ' + t.slice(0, 120) : ''));
  }
  const j = await r.json();
  const raw = j.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('AI 未返回内容');
  return raw;
}
function parseQuiz(raw) {
  const m = raw.match(/\{[\s\S]*\}/);   // 容忍模型在 JSON 外加说明文字
  if (!m) throw new Error('AI 未返回 JSON');
  const j = JSON.parse(m[0]);
  const qs = Array.isArray(j.questions) ? j.questions : [];
  const clean = qs.filter(q => q && typeof q.stem === 'string' && q.stem.trim().length > 3
      && q.options && Object.keys(q.options).length >= 3
      && q.answer && typeof q.explain === 'string' && q.explain.trim()
      && ['root', 'collocation', 'meaning', 'cloze'].includes(q.type))
    .map(q => {
      const optSrc = Object.entries(q.options || {}).slice(0, 4);
      const options = Object.fromEntries(optSrc.map(([k, v], i) => {
        const o = (v && typeof v === 'object') ? v : { t: v };
        return ['ABCD'[i], { t: String(o.t == null ? '' : o.t).trim(), note: String(o.note == null ? '' : o.note).trim() }];
      }));
      const ansK = String(q.answer).trim().toUpperCase()[0];
      if (!options[ansK] || !options[ansK].t) return null;   // 归一化后答案必须在 A-D 里(防 5 选项 answer=E 被截)
      // 选项文本两两不同(归一化大小写/空白)——重复选项题无判别度, 拒收该题(29/33 重复事故根治)
      const seenT = new Set();
      for (const o of Object.values(options)) {
        const nt = o.t.toLowerCase().replace(/\s+/g, ' ');
        if (seenT.has(nt)) return null;
        seenT.add(nt);
      }
      // 覆盖范围式判错("本节未讲/未重点讲解")=题干多解的糊弄, 拒收(9 课 q22 事故根治)
      if (/未重点讲解|本节未讲|未在本节|更直接对应本节/.test(JSON.stringify(options) + ' ' + (q.explain || ''))) return null;
      return {
        type: q.type,
        stem: String(q.stem).trim(),
        options,
        answer: ansK,
        explain: String(q.explain).trim(),
        tags: Array.isArray(q.tags) ? q.tags.map(x => String(x).slice(0, 24)).slice(0, 3) : [],
        covers: Array.isArray(q.covers) ? q.covers.map(x => String(x).slice(0, 40)) : [],
      };
    }).filter(Boolean);
  if (clean.length < 4) throw new Error('有效题目不足（仅 ' + clean.length + ' 题）');
  return {
    scope: String(j.scope || '').slice(0, 200),
    covered: Array.isArray(j.covered) ? j.covered.map(x => String(x)) : [],
    pages: Array.isArray(j.pages) ? j.pages.slice(0, 12).map(Number).filter(Number.isFinite) : [],
    families: (Array.isArray(j.families) ? j.families : []).filter(x => x && x.name).map(x => ({
      name: String(x.name).slice(0, 24),
      kind: ['root', 'prefix', 'suffix'].includes(x.kind) ? x.kind : 'root',
      gloss: String(x.gloss || '').slice(0, 120),
      words: Array.isArray(x.words) ? x.words.map(w => String(w).trim()).filter(Boolean).slice(0, 24) : [],
    })),
    questions: clean.slice(0, 14),
  };
}
/* 溯源校验(r9 修订): 只查"被考察的词"=正确答案选项里的英文实词
   (全中文选项→题干英文词)。词根/词缀这类短候选用讲义全文子串匹配
   (-ment 出现在 development 里即算讲过)。干扰项允许讲义外——词义题的
   干扰词本应多样。答案词完全不在讲义→整题丢弃——不考没教过的词。 */
function traceOK(q, wordSet, rawText) {
  const latin = s => (String(s).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []);
  const av = (q.options || {})[String(q.answer).trim().toUpperCase()];
  const ansText = (av && typeof av === 'object') ? String(av.t || '') : String(av || '');
  let cand = latin(ansText);
  if (!cand.length) cand = latin(q.stem).filter(w => !GQ_STOP.has(w));
  if (!cand.length) return true;   // 全中文问答(方法论/概念题): 无英文可查, 交提示词约束+用户坏题标记兜底
  return cand.some(w => wordSet.has(w) || rawText.includes(w)
    || [...wordSet].some(t => t.startsWith(w.slice(0, 4))));
}
const GQ_INFLIGHT = new Map();   // 同课并发去重: 双标签页/重复点击只跑一次 AI
async function genQuiz(lessonId, force) {
  if (!/^[\w.-]+$/.test(lessonId)) throw new Error('bad lessonId');
  if (GQ_INFLIGHT.has(lessonId)) return GQ_INFLIGHT.get(lessonId);
  const job = genQuizInner(lessonId, force);
  GQ_INFLIGHT.set(lessonId, job);
  try { return await job; } finally { GQ_INFLIGHT.delete(lessonId); }
}
async function genQuizInner(lessonId, force) {
  if (!force) {
    const hit = GQ_STORE[lessonId];
    if (hit && hit.v === AI_QV) return { quiz: hit, cached: true };
  }
  const f = findLesson(lessonId);
  if (!f) throw new Error('lesson not found');
  if (f.course.id !== GQ_COURSE) throw new Error('本课程暂未开通课后练');
  const sf = scriptFileFor(f.course.id, f.ix + 1);
  if (!sf) throw new Error('该节逐字稿尚未校对');
  let scriptMd = '';
  try {
    scriptMd = fs.readFileSync(path.join(sf.dir, sf.file), 'utf8').replace(/^---[\s\S]*?---\n*/, '').trim();
  } catch (e) { throw new Error('逐字稿读取失败'); }
  if (scriptMd.length < 500) throw new Error('逐字稿内容过短');
  const stem = f.course.id + '-' + String(f.ix + 1).padStart(2, '0');
  let inv = { words: [], affixes: [], roots: [], phrases: [] };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sf.dir, stem + '.words.json'), 'utf8'));
    if (sf.dir === path.join(BUILD_DIR, 'scripts-reviewed', f.course.id)) {
      const digest = createHash('sha256').update(fs.readFileSync(path.join(sf.dir, sf.file))).digest('hex');
      if (!j.sourceReview || j.sourceReview.reviewedSha256 !== digest)
        throw new Error('课稿复核签名不一致，暂停新题生成');
      if (j.sourceReview.generationReady !== true)
        throw new Error('课稿仍有待确认片段，暂停新题生成；现有课后练仍可使用');
    }
    inv = { words: j.words || [], affixes: j.affixes || [], roots: j.roots || [], phrases: j.phrases || [] };
  } catch (e) {
    if (sf.dir === path.join(BUILD_DIR, 'scripts-reviewed', f.course.id))
      throw new Error(e.message.includes('暂停新题生成') ? e.message : '复核语言点清单读取失败，暂停新题生成');
  }
  // 混录防护(09/01/17/26 事故固化): 信息密度>8字符/秒 几乎必然混入其他章节 → 只取最长节
  const durSec = f.lesson.duration_sec || 0;
  if (durSec > 60 && scriptMd.length / durSec > 8) {
    const marks = [...scriptMd.matchAll(/^## .+$/gm)];
    if (marks.length >= 2) {
      const bounds = marks.map(m => m.index).concat([scriptMd.length]);
      let best = -1, bestLen = 0;
      for (let i = 0; i < marks.length; i++) {
        const len = bounds[i + 1] - bounds[i];
        if (len > bestLen) { bestLen = len; best = i; }
      }
      if (bestLen > 800 && bestLen < scriptMd.length) {
        const fm = scriptMd.match(/^---[\s\S]*?---\n*/);
        scriptMd = (fm ? fm[0] : '') + scriptMd.slice(bounds[best], bounds[best + 1]);
        console.warn('[gen-quiz]', lessonId, '混录嫌疑 rate=' + (scriptMd.length / durSec).toFixed(1) + '字/s(原' + (durSec > 0 ? '' : '') + ') → 只取最长节 ' + marks[best][0].slice(0, 24) + ' (' + bestLen + '字符)');
      }
    }
  }
  // 词表错配防护: 清单项大面积不在逐字稿里 → 丢弃稿外项并告警(防跨课词表污染)
  let invItems = [...inv.words, ...inv.affixes, ...inv.roots].map(x => String(x).trim()).filter(Boolean);
  if (invItems.length > 20) {
    const low = scriptMd.toLowerCase();
    const inScript = invItems.filter(w => low.includes(w.toLowerCase()) || low.includes(w.toLowerCase().replace(/\s+/g, '')));
    if (inScript.length / invItems.length < 0.5) {
      console.warn('[gen-quiz]', lessonId, '词表错配嫌疑: 仅', inScript.length, '/', invItems.length, '命中逐字稿 → 丢弃稿外项');
      const keep = new Set(inScript);
      inv.words = inv.words.filter(w => keep.has(String(w).trim()));
      inv.affixes = inv.affixes.filter(w => keep.has(String(w).trim()));
      inv.roots = inv.roots.filter(w => keep.has(String(w).trim()));
      invItems = invItems.filter(w => keep.has(w));
    }
  }
  // 讲解释级(r39): 词表里"老师真正讲过"的才算出题对象, 仅念过/提及的退回词表墙(06 课 869 项覆盖式出题事故根治)
  let taughtItems = invItems;
  try {
    const graded = await aiGradeTaught(scriptMd, invItems);
    if (graded && graded.taught && graded.taught.length) {
      const set = new Set(graded.taught);
      taughtItems = invItems.filter(w => set.has(w));
      console.log('[gen-quiz]', lessonId, '讲解释级 taught', taughtItems.length, '/ mentioned', invItems.length - taughtItems.length);
    }
  } catch (e) { console.error('[gen-quiz]', lessonId, '讲解释级 FAIL, 全清单覆盖', e.message); }
  const taughtSet = new Set(taughtItems);
  const tw = inv.words.filter(w => taughtSet.has(String(w).trim()));
  const ta = inv.affixes.filter(w => taughtSet.has(String(w).trim()));
  const tr = inv.roots.filter(w => taughtSet.has(String(w).trim()));
  const invLine = 'words: ' + tw.join('、') + '\naffixes: ' + ta.join('、')
    + '\nroots: ' + tr.join('、') + (inv.phrases.length ? '\nphrases: ' + inv.phrases.join('、') : '');

  const sys = '你是托福词汇课的教研老师。根据本节课的课堂逐字稿(已校对)和本节语言点清单，生成覆盖式课后练习。铁律：'
    + '1. 覆盖第一：清单里的每一个单词/词根/词缀都必须被至少一道题考查，或出现在某题的选项解析(note)或 explain 里。'
    + '2. 每道题的每个选项都给 note(知识点)：说明该选项的含义，错误选项要说它是什么意思、为什么在这里不对。'
    + '3. 内容以逐字稿里老师讲的原话为准(老师举的例子、补充的辨析都要用上)；拼写与讲义核对。'
    + '4. 题型混合：root(词根词缀逻辑)、collocation(搭配用法)、meaning(词义选择)、cloze(例句填空，空格用 ______)，每题 4 选项。'
    + '5. 正确答案唯一：题干的判定条件必须只有正确选项满足；干扰项必须因词根/词缀含义、词义、搭配的真实错误而不成立。'
    + '若某候选词同样满足题干条件，必须换掉它——严禁与正确答案形成多解，更严禁拿"本节没讲/未重点讲解/超纲"当判错理由。'
    + '6. 严格 JSON：{"scope":"本节一句话","questions":[{"type":"root","stem":"...","options":{"A":{"t":"选项内容","note":"该选项含义/为何对错"},"B":{...},"C":{...},"D":{...}},"answer":"B","explain":"本题主知识点","tags":["-ist"],"covers":["清单中被本题覆盖的项，原文照抄"]}],"covered":["本轮已覆盖的清单项"]}';

  const user = '[本节课] 第 ' + (f.ix + 1) + ' 节：' + f.lesson.title
    + '\n\n[本节老师讲过的语言点清单(出题对象, 必须全覆盖)]\n' + invLine
    + '\n\n[课堂逐字稿(已校对)]\n' + scriptMd.slice(0, 26000);

  const parseOne = raw => {
    const parsed = parseQuiz(raw);
    // 覆盖对账: 讲过的清单项 出现在 covered 或任何题目文本里 即算覆盖
    const allText = JSON.stringify(parsed.questions).toLowerCase();
    const cov = new Set((parsed.covered || []).map(x => String(x).toLowerCase()));
    const uncovered = taughtItems.filter(w => !cov.has(w.toLowerCase()) && !allText.includes(w.toLowerCase()));
    return { parsed, uncovered };
  };
  const finish = (questions, scope, uncoveredFinal) => {
    questions.forEach((q, i) => { q.id = 'q' + (i + 1); });
    const entry = { v: AI_QV, at: Date.now(), course: f.course.id, lessonNo: f.ix + 1,
      title: f.lesson.title, scope, inventory: inv, uncovered: uncoveredFinal,
      questions, bad: [] };
    GQ_STORE[lessonId] = entry;
    gqSave();
    return { quiz: entry, cached: false, uncovered: uncoveredFinal.length };
  };
  // 覆盖闭环 V2: 清单分批(每批约 30 项, 单轮输出天然不超限), 批间全局对账, 收尾补漏一轮
  const covNow = qs => {
    const allText = JSON.stringify(qs).toLowerCase();
    return taughtItems.filter(w => !allText.includes(w.toLowerCase()));
  };
  const groups = [];
  for (let i = 0; i < taughtItems.length; i += 30) groups.push(taughtItems.slice(i, i + 30));
  if (!groups.length) groups.push([]);
  let acc = [], scope = '', lastErr = '';
  for (let gi = 0; gi < groups.length; gi++) {
    const target = groups[gi].filter(w => covNow(acc).includes(w.toLowerCase()));
    if (taughtItems.length && !target.length) continue;   // 前面批次已顺带覆盖; 词表缺失时不跳过(退化整稿出题)
    const msg = taughtItems.length
      ? user + '\n\n[本轮只针对以下清单项出题，不要超出]\n' + target.join('、')
        + '\n出 4-9 题，每题的选项 note 都要给全。'
      : user + '\n\n请出 8-12 题，每题的选项 note 都要给全。';   // 词表缺失: 退化为整稿出题
    let r;
    try { r = parseOne(await aiGen(sys, msg)); }
    catch (e) {
      lastErr = e.message;
      console.error('[gen-quiz]', lessonId, 'g' + gi, 'FAIL', e.message);
      try { r = parseOne(await aiGen(sys, msg)); }   // 截断/网络抖动重试一次
      catch (e2) { console.error('[gen-quiz]', lessonId, 'g' + gi, 'RETRY FAIL'); continue; }   // 单批失败不放弃整节
    }
    if (!scope) scope = r.parsed.scope;
    for (const q of r.parsed.questions) {
      const k = q.stem.toLowerCase().replace(/____+/g, ' ').replace(/[\s「」“”"'（）()。.,，?？!！:：;；]/g, '');
      if (acc.some(x => x.stem.toLowerCase().replace(/____+/g, ' ').replace(/[\s「」“”"'（）()。.,，?？!！:：;；]/g, '') === k)) continue;   // 跨批次题干去重(07 课 collaborate 三连事故根治)
      acc.push(q);
    }
    console.log('[gen-quiz]', lessonId, 'g' + gi, 'q', r.parsed.questions.length, '累计', acc.length);
  }
  // 收尾补漏: 全局对账后仍有未覆盖 → 一轮针对补题
  let remaining = covNow(acc);
  if (remaining.length && acc.length) {
    const msg = user + '\n\n[出题反馈] 以下清单项尚未覆盖，请只针对它们继续出题：\n' + remaining.join('、');
    try {
      const r = parseOne(await aiGen(sys, msg));
      acc = acc.concat(r.parsed.questions);
      remaining = covNow(acc);
      console.log('[gen-quiz]', lessonId, 'final', 'q', r.parsed.questions.length, 'uncovered', remaining.length);
    } catch (e) { console.error('[gen-quiz]', lessonId, 'final FAIL', e.message); }
  }
  if (!acc.length) throw new Error(lastErr || '生成失败');
  // 溯源抽查: 英文答案词必须能在逐字稿找到(防幻觉; 全中文问答跳过)
  const rawText = scriptMd.toLowerCase();
  const wordSet = new Set((rawText.match(/[a-z][a-z'-]{2,}/g) || []));
  acc = acc.filter(q => traceOK(q, wordSet, rawText));
  if (!acc.length) throw new Error('生成题目未通过溯源校验，请重试');
  // 覆盖续写轮: 大清单课(130+ 项)30 题装不下 → 继续针对性出题直到覆盖完(总量≤60)
  let extra = 0;
  remaining = taughtItems.filter(w => !acc.some(q => JSON.stringify(q).toLowerCase().includes(w.toLowerCase())));
  while (remaining.length && extra < 5) {
    const msg = user + '\n\n[补充出题] 以下清单项尚未被覆盖，请只针对它们出题(每项至少出现一次)：\n' + remaining.join('、');
    let r;
    try { r = parseOne(await aiGen(sys, msg)); }
    catch (e) { console.error('[gen-quiz]', lessonId, 'extra' + extra, 'FAIL', e.message); break; }
    const before = acc.length;
    acc = acc.concat(r.parsed.questions.filter(q => traceOK(q, wordSet, rawText)));
    extra++;
    remaining = taughtItems.filter(w => !acc.some(q => JSON.stringify(q).toLowerCase().includes(w.toLowerCase())));
    console.log('[gen-quiz]', lessonId, 'extra' + extra, 'q', acc.length - before, 'uncovered', remaining.length);
    if (acc.length >= 60 || !remaining.length) break;
    if (acc.length === before) break;   // 无进展防死循环
  }
  acc = acc.slice(0, 60);
  const finalUncovered = remaining.filter(w => !acc.some(q => JSON.stringify(q).toLowerCase().includes(w.toLowerCase())));
  acc.forEach((q, i) => { q.id = 'q' + (i + 1); });   // 判级与 finish 都依赖稳定 id(此前判级拿不到 id, AI 对 undefined 编号判 ext 会全量误标)
  acc.forEach(q => shuffleOptions(q, lessonId + '/' + q.id));   // 答案位置确定性洗牌(AI 习惯把正确项放 A, 全库曾 85% 是 A)
  await gradeTiers(scriptMd, acc);   // 分级: core=课堂讲过, ext=未展开(复习完选做); 失败全按 core
  return finish(acc, scope, finalUncovered);
}

/* 答案位置确定性洗牌: LLM 出题习惯把正确项放首位(全库曾 85% 是 A)。
   用 qid 做种子的 Fisher-Yates——同一题永远同一排列, 缓存/作答记录不漂移; note 跟选项对象一起走。 */
function shuffleOptions(q, seed) {
  if (!q.options || q.answer == null) return;
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rand = () => { h = Math.imul(h ^ (h >>> 15), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  const entries = Object.entries(q.options);
  const ansVal = entries.find(([k]) => k === q.answer);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  q.options = Object.fromEntries(entries.map(([, v], i) => ['ABCD'[i], v]));
  const at = entries.findIndex(([k]) => k === (ansVal && ansVal[0]));
  if (at >= 0) q.answer = 'ABCD'[at];
}

/* 讲解释级(r39): 对照逐字稿把清单分成 taught(实质讲解过)/mentioned(仅提及)。
   只对 taught 做覆盖出题; 失败返回 null → 调用方回退全清单(宁多勿漏, 不阻断出题)。 */
async function aiGradeTaught(scriptMd, invItems) {
  if (!invItems.length) return null;
  const taught = new Set();
  const BATCH = 120;
  for (let i = 0; i < invItems.length; i += BATCH) {
    const batch = invItems.slice(i, i + BATCH);
    const sys = '你是词汇课教研审读。给定课堂逐字稿和语言点清单，判定清单里每一项是否被老师"实质讲解"'
      + '(给出含义解释/词源构词分析/搭配用法/例句/辨析)。只在语流里顺带出现、没被解释的算 mentioned。'
      + '只输出严格 JSON：{"taught":["清单中被实质讲解的项，原文照抄"]}';
    const r = await fetch(AI_CFG.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_CFG.key },
      body: JSON.stringify({ model: AI_CFG.model, messages: [
        { role: 'system', content: sys },
        { role: 'user', content: '【课堂逐字稿】\n' + scriptMd.slice(0, 20000) + '\n\n【语言点清单】\n' + batch.join('、') },
      ], max_tokens: 3000, temperature: 0.1, stream: false }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) throw new Error('AI 接口 ' + r.status);
    const j = await r.json();
    const arr = JSON.parse(j.choices[0].message.content.match(/\{[\s\S]*\}/)[0]).taught;
    for (const w of (arr || [])) taught.add(String(w).trim());
  }
  return { taught: [...taught] };
}

/* 生成后分级(r38): 对照逐字稿判定每道题 core/ext, 前端拆「课堂复习/扩展挑战」两个入口。
   判级失败不阻断出题——全部按 core 处理(宁缺毋滥的反面是宁可多给, 不丢题)。 */
async function gradeTiers(scriptMd, questions) {
  try {
    const list = questions.map(q => {
      const a = q.options[q.answer];
      const t = (a && typeof a === 'object') ? a.t : a;
      return q.id + '. ' + String(q.stem).slice(0, 70) + ' [答案词: ' + String(t).slice(0, 30) + ']';
    }).join('\n');
    const sys = '你是词汇课教研审读。给定课堂逐字稿和题目列表，判定每道题属于哪一层：'
      + 'core=答案词(或其词根/用法)老师在逐字稿里有实质讲解(给出含义/词源/搭配/例句/辨析)；'
      + 'ext=答案词只在词表/语流中顺带出现、老师未展开讲解，或题目考点超出课堂内容。'
      + '只输出严格 JSON：{"tiers":{"题目id":"core或ext",...}}，每题都要有判定，一个不落。';
    const r = await fetch(AI_CFG.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_CFG.key },
      body: JSON.stringify({ model: AI_CFG.model, messages: [
        { role: 'system', content: sys },
        { role: 'user', content: '【课堂逐字稿】\n' + scriptMd.slice(0, 20000) + '\n\n【题目列表】\n' + list },
      ], max_tokens: 3000, temperature: 0.1, stream: false }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json();
    const tiers = (JSON.parse(j.choices[0].message.content.match(/\{[\s\S]*\}/)[0]).tiers) || {};
    let n = 0;
    for (const q of questions) if (tiers[q.id] === 'ext') { q.tier = 'ext'; n++; }
    console.log('[gen-quiz] tiers core', questions.length - n, '/ ext', n);
  } catch (e) {
    console.error('[gen-quiz] tiers FAIL(全按 core)', e.message);
  }
}

/* 课后练(gen qid)的 AI 解析: 题面来自生成题组, 讲义相关页作上下文。 */
async function aiExplainGen(qidStr, course, mk, no, force) {
  if (!force) {
    if (AI_CACHE.has(qidStr)) return { text: AI_CACHE.get(qidStr), cached: true, q: (AI_STORE[qidStr] && AI_STORE[qidStr].q) || undefined };
    if (AI_STORE[qidStr]) {
      const hit = AI_STORE[qidStr];
      if (AI_CACHE.size >= AI_CACHE_MAX) AI_CACHE.delete(AI_CACHE.keys().next().value);
      AI_CACHE.set(qidStr, hit.text);
      return { text: hit.text, cached: true, q: hit.q };
    }
  }
  const lessonId = course + '-' + String(Number(mk)).padStart(2, '0');
  const quiz = GQ_STORE[lessonId];
  const q = quiz && quiz.questions.find(x => Number(String(x.id).slice(1)) === no);
  if (!q) throw new Error('question not found');
  const att = RECORDS.attempts && RECORDS.attempts[qidStr];
  const wrongs = att && Array.isArray(att.history)
    ? [...new Set(att.history.filter(h => h.ok === false).map(h => String(h.answer || '').slice(0, 80)))]
    : [];
  const mine = wrongs.join(' / ');
  let material = '';
  try {
    if ((quiz.pages || []).length) {   // v1 题组: 讲义相关页
      const f = findLesson(lessonId);
      const nid = f && (f.course.notes_ids || [])[0];
      if (nid) {
        const note = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'courses', 'notes', nid + '.json'), 'utf8'));
        material = (note.pages || []).filter(pg => quiz.pages.includes(pg.page))
          .map(pg => '[第' + pg.page + '页]\n' + pg.text).join('\n\n').slice(0, 3000);
      }
    } else {                          // v2 题组: 课堂逐字稿(老师讲的原话就是依据)
      const parts = lessonId.split('-');
      const sf = scriptFileFor(course, Number(parts[parts.length - 1]));
      if (sf) material = fs.readFileSync(path.join(sf.dir, sf.file), 'utf8')
        .replace(/^---[\s\S]*?---\n*/, '').trim().slice(0, 3000);
    }
  } catch (e) {}
  const sys = '你是托福词汇助教，用中文讲解这道课后练习题：先一句话点明考查点（词根/词缀/搭配），'
    + '再说正确答案为什么对（引用讲义依据）'
    + (mine ? '，最后指出学生当时的错选（' + mine + '）错在哪里。' : '。没有学生作答记录，不要编造或猜测学生的选择。')
    + '不超过 160 字，2-3 小段纯文本，不要客套话。';
  const lines = [];
  if (material) lines.push('[讲义相关页]\n' + material);
  lines.push('[题干] ' + q.stem);
  lines.push('[选项]\n' + Object.entries(q.options).map(([k, v]) => k + '. ' + v).join('\n'));
  lines.push('[正确答案] ' + q.answer);
  if (mine) lines.push('[学生当时的错误答案] ' + mine);
  lines.push('[出题时的解析参考] ' + q.explain);
  const r = await fetch(AI_CFG.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_CFG.key },
    body: JSON.stringify({ model: AI_CFG.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: lines.join('\n\n') }],
      max_tokens: 400, temperature: 0.2, stream: false }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('AI 接口 ' + r.status + (t ? ': ' + t.slice(0, 120) : ''));
  }
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI 未返回内容');
  const qPub = { stem: q.stem, options: q.options, answer: q.answer, mine, passage: material };
  AI_STORE[qidStr] = { text, q: qPub, at: Date.now(), v: AI_V };
  aiStoreSave();
  if (AI_CACHE.size >= AI_CACHE_MAX) AI_CACHE.delete(AI_CACHE.keys().next().value);
  AI_CACHE.set(qidStr, text);
  return { text, cached: false, q: qPub };
}

/* ---------- 题库目录（启动时缓存） ---------- */
function fillCount(g) {
  const text=String(g.passage||'').replace(/▢/g,'_').replace(/([A-Za-z'’\-])(_+)/g,(m,c,u)=>c+' '+u.split('').join(' '));
  return [...text.matchAll(/([A-Za-z'’\-]*)((?:\s+_)+)/g)].length;
}
function moduleKey(sub,m,index) {return String(m.module)+(sub.modules.filter(x=>x.module===m.module).length>1?'p'+(m.part||index+1):'');}
function subjectStats(sub) {
  // 与 audit.py 同口径：听力/阅读按题计，写/说按任务内条目计
  const out = { q: 0, audio: 0 };
  if(sub.blocked_reason) return {...out,blocked_reason:sub.blocked_reason};
  const mods = sub.modules || [];
  for (const m of mods) for (const g of m.groups || []) {
    if(g.kind==='fill_in_blank') out.q += fillCount(g);
    else for (const q of g.questions || []) { out.q++; if (q.audio) out.audio++; }
  }
  for (const t of sub.tasks || []) {
    const items = t.items || t.sentences || [];
    out.q += items.length || ((t.prompt_lines?.length || t.body?.length) ? 1 : 0);
    for (const it of items) if (it.audio) out.audio++;
  }
  return out;
}
const TASK_KEYS = {sentence_construction:'sentence',academic_discussion:'discussion',TASK1:'s1',TASK2:'s2'};
function taskKey(sub,t,index) {
  const raw=t.type||t.task||'task';const key=TASK_KEYS[raw]||String(raw).toLowerCase();
  const same=sub.tasks.filter(x=>(x.type||x.task||'task')===raw);
  return key+(same.length>1?'p'+(same.indexOf(t)+1):'');
}
function buildCatalog() {
  const list = [];
  let audit = null;
  try { audit = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'audit.json'), 'utf8')); } catch (e) {}
  const grades = {};
  if (audit) for (const s of audit.sets || []) grades[s.set_id] = s;
  let dirs;
  try { dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true }); } catch (e) { dirs = []; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const jp = path.join(DATA_DIR, d.name, d.name + '.json');
    if (!fs.existsSync(jp)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
      const subjects = {};
      let total = 0, audio = 0, ans = 0;
      for (const [name, sub] of Object.entries(j.subjects || {})) {
        const st = subjectStats(sub);
        // 题组概要（题组列表/每题数）—— 专项训练页据此即时切换，
        // 不必为切个科目拉全部套题 JSON。qid 可由 (set,subj,mk,type,no) 构造。
        const outline = {modules: [], tasks: []};
        for (const [mi,m] of (sub.blocked_reason?[]:(sub.modules || [])).entries()) {
          outline.modules.push({
            m: moduleKey(sub,m,mi),
            groups: (m.groups || []).map(g => ({
              key: String(g.q_range || ''),
              kind: g.kind || '', title: g.title || '',
              missing_audio:name==='listening'&&(g.questions||[]).some(q=>!q.audio&&!g.audio),
              type: g.kind === 'fill_in_blank' ? 'fill' : 'mc',
              n: g.kind === 'fill_in_blank'
                ? fillCount(g)
                : (g.questions || []).length,
            })).filter(g => g.n > 0),
          });
        }
        for (const t of (sub.blocked_reason?[]:sub.tasks || [])) {
          const items = t.items || t.sentences || [];
          // email/学术讨论的题面在任务级 prompt_lines/body —— 算一个任务级条目
          const n = items.length ||
            ((t.prompt_lines && t.prompt_lines.length) || (t.body && t.body.length) ? 1 : 0);
          if (n) outline.tasks.push({
            key: taskKey(sub,t), title: t.title || (t.task==='TASK1'?'Listen and Repeat':t.task==='TASK2'?'Take an Interview':''), n,
            missing_audio:name==='speaking'&&items.some(it=>!it.audio),
            whole_audio:items.some(it=>it.audio_module_level), material_note:t.material_note||'',
          });
        }
        st.outline = outline;
        subjects[name] = st;
        total += st.q; audio += st.audio;
      }
      for (const arr of Object.values(j.answers || {}))
        for (const m of Object.values(arr)) ans += m.length;
      const g = grades[d.name] || {};
      list.push({
        id: d.name, total_q: total, audio_refs: audio, answers: ans,
        subjects, grade: Object.values(subjects).some(s=>s.blocked_reason)?'C':(g.grade || null),
        audio_links: g.audio_links ?? null,
      });
    } catch (e) {
      console.warn('[server] 套题读取失败:', d.name, e.message);
    }
  }
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
}
const CATALOG = buildCatalog();
const SET_INDEX = Object.fromEntries(CATALOG.map(s => [s.id, s]));

/* ---------- 课程目录（scan_courses.py 产物） ---------- */
let COURSES = null;
/* 视频时长: 管线在 catalog 里留了 duration_sec 槽位但为 null（源只读、无 ffprobe 依赖），
   这里零依赖解析 mp4/mov 容器的 moov→mvhd（vince mp4 与新D方 mov 同为 ISO-BMFF 家族）。 */
const DUR_MEMO = new Map();
function videoAbsFromUrl(u) {
  const s = String(u || '');
  const dec = x => { try { return decodeURIComponent(x); } catch { return x; } };
  let m = s.match(/^\/media\/vince\/(.+)$/);
  if (m) return path.join(SIB, 'vince托福课', dec(m[1]));
  m = s.match(/^\/media\/ndf\/([^/]+)\/(.+)$/);
  if (m) return path.join(SIB, '新D方', '新D方新托福全套', dec(m[1]), dec(m[2]));
  return null;
}
function mvhdSeconds(buf) {
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > buf.length) return null;
      size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16;
    }
    if (size < hdr) return null;
    if (type === 'mvhd') {
      const b = off + hdr, ver = buf[b];
      if (ver === 1 && b + 28 <= buf.length) {
        const ts = buf.readUInt32BE(b + 20);
        return ts ? Number(buf.readBigUInt64BE(b + 24)) / ts : null;
      }
      if (b + 20 <= buf.length) {
        const ts = buf.readUInt32BE(b + 12);
        return ts ? buf.readUInt32BE(b + 16) / ts : null;
      }
      return null;
    }
    off += size;
  }
  return null;
}
function videoDurationSec(fp) {
  if (DUR_MEMO.has(fp)) return DUR_MEMO.get(fp);
  let sec = null, fd = null;
  try {
    fd = fs.openSync(fp, 'r');
    const size = fs.fstatSync(fd).size;
    let off = 0;
    for (let guard = 0; guard < 64; guard++) {          // 顶层 box 链: ftyp/free/mdat(跳过)/moov
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, off) < 8) break;
      let bsize = head.readUInt32BE(0);
      const btype = head.toString('latin1', 4, 8);
      let bhdr = 8;
      if (bsize === 1) { bsize = Number(head.readBigUInt64BE(8)); bhdr = 16; }
      else if (bsize === 0) bsize = size - off;         // 0 = 延伸到文件尾
      if (bsize < bhdr) break;
      if (btype === 'moov') {                            // mvhd 是 moov 首子盒; 读盒体(跳过自身 8/16 字节头)
        const len = Math.min(bsize - bhdr, 64 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off + bhdr);
        sec = mvhdSeconds(buf);
        break;
      }
      off += bsize;
    }
  } catch { /* 读不出保持 null, 前端如实显示 — */ }
  finally { if (fd != null) { try { fs.closeSync(fd); } catch {} } }
  DUR_MEMO.set(fp, sec);
  return sec;
}
function loadCourses() {
  if (COURSES) return COURSES;
  try {
    COURSES = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'courses', 'catalog.json'), 'utf8'));
  } catch (e) {
    COURSES = { series: [], note: '课程目录尚未生成：先跑 pipeline/scan_courses.py' };
  }
  if (COURSES && COURSES.series) {
    for (const s of COURSES.series) for (const c of s.courses || []) for (const l of c.lessons || []) {
      if (l.duration_sec == null) {
        const sec = videoDurationSec(videoAbsFromUrl(l.video));
        if (Number.isFinite(sec) && sec > 0) l.duration_sec = Math.round(sec);
      }
    }
  }
  return COURSES;
}

/* 词根家族聚合(跨课): 生成题组的 families + tags → 家族卡片与题池。
   同一题可挂多个家族(tags 多值)。MVP 数据量小, 题面直接随端点下发。 */
function familiesAggregate() {
  const map = new Map();
  const ensure = (key, name, kind, gloss) => {
    let e = map.get(key);
    if (!e) { e = { key, name, kind: kind || 'root', gloss: gloss || '', words: [], items: [] }; map.set(key, e); }
    return e;
  };
  for (const qz of Object.values(GQ_STORE)) {
    if (!qz || qz.v !== AI_QV) continue;
    const badSet = new Set(qz.bad || []);
    const liveQs = (qz.questions || []).filter(q => !badSet.has(q.id));
    for (const fam of (qz.families || [])) {
      if (!fam || !fam.name) continue;
      const e = ensure(qz.course + '|' + fam.name, fam.name, fam.kind, fam.gloss);
      if (!e.gloss && fam.gloss) e.gloss = fam.gloss;
      for (const w of (fam.words || [])) if (!e.words.includes(w)) e.words.push(w);
    }
    for (const q of liveQs) {
      const sk = q.stem.toLowerCase().replace(/____+/g, ' ').replace(/[\s「」“”"'（）()。.,，?？!！:：;；]/g, '');
      for (const tag of (q.tags || [])) {
        const e = ensure(qz.course + '|' + tag, tag, 'root', '');
        if (e.items.some(x => (x.stem || '').toLowerCase().replace(/____+/g, ' ').replace(/[\s「」“”"'（）()。.,，?？!！:：;；]/g, '') === sk)) continue;   // 家族聚合跨课去重(同题干多课重复不再翻倍)
        e.items.push({ qid: 'gen/' + qz.course + '/' + qz.lessonNo + '/quiz/' + Number(String(q.id).slice(1)),
          stem: q.stem, options: q.options, answer: q.answer, explain: q.explain, tags: q.tags,
          course: qz.course, lessonNo: qz.lessonNo });
      }
    }
  }
  return [...map.values()];
}

/* ---------- 学习记录（records/records.json，服务端唯一真源） ---------- */
const RECORDS_FILE = path.join(RECORDS_DIR, 'records.json');
let RECORDS = { version: 1, attempts: {}, course: {}, study: {}, qtimes: {}, mistakes: {}, families: {}, feedback: [], saved_at: null };
function recordsLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
    if(!j || typeof j!=='object' || Array.isArray(j)) throw new Error('invalid records schema');
    RECORDS = { ...RECORDS, ...j };
    for(const [qid,a] of Object.entries(RECORDS.attempts || {})) {
      if(['writing','speaking'].includes(qid.split('/')[1])) {
        a.st='submitted';a.right=0;
        for(const h of a.history || []) h.ok=null;
      }
    }
    RECORDS.drafts=RECORDS.drafts||{};
  } catch (e) { if (e.code !== 'ENOENT') throw new Error('学习记录无法读取；为防止覆盖已停止启动: ' + e.message); }
}
// Persist before acknowledging: a failed disk write must not become a successful save.
function recordsSave(next) {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  const tmp = RECORDS_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (fs.existsSync(RECORDS_FILE)) fs.copyFileSync(RECORDS_FILE, RECORDS_FILE + '.bak');
  fs.renameSync(tmp, RECORDS_FILE);
}
/* 单题作答状态机(r56, 唯一真源): 客户端 recAttempt 的服务端版本, 语义逐行对齐;
   writing/speaking 不判 ok(与 recordsLoad 的归零语义一致)。delete 变体供重置本组。 */
function serverRecAttempt(store, ref, inc) {
  const k = ref.qid;
  if (inc.delete) { delete store.attempts[k]; delete store.qtimes[k]; delete store.mistakes[k]; delete store.writing[k]; return null; }
  const ok = (ref.subj === 'writing' || ref.subj === 'speaking') ? null : (inc.ok === null || inc.ok === undefined ? null : !!inc.ok);
  const a = store.attempts[k] = store.attempts[k] || { st: 'doing', n: 0, right: 0, history: [] };
  a.n++; a.last = Date.now(); a.last_answer = inc.answer;
  a.history.push({ t: Date.now(), answer: inc.answer, ok: ok, secs: Math.round(inc.secs || 0) });
  if (ok === true) { a.right++; a.st = 'done'; }
  else if (ok === false) a.st = 'wrong';
  else a.st = 'submitted';
  store.qtimes[k] = (store.qtimes[k] || 0) + Math.round(inc.secs || 0);
  const m = store.mistakes[k];
  if (ok === false) {
    store.mistakes[k] = (m && !m.cleared)
      ? { ...m, n_wrong: (m.n_wrong || 0) + 1, stage: 0, due: Date.now() + 864e5, last: Date.now(), set: ref.set, subj: ref.subj, mk: ref.mk, gkey: ref.gkey }
      : { n_wrong: 1, stage: 0, added: Date.now(), due: Date.now() + 864e5, last: Date.now(), set: ref.set, subj: ref.subj, mk: ref.mk, gkey: ref.gkey };
  } else if (ok === true && m && !m.cleared && Date.now() >= (m.due || 0)) {
    const next = [3, 7, 14][m.stage] || 14;
    m.stage = (m.stage || 0) + 1;
    if (m.stage >= 4) m.cleared = true;
    else m.due = Date.now() + next * 864e5;
    m.last = Date.now();
  }
  return a;
}
function nextRecords(incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('invalid records');
  const next = {...RECORDS};
  for (const k of ['attempts', 'qtimes', 'mistakes', 'families', 'course', 'study', 'writing', 'drafts']) {
    if (k === 'drafts' && !incoming[k]) {next[k]={};continue;}
    if (k === 'families' && !incoming[k]) {next[k]={};continue;}   // r16 前的旧标签页没有 families, 兼容而非报错
    if (!incoming[k] || typeof incoming[k] !== 'object' || Array.isArray(incoming[k])) throw new Error('invalid ' + k);
    // attempts/qtimes/mistakes(r56): 键级并集(incoming 优先)——作答已走 /api/records/attempt
    // 增量通道, 旧标签页的全量快照不得抹掉其它端增量写入的键。
    if (k === 'attempts' || k === 'qtimes' || k === 'mistakes') { next[k] = { ...(RECORDS[k] || {}), ...(incoming[k] || {}) }; continue; }
    next[k] = incoming[k];
  }
  if (!Array.isArray(incoming.feedback)) throw new Error('invalid feedback');
  next.feedback = incoming.feedback;
  next.revision = (RECORDS.revision || 0) + 1;
  next.saved_at = new Date().toISOString();
  return next;
}
recordsLoad();

/* ---------- HTTP 基础 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// 媒体文件：支持 Range（音频 seek / 视频拖动必需）
function sendFile(req, res, absPath) {
  let st;
  try { st = fs.statSync(absPath); } catch (e) { return sendJSON(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return sendJSON(res, 404, { error: 'not found' });
  const type = MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start, end;
    if (m && m[1]) { start = Number(m[1]); end = m[2] ? Number(m[2]) : st.size - 1; }
    else if (m && m[2]) { const tail = Number(m[2]); start = Math.max(0, st.size - tail); end = st.size - 1; }
    if (!m || (!m[1] && !m[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || start >= st.size || end < start) {
      res.writeHead(416, {...common, 'Content-Range': `bytes */${st.size}`}); return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...common, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    const stream = fs.createReadStream(absPath, { start, end });
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  } else {
    res.writeHead(200, { ...common, 'Content-Length': st.size });
    const stream = fs.createReadStream(absPath); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  }
}
// 只允许白名单扩展名出媒体路由
const MEDIA_EXT = new Set(['.mp3', '.m4a', '.wav', '.mp4', '.mov', '.webm', '.pdf', '.pptx', '.jpg', '.png']);

/* ---------- 路由 ---------- */
const VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); }
  catch (e) { return 'dev'; }
})();

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = decodeURIComponent(url.pathname);

    /* ---- API: 目录 ---- */
    if (p === '/api/health') return sendJSON(res, 200, { ok: true, version: VERSION });
    if (p === '/api/catalog') return sendJSON(res, 200, { sets: CATALOG, source_root_configured: SET_DIRS && Object.keys(SET_DIRS).length > 0 });
    const mSet = p.match(/^\/api\/set\/(.+)$/);
    if (mSet) {
      const id = mSet[1];
      if (!Object.hasOwn(SET_INDEX,id)) return sendJSON(res, 400, { error: 'bad set id' });
      const jp = path.join(DATA_DIR, id, id + '.json');
      try { return sendJSON(res, 200, JSON.parse(fs.readFileSync(jp, 'utf8'))); }
      catch (e) { return sendJSON(res, 404, { error: 'set not found' }); }
    }
    if (p === '/api/courses') return sendJSON(res, 200, loadCourses());
    const mHand = p.match(/^\/api\/handout\/(.+)$/);
    if (mHand) {
      const notesDir = path.join(BUILD_DIR, 'courses', 'notes');
      const id = mHand[1];
      if (!/^[\w.\-]+$/.test(id) || id.includes('..')) return sendJSON(res, 400, { error: 'bad id' });
      try {
        return sendJSON(res, 200, JSON.parse(fs.readFileSync(path.join(notesDir, id + '.json'), 'utf8')));
      } catch (e) { return sendJSON(res, 404, { error: 'handout not extracted' }); }
    }

    /* ---- API: 学习记录 ---- */
    if (p === '/api/records') {
      if (req.method === 'GET') return sendJSON(res, 200, RECORDS);
      if (req.method === 'POST') {
        const origin=req.headers.origin;
        if(origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return sendJSON(res,403,{error:'cross-origin write rejected'});
        if(!(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) return sendJSON(res,415,{error:'application/json required'});
        const body = await readBody(req);
        let inc; try { inc = JSON.parse(body.toString('utf8') || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
        if (inc?.revision !== (RECORDS.revision || 0)) return sendJSON(res, 409, {error:'records conflict', revision:RECORDS.revision || 0});
        let next;
        try { next = nextRecords(inc); } catch (e) { return sendJSON(res, 400, {error:e.message}); }
        try { recordsSave(next); } catch (e) { console.error('[records]',e.message); return sendJSON(res, 503, {error:'records not persisted'}); }
        RECORDS = next;
        return sendJSON(res, 200, { ok: true, revision:RECORDS.revision, saved_at: RECORDS.saved_at });
      }
      return sendJSON(res, 405, { error: 'method' });
    }

    /* ---- API: 单题作答增量上送(r56, 服务端=唯一真源) ----
       客户端每题判分即 POST 本端点; 服务端执行唯一一份状态机(n/history/st/right/last/
       qtimes/mistakes 1-3-7-14 调度), 立即落盘。无 revision 检查: 单条 append 语义,
       多端并发天然可合并, 浏览器崩溃/关页不再丢作答。delete:true = 重置本组的单题删除。 */
    if (p === '/api/records/attempt') {
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return sendJSON(res, 403, { error: 'cross-origin write rejected' });
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJSON(res, 415, { error: 'application/json required' });
      const body = await readBody(req);
      let inc; try { inc = JSON.parse(body.toString('utf8') || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
      const ref = inc.ref || {};
      if (!ref.qid || typeof ref.qid !== 'string' || !/^[\w.\-/]{1,120}$/.test(ref.qid)) return sendJSON(res, 400, { error: 'qid required' });
      let a;
      try { a = serverRecAttempt(RECORDS, ref, inc); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      RECORDS.saved_at = new Date().toISOString();
      try { recordsSave(RECORDS); } catch (e) { console.error('[attempt]', e.message); return sendJSON(res, 503, { error: 'records not persisted' }); }
      return sendJSON(res, 200, { ok: true, attempt: a, revision: RECORDS.revision, saved_at: RECORDS.saved_at });
    }

    /* ---- API: AI 助教错题解析 ---- */
    if (p === '/api/ai/explain') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return sendJSON(res, 403, { error: 'cross-origin rejected' });
      if (req.method === 'GET') return sendJSON(res, 200, {
        ok: true,
        qids: Object.keys(AI_STORE),
        legacy: Object.keys(AI_STORE).filter(q => !AI_STORE[q].v),   // 旧版本生成的解析（升级后可重生成）
      });
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method' });
      if (!AI_CFG.key) return sendJSON(res, 503, { error: 'AI 未配置（服务端缺少 TFL_AI_KEY）' });
      const body = await readBody(req);
      let inc; try { inc = JSON.parse(body.toString('utf8') || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
      try {
        const out = await aiExplain(inc.qid, !!inc.force);
        return sendJSON(res, 200, { ok: true, ...out });
      } catch (e) {
        const code = /^bad qid|not found/.test(e.message) ? 400 : 502;
        return sendJSON(res, code, { error: e.message });
      }
    }

    /* ---- 课稿(逐字稿校对版 md) ---- */
    const mScript = p.match(/^\/api\/lesson-script\/([\w.-]+)$/);
    if (mScript) {
      const lessonId = mScript[1];
      const parts = lessonId.split('-');
      const no = Number(parts[parts.length - 1]);
      const course = parts.slice(0, -1).join('-');
      const sf = scriptFileFor(course, no);
      if (!sf) return sendJSON(res, 404, { error: '该节暂无课稿' });
      try {
        let md = fs.readFileSync(path.join(sf.dir, sf.file), 'utf8').replace(/^---[\s\S]*?---\n*/, '').trim();
        let inv = null;
        const stem = course + '-' + String(no).padStart(2, '0');
        try { inv = JSON.parse(fs.readFileSync(path.join(sf.dir, stem + '.words.json'), 'utf8')); } catch (e) {}
        return sendJSON(res, 200, { ok: true, title: sf.file.replace(/\.md$/i, ''), md, inv });
      } catch (e) { return sendJSON(res, 500, { error: '课稿读取失败' }); }
    }

    /* ---- 课后练坏题标记(用户反馈, 从练习中隐藏) ---- */
    if (p === '/api/ai/quiz-bad') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return sendJSON(res, 403, { error: 'cross-origin rejected' });
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method' });
      const body = await readBody(req);
      let inc; try { inc = JSON.parse(body.toString('utf8') || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
      const qz = GQ_STORE[String(inc.lessonId || '')];
      if (!qz) return sendJSON(res, 404, { error: 'quiz not found' });
      const qid = String(inc.qid || '');
      if (!/^q\d+$/.test(qid)) return sendJSON(res, 400, { error: 'bad qid' });
      if (!qz.bad.includes(qid)) { qz.bad.push(qid); gqSave(); }
      return sendJSON(res, 200, { ok: true, bad: qz.bad });
    }

    /* ---- 词根家族聚合(课后练的长期复习) ---- */
    if (p === '/api/ai/families') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return sendJSON(res, 403, { error: 'cross-origin rejected' });
      if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method' });
      return sendJSON(res, 200, { ok: true, families: familiesAggregate() });
    }

    /* ---- AI 课后练（视频课按教材生成的题组） ---- */
    if (p === '/api/ai/quiz') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return sendJSON(res, 403, { error: 'cross-origin rejected' });
      if (req.method === 'GET') return sendJSON(res, 200, {
        ok: true,
        lessons: Object.keys(GQ_STORE).filter(k => GQ_STORE[k] && GQ_STORE[k].v === AI_QV),
        v: AI_QV,
        revisions: Object.fromEntries(Object.values(GQ_STORE).flatMap(qz => (qz.questions || []).filter(q => q.revisionAt).map(q => ['gen/' + qz.course + '/' + qz.lessonNo + '/quiz/' + Number(String(q.id).slice(1)), q.revisionAt]))),
      });
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method' });
      if (!AI_CFG.key) return sendJSON(res, 503, { error: 'AI 未配置（服务端缺少 TFL_AI_KEY）' });
      const body = await readBody(req);
      let inc; try { inc = JSON.parse(body.toString('utf8') || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
      const t0 = Date.now();
      try {
        const out = await genQuiz(String(inc.lessonId || ''), !!inc.force);
        console.log('[quiz]', inc.lessonId, out.cached ? 'cached' : 'fresh', out.quiz.questions.length + 'q', (Date.now() - t0) + 'ms');
        return sendJSON(res, 200, { ok: true, ...out });
      } catch (e) {
        console.error('[quiz]', inc.lessonId, 'FAIL', (Date.now() - t0) + 'ms', e.message);
        const code = /暂停新题生成/.test(e.message) ? 409 : /bad lessonId|not found|未开通|无文字|读取失败|溯源校验/.test(e.message) ? 400 : 502;
        return sendJSON(res, code, { error: e.message });
      }
    }

    /* ---- 媒体: 真题素材（按套题映射回源目录） ---- */
    const mMedia = p.match(/^\/media\/set\/([^/]+)\/(.+)$/);
    if (mMedia) {
      const setId = mMedia[1], rel = mMedia[2];
      const dir = SET_DIRS[setId];
      if (!dir) return sendJSON(res, 404, { error: 'set source dir not configured' });
      const abs = path.normalize(path.join(dir, rel));
      if (!abs.startsWith(path.normalize(dir) + path.sep) && abs !== path.normalize(dir))
        return sendJSON(res, 400, { error: 'bad path' });
      if (!MEDIA_EXT.has(path.extname(abs).toLowerCase())) return sendJSON(res, 403, { error: 'ext not allowed' });
      return sendFile(req, res, abs);
    }
    /* ---- 媒体: vince 课 ---- */
    const mVince = p.match(/^\/media\/vince\/(.+)$/);
    if (mVince) {
      const dir = path.resolve(SIB, 'vince托福课');
      const abs = path.normalize(path.join(dir, mVince[1]));
      if (!abs.startsWith(path.normalize(dir) + path.sep)) return sendJSON(res, 400, { error: 'bad path' });
      if (!MEDIA_EXT.has(path.extname(abs).toLowerCase())) return sendJSON(res, 403, { error: 'ext not allowed' });
      return sendFile(req, res, abs);
    }
    /* ---- 媒体: 新D方课 ---- */
    const mNdf = p.match(/^\/media\/ndf\/([^/]+)\/(.+)$/);
    if (mNdf) {
      const base = path.resolve(SIB, '新D方', '新D方新托福全套');
      const dir = path.normalize(path.join(base, mNdf[1]));
      if (!dir.startsWith(path.normalize(base) + path.sep)) return sendJSON(res, 400, { error: 'bad course dir' });
      const abs = path.normalize(path.join(dir, mNdf[2]));
      if (!abs.startsWith(dir + path.sep)) return sendJSON(res, 400, { error: 'bad path' });
      if (!MEDIA_EXT.has(path.extname(abs).toLowerCase())) return sendJSON(res, 403, { error: 'ext not allowed' });
      return sendFile(req, res, abs);
    }

    /* ---- 媒体: 课程讲义页图（scan_courses.py 从图片版 PPTX 抽出的截图帧） ---- */
    const mSlides = p.match(/^\/media\/slides\/([\w.\-]+)\/([\w.\-]+)$/);
    if (mSlides) {
      const dir = path.join(BUILD_DIR, 'courses', 'slide_images', mSlides[1]);
      const abs = path.normalize(path.join(dir, mSlides[2]));
      if (!abs.startsWith(path.normalize(dir) + path.sep)) return sendJSON(res, 400, { error: 'bad path' });
      if (!/\.(jpg|jpeg|png)$/i.test(abs)) return sendJSON(res, 403, { error: 'ext not allowed' });
      return sendFile(req, res, abs);
    }

    /* ---- 静态页 ---- */
    let rel = p === '/' ? '/index.html' : p;
    const abs = path.normalize(path.join(WEB_DIR, rel));
    if (!abs.startsWith(path.normalize(WEB_DIR) + path.sep) && abs !== path.normalize(path.join(WEB_DIR, 'index.html')))
      return sendJSON(res, 400, { error: 'bad path' });
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return sendFile(req, res, abs);
    sendJSON(res, 404, { error: 'not found', path: p });
  } catch (e) {
    console.error('[server]', e);
    try { sendJSON(res, 500, { error: 'internal' }); } catch (_) {}
  }
};

// TLS（自签）：TFL_TLS_KEY/TFL_TLS_CERT 指向 pem 文件时走 https——
// 局域网明文 http 下浏览器禁用麦克风，后续口语录音（MediaRecorder）必须 secure context。
// 证书缺失/读失败回退 http，不让部署被证书问题卡死。
let tlsOpt = null;
if (process.env.TFL_TLS_KEY && process.env.TFL_TLS_CERT) {
  try {
    tlsOpt = {
      key: fs.readFileSync(process.env.TFL_TLS_KEY),
      cert: fs.readFileSync(process.env.TFL_TLS_CERT),
    };
  } catch (e) {
    console.warn('[server] TLS 证书读取失败，回退 http:', e.message);
    tlsOpt = null;
  }
}
const httpServer = tlsOpt ? https.createServer(tlsOpt, handler) : http.createServer(handler);
httpServer.listen(PORT, () => {
  console.log(`[toefl-lab] ${tlsOpt ? 'https' : 'http'}://localhost:${PORT}  (v${VERSION})`);
  console.log(`  web:      ${WEB_DIR}`);
  console.log(`  data:     ${DATA_DIR} (${CATALOG.length} 套)`);
  console.log(`  records:  ${RECORDS_FILE}`);
  console.log(`  source:   ${SOURCE_ROOT} (${Object.keys(SET_DIRS).length} 套已映射, 只读)`);
});
