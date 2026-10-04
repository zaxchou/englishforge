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
const AI_V = 2;
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
  };
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
function loadCourses() {
  if (COURSES) return COURSES;
  try {
    COURSES = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'courses', 'catalog.json'), 'utf8'));
  } catch (e) {
    COURSES = { series: [], note: '课程目录尚未生成：先跑 pipeline/scan_courses.py' };
  }
  return COURSES;
}

/* ---------- 学习记录（records/records.json，服务端唯一真源） ---------- */
const RECORDS_FILE = path.join(RECORDS_DIR, 'records.json');
let RECORDS = { version: 1, attempts: {}, course: {}, study: {}, qtimes: {}, mistakes: {}, feedback: [], saved_at: null };
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
function nextRecords(incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('invalid records');
  const next = {...RECORDS};
  for (const k of ['attempts', 'qtimes', 'mistakes', 'course', 'study', 'writing', 'drafts']) {
    if (k === 'drafts' && !incoming[k]) {next[k]={};continue;}
    if (!incoming[k] || typeof incoming[k] !== 'object' || Array.isArray(incoming[k])) throw new Error('invalid ' + k);
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
