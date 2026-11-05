#!/usr/bin/env node
/* 对可疑句锚做保守延长。静音图仅作候选证据，不等于逐词强制对齐。
   截头：与前句间隔1.2–4s且检测成功、空隙内无>=0.35s静音。
   截尾：语速>4.5词/秒且后方有空隙，按0.45s/词延长，不越下一句。
   检测失败/媒体缺失时整期跳过，退出非0；失败不写有效缓存。
   用法：node pipeline/fix_eplod_anchors.mjs [build目录] [--dry] */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const timingOverrides = JSON.parse(fs.readFileSync(new URL('./eplod-timing-overrides.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const BUILD = path.resolve(args.find(x => x !== '--dry') || 'build');
const DRY = args.includes('--dry');
const dir = path.join(BUILD, 'eplod');
const AUDIO_ROOT = path.resolve(BUILD, '..', '..', 'EnglishPod音频库');
const SILENCE_CACHE = path.join(BUILD, 'eplod-silence.json');
const DETECTOR = 'silencedetect:-30dB:0.35:v3';
let cache = {};
if (fs.existsSync(SILENCE_CACHE)) {
  try { const value = JSON.parse(fs.readFileSync(SILENCE_CACHE, 'utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) cache = value; }
  catch { console.error('静音缓存无效，将重新检测。'); }
}
function saveCache() {
  if (DRY) return;
  const tmp = SILENCE_CACHE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, SILENCE_CACHE);
}
function silenceMap(ep) {
  const mp3 = path.join(AUDIO_ROOT, ep, 'dg.mp3');
  if (!fs.existsSync(mp3)) {
    delete cache[ep]; saveCache();
    console.error(`[跳过] ${ep} 音频缺失，未修改该期。`);
    return null;
  }
  const stat = fs.statSync(mp3);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const old = cache[ep];
  if (old?.detector === DETECTOR && old.signature === signature && Array.isArray(old.intervals) && old.intervals.every(x => Number.isFinite(x.s) && Number.isFinite(x.e) && x.e >= x.s)) return old.intervals;
  const result = spawnSync('ffmpeg', ['-v', 'info', '-i', mp3, '-af', 'silencedetect=n=-30dB:d=0.35', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) {
    delete cache[ep]; saveCache();
    console.error(`[跳过] ${ep} 静音检测失败，未修改该期：${result.error?.message || 'ffmpeg exit ' + result.status}`);
    return null;
  }
  const intervals = []; let cur = null;
  for (const m of (result.stderr + result.stdout).matchAll(/silence_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') cur = { s: +m[2] };
    else if (cur) { cur.e = +m[2]; intervals.push(cur); cur = null; }
  }
  cache[ep] = { detector: DETECTOR, signature, intervals }; saveCache();
  return intervals;
}
function hasSilence(intervals, a, b) {
  return b > a && intervals.some(x => Math.min(x.e, b) - Math.max(x.s, a) >= .35);
}
let lines = 0, failed = 0;
for (const f of fs.readdirSync(dir).filter(x => /^\d{4}\.json$/.test(x))) {
  const file = path.join(dir, f), ep = f.slice(0, -5);
  const j = JSON.parse(fs.readFileSync(file, 'utf8')), d = j.dialogue || [];
  const reviewed = timingOverrides.episodes[ep];
  if (reviewed) {
    const mp3 = path.join(AUDIO_ROOT, ep, 'dg.mp3');
    const valid = fs.existsSync(mp3) && sha256(fs.readFileSync(mp3)) === reviewed.audioSha256
      && sha256(d.map(x => x.text).join('\n')) === reviewed.dialogueSha256
      && d.length === reviewed.bounds.length
      && d.every((x, i) => x.t0 === reviewed.bounds[i][0] && x.t1 === reviewed.bounds[i][1]);
    if (!valid) { failed++; console.error(`[跳过] ${ep} 已复核断句的来源或切点变化，请先重新校准。`); }
    else console.log(`${ep} 已复核断句保持不变。`);
    continue;
  }
  const intervals = silenceMap(ep);
  if (intervals === null) { failed++; continue; }
  let changed = 0;
  for (let i = 1; i < d.length; i++) {
    const l = d[i], prev = d[i - 1];
    if (!Number.isFinite(l.t0) || !Number.isFinite(l.t1) || l.t1 <= l.t0 || !Number.isFinite(prev.t1)) continue;
    const gap = l.t0 - prev.t1;
    if (gap < 1.2 || gap > 4) continue;
    const toks = (String(l.text || '').match(/[A-Za-z0-9'’À-ÿ]+/g) || []).length;
    if (toks / (l.t1 - l.t0) >= 4 || hasSilence(intervals, prev.t1, l.t0)) continue;
    const old = l.t0; l.t0 = +(prev.t1 + .15).toFixed(2);
    changed++; lines++;
    console.log(`ep${ep} #${i + 1} 截头候选: t0 ${old.toFixed(2)} → ${l.t0.toFixed(2)}`);
  }
  for (let i = 0; i < d.length; i++) {
    const l = d[i];
    if (!Number.isFinite(l.t0) || !Number.isFinite(l.t1) || l.t1 <= l.t0) continue;
    const toks = (String(l.text || '').match(/[A-Za-z0-9'’À-ÿ]+/g) || []).length, dur = l.t1 - l.t0;
    if (dur <= .5 || toks / dur <= 4.5) continue;
    const next = d[i + 1], avail = Number.isFinite(next?.t0) ? next.t0 - .1 - l.t0 : dur + 5;
    const target = Math.max(dur, Math.min(toks * .45, avail));
    if (target > dur + .05) { l.t1 = +(l.t0 + target).toFixed(2); changed++; lines++; }
  }
  if (changed && !DRY) fs.writeFileSync(file, JSON.stringify(j));
}
console.log(`${DRY ? '[dry] 候选' : '完成'}: ${lines} 句；跳过检测失败 ${failed} 期`);
if (failed) process.exitCode = 2;
