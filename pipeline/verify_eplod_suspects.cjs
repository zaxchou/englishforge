#!/usr/bin/env node
'use strict';
// 二阶段复核: 对精筛后的嫌疑句, 切原音送 /api/eplod/asr(不带 ep/i = 无偏置),
// qwen 与官方文本再做同款句中差异判定; qwen 也判出句中差异的 = 高置信文本错误。
// 读 refined.json → 写 verified.json。顺序单进程, 失败跳过。
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const E = require('../web/eplod-records.js');

const dir = path.join(__dirname, '..', 'build', 'qa', 'eplod-text-audit');
const refined = JSON.parse(fs.readFileSync(path.join(dir, 'refined.json'), 'utf8')).items
  .filter(s => s.diffwords.length && s.diff <= 4);
const buildEp = path.join(__dirname, '..', 'build', 'eplod');
const audioLib = path.join(__dirname, '..', '..', 'EnglishPod音频库');

function align(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const pairs = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  pairs.reverse();
  const runs = (size, taken) => {
    const out = []; let start = null;
    for (let k = 0; k < size; k++) {
      if (taken.has(k)) { if (start !== null) { out.push([start, k - 1]); start = null; } }
      else if (start === null) start = k;
    }
    if (start !== null) out.push([start, size - 1]);
    return out;
  };
  const ma = new Set(pairs.map(p => p[0])), mb = new Set(pairs.map(p => p[1]));
  return [runs(n, ma), runs(m, mb)];
}

function midDiff(official, heard) {
  const ot = E.normTokens(official), ht = E.normTokens(heard);
  if (!ot.length || !ht.length) return null;
  const [ra, rb] = align(ot, ht);
  const badEdge = ra.some(([a]) => a === 0) || rb.some(([a]) => a === 0)
    || ra.some(([, b]) => b === ot.length - 1) || rb.some(([, b]) => b === ht.length - 1);
  if (badEdge) return null;
  const diffwords = [];
  for (const [a, b] of ra) diffwords.push('官:' + ot.slice(a, b + 1).join(' '));
  for (const [a, b] of rb) diffwords.push('听:' + ht.slice(a, b + 1).join(' '));
  return diffwords.length ? diffwords : null;
}

(async () => {
  const confirmed = [], log = [];
  let n = 0;
  for (const s of refined) {
    n++;
    const ep4 = String(s.ep).padStart(4, '0');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(buildEp, ep4 + '.json'), 'utf8'));
      const line = data.dialogue[s.i];
      if (!line || !Number.isFinite(line.t0) || !Number.isFinite(line.t1)) { log.push(`${ep4}[${s.i}] skip: no anchor`); continue; }
      const wav = path.join(dir, `v-${ep4}-${s.i}.wav`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(audioLib, ep4, 'dg.mp3'),
        '-af', `atrim=start=${Math.max(0, line.t0 - 0.25).toFixed(2)}:end=${(line.t1 + 0.25).toFixed(2)},asetpts=PTS-STARTPTS`, wav],
        {timeout: 60000});
      const b64 = 'data:audio/wav;base64,' + fs.readFileSync(wav).toString('base64');
      const r = await fetch('https://192.168.31.246:8018/api/eplod/asr', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({audio: b64}), signal: AbortSignal.timeout(130000)});
      const j = await r.json();
      fs.rmSync(wav, {force: true});
      if (!j.ok || !String(j.text || '').trim()) { log.push(`${ep4}[${s.i}] asr-empty`); continue; }
      const diff = midDiff(line.text, String(j.text).trim());
      if (diff) {
        confirmed.push({...s, qwen: String(j.text).trim(), qwenDiff: diff});
        log.push(`${ep4}[${s.i}] CONFIRMED | ${diff.join(' ; ').slice(0, 110)}`);
        console.log(`${ep4}[${s.i}] CONFIRMED | ${diff.join(' ; ').slice(0, 110)}`);
      } else {
        log.push(`${ep4}[${s.i}] ok (qwen 与官方一致, whisper 误听)`);
      }
    } catch (e) {
      log.push(`${ep4}[${s.i}] error: ${String(e.message).slice(0, 80)}`);
    }
    if (n % 25 === 0) {
      console.log(`-- 进度 ${n}/${refined.length}, 确认 ${confirmed.length}`);
      fs.writeFileSync(path.join(dir, 'verified.json'), JSON.stringify({count: confirmed.length, items: confirmed}, null, 1), 'utf8');
      fs.writeFileSync(path.join(dir, 'verify.log'), log.join('\n'), 'utf8');
    }
  }
  fs.writeFileSync(path.join(dir, 'verified.json'), JSON.stringify({count: confirmed.length, items: confirmed}, null, 1), 'utf8');
  fs.writeFileSync(path.join(dir, 'verify.log'), log.join('\n'), 'utf8');
  console.log(`完成: 复核 ${n}, 确认 ${confirmed.length}`);
})();
