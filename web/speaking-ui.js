/* 口语课后练 (ndf-07) — 挂载在视频课「练习」页签。
   四种卡: 复述(retell) / 面试(interview) / 发音(listenpick+shadowread) / 练习题(chunkmark+dictation+classify+pick)。
   听后复述先听后看文; 首答/重说分开保存; 照读、跟读记为 practice 不计入独立作答。
   依赖全局: $, esc, api, EplodRecords(scoreTokens/normTokens)。参考音为合成朗读(页面有标注)。 */
(function () {
'use strict';
const SPK = window.SPK = { cur: null, data: null, rec: null, stream: null, refAudio: null };

/* ---------- 小工具 ---------- */
const WORD_RE = /[A-Za-z0-9'’-]+/g;
function words(s) { return String(s || '').match(WORD_RE) || []; }
function normWord(w) { return w.toLowerCase().replace(/[’]/g, "'"); }
/* 作答记录里词级对照的字段名：旧记录写 ev，新记录写 eval（与服务端 payload 同名） */
function evOf(e) { return (e && (e.eval || e.ev)) || {}; }
/* 判定分词复用 EnglishPod 那套归一：缩写(You'll = You will)、英式拼写、数字读法、语气词
   都归到同一条 token。不归一的话，学生把 You'll 说成 You will 会被判成「漏词 You'll / 多出 You will」
   ——用户 2026-11-05 实报词准 92%，其实一个字都没错。 */
function normTokens(s) {
  const E = window.EplodRecords;
  if (E && typeof E.normTokens === 'function') { try { const t = E.normTokens(String(s || '')); if (t.length) return t; } catch (e) {} }
  return words(s).map(normWord);
}
/* 每个原词展开成若干判定 token，记住它来自第几个原词，好把结果回显到原文上 */
function wordTokens(text) {
  const ws = words(text), toks = [], byWord = ws.map(() => []);
  ws.forEach((w, wi) => {
    const t = normTokens(w);
    (t.length ? t : [normWord(w)]).forEach(x => { byWord[wi].push(toks.length); toks.push({ t: x, wi }); });
  });
  return { ws, toks, byWord };
}
function diffWords(target, mine) {
  const A = wordTokens(target), B = wordTokens(mine);
  const a = A.toks, b = B.toks, n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    dp[i][j] = a[i - 1].t === b[j - 1].t ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const okA = new Array(n).fill(false), okB = new Array(m).fill(false);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1].t === b[j - 1].t) { okA[i - 1] = true; okB[j - 1] = true; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--;
  }
  const miss = [], extra = [];
  A.ws.forEach((w, wi) => { const own = A.byWord[wi]; if (own.length && !own.some(k => okA[k])) miss.push(w); });
  B.ws.forEach((w, wi) => { const own = B.byWord[wi]; if (own.length && !own.some(k => okB[k])) extra.push(w); });
  const matched = okA.reduce((s, x) => s + (x ? 1 : 0), 0);
  return { acc: n ? matched / n : 0, miss, extra };
}
function chunkCuts(item) {
  /* 讲义分块 → 词间切点集合(切在第 k 个词之前, k 从 1 起) */
  const cuts = []; let acc = 0;
  for (let c = 0; c < item.chunks.length - 1; c++) { acc += words(item.chunks[c]).length; cuts.push(acc); }
  return cuts;
}
function fmt2(s) { return String(Math.floor(s)).padStart(2, '0'); }
/* 标题里常带「（点词间空隙插入 /）」这类操作说明，与下方 hint 重复；统一只留任务名。 */
function headTitle(t) { return esc(String(t || '').replace(/（[^）]*）/g, '').trim()); }
/* 「标断句 · 校园问路 6 句（点词间空隙插入 /）」→ 类型 + 主题。
   句数/题数已经由右侧计数(0/6)承担，标题里再写一遍既长又重复；括号里的操作说明也由 hint 承担。 */
function titleParts(task) {
  const raw = String((task && task.title) || '');
  const core = raw.replace(/（[^）]*）/g, '').trim();
  const m = core.match(/^(.+?)\s*·\s*(.+)$/);
  const kind = m ? m[1].trim() : '';
  let topic = (m ? m[2] : core).trim();
  topic = topic.replace(/\s*\d+\s*(句|组|题|条)\s*$/, '').trim();
  return { kind, topic: topic || core };
}
/* 卡片头部统一：类型标签 + 主题 + 一句操作提示 */
function headHTML(task, hint) {
  const { kind, topic } = titleParts(task);
  return '<div class="spk-head">' + (kind ? '<span class="spk-kind">' + esc(kind) + '</span>' : '')
    + '<b>' + esc(topic) + '</b>' + (hint ? '<span class="spk-hint">' + esc(hint) + '</span>' : '') + '</div>';
}
function spkNote(msg, isErr, tag) {
  const n = document.querySelector('#spk-note');
  if (!n) return;
  n.style.display = ''; n.className = 'gq-note' + (isErr ? ' spk-err' : '');
  n.dataset.tag = tag || '';
  n.textContent = msg;
}
function spkClearNote() { const n = document.querySelector('#spk-note'); if (n) { n.style.display = 'none'; n.textContent = ''; n.dataset.tag = ''; } }
function spkRefUrl(text) { return '/api/speaking/tts?text=' + encodeURIComponent(text); }
/* 参考音复用同一个 audio；播放期间按钮变「停止」，再点一次=停止并回到开头（下次从头重放） */
let refBtn = null, refText = '';
function spkRefReset() {
  if (refBtn) { try { refBtn.textContent = refText; } catch (e) {} }
  refBtn = null; refText = '';
}
function stopRef() {
  const a = SPK.refAudio;
  if (a) { try { a.pause(); } catch (e) {} try { a.currentTime = 0; } catch (e) {} }
  spkRefReset();
}
/* 返回 true=开始播放，false=已停止（调用方可据此决定要不要计次） */
function playRef(url, btn, playingText) {
  if (!url) return false;
  if (!SPK.refAudio) {
    SPK.refAudio = new Audio();
    SPK.refAudio.addEventListener('ended', spkRefReset);
    SPK.refAudio.addEventListener('error', spkRefReset);
  }
  const a = SPK.refAudio;
  if (a.getAttribute('src') === url && !a.paused) { stopRef(); return false; }   // 正在播同一条 → 停
  stopRef();
  a.src = url;
  if (btn) { refBtn = btn; refText = btn.textContent; btn.textContent = playingText || '⏹ 停止'; }
  a.play().catch(() => { spkRefReset(); spkNote('参考音播放失败，请检查网络或稍后再试', true); });
  return true;
}

/* ---------- 录音 ---------- */
async function ensureMic() {
  if (SPK.stream && SPK.stream.active) return SPK.stream;
  SPK.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return SPK.stream;
}
function pickMime() {
  const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
async function startRec() {
  const stream = await ensureMic();
  stopRef();
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = res; });
  rec.start(250);
  SPK.rec = { rec, chunks, done, t0: Date.now(), mime: mimeType || 'audio/webm' };
  return SPK.rec;
}
async function stopRec() {
  const r = SPK.rec; if (!r) return null;
  SPK.rec = null;
  try { r.rec.stop(); } catch (e) {}
  await r.done;
  const blob = new Blob(r.chunks, { type: r.mime });
  const dur = Math.max(0.3, (Date.now() - r.t0) / 1000);
  return { blob, dur, mime: r.mime };
}
/* 麦克风失败原因翻成人话：原始 e.message 是英文浏览器术语 */
function micErrText(e) {
  const m = String((e && e.message) || '');
  if (/denied|not allowed|permission/i.test(m)) return '麦克风权限被拒绝：请在浏览器地址栏的麦克风图标里允许本站使用麦克风，然后重试。';
  if (/not found|no .*device|找不到/i.test(m)) return '没有检测到可用麦克风：请插上麦克风或换个输入设备后重试。';
  return '麦克风不可用：' + m + '。请检查设备后重试。';
}
/* 取消：停下并丢弃这段录音，不上传、不判分、不计次 */
async function abortRec() {
  const r = SPK.rec; if (!r) return false;
  SPK.rec = null;
  try { r.rec.stop(); } catch (e) {}
  try { await r.done; } catch (e) {}
  return true;
}
async function blobDataURI(blob) {
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error('读取录音失败'));
    fr.readAsDataURL(blob);
  });
}
async function uploadTake(lessonId, taskKey, ix, blob, mime) {
  const takeId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const dataURI = await blobDataURI(blob);
  const r = await api('/api/speaking/recording', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId, taskKey, ix, takeId, audio: dataURI }) });
  r._mime = mime;
  return r;
}
async function asrText(blob) {
  const dataURI = await blobDataURI(blob);
  const r = await api('/api/eplod/asr', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: dataURI }) });
  return r.text || '';
}
/* 作答：先更本地(UI 立即响应) → 再入队上传。上传失败留在本机队列，下次保存/进页时自动补传，
   断网或接口抖动都不丢作答。队列按「课-任务-题号-阶段-时间戳」去重，重传不会重复计次。 */
const SPK_QKEY = 'tfl-spk-queue';
function spkPending() {
  try { const v = JSON.parse(localStorage.getItem(SPK_QKEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function spkSetPending(list) { try { localStorage.setItem(SPK_QKEY, JSON.stringify(list.slice(-400))); } catch (e) {} }
function spkPayload(p) {
  return { lessonId: p.lessonId, taskKey: p.taskKey, ix: p.ix, stage: p.stage,
    ...(p.entry.transcript != null ? { transcript: p.entry.transcript } : {}),
    ...(p.entry.dur != null ? { dur: p.entry.dur } : {}),
    ...(p.entry.take ? { take: p.entry.take } : {}),
    ...(p.entry.eval || p.entry.ev ? { eval: p.entry.eval || p.entry.ev } : {}),
    ...(p.entry.result ? { result: p.entry.result } : {}) };
}
let SPK_FLUSHING = null;
function spkFlush() {
  if (SPK_FLUSHING) return SPK_FLUSHING;
  SPK_FLUSHING = (async () => {
    /* 每轮都从 localStorage 重读：上传期间新作的答会 push 进来，
       不能拿着旧数组 shift 后整份写回——那会把并发进来的一条抹掉（deep review 2026-11-06） */
    for (;;) {
      const list = spkPending();
      if (!list.length) break;
      const p = list[0];
      try {
        await api('/api/speaking/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spkPayload(p)) });
        spkSetPending(spkPending().filter(x => x.qid !== p.qid));   // 只移除已上传的这一条
      } catch (e) {
        spkNote('这次作答已存在本机，联网后会自动补传（' + e.message.slice(0, 40) + '）', true, 'queue');
        break;
      }
    }
    if (!spkPending().length) {
      const n = document.querySelector('#spk-note');
      if (n && n.dataset.tag === 'queue') spkClearNote();   // 只清「待补传」提示, 不动其他错误提示
    }
  })().finally(() => { SPK_FLUSHING = null; });
  return SPK_FLUSHING;
}
function saveAttempt(lessonId, taskKey, ix, stage, entry) {
  /* 参数护栏：漏传 lessonId/entry 会让 entry.at 直接炸掉整张卡（r11 线上事故） */
  if (!lessonId || !taskKey || !entry || typeof entry !== 'object' || !Number.isInteger(ix)) {
    console.error('[speaking] saveAttempt 参数不完整', {lessonId, taskKey, ix, stage, hasEntry: !!entry});
    spkNote('保存参数异常，本次没有记录（已上报）', true, 'bug');
    return;
  }
  const tasks = SPK.data.attempts.tasks;
  const t = tasks[taskKey] = tasks[taskKey] || { items: {} };
  t.items = t.items || {};
  const it = t.items[ix] = t.items[ix] || { practice: [] };
  if (stage === 'practice') { it.practice = (it.practice || []).concat([entry]).slice(-20); }
  else it[stage] = entry;
  renderTaskList();
  const pending = spkPending();
  pending.push({ lessonId, taskKey, ix, stage, entry, qid: [lessonId, taskKey, ix, stage, entry.at].join('|') });
  spkSetPending(pending);
  const flushP = spkFlush();
  if (typeof window.spkNavRefresh === 'function') window.spkNavRefresh();   // 课程列表的练习进度要跟着变
  return flushP;   // 调用方（助教）要等作答落库后才拿得到
}

/* ---------- 卡片渲染 ---------- */
function taskDone(tkey, ix) {
  const it = SPK.data.attempts.tasks[tkey]?.items?.[ix];
  if (!it) return {attempted: false, ok: false};
  const prac = Array.isArray(it.practice) ? it.practice : [];
  const last = prac.length ? prac[prac.length - 1] : null;
  if (it.first) {                       // 复述/面试/跟读：按最近一次的转写词准判「做对」
    const e = it.retry || it.first;
    const acc = e && Number.isFinite(evOf(e).acc) ? evOf(e).acc : null;
    return {attempted: true, ok: acc == null ? true : acc >= 0.9};
  }
  return {attempted: !!prac.length, ok: !!(last && last.result && last.result.ok)};
}
function renderTaskList() {
  const box = document.querySelector('#spk-tasks'); if (!box) return;
  const d = SPK.data;
  box.innerHTML = d.lesson.tasks.map((t, ti) => {
    const states = t.items.map((_, i) => taskDone(t.key, i));
    const doneCount = states.filter(x => x.attempted).length;
    const allAttempted = doneCount === t.items.length;
    const allOk = allAttempted && states.every(x => x.ok);
    const open = SPK.cur.taskKey === t.key;
    const parts = titleParts(t);
    return '<button class="spk-task' + (open ? ' on' : '') + '" data-ti="' + ti + '" title="' + esc(t.title) + '">'
      + '<span class="spk-task-dot ' + (allOk ? 'spk-task-dot--ok' : doneCount ? 'spk-task-dot--partial' : '') + '"></span>'
      + (parts.kind ? '<span class="spk-task-k">' + esc(parts.kind) + '</span>' : '')
      + '<span class="spk-task-t">' + esc(parts.topic) + '</span>'
      + '<span class="spk-task-n">' + doneCount + '/' + t.items.length + '</span></button>';
  }).join('');
  box.querySelectorAll('.spk-task').forEach(b => { b.onclick = () => openTask(Number(b.dataset.ti)); });
}
/* 助教文本里可能混进 HTML 实体（模型习惯）或已转义的旧记录，显示前先还原成字符 */
function coachText(text) {
  let t = String(text || '');
  if (/&[a-zA-Z#0-9]+;/.test(t)) {
    const el = document.createElement('textarea');
    el.innerHTML = t;
    t = el.value;
  }
  return t;
}
function coachHTML(text) {
  /* 只在逐行渲染时 esc 一次：外层再 esc 会把 &quot; 变成 &amp;quot;，页面显示出一串 &quot; */
  return coachText(text).split('\n').filter(Boolean).map(line => {
    const cls = line.startsWith('✗') ? 'spk-ck-bad' : line.startsWith('✓') ? 'spk-ck-good' : '';
    return '<div class="spk-coach-line ' + cls + '">' + esc(line).replace(/^(&#10003;|&#10007;|✓|✗)/, '<b>$1</b>') + '</div>';
  }).join('');
}
function evalHTML(ev, sec) {
  const parts = [];
  if (ev && Number.isFinite(ev.acc)) parts.push('词准粗测 <b>' + Math.round(ev.acc * 100) + '%</b>');
  if (ev && ev.miss && ev.miss.length) parts.push('待核对漏词: <span class="spk-miss">' + esc(ev.miss.join(' / ')) + '</span>');
  if (ev && ev.extra && ev.extra.length) parts.push('多出或替换: <span class="spk-extra">' + esc(ev.extra.join(' / ')) + '</span>');
  if (sec) parts.push('参考时长 ' + sec + 's');
  return parts.length ? '<div class="spk-eval">' + parts.join(' · ') + '</div>' : '';
}
function coachBoxHTML() { return '<div class="spk-coach" id="spk-coach" hidden></div>'; }
async function runCoach(taskKey, ix, stage, box) {
  box.hidden = false; box.innerHTML = '<div class="spk-coach-line">🤖 助教正在按本课方法检查…</div>';
  try {
    const r = await api('/api/speaking/coach', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: SPK.cur.lessonId, taskKey, ix, stage }) });
    box.innerHTML = coachHTML(r.text || '（助教没有返回内容）');
  } catch (e) {
    box.innerHTML = '<div class="spk-coach-line">🤖 助教暂时不可用（' + esc(e.message) + '）。上方的词准粗测与漏词核对仍然有效。</div>';
  }
}
function showTranscriptDiff(box, item, transcript, ev, opts) {
  const t = words(item.text);
  const mw = new Set((ev.miss || []).map(normWord));
  const ex = new Set((ev.extra || []).map(normWord));
  const targetHTML = t.map(w => {
    const hit = !mw.has(normWord(w));
    return '<span class="' + (hit ? '' : 'spk-w-miss') + '">' + esc(w) + '</span>';
  }).join(' ');
  const mineHTML = words(transcript).map(w => {
    const bad = ex.has(normWord(w));
    return '<span class="' + (bad ? 'spk-w-extra' : '') + '">' + esc(w) + '</span>';
  }).join(' ');
  box.innerHTML = '<div class="spk-diff"><div class="spk-diff-row"><span class="k">原文</span>' + targetHTML + '</div>'
    + '<div class="spk-diff-row"><span class="k">你的转写</span>' + (mineHTML || '<i>(空)</i>') + '</div></div>'
    + (opts && opts.evalHTML || '');
}

/* ---------- 复述卡 / 面试卡 ---------- */
function renderSpeakCard(host, task) {
  const d = SPK.data, isInterview = task.type === 'interview';
  host.innerHTML = headHTML(task, (isInterview ? '无准备时间 · 每题 45 秒' : '先听后说 · 每句 ' + (task.sec || 12) + ' 秒内')
    + ' · 参考音为合成朗读')
    + '<div class="spk-actions"><button class="spk-sec" id="spk-play">▶ 听' + (isInterview ? '题' : '这句') + '</button>'
    + '<button class="pri" id="spk-rec" disabled>🎙 按住说完点这里（开始录音）</button>'
    + '<button class="spk-cancel" id="spk-cancel" hidden>✕ 取消</button>'
    + '<span class="spk-timer" id="spk-timer"></span></div>'
    + '<div id="spk-result"></div>' + coachBoxHTML()
    + '<div class="spk-nav"><button id="spk-prev">‹ 上一句</button><span id="spk-pos"></span><button id="spk-next">下一句 ›</button></div>';
  let ix = SPK.cur.ix;
  let attempt = null;   // {transcript, dur, ev, takeUrl}
  const playBtn = host.querySelector('#spk-play'), recBtn = host.querySelector('#spk-rec');
  const cancelBtn = host.querySelector('#spk-cancel');
  const timer = host.querySelector('#spk-timer'), result = host.querySelector('#spk-result');
  const coach = host.querySelector('#spk-coach');
  const idleLabel = () => attempt
    ? (isInterview ? '🎙 重说一次' : '🎙 重说一次（撤掉原文）')
    : (isInterview ? '🎙 开始作答（45 秒）' : '🎙 听完开始录音');
  const paintPos = () => { host.querySelector('#spk-pos').textContent = (ix + 1) + ' / ' + task.items.length; };
  const loadIx = () => {
    attempt = null; result.innerHTML = ''; coach.hidden = true; recBtn.disabled = false;
    playBtn.disabled = false;             // 上一句录音被导航打断时可能残留在禁用态
    recBtn.textContent = isInterview ? '🎙 开始作答（45 秒）' : '🎙 听完开始录音';
    cancelBtn.hidden = true; cancelBtn.disabled = false;
    paintPos();
    const item = task.items[ix];
    playBtn.onclick = () => playRef(spkRefUrl(item.text), playBtn, '⏹ 停止');
    recBtn.onclick = () => onRec(item);
    const saved = d.attempts.tasks[task.key]?.items?.[ix];
    if (saved?.first) restore(saved);
  };
  function restore(saved) {
    attempt = saved.first;
    recBtn.textContent = '🎙 重录首答'; paintResult('已保存的首答：');
    if (saved.first.coach) { coach.hidden = false; coach.innerHTML = coachHTML(saved.first.coach); }
    if (saved.retry) paintRetry(saved.retry);
  }
  function paintResult(prefix) {
    const item = task.items[ix];
    /* 面试题没有范文，拿答案去跟题干做词比对毫无意义（此前就是这么比的，会显示一堆假漏词），
       只回显回答与用时，内容判断交给助教。 */
    result.innerHTML = '<div class="spk-done">' + esc(prefix) + '</div>'
      + (isInterview
        ? '<div class="spk-zh">题目：' + esc(item.text || '') + '</div>'
          + '<div class="spk-diff"><div class="spk-diff-row"><span class="k">你的回答</span>' + (esc(attempt.transcript) || '<i>(空)</i>') + '</div></div>'
          + '<div class="spk-eval">用时 ' + esc(String(attempt.dur || 0)) + ' 秒 · 参考 45 秒</div>'
          + '<div id="spk-hearbox"></div>'
        : '<div class="spk-zh">' + esc(item.zh || '') + '</div><div id="spk-diffbox"></div><div id="spk-hearbox"></div>');
    if (!isInterview) {
      const diffbox = host.querySelector('#spk-diffbox');
      showTranscriptDiff(diffbox, item, attempt.transcript, evOf(attempt), { evalHTML: evalHTML(evOf(attempt), task.sec) });
    }
    if (attempt.take) {
      const hb = host.querySelector('#spk-hearbox');
      hb.innerHTML = '<button class="spk-mini" id="spk-hear">🔊 回听我的录音</button>';
      const hearBtn = hb.querySelector('#spk-hear');
      hearBtn.onclick = () => playRef(attempt.take, hearBtn, '⏹ 停止');
    }
  }
  function paintRetry(savedRetry) {
    if (!savedRetry) return;
    const div = host.querySelector('#spk-retrybox') || result.appendChild(Object.assign(document.createElement('div'), { id: 'spk-retrybox', className: 'spk-retry' }));
    div.innerHTML = '<div class="spk-done">重说：' + esc(savedRetry.transcript || '') + '</div>';
  }
  async function onRec(item) {
    if (SPK.rec) {                       // 正在录 → 停止并提交
      cancelBtn.hidden = true; cancelBtn.disabled = false;
      playBtn.disabled = true;          // 录音中不播参考音，免得录进去
      recBtn.disabled = true; recBtn.textContent = '转写中…';
      try {
        const stopped = await stopRec();
        timer.textContent = '';
        if (!stopped || stopped.blob.size < 800) { spkNote('这次录音太短，没有提交。请点开始后再说话。', true); return; }
        // 存档与转写并行：先发存档（失败只影响回听），转写决定成绩
        let uploadErr = null;
        const uploadP = uploadTake(d.lessonId, task.key, ix, stopped.blob, stopped.mime)
          .then(t => t.url).catch(e => { uploadErr = e; return null; });
        let transcript = '';
        try { transcript = await asrText(stopped.blob); }
        catch (e) { spkNote('这次没转写成功：' + e.message + '（录音已留存，可直接重说）', true, 'asr'); return; }
        if (!transcript) { spkNote('没有识别到语音内容，请再试一次（录音已留存）。', true, 'asr'); return; }
        const stage = attempt ? 'retry' : 'first';
        /* 复述题有原文可比才做词级对照；面试题只有题干，比对答案与题干只会产出假漏词 */
        const ev = isInterview ? null : diffWords(item.text, transcript);
        const entry = { at: Date.now(), transcript, dur: Math.round(stopped.dur * 10) / 10,
          ...(ev ? { eval: { acc: ev.acc, miss: ev.miss.slice(0, 8), extra: ev.extra.slice(0, 8) } } : {}) };
        const takeUrl = await uploadP;
        if (takeUrl) entry.take = takeUrl;
        attempt = entry;
        const savedP = saveAttempt(d.lessonId, task.key, ix, stage, entry);
        result.innerHTML = '';
        paintResult(stage === 'retry' ? '重说已保存：' : '首答已保存：');
        if (stage === 'retry') paintRetry(entry);
        if (uploadErr) spkNote('本次成绩已记录，但录音没存上（' + uploadErr.message + '），所以不能回听。', true, 'upload');
        await (savedP || Promise.resolve()).catch(() => {});   // 先落库再叫助教, 慢网下不再撞「attempt not found」
        await runCoach(task.key, ix, stage, coach);
      } catch (e) {
        spkNote('这次没有判分：' + e.message, true);
      } finally {
        recBtn.disabled = false; playBtn.disabled = false;
        recBtn.textContent = idleLabel();
      }
      return;
    }
    // 开始录音
    spkClearNote();
    try { await startRec(); } catch (e) { spkNote(micErrText(e), true); return; }
    recBtn.textContent = '⏹ 结束录音';
    cancelBtn.hidden = false; cancelBtn.disabled = false;
    playBtn.disabled = true;            // 录音中不播参考音，免得录进去
    const limit = isInterview ? 45 : (task.sec || 12) + 3;
    const tick = setInterval(() => {
      if (!SPK.rec) { clearInterval(tick); return; }   // 先判空再读 t0：停止录音后 tick 会读到 null
      const s = (Date.now() - SPK.rec.t0) / 1000;
      timer.innerHTML = '<i class="spk-recdot" aria-hidden="true"></i>剩余 ' + Math.max(0, Math.ceil(limit - s)) + 's';
      if (s >= limit) { clearInterval(tick); onRec(item); }
    }, 250);
  }
  /* 取消：停下丢弃，不上传不判分，按钮复位 */
  cancelBtn.onclick = async () => {
    if (!SPK.rec) { cancelBtn.hidden = true; return; }
    cancelBtn.disabled = true;
    await abortRec();
    timer.textContent = '';
    cancelBtn.hidden = true; cancelBtn.disabled = false;
    recBtn.disabled = false; playBtn.disabled = false; recBtn.textContent = idleLabel();
    spkNote('已取消这段录音，没有记录。', false, 'cancel');
  };
  host.querySelector('#spk-prev').onclick = async () => { if (ix > 0) { stopRef(); await abortRec(); timer.textContent = ''; ix--; SPK.cur.ix = ix; loadIx(); } };
  host.querySelector('#spk-next').onclick = async () => { if (ix < task.items.length - 1) { stopRef(); await abortRec(); timer.textContent = ''; ix++; SPK.cur.ix = ix; loadIx(); } };
  loadIx();
}

/* ---------- 发音卡 ---------- */
function renderShadowCard(host, task) {
  const d = SPK.data;
  host.innerHTML = headHTML(task, '看原文 → 听示范 → 录音跟读 → A/B 对照自评（记为练习，不算独立作答）')
    + '<div id="spk-shadow"></div><div class="spk-nav"><button id="spk-prev">‹ 上一句</button><span id="spk-pos"></span><button id="spk-next">下一句 ›</button></div>';
  let ix = SPK.cur.ix;
  const box = host.querySelector('#spk-shadow'), pos = host.querySelector('#spk-pos');
  function paint() {
    const item = task.items[ix];
    pos.textContent = (ix + 1) + ' / ' + task.items.length;
    box.innerHTML = '<div class="spk-sentence">' + esc(item.text) + '</div>'
      + '<div class="spk-tips">' + (item.tips || []).map(x => '<span>' + esc(x) + '</span>').join('') + '</div>'
      + '<div class="spk-actions"><button class="spk-sec" id="spk-play">🔊 听示范</button>'
      + '<button class="pri" id="spk-rec">🎙 录音跟读</button>'
      + '<button class="spk-cancel" id="spk-cancel" hidden>✕ 取消</button>'
      + '<span class="spk-timer" id="spk-timer"></span></div>'
      + '<div id="spk-shadow-result"></div>';
    const result = box.querySelector('#spk-shadow-result');
    const playBtn = box.querySelector('#spk-play'), cancelBtn = box.querySelector('#spk-cancel');
    const timer = box.querySelector('#spk-timer');
    const idle = () => (result.innerHTML ? '🎙 重录' : '🎙 录音跟读');
    playBtn.onclick = () => playRef(spkRefUrl(item.text), playBtn, '⏹ 停止');
    const recBtn = box.querySelector('#spk-rec');
    recBtn.onclick = async () => {
      if (SPK.rec) {
        cancelBtn.hidden = true; cancelBtn.disabled = false;
        playBtn.disabled = true;            // 录音中不播参考音，免得录进去
        recBtn.disabled = true; recBtn.textContent = '转写中…';
        try {
          const stopped = await stopRec();
          timer.textContent = '';
          if (!stopped || stopped.blob.size < 800) { spkNote('这次录音太短，没有提交。', true); return; }
          // 存档与转写并行（存档失败只影响 A/B 回听）
          let take = null, uploadErr = null;
          const uploadP = uploadTake(d.lessonId, task.key, ix, stopped.blob, stopped.mime)
            .then(t => t).catch(e => { uploadErr = e; return null; });
          const transcript = await asrText(stopped.blob);
          if (!transcript) { spkNote('没有识别到语音内容，请再试一次（录音已尽量留存）。', true); return; }
          const ev = diffWords(item.text, transcript);
          const said = new Set(normTokens(transcript));
          const focusHit = (item.focus || []).filter(f => { const t = normTokens(f); return t.length && t.every(x => said.has(x)); });
          take = await uploadP;
          if (uploadErr) spkNote('跟读结果已记录，但录音没存上（' + uploadErr.message + '），不能用示范 A/B 对照。', true, 'upload');
          saveAttempt(d.lessonId, task.key, ix, 'practice', { at: Date.now(), transcript, dur: Math.round(stopped.dur * 10) / 10, ...(take ? { take: take.url } : {}), result: { ok: focusHit.length === (item.focus || []).length, n: focusHit.length, total: (item.focus || []).length } });
          result.innerHTML = '<div id="spk-diffbox"></div>'
            + '<div class="spk-eval">目标词命中 ' + focusHit.length + '/' + (item.focus || []).length + '（' + esc(focusHit.join(' / ') || '—') + '）'
            + ' · <button class="spk-mini" id="spk-ab-ref">🔊 示范</button>' + (take ? ' <button class="spk-mini" id="spk-ab-me">🔊 我的录音</button>' : '') + '</div>'
            + '<div class="spk-selfcheck">' + (item.tips || []).map((x, i) => '<label><input type="checkbox" data-i="' + i + '"> ' + esc(x) + '</label>').join('') + '</div>'
            + '<div class="spk-note-ok">自评勾选后本句即完成（练习记录）。</div>';
          showTranscriptDiff(result.querySelector('#spk-diffbox'), item, transcript, ev, {});
          result.querySelector('#spk-ab-ref').onclick = (e) => playRef(spkRefUrl(item.text), e.currentTarget, '⏹ 停止');
          const abMe = result.querySelector('#spk-ab-me');
          if (abMe) abMe.onclick = (e) => playRef(take.url, e.currentTarget, '⏹ 停止');
        } catch (e) { spkNote('这次没有结果：' + e.message, true); }
        finally { recBtn.disabled = false; playBtn.disabled = false; recBtn.textContent = idle(); }
        return;
      }
      spkClearNote();
      try { await startRec(); } catch (e) { spkNote(micErrText(e), true); return; }
      recBtn.textContent = '⏹ 结束录音';
      cancelBtn.hidden = false; cancelBtn.disabled = false;
      playBtn.disabled = true;              // 录音中不播参考音，免得录进去
      const tick = setInterval(() => {
        if (!SPK.rec) { clearInterval(tick); return; }
        timer.innerHTML = '<i class="spk-recdot" aria-hidden="true"></i>' + fmt2(Math.floor((Date.now() - SPK.rec.t0) / 1000)) + 's';
      }, 250);
    };
    cancelBtn.onclick = async () => {
      if (!SPK.rec) { cancelBtn.hidden = true; return; }
      cancelBtn.disabled = true;
      await abortRec();
      timer.textContent = '';
      cancelBtn.hidden = true; cancelBtn.disabled = false;
      recBtn.disabled = false; playBtn.disabled = false; recBtn.textContent = idle();
      spkNote('已取消这段录音，没有记录。', false, 'cancel');
    };
  }
  host.querySelector('#spk-prev').onclick = async () => { if (ix > 0) { stopRef(); await abortRec(); ix--; SPK.cur.ix = ix; paint(); } };
  host.querySelector('#spk-next').onclick = async () => { if (ix < task.items.length - 1) { stopRef(); await abortRec(); ix++; SPK.cur.ix = ix; paint(); } };
  paint();
}
function renderPickCard(host, task) {
  const d = SPK.data;
  let ix = 0, correct = 0, played = null;
  host.innerHTML = headHTML(task, '听机器读一个词，点你听到的那个。机器判对错。')
    + '<div id="spk-pick"></div><div class="spk-nav"><span id="spk-tally"></span></div>';
  const box = host.querySelector('#spk-pick'), tally = host.querySelector('#spk-tally');
  function paint() {
    const item = task.items[ix];
    played = Math.random() < 0.5 ? item.pair[0] : item.pair[1];
    box.innerHTML = '<div class="spk-progress">第 ' + (ix + 1) + ' / ' + task.items.length + ' 组</div>'
      + '<div class="spk-actions"><button class="pri" id="spk-play">🔊 播放（可重复听）</button></div>'
      + '<div class="spk-options">' + item.pair.map((w, i) => '<button class="spk-opt" data-i="' + i + '">' + esc(w) + '</button>').join('') + '</div>'
      + '<div id="spk-pick-fb"></div>';
    tally.textContent = '已对 ' + correct + ' 题';
    const pickPlay = box.querySelector('#spk-play');
    pickPlay.onclick = () => playRef(spkRefUrl(played), pickPlay, '⏹ 停止');
    box.querySelectorAll('.spk-opt').forEach(b => {
      b.onclick = () => {
        const ok = item.pair[Number(b.dataset.i)] === played;
        if (ok) correct++;
        box.querySelectorAll('.spk-opt').forEach(x => x.disabled = true);
        saveAttempt(d.lessonId, task.key, ix, 'practice', { at: Date.now(), result: { ok, n: ok ? 1 : 0, total: 1 } });
        box.querySelector('#spk-pick-fb').innerHTML = '<div class="' + (ok ? 'spk-ok' : 'spk-bad') + '">' + (ok ? '✓ 对，刚才读的是 <b>' + esc(played) + '</b>' : '✗ 刚才读的是 <b>' + esc(played) + '</b>') + '</div>'
          + '<button class="pri" id="spk-nextpair">' + (ix + 1 < task.items.length ? '下一组 →' : '完成') + '</button>';
        box.querySelector('#spk-nextpair').onclick = () => {
          if (ix + 1 < task.items.length) { ix++; paint(); }
          else {
            box.innerHTML = '<div class="spk-done">听辨完成：' + correct + ' / ' + task.items.length + '。错得多的组，回到上面的跟读任务多练几遍。</div>';
            tally.textContent = '';
          }
        };
      };
    });
  }
  paint();
}

/* ---------- 练习题卡 ----------
   一个主按钮走完全程：核对断句 → 下一句 → 完成。上一句是次级图标；清空/听示范是静音次级。
   不再出现「正文一个下一句 + 底部一个下一句」的重复导航。 */
function renderChunkCard(host, task) {
  const d = SPK.data;
  const shortTitle = task.title.replace(/（[^）]*）/g, '').trim();
  let ix = SPK.cur.ix;
  host.innerHTML = headHTML(task, task.hint || '点词间空隙标断句')
    + '<div id="spk-chunk"></div>';
  const box = host.querySelector('#spk-chunk');
  let cuts = new Set(), checked = false, primary = null;
  function paint() {
    const item = task.items[ix];
    const ws = words(item.text);
    cuts = new Set(); checked = false;
    box.innerHTML = '<div class="spk-meta">第 ' + (ix + 1) + ' / ' + task.items.length + ' 句</div>'
      + '<div class="spk-words" id="spk-words"></div>'
      + '<div class="spk-foot"><button class="spk-mini" id="spk-prev"' + (ix === 0 ? ' disabled style="visibility:hidden"' : '') + ' aria-label="上一句">‹</button>'
      + '<button class="pri" id="spk-primary">核对断句</button>'
      + '<span class="spk-foot-side" id="spk-foot-side"><button class="spk-mini" id="spk-clear">清空</button>'
      + '<button class="spk-mini" id="spk-play" title="听示范" aria-label="听示范">🔊</button></span></div>'
      + '<div id="spk-chunk-fb"></div>';
    const wbox = box.querySelector('#spk-words');
    ws.forEach((w, i) => {
      if (i > 0) {
        const g = document.createElement('button');
        g.className = 'spk-gap'; g.textContent = '/';
        g.setAttribute('aria-label', '在第 ' + i + ' 个词后断句');
        g.onclick = () => { if (checked) return; if (cuts.has(i)) cuts.delete(i); else cuts.add(i); g.classList.toggle('on', cuts.has(i)); };
        wbox.appendChild(g);
      }
      wbox.appendChild(Object.assign(document.createElement('span'), { className: 'spk-word', textContent: w }));
    });
    box.querySelector('#spk-prev').onclick = () => { if (ix > 0) { ix--; SPK.cur.ix = ix; paint(); } };
    box.querySelector('#spk-clear').onclick = () => {
      cuts.clear();
      wbox.querySelectorAll('.spk-gap').forEach(g => g.classList.remove('on'));
      box.querySelector('#spk-chunk-fb').innerHTML = '';
    };
    const chunkPlay = box.querySelector('#spk-play');
    chunkPlay.onclick = () => playRef(spkRefUrl(item.text), chunkPlay, '⏹');   // 图标按钮：播放中变成停止
    primary = box.querySelector('#spk-primary');
    primary.onclick = () => { if (checked) advance(); else check(); };
    primary.focus({ preventScroll: true });
  }
  function check() {
    const item = task.items[ix];
    const want = new Set(chunkCuts(item));
    let hit = 0;
    want.forEach(c => { if (cuts.has(c)) hit++; });
    const extra = [...cuts].filter(c => !want.has(c)).length;
    const perfect = hit === want.size && extra === 0;
    checked = true;
    box.querySelectorAll('.spk-gap').forEach(g => { g.disabled = true; });
    box.querySelector('#spk-clear').style.display = 'none';
    const last = ix + 1 >= task.items.length;
    const fb = box.querySelector('#spk-chunk-fb');
    fb.innerHTML =
      '<div class="' + (perfect ? 'spk-ok' : 'spk-bad') + '">' + (perfect ? '✓ 全对' : '断点 ' + hit + '/' + want.size + (extra ? '，多标 ' + extra + ' 处' : '')) + '</div>'
      + '<div class="spk-ref">' + item.chunks.map(c => '<span>' + esc(c) + '</span>').join('<b class="spk-slash">/</b>') + '</div>';
    if (perfect) {
      primary.textContent = last ? '完成本任务' : '下一句 →';
      primary.onclick = advance;
    } else {
      /* 标错了要能改：主按钮变「再标一次」，旁边给次级「下一句」可以跳过 */
      primary.textContent = '再标一次';
      primary.onclick = () => { cuts = new Set(); paint(); };
      box.querySelector('#spk-foot-side').insertAdjacentHTML('afterbegin',
        '<button class="spk-mini" id="spk-skip">下一句 →</button>');
      box.querySelector('#spk-skip').onclick = advance;
    }
    primary.focus({ preventScroll: true });
    saveAttempt(d.lessonId, task.key, ix, 'practice', { at: Date.now(), result: { ok: perfect, n: hit, total: want.size } });
  }
  function advance() {
    if (ix + 1 < task.items.length) { ix++; SPK.cur.ix = ix; paint(); box.scrollIntoView({ block: 'nearest' }); }
    else box.innerHTML = '<div class="spk-done">这组断句做完了（' + task.items.length + ' 句）。换上面其他任务继续，或去「讲义」对照老师的讲解。</div>';
  }
  host.onkeydown = e => { if (e.key === 'Enter' && primary) { e.preventDefault(); primary.click(); } };
  paint();
}
function renderDictationCard(host, task) {
  const d = SPK.data;
  let ix = 0, plays = 0;
  host.innerHTML = headHTML(task, '听写句子，最多听 3 遍。标点不计，单词拼写与单复数要写对。') + '<div id="spk-dict"></div>';
  const box = host.querySelector('#spk-dict');
  function paint() {
    const item = task.items[ix]; plays = 0;
    box.innerHTML = '<div class="spk-progress">第 ' + (ix + 1) + ' / ' + task.items.length + ' 句（还可听 <span id="spk-plays">' + task.plays + '</span> 遍）</div>'
      + '<div class="spk-actions"><button class="pri" id="spk-play">🔊 播放</button></div>'
      + '<textarea id="spk-dt" rows="2" placeholder="写出你听到的句子（Enter 提交）"></textarea>'
      + '<div class="spk-actions"><button class="pri" id="spk-submit">提交</button></div><div id="spk-dict-fb"></div>';
    const ta = box.querySelector('#spk-dt');
    const dictPlay = box.querySelector('#spk-play');
    dictPlay.onclick = () => {
      if (dictPlay.textContent.indexOf('停止') >= 0) { stopRef(); return; }   // 播放中点=停止，不算听一遍
      if (plays >= task.plays) { spkNote('这一句的播放次数用完了，先写再核对。', true); return; }
      plays++; box.querySelector('#spk-plays').textContent = task.plays - plays;
      playRef(spkRefUrl(item.text), dictPlay, '⏹ 停止');
    };
    const submit = () => {
      const ev = diffWords(item.text, ta.value);
      const ok = ev.acc >= 0.99;
      const fb = box.querySelector('#spk-dict-fb');
      fb.innerHTML = '<div class="' + (ok ? 'spk-ok' : 'spk-bad') + '">' + (ok ? '✓ 全对' : '词准 ' + Math.round(ev.acc * 100) + '%') + '</div>'
        + '<div class="spk-diff"><div class="spk-diff-row"><span class="k">原文</span>' + words(item.text).map(w => '<span class="' + (ev.miss.map(normWord).includes(normWord(w)) ? 'spk-w-miss' : '') + '">' + esc(w) + '</span>').join(' ') + '</div>'
        + '<div class="spk-diff-row"><span class="k">你写</span>' + words(ta.value).map(w => '<span class="' + (ev.extra.map(normWord).includes(normWord(w)) ? 'spk-w-extra' : '') + '">' + esc(w) + '</span>').join(' ') + '</div></div>'
        + '<button class="pri" id="spk-nextdict">' + (ix + 1 < task.items.length ? '下一句 →' : '完成') + '</button>';
      saveAttempt(d.lessonId, task.key, ix, 'practice', { at: Date.now(), transcript: ta.value, result: { ok, n: Math.round(ev.acc * words(item.text).length), total: words(item.text).length } });
      fb.querySelector('#spk-nextdict').onclick = () => { if (ix + 1 < task.items.length) { ix++; paint(); } else box.innerHTML = '<div class="spk-done">听写完成。</div>'; };
    };
    box.querySelector('#spk-submit').onclick = submit;
    ta.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  }
  paint();
}
function renderClassifyCard(host, task) {
  const d = SPK.data;
  let ix = 0, correct = 0;
  host.innerHTML = headHTML(task, '判断这条规则属于哪一档强制程度。') + '<div id="spk-cl"></div>';
  const box = host.querySelector('#spk-cl');
  function paint() {
    const item = task.items[ix];
    box.innerHTML = '<div class="spk-progress">第 ' + (ix + 1) + ' / ' + task.items.length + ' 条 · 已对 ' + correct + '</div>'
      + '<div class="spk-sentence">' + esc(item.text) + '</div>'
      + '<div class="spk-options spk-cats">' + task.categories.map((c, i) => '<button class="spk-opt" data-i="' + i + '">' + esc(c) + '</button>').join('') + '</div>'
      + '<div id="spk-cl-fb"></div>';
    box.querySelectorAll('.spk-opt').forEach(b => {
      b.onclick = () => {
        const ok = Number(b.dataset.i) === item.cat;
        if (ok) correct++;
        box.querySelectorAll('.spk-opt').forEach(x => x.disabled = true);
        saveAttempt(d.lessonId, task.key, ix, 'practice', { at: Date.now(), result: { ok, n: ok ? 1 : 0, total: 1 } });
        box.querySelector('#spk-cl-fb').innerHTML = '<div class="' + (ok ? 'spk-ok' : 'spk-bad') + '">' + (ok ? '✓ 对' : '✗ 应属「' + esc(task.categories[item.cat]) + '」') + '</div>'
          + '<button class="pri" id="spk-nextcl">' + (ix + 1 < task.items.length ? '下一条 →' : '完成') + '</button>';
        box.querySelector('#spk-nextcl').onclick = () => {
          if (ix + 1 < task.items.length) { ix++; paint(); }
          else box.innerHTML = '<div class="spk-done">归类完成：' + correct + ' / ' + task.items.length + '。易混的是 are supposed to 与 are required to 的强度差别——回去对照第 05 课讲义再看一遍。</div>';
        };
      };
    });
  }
  paint();
}
function renderSimplePickCard(host, task) {
  const d = SPK.data;
  let ix = 0, correct = 0;
  host.innerHTML = headHTML(task, '看中文选英文。') + '<div id="spk-p"></div>';
  const box = host.querySelector('#spk-p');
  function paint() {
    const item = task.items[ix];
    box.innerHTML = '<div class="spk-progress">第 ' + (ix + 1) + ' / ' + task.items.length + ' 题 · 已对 ' + correct + '</div>'
      + '<div class="spk-sentence">' + esc(item.prompt) + '</div>'
      + '<div class="spk-options">' + (item.options || []).map((o, i) => '<button class="spk-opt" data-i="' + i + '">' + esc(o) + '</button>').join('') + '</div>'
      + '<div id="spk-p-fb"></div>';
    box.querySelectorAll('.spk-opt').forEach(b => {
      b.onclick = () => {
        const ok = Number(b.dataset.i) === item.answer;
        if (ok) correct++;
        box.querySelectorAll('.spk-opt').forEach(x => x.disabled = true);
        saveAttempt(d.lessonId, task.key, ix, 'practice', { at: Date.now(), result: { ok, n: ok ? 1 : 0, total: 1 } });
        box.querySelector('#spk-p-fb').innerHTML = '<div class="' + (ok ? 'spk-ok' : 'spk-bad') + '">' + (ok ? '✓ 对' : '✗ 正确是 <b>' + esc(item.options[item.answer]) + '</b>') + '</div>'
          + '<button class="pri" id="spk-nextp">' + (ix + 1 < task.items.length ? '下一题 →' : '完成') + '</button>';
        box.querySelector('#spk-nextp').onclick = () => {
          if (ix + 1 < task.items.length) { ix++; paint(); }
          else box.innerHTML = '<div class="spk-done">完成：' + correct + ' / ' + task.items.length + '。</div>';
        };
      };
    });
  }
  paint();
}

/* ---------- 入口 ---------- */
const RENDERERS = {
  retell: renderSpeakCard, interview: renderSpeakCard, shadowread: renderShadowCard,
  listenpick: renderPickCard, chunkmark: renderChunkCard, dictation: renderDictationCard,
  classify: renderClassifyCard, pick: renderSimplePickCard,
};
function openTask(ti) {
  const d = SPK.data;
  SPK.cur.taskKey = d.lesson.tasks[ti].key;
  SPK.cur.ix = 0;
  const host = document.querySelector('#spk-card');
  (RENDERERS[d.lesson.tasks[ti].type] || renderSpeakCard)(host, d.lesson.tasks[ti]);
  renderTaskList();
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function wire(course, lesson) {
  if (!course || course.id !== 'ndf-07' || !lesson) return;
  const body = document.querySelector('#spk-body');
  if (!body) return;
  if (SPK.cur && SPK.cur.lessonId === lesson.id && SPK.cur.wired) return;
  stopRef();
  if (SPK.rec) { try { SPK.rec.rec.stop(); } catch (e) {} SPK.rec = null; }
  body.innerHTML = '<p class="gq-note">正在加载口语课后练…</p>';
  try {
    const r = await api('/api/speaking/lesson/' + encodeURIComponent(lesson.id));
    SPK.cur = { lessonId: lesson.id, taskKey: null, ix: 0, wired: true };
    SPK.data = r;
    SPK.data.lessonId = r.lesson.lessonId;   /* 卡片里统一用 d.lessonId */
    const caps = [];
    if (!r.ttsOk) caps.push('参考音（TTS 未配置）');
    if (!r.asrOk) caps.push('转写判分（ASR 未配置）');
    if (!r.aiOk) caps.push('AI 助教讲解');
    body.innerHTML = '<div class="spk-intro">' + esc(r.lesson.intro || '') + '</div>'
      + (caps.length ? '<div class="spk-caps">本页不可用：' + esc(caps.join('、')) + '（服务端未配置对应能力）</div>' : '')
      + '<div id="spk-tasks" class="spk-tasks"></div>'
      + '<div class="spk-note gq-note" id="spk-note" style="display:none"></div>'
      + '<div id="spk-card" class="card spk-cardbox"></div>';
    SPK.cur.taskKey = r.lesson.tasks[0].key;
    openTask(0);
    if (spkPending().length) spkFlush();   // 上次没传成功的作答, 进页即补传
  } catch (e) {
    body.innerHTML = '<div class="empty">口语课后练加载失败：' + esc(e.message) + '。<button class="pri" id="spk-retry">重试</button></div>';
    const b = body.querySelector('#spk-retry');
    if (b) b.onclick = () => { SPK.cur = null; wire(course, lesson); };
  }
}
function leave() {
  stopRef();
  if (SPK.rec) { try { SPK.rec.rec.stop(); } catch (e) {} SPK.rec = null; }
  if (SPK.stream) { try { SPK.stream.getTracks().forEach(t => t.stop()); } catch (e) {} SPK.stream = null; }
  if (SPK.cur) SPK.cur = { ...SPK.cur, wired: false };
}
window.SPK = { wire, leave, get state() { return SPK; } };
})();
