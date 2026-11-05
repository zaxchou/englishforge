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
function diffWords(target, mine) {
  const a = words(target).map(normWord), b = words(mine).map(normWord);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const miss = [], extra = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { extra.unshift(words(mine)[j - 1]); j--; }
    else { miss.unshift(words(target)[i - 1]); i--; }
  }
  return { acc: n ? (n - miss.length) / n : 0, miss, extra };
}
function chunkCuts(item) {
  /* 讲义分块 → 词间切点集合(切在第 k 个词之前, k 从 1 起) */
  const cuts = []; let acc = 0;
  for (let c = 0; c < item.chunks.length - 1; c++) { acc += words(item.chunks[c]).length; cuts.push(acc); }
  return cuts;
}
function fmt2(s) { return String(Math.floor(s)).padStart(2, '0'); }
function spkNote(msg, isErr) {
  const n = document.querySelector('#spk-note');
  if (!n) return;
  n.style.display = ''; n.className = 'gq-note' + (isErr ? ' spk-err' : '');
  n.textContent = msg;
}
function spkClearNote() { const n = document.querySelector('#spk-note'); if (n) { n.style.display = 'none'; n.textContent = ''; } }
function spkRefUrl(text) { return '/api/speaking/tts?text=' + encodeURIComponent(text); }
function stopRef() { if (SPK.refAudio) { try { SPK.refAudio.pause(); } catch (e) {} } }

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
function saveAttempt(lessonId, taskKey, ix, stage, entry) {
  const tasks = SPK.data.attempts.tasks;
  const t = tasks[taskKey] = tasks[taskKey] || { items: {} };
  t.items = t.items || {};
  const it = t.items[ix] = t.items[ix] || { practice: [] };
  if (stage === 'practice') { it.practice = (it.practice || []).concat([entry]).slice(-20); }
  else it[stage] = entry;
  renderTaskList();
}

/* ---------- 卡片渲染 ---------- */
function taskDone(tkey, ix) {
  const it = SPK.data.attempts.tasks[tkey]?.items?.[ix];
  return !!(it && (it.first || (it.practice && it.practice.length)));
}
function renderTaskList() {
  const box = document.querySelector('#spk-tasks'); if (!box) return;
  const d = SPK.data;
  box.innerHTML = d.lesson.tasks.map((t, ti) => {
    const doneCount = t.items.filter((_, i) => taskDone(t.key, i)).length;
    const all = doneCount === t.items.length;
    const open = SPK.cur.taskKey === t.key;
    return '<button class="spk-task' + (open ? ' on' : '') + '" data-ti="' + ti + '" title="' + esc(t.title) + '">'
      + '<span class="spk-task-dot ' + (all ? 'spk-task-dot--ok' : doneCount ? 'spk-task-dot--partial' : '') + '"></span>'
      + '<span class="spk-task-t">' + esc(t.title) + '</span>'
      + '<span class="spk-task-n">' + doneCount + '/' + t.items.length + '</span></button>';
  }).join('');
  box.querySelectorAll('.spk-task').forEach(b => { b.onclick = () => openTask(Number(b.dataset.ti)); });
}
function coachHTML(text) {
  return esc(text).split('\n').filter(Boolean).map(line => {
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
  host.innerHTML = '<div class="spk-head"><b>' + esc(task.title) + '</b><span class="spk-hint">'
    + (isInterview ? '无准备时间 · 每题 45 秒' : '先听后说 · 每句 ' + (task.sec || 12) + ' 秒内')
    + ' · 参考音为合成朗读</span></div>'
    + '<div class="spk-actions"><button class="pri" id="spk-play">▶ 听' + (isInterview ? '题' : '这句') + '</button>'
    + '<button class="pri" id="spk-rec" disabled>🎙 按住说完点这里（开始录音）</button>'
    + '<span class="spk-timer" id="spk-timer"></span></div>'
    + '<div id="spk-result"></div>' + coachBoxHTML()
    + '<div class="spk-nav"><button id="spk-prev">‹ 上一句</button><span id="spk-pos"></span><button id="spk-next">下一句 ›</button></div>';
  let ix = SPK.cur.ix;
  let attempt = null;   // {transcript, dur, ev, takeUrl}
  const playBtn = host.querySelector('#spk-play'), recBtn = host.querySelector('#spk-rec');
  const timer = host.querySelector('#spk-timer'), result = host.querySelector('#spk-result');
  const coach = host.querySelector('#spk-coach');
  const paintPos = () => { host.querySelector('#spk-pos').textContent = (ix + 1) + ' / ' + task.items.length; };
  const loadIx = () => {
    attempt = null; result.innerHTML = ''; coach.hidden = true; recBtn.disabled = false;
    recBtn.textContent = isInterview ? '🎙 开始作答（45 秒）' : '🎙 听完开始录音';
    paintPos();
    const item = task.items[ix];
    playBtn.onclick = () => { stopRef(); if (!SPK.refAudio) SPK.refAudio = new Audio(); SPK.refAudio.src = spkRefUrl(item.text); SPK.refAudio.play().catch(() => spkNote('参考音播放失败，请检查网络或稍后再试', true)); };
    recBtn.onclick = () => onRec(item);
    const saved = d.attempts.tasks[task.key]?.items?.[ix];
    if (saved?.first) restore(saved);
  };
  function restore(saved) {
    attempt = saved.first;
    recBtn.textContent = '🎙 重录首答'; paintResult('已保存的首答：');
    if (saved.first.coach) { coach.hidden = false; coach.innerHTML = coachHTML(saved.first.coach); }
    if (saved.retry) paintRetry(saved.retry);
    if (attempt.take) {
      const b = host.querySelector('#spk-hear');
      if (b) b.onclick = () => { stopRef(); if (!SPK.refAudio) SPK.refAudio = new Audio(); SPK.refAudio.src = attempt.take; SPK.refAudio.play(); };
    }
  }
  function paintResult(prefix) {
    const item = task.items[ix];
    result.innerHTML = '<div class="spk-done">' + esc(prefix) + '</div>'
      + '<div class="spk-zh">' + esc(item.zh || '') + '</div>'
      + '<div id="spk-diffbox"></div><div id="spk-hearbox"></div>';
    const diffbox = host.querySelector('#spk-diffbox');
    showTranscriptDiff(diffbox, item, attempt.transcript, attempt.ev || {}, { evalHTML: evalHTML(attempt.ev, isInterview ? 45 : task.sec) });
    if (attempt.take) {
      const hb = host.querySelector('#spk-hearbox');
      hb.innerHTML = '<button class="spk-mini" id="spk-hear">🔊 回听我的录音</button>';
    }
  }
  function paintRetry(savedRetry) {
    if (!savedRetry) return;
    const div = host.querySelector('#spk-retrybox') || result.appendChild(Object.assign(document.createElement('div'), { id: 'spk-retrybox', className: 'spk-retry' }));
    div.innerHTML = '<div class="spk-done">重说：' + esc(savedRetry.transcript || '') + '</div>';
  }
  async function onRec(item) {
    if (SPK.rec) {                       // 正在录 → 停止并提交
      recBtn.disabled = true; recBtn.textContent = '转写中…';
      let stopped;
      try { stopped = await stopRec(); } catch (e) { spkNote('录音结束失败：' + e.message, true); recBtn.disabled = false; return; }
      timer.textContent = '';
      if (!stopped || stopped.blob.size < 800) { spkNote('这次录音太短，没有提交。请点开始后再说话。', true); recBtn.disabled = false; return; }
      try {
        const take = await uploadTake(d.lessonId, task.key, ix, stopped.blob, stopped.mime);
        const transcript = await asrText(stopped.blob);
        if (!transcript) { spkNote('没有识别到语音内容，请再试一次（录音已保留）。', true); recBtn.disabled = false; return; }
        const stage = attempt ? 'retry' : 'first';
        const ev = diffWords(item.text, transcript);
        entry = { at: Date.now(), transcript, dur: Math.round(stopped.dur * 10) / 10, take: take.url, ev: { acc: ev.acc, miss: ev.miss.slice(0, 8), extra: ev.extra.slice(0, 8) } };
        saveAttempt(task.key, ix, stage, entry);
        attempt = entry;
        recBtn.textContent = isInterview ? '🎙 重说一次' : '🎙 重说一次（撤掉原文）';
        result.innerHTML = '';
        paintResult(stage === 'retry' ? '重说已保存：' : '首答已保存：');
        if (stage === 'retry') paintRetry(entry);
        await runCoach(task.key, ix, stage, coach);
        recBtn.disabled = false;
      } catch (e) {
        spkNote('提交失败：' + e.message + '。录音未上传成功，请重试。', true);
        recBtn.disabled = false;
      }
      return;
    }
    // 开始录音
    spkClearNote();
    try { await startRec(); } catch (e) { spkNote('麦克风不可用：' + e.message + '。请允许麦克风权限后重试。', true); return; }
    recBtn.textContent = '⏹ 说完了，点这里结束';
    const limit = isInterview ? 45 : (task.sec || 12) + 3;
    const tick = setInterval(() => {
      const s = (Date.now() - SPK.rec.t0) / 1000;
      if (!SPK.rec) { clearInterval(tick); return; }
      timer.textContent = fmt2(Math.floor(s)) + 's';
      if (s >= limit) { clearInterval(tick); if (SPK.rec) onRec(item); }
    }, 250);
  }
  host.querySelector('#spk-prev').onclick = () => { if (ix > 0) { ix--; SPK.cur.ix = ix; loadIx(); } };
  host.querySelector('#spk-next').onclick = () => { if (ix < task.items.length - 1) { ix++; SPK.cur.ix = ix; loadIx(); } };
  loadIx();
}
let entry = null;   /* 当前正在提交的 attempt(见 onRec) */

/* ---------- 发音卡 ---------- */
function renderShadowCard(host, task) {
  const d = SPK.data;
  host.innerHTML = '<div class="spk-head"><b>' + esc(task.title) + '</b><span class="spk-hint">看原文 → 听示范 → 录音跟读 → A/B 对照自评（记为练习，不算独立作答）</span></div>'
    + '<div id="spk-shadow"></div><div class="spk-nav"><button id="spk-prev">‹ 上一句</button><span id="spk-pos"></span><button id="spk-next">下一句 ›</button></div>';
  let ix = SPK.cur.ix;
  const box = host.querySelector('#spk-shadow'), pos = host.querySelector('#spk-pos');
  function paint() {
    const item = task.items[ix];
    pos.textContent = (ix + 1) + ' / ' + task.items.length;
    box.innerHTML = '<div class="spk-sentence">' + esc(item.text) + '</div>'
      + '<div class="spk-tips">' + (item.tips || []).map(x => '<span>' + esc(x) + '</span>').join('') + '</div>'
      + '<div class="spk-actions"><button class="pri" id="spk-play">🔊 听示范</button>'
      + '<button class="pri" id="spk-rec">🎙 录音跟读</button><span class="spk-timer" id="spk-timer"></span></div>'
      + '<div id="spk-shadow-result"></div>';
    const result = box.querySelector('#spk-shadow-result');
    box.querySelector('#spk-play').onclick = () => { stopRef(); if (!SPK.refAudio) SPK.refAudio = new Audio(); SPK.refAudio.src = spkRefUrl(item.text); SPK.refAudio.play(); };
    const recBtn = box.querySelector('#spk-rec');
    recBtn.onclick = async () => {
      if (SPK.rec) {
        recBtn.disabled = true; recBtn.textContent = '转写中…';
        try {
          const stopped = await stopRec();
          const take = await uploadTake(d.lessonId, task.key, ix, stopped.blob, stopped.mime);
          const transcript = await asrText(stopped.blob);
          const ev = diffWords(item.text, transcript);
          const focusHit = (item.focus || []).filter(f => words(transcript).map(normWord).includes(normWord(f)));
          saveAttempt(d.lessonId, task.key, ix, 'practice', { at: Date.now(), transcript, dur: Math.round(stopped.dur * 10) / 10, take: take.url, result: { ok: focusHit.length === (item.focus || []).length, n: focusHit.length, total: (item.focus || []).length } });
          result.innerHTML = '<div id="spk-diffbox"></div>'
            + '<div class="spk-eval">目标词命中 ' + focusHit.length + '/' + (item.focus || []).length + '（' + esc(focusHit.join(' / ') || '—') + '）'
            + ' · <button class="spk-mini" id="spk-ab-ref">🔊 示范</button> <button class="spk-mini" id="spk-ab-me">🔊 我的录音</button></div>'
            + '<div class="spk-selfcheck">' + (item.tips || []).map((x, i) => '<label><input type="checkbox" data-i="' + i + '"> ' + esc(x) + '</label>').join('') + '</div>'
            + '<div class="spk-note-ok">自评勾选后本句即完成（练习记录）。</div>';
          showTranscriptDiff(result.querySelector('#spk-diffbox'), item, transcript, ev, {});
          result.querySelector('#spk-ab-ref').onclick = () => { stopRef(); if (!SPK.refAudio) SPK.refAudio = new Audio(); SPK.refAudio.src = spkRefUrl(item.text); SPK.refAudio.play(); };
          result.querySelector('#spk-ab-me').onclick = () => { stopRef(); if (!SPK.refAudio) SPK.refAudio = new Audio(); SPK.refAudio.src = take.url; SPK.refAudio.play(); };
        } catch (e) { spkNote('提交失败：' + e.message, true); }
        recBtn.disabled = false; recBtn.textContent = '🎙 重录';
        return;
      }
      spkClearNote();
      try { await startRec(); } catch (e) { spkNote('麦克风不可用：' + e.message, true); return; }
      recBtn.textContent = '⏹ 说完了，点这里结束';
    };
  }
  host.querySelector('#spk-prev').onclick = () => { if (ix > 0) { ix--; SPK.cur.ix = ix; paint(); } };
  host.querySelector('#spk-next').onclick = () => { if (ix < task.items.length - 1) { ix++; SPK.cur.ix = ix; paint(); } };
  paint();
}
function renderPickCard(host, task) {
  const d = SPK.data;
  let ix = 0, correct = 0, played = null;
  host.innerHTML = '<div class="spk-head"><b>' + esc(task.title) + '</b><span class="spk-hint">听机器读一个词，点你听到的那个。机器判对错。</span></div>'
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
    box.querySelector('#spk-play').onclick = () => { stopRef(); if (!SPK.refAudio) SPK.refAudio = new Audio(); SPK.refAudio.src = spkRefUrl(played); SPK.refAudio.play(); };
    box.querySelectorAll('.spk-opt').forEach(b => {
      b.onclick = () => {
        const ok = item.pair[Number(b.dataset.i)] === played;
        if (ok) correct++;
        box.querySelector('#spk-pick-fb').innerHTML = '<div class="' + (ok ? 'spk-ok' : 'spk-bad') + '">' + (ok ? '✓ 对，刚才读的是 <b>' + esc(played) + '</b>' : '✗ 刚才读的是 <b>' + esc(played) + '</b>') + '</div>'
          + '<button class="pri" id="spk-nextpair">' + (ix + 1 < task.items.length ? '下一组 →' : '完成，保存记录') + '</button>';
        box.querySelectorAll('.spk-opt').forEach(x => x.disabled = true);
        box.querySelector('#spk-nextpair').onclick = () => {
          if (ix + 1 < task.items.length) { ix++; paint(); }
          else {
            saveAttempt(d.lessonId, task.key, 0, 'practice', { at: Date.now(), result: { ok: correct === task.items.length, n: correct, total: task.items.length } });
            box.innerHTML = '<div class="spk-done">听辨完成：' + correct + ' / ' + task.items.length + '。错得多的组，回到上面的跟读任务多练几遍。</div>';
            tally.textContent = '';
          }
        };
      };
    });
  }
  paint();
}

/* ---------- 练习题卡 ---------- */
function renderChunkCard(host, task) {
  const d = SPK.data;
  let ix = SPK.cur.ix;
  host.innerHTML = '<div class="spk-head"><b>' + esc(task.title) + '</b><span class="spk-hint">点词与词之间的空隙插入「/」，标完点核对。依据：标点/主谓/从句/并列/介词短语。</span></div>'
    + '<div id="spk-chunk"></div>';
  const box = host.querySelector('#spk-chunk');
  function paint() {
    const item = task.items[ix];
    const ws = words(item.text);
    const cuts = new Set();
    box.innerHTML = '<div class="spk-progress">第 ' + (ix + 1) + ' / ' + task.items.length + ' 句</div>'
      + '<div class="spk-words" id="spk-words"></div>'
      + '<div class="spk-actions"><button class="pri" id="spk-check">核对断句</button> <button class="spk-mini" id="spk-clear">清空重标</button>'
      + ' <button class="spk-mini" id="spk-play">🔊 听整体节奏</button></div><div id="spk-chunk-fb"></div>';
    const wbox = box.querySelector('#spk-words');
    ws.forEach((w, i) => {
      if (i > 0) {
        const g = document.createElement('button');
        g.className = 'spk-gap'; g.textContent = '/';
        g.setAttribute('aria-label', '在第 ' + i + ' 个词后断句');
        g.onclick = () => { if (cuts.has(i)) cuts.delete(i); else cuts.add(i); g.classList.toggle('on', cuts.has(i)); };
        wbox.appendChild(g);
      }
      wbox.appendChild(Object.assign(document.createElement('span'), { className: 'spk-word', textContent: w }));
    });
    box.querySelector('#spk-clear').onclick = () => { cuts.clear(); wbox.querySelectorAll('.spk-gap').forEach(g => g.classList.remove('on')); box.querySelector('#spk-chunk-fb').innerHTML = ''; };
    box.querySelector('#spk-play').onclick = () => { stopRef(); if (!SPK.refAudio) SPK.refAudio = new Audio(); SPK.refAudio.src = spkRefUrl(item.text); SPK.refAudio.play(); };
    box.querySelector('#spk-check').onclick = () => {
      const want = new Set(chunkCuts(item));
      let hit = 0;
      want.forEach(c => { if (cuts.has(c)) hit++; });
      const extra = [...cuts].filter(c => !want.has(c)).length;
      const fb = box.querySelector('#spk-chunk-fb');
      const perfect = hit === want.size && extra === 0;
      fb.innerHTML = '<div class="' + (perfect ? 'spk-ok' : 'spk-bad') + '">' + (perfect ? '✓ 全对' : '断点 ' + hit + '/' + want.size + '，多标 ' + extra + ' 处。') + '参考断法：</div>'
        + '<div class="spk-ref">' + item.chunks.map(c => '<span>' + esc(c) + '</span>').join('<b class="spk-slash">/</b>') + '</div>';
      if (perfect) saveAttempt(d.lessonId, task.key, ix, 'practice', { at: Date.now(), result: { ok: true, n: want.size, total: want.size } });
    };
  }
  paint();
}
function renderDictationCard(host, task) {
  const d = SPK.data;
  let ix = 0, plays = 0;
  host.innerHTML = '<div class="spk-head"><b>' + esc(task.title) + '</b><span class="spk-hint">听写句子，最多听 3 遍。标点不计，单词拼写与单复数要写对。</span></div><div id="spk-dict"></div>';
  const box = host.querySelector('#spk-dict');
  function paint() {
    const item = task.items[ix]; plays = 0;
    box.innerHTML = '<div class="spk-progress">第 ' + (ix + 1) + ' / ' + task.items.length + ' 句（还可听 <span id="spk-plays">' + task.plays + '</span> 遍）</div>'
      + '<div class="spk-actions"><button class="pri" id="spk-play">🔊 播放</button></div>'
      + '<textarea id="spk-dt" rows="2" placeholder="写出你听到的句子（Enter 提交）"></textarea>'
      + '<div class="spk-actions"><button class="pri" id="spk-submit">提交</button></div><div id="spk-dict-fb"></div>';
    const ta = box.querySelector('#spk-dt');
    box.querySelector('#spk-play').onclick = () => { if (plays >= task.plays) { spkNote('这一句的播放次数用完了，先写再核对。', true); return; } plays++; box.querySelector('#spk-plays').textContent = task.plays - plays; stopRef(); if (!SPK.refAudio) SPK.refAudio = new Audio(); SPK.refAudio.src = spkRefUrl(item.text); SPK.refAudio.play(); };
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
  host.innerHTML = '<div class="spk-head"><b>' + esc(task.title) + '</b><span class="spk-hint">判断这条规则属于哪一档强制程度。</span></div><div id="spk-cl"></div>';
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
        box.querySelector('#spk-cl-fb').innerHTML = '<div class="' + (ok ? 'spk-ok' : 'spk-bad') + '">' + (ok ? '✓ 对' : '✗ 应属「' + esc(task.categories[item.cat]) + '」') + '</div>'
          + '<button class="pri" id="spk-nextcl">' + (ix + 1 < task.items.length ? '下一条 →' : '完成，保存') + '</button>';
        box.querySelectorAll('.spk-opt').forEach(x => x.disabled = true);
        box.querySelector('#spk-nextcl').onclick = () => {
          if (ix + 1 < task.items.length) { ix++; paint(); }
          else {
            saveAttempt(d.lessonId, task.key, 0, 'practice', { at: Date.now(), result: { ok: correct === task.items.length, n: correct, total: task.items.length } });
            box.innerHTML = '<div class="spk-done">归类完成：' + correct + ' / ' + task.items.length + '。</div>';
          }
        };
      };
    });
  }
  paint();
}
function renderSimplePickCard(host, task) {
  const d = SPK.data;
  let ix = 0, correct = 0;
  host.innerHTML = '<div class="spk-head"><b>' + esc(task.title) + '</b><span class="spk-hint">看中文选英文。</span></div><div id="spk-p"></div>';
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
        box.querySelector('#spk-p-fb').innerHTML = '<div class="' + (ok ? 'spk-ok' : 'spk-bad') + '">' + (ok ? '✓ 对' : '✗ 正确是 <b>' + esc(item.options[item.answer]) + '</b>') + '</div>'
          + '<button class="pri" id="spk-nextp">' + (ix + 1 < task.items.length ? '下一题 →' : '完成，保存') + '</button>';
        box.querySelectorAll('.spk-opt').forEach(x => x.disabled = true);
        box.querySelector('#spk-nextp').onclick = () => {
          if (ix + 1 < task.items.length) { ix++; paint(); }
          else {
            saveAttempt(d.lessonId, task.key, 0, 'practice', { at: Date.now(), result: { ok: correct === task.items.length, n: correct, total: task.items.length } });
            box.innerHTML = '<div class="spk-done">完成：' + correct + ' / ' + task.items.length + '。</div>';
          }
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
