/* 数字听写训练界面：单题状态机 + 大键盘 + 轮末反馈 + 历史。
   依赖 number-trainer-model / -client / -audio。挂载由主站 go() 调用 mount / leave。 */
import * as M from './number-trainer-model.mjs';
import { createQueue } from './number-trainer-client.mjs';
import { createPlayer } from './number-trainer-audio.mjs';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS_CFG = 'nt:cfg';
const LS_THEME = 'nt:theme';
const SS_RUN = 'nt:run';
const API = '/api/number-trainer';
let theme = 'light';

const S = {
  mounted: false, token: 0, screen: 'home',
  cfg: { mode: 'smart', digits: 3, count: 20, rate: 1, auto: true, phoneMin: 7, phoneMax: 11 },
  meta: null, summary: null, history: null,
  session: null, index: 0, input: '', caret: 0, answers: [], autoTimer: null,
  playState: 'idle', endedAt: 0, firstAt: 0, replay: false, hint: false, plays: 0,
  timingValid: true, invalidReason: null, result: null, assistedThis: false,
  browserVoice: false, pending: 0, note: '', finishSummary: null, finishState: 'idle',
};

let player = null, queue = null, root = null;
const CARET = '<i class="nt-caret" aria-hidden="true"></i>';

function cfgLoad() {
  try { const c = JSON.parse(localStorage.getItem(LS_CFG) || 'null');if (c && typeof c === 'object') S.cfg = { ...S.cfg, ...c }; } catch { /* 忽略 */ }
}
function cfgSave() { try { localStorage.setItem(LS_CFG, JSON.stringify(S.cfg)); } catch { /* 忽略 */ } }
function themeLoad() {
  try { theme = localStorage.getItem(LS_THEME) === 'dark' ? 'dark' : 'light'; } catch { theme = 'light'; }
  themeApply();
}
function themeApply() {
  const view = document.getElementById('v-number-trainer');
  if (view) view.setAttribute('data-theme', theme);
}
function themeToggle() {
  theme = theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(LS_THEME, theme); } catch { /* 忽略 */ }
  themeApply();
  render();
}
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

const ICON_BACK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>';
const ICON_GEAR = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/></svg>';
const ICON_SPEAKER = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3L12 5v14l-5-4.5H4z"/><path d="M16 8.5a5 5 0 0 1 0 7"/></svg>';
const ICON_SUN = '<svg class="nt-theme-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';
const ICON_MOON = '<svg class="nt-theme-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>';
const themeButton = () => theme === 'dark'
  ? `<button class="nt-ico nt-theme" data-act="theme" aria-label="切换到亮色主题" title="切换到亮色主题">${ICON_SUN}</button>`
  : `<button class="nt-ico nt-theme" data-act="theme" aria-label="切换到深色主题" title="切换到深色主题">${ICON_MOON}</button>`;

const FEATURE_HINT = {
  teenTy: '末两位里 -teen 和 -ty 只差一个音，最容易被听成另一个数，要盯住结尾。',
  zeroGap: '数位中间夹着零，容易漏掉位置；听的时候先记住一共有几位。',
  adjacentRepeat: '有连续重复的数字，容易少记或多记一个。',
  distinctDigits: '数字互不相同，顺序变了就是另一个数，注意排列。',
  crossGroup: '跨过 thousand 之后要换到下一组，注意单位后面的尾数。',
};
const SOURCE_HINT = {
  focus: '按你的记录，这类最容易出错，所以这轮多练一点。',
  review: '之前练过但不稳，换个新数字再确认一次。',
  probe: '随机抽的题，用来检查换了数字还听不听得懂。',
};

/* ---------- 渲染 ---------- */
function render() {
  if (!root) return;
  let html;
  if (S.screen === 'home') html = homeHTML();
  else if (S.screen === 'history') html = historyHTML();
  else if (S.screen === 'loading') html = loadingHTML();
  else if (S.screen === 'done') html = doneHTML();
  else { html = trainHTML();saveRun(); }
  root.innerHTML = '<div class="nt nt-' + S.screen + '">' + html + '</div>';
  bind();
}
function headHTML(title, { back = true, gear = true } = {}) {
  const left = back ? `<button class="nt-ico" data-act="back" aria-label="返回">${ICON_BACK}</button>` : '<span class="nt-ico-space" aria-hidden="true"></span>';
  const buttons = `${gear ? `<button class="nt-ico" data-act="settings" aria-label="设置">${ICON_GEAR}</button>` : ''}${themeButton()}`;
  const right = gear || buttons ? `<div class="nt-top-right">${buttons}</div>` : '<span class="nt-ico-space" aria-hidden="true"></span>';
  return `<div class="nt-top">${left}<b>${esc(title)}</b>${right}</div>`;
}
function tiles(s, accLabel = '单听准确', label = '已练题数') {
  const ready = !!s?.total?.settled;
  return `<div class="nt-tiles">
    <div><b>${ready ? Math.round((s.total.independentRate || 0) * 100) + '%' : '—'}</b><span>${accLabel}</span></div>
    <div><b>${ready ? M.fmtSec(s.total.medianMs) : '—'}</b><span>中位用时</span></div>
    <div><b>${ready ? s.total.settled : 0}</b><span>${label}</span></div>
  </div>`;
}
function homeHTML() {
  const phone = S.cfg.mode === 'phone';
  const s = phone ? S.summary?.phone?.summary : S.summary?.summary;
  const adv = (phone ? S.summary?.phone?.advice : S.summary?.advice) || [];
  const rec = S.summary?.recommendedDigits;
  const last = (S.history?.rounds || []).find(r => r.settled >= 5 && (phone ? r.mode === 'phone' : r.mode !== 'phone'));
  const has = (s?.total?.settled || 0) > 0;
  return `<div class="nt-top"><span></span>${themeButton()}</div>
  <div class="nt-pad">
    <h1 class="nt-h1">数字敏感度训练</h1>
    <p class="nt-lead">${phone
      ? '逐个数字播放，像听电话号码一样。长度不固定，前面的 0 也要写出来。'
      : '每题播放一个英语数字，听完输入数值。电脑上直接敲数字即可；答对会自动进入下一题。'}</p>
    <div class="nt-field"><span class="nt-label">练什么</span><div class="nt-chips" role="group" aria-label="练习类型">
      <button class="nt-chip${phone ? '' : ' on'}" data-kind="number">数字</button>
      <button class="nt-chip${phone ? ' on' : ''}" data-kind="phone">电话号码</button>
    </div></div>
    ${has ? tiles(s, phone ? '逐位准确' : '单听准确', phone ? '已练题数' : '已练题数') : ''}
    ${has
      ? `<div class="nt-advice">${adv.slice(0, 2).map(a => `<p>${esc(a.text)}</p>`).join('')}</div>`
      : `<p class="nt-empty">${phone ? '还没有电话号记录。先做一轮 7 位号码建立基线。' : '还没有训练记录。做完第一轮，这里会显示准确率、反应时间和建议。'}</p>`}
    ${phone
      ? `<div class="nt-field"><span class="nt-label">号码长度</span><div class="nt-chips cols-4" role="group" aria-label="号码长度">
          ${[['7:11', '随机 7–11'], ['7:7', '7 位'], ['10:10', '10 位'], ['11:11', '11 位']].map(([range, label]) => {
            const [lo, hi] = range.split(':').map(Number);
            const on = (S.cfg.phoneMin || 7) === lo && (S.cfg.phoneMax || 11) === hi;
            return `<button class="nt-chip${on ? ' on' : ''}" data-phone="${range}">${label}</button>`;
          }).join('')}
        </div></div>`
      : `<div class="nt-field"><span class="nt-label">位数</span><div class="nt-chips cols-7" role="group" aria-label="位数">
          <button class="nt-chip span2${S.cfg.mode === 'smart' ? ' on' : ''}" data-mode="smart">智能</button>
          ${[2, 3, 4, 5, 6].map(d => `<button class="nt-chip${S.cfg.mode === 'fixed' && S.cfg.digits === d ? ' on' : ''}" data-fixed="${d}">${d}</button>`).join('')}
        </div>${S.cfg.mode === 'smart' ? `<span class="nt-note">${has && (s?.total?.settled || 0) >= 5 ? `按当前记录建议 ${rec} 位` : '还没有记录，先按 2 位起步'}</span>` : ''}</div>`}
    <div class="nt-field"><span class="nt-label">每轮</span><div class="nt-chips cols-3" role="group" aria-label="每轮题数">
      ${[10, 20, 30].map(n => `<button class="nt-chip${S.cfg.count === n ? ' on' : ''}" data-count="${n}">${n} 题</button>`).join('')}
    </div></div>
    <div class="nt-field"><span class="nt-label">答对后</span><div class="nt-chips" role="group" aria-label="答对后">
      <button class="nt-chip${S.cfg.auto ? ' on' : ''}" data-auto="on">自动下一题</button>
      <button class="nt-chip${S.cfg.auto ? '' : ' on'}" data-auto="off">手动确认</button>
    </div></div>
    <button class="nt-primary" data-act="start">开始训练</button>
    ${last ? `<button class="nt-last" data-act="history">
      <span><b>上次训练</b><small>${esc(dayLabel(last.endedAt))} · ${last.settled} 题 · ${Math.round((last.accuracy || 0) * 100)}%${last.medianMs ? ' · ' + M.fmtSec(last.medianMs) : ''}</small></span>
      <span class="nt-last-go">看记录 →</span></button>` : ''}
    <p class="nt-fine">${S.meta?.tts === false ? '当前使用浏览器朗读，声音与速度因设备而异。' : phone ? '整串逐位朗读，0 读作 oh；不按整数连读。' : '音频为固定音色与读法；加载时间不计入反应时间。'}</p>
    ${S.pending ? `<p class="nt-fine nt-warn">${S.pending} 条作答待同步，联网后自动补传。</p>` : ''}
  </div>`;
}
function historyHTML() {
  const list = S.history?.rounds || [];
  return `${headHTML('最近训练', { gear: false })}
  <div class="nt-pad">
    ${list.length ? `<ul class="nt-rounds">${list.map(r => `<li>
      <div class="nt-round-main"><b>${Math.round((r.accuracy || 0) * 100)}%</b><span>${esc(dayLabel(r.endedAt))} · ${r.settled} 题${r.digits ? ' · ' + esc(r.digits) + ' 位' : ''}</span></div>
      <div class="nt-round-meta"><span>${r.medianMs ? M.fmtSec(r.medianMs) : '—'}</span><span>${r.topError ? esc(M.ERROR_LABELS[r.topError] || r.topError) : '无主要错误'}</span></div>
    </li>`).join('')}</ul>` : '<p class="nt-lead">还没有完成过的轮次。</p>'}
    <button class="nt-secondary" data-act="home">回到入口</button>
  </div>`;
}
function loadingHTML() {
  return `${headHTML('正在准备')}<div class="nt-pad"><p class="nt-lead">正在生成题目并准备音频…</p></div>`;
}
function trainHTML() {
  const q = currentQ(), total = S.session?.questions.length || S.cfg.count;
  const pct = Math.round((S.index + 1) / total * 100);
  const heard = S.playState === 'ready' || S.playState === 'done';
  const phoneStyle = q?.mode === 'phone';
  return `${headHTML('正在练习', { gear: false })}
  <div class="nt-bars" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${S.index + (S.result ? 1 : 0)}"><i style="width:${pct}%"></i></div>
  <div class="nt-meta-row"><span>${S.index + 1} / ${total}</span><button class="nt-src" data-act="srchint">${esc(M.SOURCE_LABELS[q?.source] || '')} ⓘ</button></div>
  <div class="nt-stage">
    <div class="nt-digits${phoneStyle ? ' phone' : ''}" aria-live="polite">${inputBoxes()}</div>
    ${S.result ? resultHTML() : stateHTML(heard)}
  </div>
  ${keysHTML(!!S.result, heard)}
  <p class="nt-hint-row" aria-hidden="true">数字直接输入 · R 重听 · C 清空 · ⌫ / Del 删除 · ← → 移动 · Enter 确认</p>`;
}
function groupBreaks(len) {
  // 与 groupDigits 一致的断点：10 位 3-3-4，11 位 3-4-4，7 位 3-4，其余每 3 位。
  if (len === 10) return [3, 6];
  if (len === 11) return [3, 7];
  if (len === 7) return [3];
  const out = [];
  for (let i = 3; i < len; i += 3) out.push(i);
  return out;
}
function inputBoxes() {
  const chars = [...S.input];
  const showCaret = !S.result;
  if (!chars.length) return `<span class="nt-box empty-single" data-slot="0">${showCaret ? CARET : ''}</span>`;
  const q = currentQ();
  const phone = q?.mode === 'phone';
  const box = (c, i) => `<span class="nt-box filled${S.result && !S.result.correct ? ' miss' : ''}" data-slot="${i + 1}">${esc(c)}</span>`;
  if (!phone) {
    const out = [];
    chars.slice(0, 12).forEach((c, i) => {
      if (showCaret && i === S.caret) out.push(CARET);
      out.push(box(c, i));
    });
    if (showCaret && S.caret >= Math.min(chars.length, 12)) out.push(CARET);
    return out.join('');
  }
  // 电话号：按 3-3-4 分组渲染，组内格子尺寸固定，不随长度变化
  const breaks = new Set(groupBreaks(Number(q.digits) || chars.length));
  let html = '', open = false;
  chars.slice(0, 12).forEach((c, i) => {
    if (!open || breaks.has(i)) { if (open) html += '</span>';html += '<span class="nt-grp">';open = true; }
    if (showCaret && i === S.caret) html += CARET;
    html += box(c, i);
  });
  if (open) html += '</span>';
  if (showCaret && S.caret >= Math.min(chars.length, 12)) html += CARET;
  return html;
}
function stateHTML(heard) {
  if (S.playState === 'loading') return '<p class="nt-state">正在准备音频…</p>';
  if (S.playState === 'playing') return '<p class="nt-state">正在播放，请听完整…</p>';
  if (S.playState === 'blocked') return '<p class="nt-state">浏览器拦截了自动播放</p><button class="nt-secondary" data-act="play">播放本题</button>';
  if (S.playState === 'paused') return '<p class="nt-state nt-err">离开页面时已中断，本题不计反应时间</p><button class="nt-secondary" data-act="play">重新播放本题</button>';
  if (S.playState === 'error') return `<p class="nt-state nt-err">${esc(S.note || '音频加载失败')}</p><button class="nt-secondary" data-act="retryAudio">重新读取音频</button>`;
  if (heard) return `<p class="nt-state">输入你听到的数值，再按确认</p>
    <div class="nt-subrow">${S.replay ? '<span class="nt-flag">已重听 · 不计单听准确</span>' : `<button class="nt-pill" data-act="replay">${ICON_SPEAKER}再听一次</button>`}${S.hint ? '<span class="nt-flag">已用提示</span>' : ''}</div>`;
  return '<p class="nt-state">点播放开始这一题</p>';
}
function resultHTML() {
  const r = S.result, q = currentQ();
  const tags = (r.errorTags || []).map(t => `<span class="nt-tag">${esc(M.ERROR_LABELS[t] || t)}</span>`).join('');
  const hint = q?.feature && FEATURE_HINT[q.feature] ? `<p class="nt-why">${esc(FEATURE_HINT[q.feature])}</p>` : '';
  return `<div class="nt-result ${r.correct ? 'ok' : 'bad'}" role="status">
    <b>${r.correct ? (S.assistedThis ? '答对了（用了辅助）' : '答对了') : (r.skip ? '已跳过' : '这次不对')}</b>
    ${r.mode === 'phone'
      ? `<div class="nt-compare"><span><small>你的输入</small><code>${esc(S.input ? M.groupDigits(S.input) : '—')}</code></span><span><small>正确</small><code>${esc(r.display || r.answer)}</code></span></div><p class="nt-read">${esc(r.text)}</p>`
      : r.correct && !r.skip
        ? `<p class="nt-answer-line"><code>${esc(r.answer)}</code><span>${esc(r.text)}</span></p>`
        : `<div class="nt-compare"><span><small>你的输入</small><code>${esc(S.input || '—')}</code></span><span><small>正确</small><code>${esc(r.answer)}</code></span></div><p class="nt-read">${esc(r.text)}</p>`}
    ${tags ? `<p class="nt-tags">${tags}</p>` : ''}
    ${hint}
    <p class="nt-time">${S.submitMs != null ? `本题用时 ${M.fmtSec(S.submitMs)}` : '本题未记录有效时间'}${S.replay ? ' · 含重听' : ''}</p>
  </div>`;
}
function keysHTML(showResult, heard) {
  const canConfirm = heard && !showResult && S.input.length > 0;
  const last = showResult && S.index + 1 >= (S.session?.questions.length || 0);
  const next = showResult
    ? `<button class="nt-key confirm wide2" data-act="next">${last ? '看本轮结果' : '下一题'}</button>`
    : `<button class="nt-key confirm" data-act="confirm" ${canConfirm ? '' : 'disabled'}>确认</button>`;
  const lock = showResult ? 'disabled' : '';
  return `<div class="nt-keys">
    ${[1, 2, 3].map(d => `<button class="nt-key" data-digit="${d}" ${lock}>${d}</button>`).join('')}<button class="nt-key alt" data-act="del" ${lock}>删除</button>
    ${[4, 5, 6].map(d => `<button class="nt-key" data-digit="${d}" ${lock}>${d}</button>`).join('')}<button class="nt-key alt" data-act="replay">重听</button>
    ${[7, 8, 9].map(d => `<button class="nt-key" data-digit="${d}" ${lock}>${d}</button>`).join('')}<button class="nt-key alt" data-act="hint" ${showResult ? 'disabled' : ''}>提示</button>
    <button class="nt-key alt" data-act="skip" ${showResult ? 'disabled' : ''}>跳过</button><button class="nt-key" data-digit="0" ${lock}>0</button>${next}
  </div>`;
}
function doneHTML() {
  const s = S.finishSummary?.summary, adv = S.finishSummary?.advice || [];
  const wrong = S.answers.map((a, i) => ({ a, i })).filter(x => x.a && !x.a.correct && !x.a.skip);
  const retryFeatures = [...new Set(wrong.map(x => S.session?.questions?.[x.i]?.feature).filter(f => f && M.FEATURE_LABELS[f]))];
  const hasErrors = retryFeatures.length > 0;
  const rows = S.answers.map((a, i) => {
    const q = S.session?.questions?.[i];if (!q) return '';
    return `<li class="${a?.correct ? 'ok' : 'bad'}"><span class="nt-row-word">${esc(q.value)}</span><small>${a?.correct ? '对' : (a?.skip ? '跳过' : '错')}${a?.assisted ? ' · 辅助' : ''}${a?.submitMs != null ? ' · ' + M.fmtSec(a.submitMs) : ''}</small></li>`;
  }).join('');
  const summary = S.finishState === 'loading'
    ? '<p class="nt-lead">正在汇总本轮…</p>'
    : S.finishState === 'error'
      ? '<div class="nt-advice"><p>本轮记录已保存，但汇总暂时读不到，可以稍后在「最近记录」里查看。</p></div>'
      : `${tiles(s)}<div class="nt-advice">${adv.map(a => `<p>${esc(a.text)}</p>`).join('') || '<p>记录已保存。</p>'}</div>`;
  return `<div class="nt-pad">
    <h1 class="nt-h1">本轮完成</h1>
    ${summary}
    <details class="nt-detail"><summary>看这一轮的每一题</summary><ul class="nt-list">${rows}</ul></details>
    ${hasErrors
      ? `<button class="nt-primary" data-act="retry">重练本轮错题</button><button class="nt-secondary" data-act="again">再来一轮随机</button>`
      : '<button class="nt-primary" data-act="again">再练一轮</button>'}
    <div class="nt-done-actions"><button class="nt-secondary" data-act="history">看最近记录</button><button class="nt-secondary" data-act="home">回到入口</button></div>
  </div>`;
}

/* ---------- 交互 ---------- */
function currentQ() { return S.session?.questions[S.index] || null; }
function bind() {
  root.querySelectorAll('[data-digit]').forEach(b => b.onclick = () => pressDigit(b.dataset.digit));
  root.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => {
    if (S.result) return;
    S.caret = Math.min(Number(b.dataset.slot), [...S.input].length);render();
  });
  root.querySelectorAll('[data-act]').forEach(b => { if (b.dataset.act !== 'del') b.onclick = () => act(b.dataset.act); });
  root.querySelectorAll('[data-act="del"]').forEach(b => {
    let timer = null, longFired = false;
    const stop = () => { if (timer) { clearTimeout(timer);timer = null; } };
    b.addEventListener('pointerdown', () => { longFired = false;timer = setTimeout(() => { longFired = true;clearInput(); }, 550); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
    b.addEventListener('click', () => { if (longFired) { longFired = false;return; }delBack(); });
  });
  root.querySelectorAll('[data-auto]').forEach(b => b.onclick = () => { S.cfg.auto = b.dataset.auto === 'on';cfgSave();render(); });
  root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { S.cfg.mode = b.dataset.mode;cfgSave();render(); });
  root.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    if (b.dataset.kind === 'phone') S.cfg.mode = 'phone';
    else if (S.cfg.mode === 'phone') S.cfg.mode = 'smart';
    cfgSave();render();
  });
  root.querySelectorAll('[data-phone]').forEach(b => b.onclick = () => {
    const [lo, hi] = b.dataset.phone.split(':').map(Number);
    S.cfg.mode = 'phone';S.cfg.phoneMin = lo;S.cfg.phoneMax = hi;cfgSave();render();
  });
  root.querySelectorAll('[data-fixed]').forEach(b => b.onclick = () => { S.cfg.mode = 'fixed';S.cfg.digits = Number(b.dataset.fixed);cfgSave();render(); });
  root.querySelectorAll('[data-count]').forEach(b => b.onclick = () => { S.cfg.count = Number(b.dataset.count);cfgSave();render(); });
}
function pressDigit(d) {
  if (S.result || S.input.length >= 12) return;
  cancelAutoNext();
  if (S.firstAt === 0 && S.endedAt) S.firstAt = performance.now();
  const chars = [...S.input];
  const at = Math.min(S.caret, chars.length);
  chars.splice(at, 0, d);
  S.input = chars.join('');
  S.caret = at + 1;
  render();
}
function clearInput() {
  if (S.result) return;
  cancelAutoNext();
  S.input = '';S.caret = 0;render();
}
function delBack() {
  if (S.result) return;
  cancelAutoNext();
  const chars = [...S.input];
  if (!chars.length) return;
  const at = Math.min(S.caret, chars.length);
  if (at > 0) { chars.splice(at - 1, 1);S.input = chars.join('');S.caret = at - 1;render(); }
}
function delForward() {
  if (S.result) return;
  cancelAutoNext();
  const chars = [...S.input];
  const at = Math.min(S.caret, chars.length);
  if (at < chars.length) { chars.splice(at, 1);S.input = chars.join('');render(); }
}
function moveCaret(step) {
  if (S.result) return;
  const len = [...S.input].length;
  S.caret = Math.max(0, Math.min(len, S.caret + step));
  render();
}
function act(a) {
  if (a === 'start') return startSession();
  if (a === 'back') { if (S.screen === 'history') { S.screen = 'home';render(); } else leaveToHome(true); return; }
  if (a === 'home') { S.screen = 'home';S.session = null;S.result = null;S.input = '';render();refreshHistory();return; }
  if (a === 'history') return openHistory();
  if (a === 'settings') return toast('在上方切换位数和每轮题数。');
  if (a === 'theme') return themeToggle();
  if (a === 'srchint') return toast(SOURCE_HINT[currentQ()?.source] || '这轮按记录自动配题。');
  if (a === 'play') return playCurrent();
  if (a === 'retryAudio') return loadAndPlay(currentQ());
  if (a === 'del') return delBack();
  if (a === 'clear') return clearInput();
  if (a === 'replay') return playCurrent(true);
  if (a === 'hint') { if (!S.result) { S.hint = true;render(); } return; }
  if (a === 'skip') return submit(true);
  if (a === 'confirm') return submit(false);
  if (a === 'next') return nextQuestion();
  if (a === 'again') return startSession();
  if (a === 'retry') return retryErrors();
}

async function startSession(override = null) {
  const token = ++S.token;
  cancelAutoNext();clearRun();S.screen = 'loading';S.result = null;S.answers = [];S.index = 0;S.input = '';S.caret = 0;render();
  try {
    const data = await api('/sessions', override || S.cfg);
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
  cancelAutoNext();S.input = '';S.caret = 0;S.result = null;S.endedAt = 0;S.firstAt = 0;S.submitMs = null;
  S.replay = false;S.hint = false;S.plays = 0;S.timingValid = true;S.invalidReason = null;S.assistedThis = false;
  S.playState = 'idle';S.note = '';
}
async function enterQuestion({ draft = '' } = {}) {
  resetQuestionState();S.input = draft;S.caret = [...draft].length;render();
  const q = currentQ();if (!q) return;
  await loadAndPlay(q);
}
async function loadAndPlay(q) {
  const token = S.token;
  S.playState = 'loading';render();
  if (!S.meta?.tts) { await playCurrent();return; }   // 只有服务端明确没有语音时才用浏览器朗读
  try {
    let ok = await player.load(q.audioUrl);
    if (token !== S.token) return;
    if (!ok.ok) {                                     // 冷缓存偶发慢，重试一次再报错
      await new Promise(r => setTimeout(r, 250));
      if (token !== S.token) return;
      ok = await player.load(q.audioUrl);
      if (token !== S.token) return;
    }
    if (!ok.ok) {
      S.playState = 'error';S.note = '音频没准备好，点下面重试';S.timingValid = false;S.invalidReason = 'audio_load';
      render();return;
    }
    await playCurrent();
  } catch {
    if (token !== S.token) return;
    S.playState = 'error';S.note = '音频加载失败，点下面重试';S.timingValid = false;S.invalidReason = 'audio_load';
    render();
  }
}
async function playCurrent(isReplay = false) {
  const q = currentQ();if (!q) return;
  if (S.result && !isReplay) return;
  cancelAutoNext();   // 想再听就别把题换掉
  if (isReplay || S.plays > 0) S.replay = true;
  const token = S.token;
  S.playState = 'playing';render();
  if (!S.meta?.tts) {
    if (!('speechSynthesis' in window)) { S.playState = 'error';S.note = '此设备不支持朗读';render();return; }
    S.browserVoice = true;
    await new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(q.text.replace(/-/g, ' '));u.lang = 'en-US';u.rate = S.cfg.rate;
      try { const v = speechSynthesis.getVoices().find(x => /^en(-|_)/i.test(x.lang));if (v) u.voice = v; } catch { /* 忽略 */ }
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
  else if (out.reason === 'autoplay') S.playState = 'blocked';
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
  const graded = skip ? { correct: false, status: 'skipped' }
    : (q.mode === 'phone' ? M.gradePhone(q.value, S.input) : M.gradeAnswer(q.value, S.input));
  S.assistedThis = S.replay || S.hint;
  const errorTags = graded.correct || skip ? [] : M.classifyError(q.value, graded.normalized);
  S.result = { correct: !!graded.correct, answer: q.value, text: q.text, errorTags, skip, mode: q.mode || 'number', display: q.mode === 'phone' ? M.groupDigits(q.value) : null };
  S.answers[S.index] = { correct: !!graded.correct, skip, assisted: S.assistedThis, submitMs: S.submitMs, errorTags };
  render();
  persist(skip);
  scheduleAutoNext();
  const next = S.session?.questions?.[S.index + 1];
  if (next && S.meta?.tts && player) player.warm(next.audioUrl);
}
function persist(skip) {
  const q = currentQ();
  const event = {
    eventId: crypto.randomUUID(), sessionId: S.session.id, questionId: q.id, mode: q.mode || 'number',
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
function primaryDoneAction() {
  if (document.querySelector('[data-act="retry"]')) return retryErrors();
  return startSession();
}
function retryErrors() {
  const wrong = S.answers.map((a, i) => ({ a, i })).filter(x => x.a && !x.a.correct && !x.a.skip);
  const feats = [...new Set(wrong.map(x => S.session?.questions?.[x.i]?.feature).filter(f => f && M.FEATURE_LABELS[f]))];
  if (!feats.length) return;
  const base = S.session?.config || S.cfg;
  startSession({ ...base, count: Math.min(20, Math.max(10, feats.length * 4)), focus: feats });
}
function scheduleAutoNext() {
  cancelAutoNext();
  if (!S.cfg.auto || !S.result?.correct || S.result.skip) return;
  const tryAdvance = (left = 40) => {
    S.autoTimer = null;
    if (S.screen !== 'train' || !S.result?.correct) return;
    if (S.playState === 'playing' && left > 0) { S.autoTimer = setTimeout(() => tryAdvance(left - 1), 300);return; }
    nextQuestion();
  };
  S.autoTimer = setTimeout(() => tryAdvance(), 900);
}
function cancelAutoNext() {
  if (S.autoTimer) { clearTimeout(S.autoTimer);S.autoTimer = null; }
}
function nextQuestion() {
  cancelAutoNext();
  if (S.index + 1 >= (S.session?.questions.length || 0)) return finishRound();
  S.index++;S.result = null;enterQuestion();
}
async function finishRound() {
  const token = ++S.token;
  S.screen = 'done';S.result = null;S.finishSummary = null;S.finishState = 'loading';render();
  // 汇总前先把最后一条作答传完，否则服务端统计会少一题。
  try { await queue.flush(); } catch { /* 离线时按已落盘部分汇总 */ }
  try {
    const out = await api(`/sessions/${S.session.id}/finish`, {});
    if (token !== S.token) return;
    S.finishSummary = out;S.finishState = 'ready';render();
  } catch {
    if (token !== S.token) return;
    S.finishSummary = null;S.finishState = 'error';render();
  }
  refreshSummary();refreshHistory();
}
function leaveToHome(confirmLeave) {
  if (confirmLeave && S.screen === 'train' && S.session && S.answers.length && S.answers.length < S.session.questions.length) {
    if (!window.confirm('这一轮还没做完。离开后本轮记录会保留，但要重新开始一轮。')) return;
  }
  cancelAutoNext();clearRun();S.token++;S.screen = 'home';S.session = null;S.result = null;S.input = '';S.caret = 0;
  if (player) player.stop();
  S.pending = queue ? queue.pendingCount() : 0;
  refreshSummary();refreshHistory();render();
}
async function refreshSummary() {
  try { const s = await api('/summary');S.summary = s;if (S.screen === 'home') render(); } catch { /* 忽略 */ }
}
async function refreshHistory() {
  try {
    const h = await api('/history?limit=8');S.history = h;
    if (S.screen === 'home' || S.screen === 'history') render();
  } catch { /* 忽略 */ }
}
function openHistory() {
  S.screen = 'history';render();
  if (!S.history) refreshHistory();
}
function dayLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso), t = new Date();
  const same = d.toDateString() === t.toDateString();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  return same ? `今天 ${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/* ---------- 生命周期 ---------- */
export async function mount(el) {
  if (!el) return;
  if (S.mounted && root === el) return;
  if (S.mounted) leave();
  root = el;S.mounted = true;S.token++;
  cfgLoad();themeLoad();
  player = createPlayer();
  queue = createQueue({ onChange: n => { S.pending = n;if (S.screen === 'home') render(); } });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('keydown', onKeydown);
  render();
  try { S.meta = await api('/config'); } catch { S.meta = { tts: false }; }
  if (!S.mounted) return;
  S.pending = queue.pendingCount();
  queue.flush().catch(() => { });
  render();
  refreshSummary();refreshHistory();
  resumeRun();
}
export function leave() {
  S.mounted = false;S.token++;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  document.removeEventListener('keydown', onKeydown);
  if (player) { player.dispose();player = null; }
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
function onKeydown(e) {
  if (!S.mounted || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const eat = () => { e.preventDefault();e.stopPropagation(); };
  if (S.screen === 'home') { if (e.key === 'Enter') { eat();startSession(); } return; }
  if (S.screen === 'done') { if (e.key === 'Enter') { eat();primaryDoneAction(); } return; }
  if (S.screen !== 'train') return;
  if (/^[0-9]$/.test(e.key)) { eat();pressDigit(e.key);return; }
  if (e.key === 'Backspace') { eat();delBack();return; }
  if (e.key === 'Delete') { eat();delForward();return; }
  if (e.key === 'ArrowLeft') { eat();moveCaret(-1);return; }
  if (e.key === 'ArrowRight') { eat();moveCaret(1);return; }
  if (e.key === 'Home') { eat();S.caret = 0;render();return; }
  if (e.key === 'End') { eat();S.caret = [...S.input].length;render();return; }
  if (e.key === 'Enter') { eat();act(S.result ? 'next' : 'confirm');return; }
  if (e.key === ' ') { eat();act('replay');return; }
  const k = e.key.toLowerCase();
  if (k === 'r') { eat();act('replay');return; }
  if (k === 'c') { eat();clearInput();return; }
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
    // 读音版本变了（例如 0 从 zero 改成 oh）就不再续做旧轮，避免继续听旧音频。
    const stale = (data.questions || []).some(q => q.readingVersion && q.readingVersion !== M.READING_VERSION);
    if (stale) { clearRun();return; }
    const idx = Number.isInteger(saved.index) && saved.index >= 0 && saved.index < data.questions.length ? saved.index : 0;
    S.session = data;S.screen = 'train';S.index = idx;
    S.answers = Array.isArray(saved.answers) ? saved.answers.slice(0, idx + 1) : [];
    render();
    await enterQuestion({ draft: typeof saved.input === 'string' ? saved.input : '' });
  } catch { clearRun(); }
}

function toast(text) {
  if (!root) return;
  let t = $('#nt-toast', root);
  if (!t) { t = document.createElement('div');t.id = 'nt-toast';t.className = 'nt-toast';root.appendChild(t); }
  t.textContent = text;t.hidden = false;
  clearTimeout(toast._t);toast._t = setTimeout(() => { if (t) t.hidden = true; }, 2400);
}
