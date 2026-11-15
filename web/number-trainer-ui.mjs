/* 数字听写训练界面：单题状态机 + 大键盘 + 轮末反馈。
   依赖 number-trainer-model / -client / -audio。挂载由主站 go() 调用 mount / leave。 */
import * as M from './number-trainer-model.mjs';
import { createQueue } from './number-trainer-client.mjs';
import { createPlayer } from './number-trainer-audio.mjs';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS_CFG = 'nt:cfg';
const SS_RUN = 'nt:run';
const API = '/api/number-trainer';

const S = {
  mounted: false, token: 0, screen: 'home',
  cfg: { mode: 'smart', digits: 3, count: 20, rate: 1 },
  meta: null, summary: null,
  session: null, index: 0, input: '', answers: [],
  playState: 'idle', endedAt: 0, firstAt: 0, replay: false, hint: false, plays: 0,
  timingValid: true, invalidReason: null, result: null, busy: false,
  ttsBroken: false, browserVoice: false, pending: 0, note: '',
};

let player = null, queue = null, root = null, offTimer = null;

function cfgLoad() {
  try { const c = JSON.parse(localStorage.getItem(LS_CFG) || 'null');if (c && typeof c === 'object') S.cfg = { ...S.cfg, ...c }; } catch { /* 忽略 */ }
}
function cfgSave() { try { localStorage.setItem(LS_CFG, JSON.stringify(S.cfg)); } catch { /* 忽略 */ } }
function saveRun() {
  try {
    if (S.screen !== 'train' || !S.session) return;
    sessionStorage.setItem(SS_RUN, JSON.stringify({ id: S.session.id, index: S.index, answers: S.answers, input: S.input }));
  } catch { /* 忽略 */ }
}
function clearRun() { try { sessionStorage.removeItem(SS_RUN); } catch { /* 忽略 */ } }

async function api(p, body) {
  const r = await fetch(API + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;try { data = await r.json(); } catch { /* 忽略 */ }
  if (!r.ok) throw Object.assign(new Error(data?.error || 'REQUEST_FAILED'), { status: r.status, data });
  return data;
}

/* ---------- 渲染 ---------- */
function render() {
  if (!root) return;
  let html;
  if (S.screen === 'home') html = homeHTML();
  else if (S.screen === 'loading') html = loadingHTML();
  else if (S.screen === 'done') html = doneHTML();
  else { html = trainHTML();saveRun(); }
  root.innerHTML = '<div class="nt">' + html + '</div>';
  bind();
}
const ICON_BACK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>';
const ICON_GEAR = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1"/></svg>';
function headHTML(title, back = true, gear = true) {
  const left = back ? `<button class="nt-ico" data-act="back" aria-label="返回">${ICON_BACK}</button>` : '<span class="nt-ico-space" aria-hidden="true"></span>';
  const right = gear ? `<button class="nt-ico" data-act="settings" aria-label="设置">${ICON_GEAR}</button>` : '<span class="nt-ico-space" aria-hidden="true"></span>';
  return `<div class="nt-top">${left}<b>${esc(title)}</b>${right}</div>`;
}
function homeHTML() {
  const s = S.summary?.summary, adv = S.summary?.advice || [];
  const rec = S.summary?.recommendedDigits;
  const stat = s?.total?.settled ? `<div class="nt-stats">
    <div><b>${Math.round((s.total.independentRate || 0) * 100)}%</b><span>单听准确</span></div>
    <div><b>${M.fmtSec(s.total.medianMs)}</b><span>中位用时</span></div>
    <div><b>${s.samples}</b><span>样本</span></div></div>` : '';
  return `${headHTML('数字听写', false, false)}
  <div class="nt-pad">
    <p class="nt-eyebrow">听到多少，就输入多少</p>
    <h1 class="nt-h1">数字敏感度训练</h1>
    <p class="nt-lead">每题播放一个英语数字。听完输入数值，系统按准确度和反应时间记录，并把易错类型安排成下一轮的专项题。</p>
    ${stat}
    <div class="nt-advice">${adv.slice(0, 2).map(a => `<p>${esc(a.text)}</p>`).join('') || '<p>还没有记录。先做一轮，建立你的个人基线。</p>'}</div>
    <div class="nt-cfgrow">
      <label>位数<select data-cfg="mode"><option value="smart"${S.cfg.mode === 'smart' ? ' selected' : ''}>智能（推荐${rec ? ' · 当前建议' + rec + '位' : ''}）</option><option value="fixed"${S.cfg.mode === 'fixed' ? ' selected' : ''}>固定位数</option></select></label>
      ${S.cfg.mode === 'fixed' ? `<label>固定<select data-cfg="digits">${[1, 2, 3, 4, 5, 6].map(d => `<option value="${d}"${S.cfg.digits === d ? ' selected' : ''}>${d} 位</option>`).join('')}</select></label>` : ''}
      <label>题数<select data-cfg="count">${[10, 20, 30].map(n => `<option value="${n}"${S.cfg.count === n ? ' selected' : ''}>${n} 题</option>`).join('')}</select></label>
    </div>
    <button class="nt-primary" data-act="start">开始训练</button>
    <p class="nt-fine">${S.meta?.tts === false ? '当前未配置服务端语音，将使用浏览器朗读；声音与速度会因设备而异。' : '音频为固定音色与读法，加载时间不计入反应时间。'}</p>
    ${S.pending ? `<p class="nt-fine nt-warn">${S.pending} 条作答待同步，联网后会自动补传。</p>` : ''}
  </div>`;
}
function loadingHTML() {
  return `${headHTML('正在准备', true)}<div class="nt-pad"><p class="nt-lead">正在生成这一轮的题目并准备音频…</p></div>`;
}
function trainHTML() {
  const q = currentQ(), total = S.session?.questions.length || S.cfg.count;
  const bars = Array.from({ length: total }, (_, i) => `<i class="${i < S.index ? 'done' : i === S.index ? 'cur' : ''}"></i>`).join('');
  const showResult = !!S.result;
  const heard = S.playState === 'ready' || S.playState === 'done';
  const boxes = inputBoxes();
  return `${headHTML('正在练习', true)}
  <div class="nt-bars" aria-hidden="true">${bars}</div>
  <div class="nt-stage">
    <p class="nt-progress">${S.index + 1} / ${total}${q?.source ? ` · ${esc(M.SOURCE_LABELS[q.source] || '')}` : ''}</p>
    <div class="nt-digits" aria-live="polite">${boxes}</div>
    ${showResult ? resultHTML() : stateHTML(heard)}
  </div>
  ${keysHTML(showResult, heard)}`;
}
function inputBoxes() {
  const chars = [...S.input];
  const shown = chars.length ? chars : ['', '', ''];
  return shown.slice(0, 12).map(c => `<span class="nt-box${c ? ' filled' : ''}${S.result && !S.result.correct ? ' miss' : ''}">${c ? esc(c) : ''}</span>`).join('');
}
function stateHTML(heard) {
  if (S.playState === 'loading') return '<p class="nt-state">正在准备音频…</p>';
  if (S.playState === 'playing') return '<p class="nt-state">正在播放，请听完整…</p>';
  if (S.playState === 'blocked') return '<p class="nt-state">浏览器拦截了自动播放</p><button class="nt-secondary" data-act="play">播放本題</button>';
  if (S.playState === 'paused') return '<p class="nt-state nt-err">离开页面时已中断，本题不计反应时间</p><button class="nt-secondary" data-act="play">重新播放本题</button>';
  if (S.playState === 'error') return `<p class="nt-state nt-err">${esc(S.note || '音频加载失败')}</p><button class="nt-secondary" data-act="play">重试播放</button>`;
  if (heard) return `<p class="nt-state">${S.replay ? '已重听 · 本题不计入单听准确率' : '输入你听到的数值，再按确认'}</p>${S.hint && !S.result ? `<p class="nt-hint">${hintText()}</p>` : ''}`;
  return '<p class="nt-state">点播放开始这一题</p>';
}
function hintText() {
  const q = currentQ();if (!q) return '';
  return `提示：${esc(q.text)}（本次计为辅助完成）`;
}
function resultHTML() {
  const r = S.result;
  const tags = (r.errorTags || []).map(t => `<span class="nt-tag">${esc(M.ERROR_LABELS[t] || t)}</span>`).join('');
  return `<div class="nt-result ${r.correct ? 'ok' : 'bad'}" role="status">
    <b>${r.correct ? (S.assistedThis ? '答对了（用了辅助）' : '答对了') : (r.skip ? '已跳过' : '这次不对')}</b>
    <p>你输入 <code>${esc(S.input || '—')}</code>・正确 <code>${esc(r.answer)}</code></p>
    <p class="nt-read">${esc(r.text)}</p>
    ${tags ? `<p class="nt-tags">${tags}</p>` : ''}
    <p class="nt-time">${S.submitMs != null ? `本题用时 ${M.fmtSec(S.submitMs)}` : '本题未记录有效时间'}${S.replay ? ' · 含重听' : ''}</p>
  </div>`;
}
function keysHTML(showResult, heard) {
  const canConfirm = heard && !showResult && S.input.length > 0;
  const next = showResult ? `<button class="nt-key wide2 confirm" data-act="next">下一题</button>` : `<button class="nt-key confirm" data-act="confirm" ${canConfirm ? '' : 'disabled'}>确认</button>`;
  return `<div class="nt-keys">
    ${[1, 2, 3].map(d => `<button class="nt-key" data-digit="${d}">${d}</button>`).join('')}<button class="nt-key alt" data-act="del">删除</button>
    ${[4, 5, 6].map(d => `<button class="nt-key" data-digit="${d}">${d}</button>`).join('')}<button class="nt-key alt" data-act="replay">重听</button>
    ${[7, 8, 9].map(d => `<button class="nt-key" data-digit="${d}">${d}</button>`).join('')}<button class="nt-key alt" data-act="hint" ${showResult ? 'disabled' : ''}>提示</button>
    <button class="nt-key alt" data-act="skip" ${showResult ? 'disabled' : ''}>跳过</button><button class="nt-key" data-digit="0">0</button>${next}
  </div>`;
}
function doneHTML() {
  const s = S.finishSummary;
  const total = s?.summary?.total || { settled: 0, independent: 0, independentRate: 0, medianMs: null, samples: 0 };
  const rows = S.answers.map((a, i) => {
    const q = S.session.questions[i];
    return `<li class="${a.correct ? 'ok' : 'bad'}"><span>${esc(q.value)}</span><small>${esc(a.correct ? '对' : (a.skip ? '跳过' : '错'))}${a.assisted ? ' · 辅助' : ''}${a.submitMs != null ? ' · ' + M.fmtSec(a.submitMs) : ''}</small></li>`;
  }).join('');
  return `${headHTML('本轮结束', false)}
  <div class="nt-pad">
    <p class="nt-eyebrow">这一轮</p>
    <h1 class="nt-h1">本轮完成</h1>
    <div class="nt-stats">
      <div><b>${Math.round((total.independentRate || 0) * 100)}%</b><span>单听准确</span></div>
      <div><b>${M.fmtSec(total.medianMs)}</b><span>中位用时</span></div>
      <div><b>${total.independent}/${total.settled}</b><span>独立答对</span></div>
    </div>
    <div class="nt-advice">${(s?.advice || []).map(a => `<p>${esc(a.text)}</p>`).join('') || '<p>记录已保存。</p>'}</div>
    <details class="nt-detail"><summary>看这一轮的每一题</summary><ul class="nt-list">${rows}</ul></details>
    <button class="nt-primary" data-act="again">再练一轮</button>
    <button class="nt-secondary" data-act="home">回到入口</button>
  </div>`;
}

/* ---------- 绑定 ---------- */
function currentQ() { return S.session?.questions[S.index] || null; }
function bind() {
  root.querySelectorAll('[data-digit]').forEach(b => b.onclick = () => pressDigit(b.dataset.digit));
  root.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
  root.querySelectorAll('[data-cfg]').forEach(sel => sel.onchange = () => {
    const k = sel.dataset.cfg;
    S.cfg[k] = k === 'count' || k === 'digits' ? Number(sel.value) : sel.value;
    cfgSave();render();
  });
}
function pressDigit(d) {
  if (S.result || S.input.length >= 12) return;
  if (S.firstAt === 0 && S.endedAt) S.firstAt = performance.now();
  S.input += d;render();
}
function act(a) {
  if (a === 'start') return startSession();
  if (a === 'back') return leaveToHome(true);
  if (a === 'home') { S.screen = 'home';S.session = null;S.result = null;S.input = '';render();return; }
  if (a === 'settings') return toast('在入口页调整位数与题数。');
  if (a === 'play') return playCurrent();
  if (a === 'del') { if (!S.result) { S.input = S.input.slice(0, -1);render(); } return; }
  if (a === 'replay') return playCurrent(true);
  if (a === 'hint') { if (S.result) return;S.hint = true;render();return; }
  if (a === 'skip') return submit(true);
  if (a === 'confirm') return submit(false);
  if (a === 'next') return nextQuestion();
  if (a === 'again') return startSession();
}

/* ---------- 一轮 ---------- */
async function startSession() {
  const token = ++S.token;
  clearRun();S.screen = 'loading';S.result = null;S.answers = [];S.index = 0;S.input = '';render();
  try {
    const data = await api('/sessions', S.cfg);
    if (token !== S.token) return;
    S.session = data;S.screen = 'train';S.finishSummary = null;
    S.index = 0;S.answers = [];
    render();await enterQuestion();
  } catch (e) {
    if (token !== S.token) return;
    S.screen = 'home';S.note = e.message;render();toast('开始失败：' + (e.data?.error || e.message));
  }
}
function resetQuestionState() {
  S.input = '';S.result = null;S.endedAt = 0;S.firstAt = 0;S.submitMs = null;
  S.replay = false;S.hint = false;S.plays = 0;S.timingValid = true;S.invalidReason = null;S.assistedThis = false;
  S.playState = 'idle';S.note = '';
}
async function enterQuestion({ draft = '' } = {}) {
  resetQuestionState();S.input = draft;render();
  const q = currentQ();if (!q) return;
  await loadAndPlay(q);
}
async function loadAndPlay(q) {
  const token = S.token;
  S.playState = 'loading';render();
  if (!S.meta?.tts || S.ttsBroken) { await playCurrent();return; }
  try {
    const ok = await player.load(q.audioUrl);
    if (token !== S.token) return;
    if (!ok.ok) {
      // 服务端音频不可用时退回浏览器朗读，并在本轮内保持该选择；统计按 voice 分开。
      S.ttsBroken = true;S.note = '服务端音频不可用，本次改用浏览器朗读';toast(S.note);
      await playCurrent();return;
    }
    await playCurrent();
  } catch {
    if (token !== S.token) return;
    S.ttsBroken = true;S.note = '服务端音频不可用，本次改用浏览器朗读';
    await playCurrent();
  }
}
async function playCurrent(isReplay = false) {
  const q = currentQ();if (!q || S.result) return;
  if (isReplay || S.plays > 0) S.replay = true;
  const token = S.token;
  S.playState = 'playing';render();
  if (!S.meta?.tts || S.ttsBroken) {
    // 浏览器朗读兜底：明确标记 voice=browser，不与服务端音频混算
    if (!('speechSynthesis' in window)) { S.playState = 'error';S.note = '此设备不支持朗读';render();return; }
    S.browserVoice = true;
    const t0 = performance.now();
    await new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(q.text);u.lang = 'en-US';u.rate = S.cfg.rate;
      u.onend = () => resolve(true);u.onerror = () => resolve(false);
      speechSynthesis.cancel();speechSynthesis.speak(u);
      setTimeout(() => resolve(false), 15000);
    }).then(ok => {
      if (token !== S.token) return;
      if (!ok) { S.playState = 'error';S.note = '朗读失败，可重试';S.timingValid = false;S.invalidReason = 'browser_voice'; }
      else { S.plays++;S.endedAt = performance.now();S.playState = 'ready'; }
      render();
    });
    return;
  }
  const out = await player.play({ rate: S.cfg.rate });
  if (token !== S.token) return;
  if (out.ok) { S.plays++;S.endedAt = performance.now();S.playState = 'ready'; }
  else if (out.reason === 'stopped') { /* 已被新题替换 */ }
  else if (out.reason === 'autoplay') { S.playState = 'blocked'; }
  else if (out.reason === 'stopped') { /* 已被新题替换 */ }
  else { S.playState = 'error';S.note = '播放失败，可重试';S.timingValid = false;S.invalidReason = 'audio_play'; }
  render();
}
function submit(skip) {
  if (S.result) return;
  const q = currentQ();if (!q) return;
  if (!skip && !S.input.trim()) { toast('先输入数字，或点跳过。');return; }
  const nowP = performance.now();
  S.submitMs = S.endedAt ? Math.round(nowP - S.endedAt) : null;
  const graded = skip ? { correct: false, status: 'skipped' } : M.gradeAnswer(q.value, S.input);
  S.assistedThis = S.replay || S.hint;
  const errorTags = graded.correct || skip ? [] : (skip ? [] : M.classifyError(q.value, graded.normalized));
  S.result = { correct: !!graded.correct, answer: q.value, text: q.text, errorTags, skip };
  S.answers[S.index] = { correct: !!graded.correct, skip, assisted: S.assistedThis, submitMs: S.submitMs };
  render();
  persist(skip);
}
function persist(skip) {
  const q = currentQ();
  const event = {
    eventId: crypto.randomUUID(), sessionId: S.session.id, questionId: q.id,
    raw: S.input, skip,
    replay: S.replay, hint: S.hint, plays: Math.max(1, S.plays),
    firstInputMs: S.firstAt && S.endedAt ? Math.round(S.firstAt - S.endedAt) : null,
    inputMs: S.firstAt && S.submitMs != null ? Math.max(0, S.submitMs - Math.round(S.firstAt - S.endedAt)) : null,
    submitMs: S.submitMs,
    timingValid: S.timingValid && S.submitMs != null,
    invalidReason: S.invalidReason,
    rate: S.cfg.rate, voice: S.browserVoice ? 'browser' : 'server',
    device: matchMedia('(pointer:coarse)').matches ? 'touch' : 'pointer',
    clientAt: new Date().toISOString(),
  };
  queue.enqueue(event);
  queue.flush().catch(() => { });
}
function nextQuestion() {
  if (S.index + 1 >= (S.session?.questions.length || 0)) return finishRound();
  S.index++;S.result = null;enterQuestion();
}
async function finishRound() {
  const token = ++S.token;
  S.screen = 'done';S.result = null;render();
  try {
    const out = await api(`/sessions/${S.session.id}/finish`, {});
    if (token !== S.token) return;
    S.finishSummary = out;render();
  } catch {
    if (token !== S.token) return;
    S.finishSummary = null;render();
  }
  try { const s = await api('/summary');if (token === S.token) { S.summary = s; } } catch { /* 忽略 */ }
}
function leaveToHome(confirmLeave) {
  if (confirmLeave && S.screen === 'train' && S.session && S.answers.length && S.answers.length < S.session.questions.length) {
    if (!window.confirm('这一轮还没做完。离开后本轮记录会保留，但要重新开始一轮。')) return;
  }
  clearRun();S.token++;S.screen = 'home';S.session = null;S.result = null;S.input = '';
  if (player) player.stop();
  S.pending = queue ? queue.pendingCount() : 0;
  refreshSummary();render();
}
async function refreshSummary() {
  try { const s = await api('/summary');S.summary = s;if (S.screen === 'home') render(); } catch { /* 忽略 */ }
}

/* ---------- 生命周期 ---------- */
export async function mount(el) {
  if (!el) return;
  if (S.mounted && root === el) return;
  if (S.mounted) leave();
  root = el;S.mounted = true;S.token++;
  cfgLoad();
  player = createPlayer();
  queue = createQueue({ onChange: n => { S.pending = n;if (S.screen === 'home') render(); } });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  render();
  try { S.meta = await api('/config'); } catch { S.meta = { tts: false }; }
  if (!S.mounted) return;
  S.pending = queue.pendingCount();
  queue.flush().catch(() => { });
  render();
  refreshSummary();
  resumeRun();
}
async function resumeRun() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(SS_RUN) || 'null'); } catch { /* 忽略 */ }
  if (!saved || !saved.id) return;
  const token = S.token;
  try {
    const data = await api('/sessions/' + encodeURIComponent(saved.id));
    if (token !== S.token || S.session) return;
    if (data.state !== 'active') { clearRun();return; }
    const idx = Number.isInteger(saved.index) && saved.index >= 0 && saved.index < data.questions.length ? saved.index : 0;
    S.session = data;S.screen = 'train';S.index = idx;
    S.answers = Array.isArray(saved.answers) ? saved.answers.slice(0, idx + 1) : [];
    render();
    await enterQuestion({ draft: typeof saved.input === 'string' ? saved.input : '' });
  } catch { clearRun(); }
}
export function leave() {
  S.mounted = false;S.token++;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  if (player) { player.dispose();player = null; }
  if (offTimer) { clearTimeout(offTimer);offTimer = null; }
  root = null;
}
export const isActive = () => S.mounted;

function onVisibility() {
  if (document.visibilityState !== 'hidden') return;
  if (player && S.screen === 'train' && S.playState === 'playing') {
    player.stop();S.playState = 'paused';S.timingValid = false;S.invalidReason = 'hidden';render();
  }
}
function onPageHide() { if (player) player.stop(); }

function toast(text) {
  if (!root) return;
  let t = $('#nt-toast', root);
  if (!t) { t = document.createElement('div');t.id = 'nt-toast';t.className = 'nt-toast';root.appendChild(t); }
  t.textContent = text;t.hidden = false;
  clearTimeout(toast._t);toast._t = setTimeout(() => { if (t) t.hidden = true; }, 2400);
}
