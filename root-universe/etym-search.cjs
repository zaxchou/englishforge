#!/usr/bin/env node
/* 词源多来源搜索/抓取管线(2026-11-13 用户拍板"现在就可以做"):
   用 DeepSeek 联网搜索 + 网页抓取(¥5/千次)按词抓取多来源词源证据,
   产出 build/qa/root-etym/<word>/ 下的 capture(原文快照+SHA256+许可标注)与
   machine-candidate(模型整理的结构化候选词源, 状态=machine-candidate, 不算已核验)。
   纪律沿用词根宇宙: 机器产物只是证据与候选, 进正式包仍需人工整理+独立复核签 review。
   用法:
     node pipeline/root-universe/etym-search.cjs --words predict,port,ject
     node pipeline/root-universe/etym-search.cjs --alliance-dict        # dict 联盟全部词
     选项: --sources 3(每词抓取页数) --limit N(本次最多词数) --force(重跑已有词)
           --max-calls 60(本次 API 调用上限, 超=停止并汇总) */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'qa', 'root-etym');
const COST = { search: 0.005, fetch: 0.005 };   // ¥5/千次(限时刊例同价, 官方定价页)
const DAILY_CALL_LIMIT = 100;   // 每天最多 100 次工具调用(≈¥0.5), 防失控

function envKey(name, file) {
  const env = process.env[name];
  if (env) return env;
  try {
    const text = fs.readFileSync(path.join(ROOT, file || '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*)\\s*$'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {}
  return '';
}
function apiKey() { return process.env.TFL_AI_KEY || envKey('TFL_AI_KEY') || ''; }
function aiBase() { return (process.env.TFL_AI_BASE_URL || envKey('TFL_AI_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, ''); }
function aiModel() { return process.env.TFL_AI_MODEL || envKey('TFL_AI_MODEL') || 'deepseek-chat'; }

/* 来源站分级: 优先权威词源站; 牛津(oed.com)按语料许可边界硬禁止;
   wiktionary 是 CC BY-SA; 其余抓取只作核验证据, 许可按 unknown-verify-only 标注。 */
const PREFERRED = ['etymonline.com', 'en.wiktionary.org', 'merriam-webster.com', 'britannica.com', 'etymologeek.com', 'BehindTheName.com'];
const BLOCKED = ['oed.com'];
const LICENSE_NOTES = {
  'en.wiktionary.org': 'CC BY-SA(署名转载需注明)',
  'etymonline.com': '© Douglas Harper(仅核验引用, 不得原文进产品)',
  'merriam-webster.com': '© Merriam-Webster(仅核验引用)',
  'britannica.com': '© Encyclopædia Britannica(仅核验引用)',
};

function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
/* 搜索结果常带锚点尾巴(#1/#:~:text=…)与搜索页/PDF, DeepSeek 抓取器对它们一律 404/拿不到正文(实测
   spect/visible): 统一剥锚点, 并把搜索页与 PDF 从候选里剔除, 别浪费抓取预算。 */
function normalizeUrl(url) { try { const u = new URL(url); u.hash = ''; return u.toString(); } catch { return url; } }
function isUnfetchable(url) { return /\/search\?|[?&]q=|\.pdf($|[?#])/i.test(url); }
function licenseOf(url) { return LICENSE_NOTES[domainOf(url)] || 'unknown-verify-only'; }
/* 从搜索结果挑选抓取对象: 域名去重、屏蔽牛津、剥锚点、权威分+优先站加分。供测试直接调用。 */
function pickSources(results, n) {
  const seen = new Set(), picked = [];
  for (const r of results.slice().sort((a, b) => (b.rerank_score - a.rerank_score) || ((b.authority || 0) - (a.authority || 0)))) {
    const raw = (r.url || '').trim();
    const dom = domainOf(raw);
    if (!dom || seen.has(dom) || BLOCKED.some(b => dom === b || dom.endsWith('.' + b))) continue;
    const url = normalizeUrl(raw);
    if (isUnfetchable(url)) continue;
    const score = (r.rerank_score || 0) + (r.authority >= 3 ? 1 : 0) + (PREFERRED.some(p => dom === p || dom.endsWith('.' + p)) ? 0.5 : 0);
    seen.add(dom); picked.push({ url, dom, score, title: r.title || '', snippet: r.snippet || '', summary: r.summary || '', authority: r.authority ?? -1 });
  }
  return picked.sort((a, b) => b.score - a.score).slice(0, n);
}
async function toolApi(kind, payload, state) {
  if (state.calls >= state.maxCalls) throw new Error('CALL_BUDGET_EXHAUSTED');
  state.calls++;
  const r = await fetch('https://api.deepseek.com/v1/tools/' + kind, {
    method: 'POST', headers: { Authorization: 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('tools/' + kind + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function chatExtract(word, pages, state) {
  if (state.calls >= state.maxCalls) throw new Error('CALL_BUDGET_EXHAUSTED');
  state.calls++;
  const body = [
    '下面是关于英文词「' + word + '」词源的 ' + pages.length + ' 个网页快照。只依据这些页面内容, 整理成 JSON(不要编造):',
    JSON.stringify({
      word, root_candidates: [{ root: '词根/语源成分', meaning: '含义', language: '拉丁/希腊/古英语…' }],
      chain: [{ stage: '原始印欧语/拉丁语/中古英语…', text: '该阶段的形态与含义' }],
      earliest_english_sense: '英语里最早记录的义项', sense_shift: ['义项如何演变'],
      disagreements: ['来源间不一致处, 没有则空数组'], sources: [{ url: '支撑该结论的页面 URL', claim: '该页说了什么' }],
      confidence: 'high|medium|low',
    }, null, 0).slice(0, 200),
    '要求: 每条结论都在 sources 里给出对应 URL; 来源冲突写进 disagreements; 页面没讲的字段填 null; 只输出 JSON。',
    ...pages.map((p, i) => '【页面' + (i + 1) + '】' + p.url + '\n' + p.content.slice(0, 8000)),
  ].join('\n\n');
  const r = await fetch(aiBase() + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: aiModel(), messages: [{ role: 'user', content: body }], stream: false, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error('chat -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const text = (await r.json()).choices?.[0]?.message?.content || '';
  try { return { ok: true, candidate: JSON.parse(text) }; }
  catch { return { ok: false, raw: text.slice(0, 4000) }; }
}
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function writeCapture(word, i, cap, outDir) {
  const dir = path.join(outDir || OUT_DIR, word);
  fs.mkdirSync(dir, { recursive: true });
  const file = String(i + 1).padStart(2, '0') + '-' + (cap.dom || 'page').replace(/[^\w.-]/g, '_') + '.md';
  const head = ['<!-- capture: ' + word, 'url: ' + cap.url, 'title: ' + (cap.title || ''), 'fetched_at: ' + new Date().toISOString(),
    'sha256: ' + cap.sha256, 'license: ' + licenseOf(cap.url), '-->', ''].join('\n');
  fs.writeFileSync(path.join(dir, file), head + cap.content, 'utf8');
  return file;
}
async function processWord(word, opts, state) {
  const dir = path.join(opts.outDir || OUT_DIR, word);
  if (!opts.force && fs.existsSync(path.join(dir, 'result.json'))) return { word, skipped: true };
  const fetchErrors = [];
  const search = await toolApi('search', { query: word + ' etymology origin of the word history', count: 10, need_content: false }, state);
  const captures = [];
  const tried = new Set();
  /* 首轮结果常被学术 PDF/外语词典占满(试跑 spect/visible 实测): 抓不到正文时做站点定向补搜,
     etymonline/wiktionary 是最稳的英文词源站; 补搜每次 ¥0.005, 预算内才做。 */
  const tryFetch = async picks => {
    for (const p of picks) {
      if (captures.length >= opts.sources) break;
      if (tried.has(p.url)) continue;
      tried.add(p.url);
      try {
        const f = await toolApi('fetch', { url: p.url }, state);
        const content = f.content || '';
        if (content.length < 200) { fetchErrors.push({ url: p.url, reason: 'content too short(' + content.length + ')' }); continue; }
        const cap = { url: p.url, dom: p.dom, title: f.title || p.title, content, sha256: sha256(content), license: licenseOf(p.url) };
        cap.file = writeCapture(word, captures.length, cap, opts.outDir);
        captures.push(cap);
      } catch (e) {
        if (e.message === 'CALL_BUDGET_EXHAUSTED') throw e;
        fetchErrors.push({ url: p.url, reason: e.message.slice(0, 120) });
      }
    }
  };
  await tryFetch(pickSources(search.results || [], opts.sources));
  for (const fallback of ['site:etymonline.com', 'site:en.wiktionary.org']) {
    if (captures.length) break;
    if (state.calls >= state.maxCalls) break;
    try {
      const extra = await toolApi('search', { query: word + ' etymology ' + fallback, count: 8, need_content: false }, state);
      await tryFetch(pickSources(extra.results || [], opts.sources));
    } catch (e) { if (e.message === 'CALL_BUDGET_EXHAUSTED') throw e; }
  }
  let extract = { ok: false, raw: '(skipped)', chat: 0 };
  if (captures.length && state.calls < state.maxCalls) {
    try { extract = await chatExtract(word, captures, state); extract.chat = 1; }
    catch (e) { if (e.message === 'CALL_BUDGET_EXHAUSTED') state.exhausted = true; else extract = { ok: false, raw: e.message, chat: 0 }; }
  }
  const result = {
    word, at: new Date().toISOString(), status: 'machine-candidate',   // 未核验; 进正式包需人工整理+独立 review 签署
    cost: { search_calls: 1, fetch_calls: captures.length, chat_calls: extract.chat || 0, est_cny: null },
    search_results: (search.results || []).slice(0, 10).map(r => ({ title: r.title, url: r.url, authority: r.authority, rerank_score: r.rerank_score })),
    captures: captures.map(c => ({ url: c.url, title: c.title, file: c.file, sha256: c.sha256, license: c.license })),
    fetch_errors: fetchErrors,
    candidate: extract.ok ? extract.candidate : null, candidate_raw: extract.ok ? undefined : extract.raw,
  };
  result.cost.est_cny = +(result.cost.search_calls * COST.search + result.cost.fetch_calls * COST.fetch).toFixed(4);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 1), 'utf8');
  return { word, skipped: false, captures: captures.length, ok: extract.ok };
}
/* ---- 按需查词(2026-11-14 用户定案: 不全量预跑, 查词时才调用) ---- */
/* 摘要优先决策(纯函数, 供测试): 优先站/权威结果的长摘要够用时, 0 次抓取出候选;
   不够时返回要抓的页面。 */
function planSources(results, { snippetFirst = true, maxFetch = 2 } = {}) {
  const picks = pickSources(results, 8);
  const preferred = r => PREFERRED.some(p => r.dom === p || r.dom.endsWith('.' + p));
  if (snippetFirst) {
    const rich = picks.filter(p => preferred(p) && (p.summary || '').length >= 240);
    if (rich.length) return { mode: 'summaries', pages: rich.slice(0, 3).map(p => ({ url: p.url, content: '[搜索摘要] ' + p.summary })) };
  }
  return { mode: 'fetch', picks: picks.slice(0, maxFetch) };
}
/* 日预算账本: <cacheDir>/_spend.json {day,calls}。防失控, 不追求精确计费。 */
function spendGuard(cacheDir, maxPerDay = DAILY_CALL_LIMIT) {
  const file = path.join(cacheDir, '_spend.json');
  const day = new Date().toISOString().slice(0, 10);
  let s = { day, calls: 0 };
  try { const old = JSON.parse(fs.readFileSync(file, 'utf8')); if (old && old.day === day) s = old; } catch {}
  if (s.calls >= maxPerDay) { const e = Error('当日联网查证次数已达上限(' + maxPerDay + ' 次调用)，明天再试'); e.code = 'DAILY_BUDGET'; throw e; }
  return { add(n) { s.calls += n; fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(s), 'utf8'); } };
}
/* 单词按需查证: 缓存命中 0 调用; 否则 1 搜索 + 0~maxFetch 抓取 + 1 整理, 结果永久缓存。
   服务端(/dict)与 CLI 共用; opts: {cacheDir, maxFetch, snippetFirst, maxPerDay, force} */
async function lookupEtymology(word, opts = {}) {
  const o = { cacheDir: OUT_DIR, maxFetch: 2, snippetFirst: true, maxPerDay: DAILY_CALL_LIMIT, force: false, ...opts };
  word = String(word || '').trim().toLowerCase();
  if (!/^[a-z][a-z'\-]{0,31}$/.test(word)) { const e = Error('词形不合法'); e.code = 'WORD_INVALID'; throw e; }
  const dir = path.join(o.cacheDir, word);
  if (!o.force) { try { return { cached: true, result: JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')) }; } catch {} }
  if (!apiKey()) { const e = Error('未配置 TFL_AI_KEY'); e.code = 'NO_KEY'; throw e; }
  const spend = spendGuard(o.cacheDir, o.maxPerDay);
  const fetchErrors = [];
  const search = await toolApi('search', { query: word + ' etymology origin of the word history', count: 8, need_content: false }, { calls: 0, maxCalls: 1e9 });
  let calls = 1, searchCalls = 1;
  const results = (search.results || []).map(r => ({ ...r, url: normalizeUrl(String(r.url || '').trim()) }))
    .filter(r => domainOf(r.url) && !isUnfetchable(r.url));
  const plan = planSources(results, o);
  const captures = [];
  if (plan.mode === 'summaries') {
    for (const pg of plan.pages) {
      const cap = { url: pg.url, dom: domainOf(pg.url), title: '', content: pg.content, sha256: sha256(pg.content), license: licenseOf(pg.url) };
      cap.file = writeCapture(word, captures.length, cap, o.cacheDir);
      captures.push(cap);
    }
  } else {
    const tryFetch = async picks => {
      for (const p of picks) {
        if (captures.length >= o.maxFetch) break;
        try {
          const f = await toolApi('fetch', { url: p.url }, { calls: 0, maxCalls: 1e9 }); calls++;
          const content = f.content || '';
          if (content.length < 200) { fetchErrors.push({ url: p.url, reason: 'content too short(' + content.length + ')' }); continue; }
          const cap = { url: p.url, dom: p.dom, title: f.title || p.title, content, sha256: sha256(content), license: licenseOf(p.url) };
          cap.file = writeCapture(word, captures.length, cap, o.cacheDir);
          captures.push(cap);
        } catch (e) { fetchErrors.push({ url: p.url, reason: e.message.slice(0, 120) }); }
      }
    };
    await tryFetch(plan.picks);
    for (const fallback of ['site:etymonline.com', 'site:en.wiktionary.org']) {
      if (captures.length || calls > 6) break;
      try {
        const extra = await toolApi('search', { query: word + ' etymology ' + fallback, count: 8, need_content: false }, { calls: 0, maxCalls: 1e9 }); calls++; searchCalls++;
        await tryFetch(pickSources(extra.results || [], o.maxFetch));
      } catch (e) { fetchErrors.push({ fallback, reason: e.message.slice(0, 120) }); }
    }
  }
  let extract = { ok: false, raw: captures.length ? '(extraction failed)' : '(no sources)', chat: 0 };
  if (captures.length) {
    try { extract = await chatExtract(word, captures, { calls: 0, maxCalls: 1e9 }); extract.chat = 1; calls++; }
    catch (e) { extract = { ok: false, raw: e.message.slice(0, 200), chat: 0 }; }
  }
  const result = {
    word, at: new Date().toISOString(), status: 'machine-candidate',   // 未核验; 进正式包需人工整理+独立 review 签署
    mode: plan.mode,
    cost: { search_calls: searchCalls, fetch_calls: captures.length, chat_calls: extract.chat || 0, est_cny: null },
    search_results: results.slice(0, 8).map(r => ({ title: r.title, url: r.url, authority: r.authority, rerank_score: r.rerank_score, summary: (r.summary || '').slice(0, 400) })),
    captures: captures.map(c => ({ url: c.url, title: c.title, file: c.file, sha256: c.sha256, license: c.license })),
    fetch_errors: fetchErrors,
    candidate: extract.ok ? extract.candidate : null, candidate_raw: extract.ok ? undefined : extract.raw,
  };
  result.cost.est_cny = +(result.cost.search_calls * COST.search + result.cost.fetch_calls * COST.fetch + (extract.chat || 0) * 0.002).toFixed(4);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 1), 'utf8');
  spend.add(calls);
  return { cached: false, result };
}
async function main() {
  const args = process.argv.slice(2);
  const opt = { words: [], sources: 3, limit: Infinity, force: false, maxCalls: 60, allianceDict: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--words') opt.words = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (args[i] === '--sources') opt.sources = Math.max(1, Number(args[++i]) || 3);
    else if (args[i] === '--limit') opt.limit = Number(args[++i]) || Infinity;
    else if (args[i] === '--force') opt.force = true;
    else if (args[i] === '--max-calls') opt.maxCalls = Number(args[++i]) || 60;
    else if (args[i] === '--alliance-dict') opt.allianceDict = true;
  }
  if (opt.allianceDict) {
    const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'root-universe', 'learning', 'dict', 'entry.json'), 'utf8'));
    opt.words = [...new Set([...(entry.alliance?.words || []), ...(entry.words || []).map(w => w.word)])].map(w => String(w).toLowerCase());
  }
  opt.words = opt.words.slice(0, opt.limit === Infinity ? opt.words.length : opt.limit);
  if (!opt.words.length) { console.error('用法: --words a,b,c | --alliance-dict [--sources N] [--limit N] [--force] [--max-calls N]'); process.exit(1); }
  const state = { calls: 0, maxCalls: opt.maxCalls, doneAt: 0 };
  const summary = [];
  for (const word of opt.words) {
    state.doneAt = state.calls;
    try {
      const r = await processWord(word, opt, state);
      summary.push(r);
      console.log(r.skipped ? 'SKIP ' + word + '(已有 result.json, --force 重跑)' : (r.empty ? 'EMPTY ' + word : 'OK   ' + word + ' captures=' + r.captures + ' candidate=' + (r.ok ? 'yes' : 'raw-only')));
      if (state.exhausted) { console.log('已达 --max-calls=' + opt.maxCalls + ', 停止'); break; }
    } catch (e) {
      summary.push({ word, error: e.message });
      console.log('ERR  ' + word + ' ' + e.message);
      if (e.message === 'CALL_BUDGET_EXHAUSTED') break;
    }
  }
  const spent = state.calls * COST.search;   // search/fetch 同价, 近似
  fs.mkdirSync(opt.outDir || OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(opt.outDir || OUT_DIR, 'run-log.json'), JSON.stringify({ at: new Date().toISOString(), words: opt.words, summary, api_calls: state.calls, est_cny: +spent.toFixed(4) }, null, 1), 'utf8');
  console.log('== 完成: ' + summary.length + ' 词 · API 调用 ' + state.calls + ' 次 · 预估 ¥' + spent.toFixed(2) + ' · 明细 build/qa/root-etym/run-log.json');
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { pickSources, planSources, spendGuard, lookupEtymology, licenseOf, domainOf, sha256, normalizeUrl, isUnfetchable, LICENSE_NOTES, BLOCKED, PREFERRED, DAILY_CALL_LIMIT, COST };
