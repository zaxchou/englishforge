#!/usr/bin/env node
/* 修复 eplod 对话句的坏时间锚点(2026-11-01)。
   现象一(截尾): 句子 t1 被原始对齐截早(用户实录 0024#5 官方锚 3.3s, 实读需 ~10s)。
   规则(幂等): 语速 >4.5 词/秒 且 下一句开头留有富余时, 把 t1 延长到
     t0 + max(原时长, min(0.45s*词数, next.t0-0.1))
   末句(无 next)最多延 5s。不缩不挪只延, 已合规的行不动 → 重跑零改动。
   现象二(截头, r5 2026-11-01): 0026#5 播放从句中开始——t0 起点晚于真实句首,
   句头落在与上一句之间的空隙里。判据: 空隙 ≥1.2s 且 silencedetect 显示空隙内
   无 ≥0.35s 静音(=语音连续, 不是自然停顿) → 把 t0 拉回上一句结束+0.15s。
   安全闸: 仅非首句; 空隙 ≤4s(更长的是音乐/转场); 拉回后语速 ≤4 词/秒。
   静音图谱缓存在 build/eplod-silence.json(每期一次 ffmpeg, 首跑自动生成)。
   用法: node pipeline/fix_eplod_anchors.mjs [build目录] [--dry] */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
const BUILD = path.resolve(process.argv[2] || 'build');
const DRY = process.argv.includes('--dry');
const dir = path.join(BUILD, 'eplod');
const AUDIO_ROOT = path.resolve(BUILD, '..', '..', 'EnglishPod音频库');   /* 音频库与 toefl-lab 同级, 在 build 的上两级 */
const SILENCE_CACHE = path.join(BUILD, 'eplod-silence.json');
function silenceMap(ep) {
  const cache = fs.existsSync(SILENCE_CACHE) ? JSON.parse(fs.readFileSync(SILENCE_CACHE, 'utf8')) : {};
  if (!cache[ep]) {
    const mp3 = path.join(AUDIO_ROOT, ep, 'dg.mp3');
    if (!fs.existsSync(mp3)) { cache[ep] = []; return cache[ep]; }
    let out = '';
    try { out = execSync(`ffmpeg -v info -i "${mp3}" -af silencedetect=n=-30dB:d=0.35 -f null - 2>&1`).toString(); }
    catch (e) { out = e.stdout ? e.stdout.toString() : ''; }
    const intervals = []; let cur = null;
    for (const m of out.matchAll(/silence_(start|end): ([\d.]+)/g)) {
      if (m[1] === 'start') cur = { s: +m[2] };
      else if (cur) { cur.e = +m[2]; intervals.push(cur); cur = null; }
    }
    cache[ep] = intervals;
    if (!DRY) fs.writeFileSync(SILENCE_CACHE, JSON.stringify(cache));
  }
  return cache[ep];
}
/* (a,b) 内是否存在 ≥0.35s 的静音区间: 有=自然停顿, 无=语音连续(锚点错位) */
function speechIn(intervals, a, b) {
  if (b <= a) return false;
  for (const x of intervals) {
    const ov = Math.min(x.e, b) - Math.max(x.s, a);
    if (ov >= 0.35) return true;
  }
  return false;
}
let touched = 0, lines = 0;
for (const f of fs.readdirSync(dir).filter(x => /^\d{4}\.json$/.test(x))) {
  const file = path.join(dir, f);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = j.dialogue || [];
  const ep = f.slice(0, -5);
  const intervals = silenceMap(ep);
  let changed = 0;
  /* pass 2 先跑: 截头修复 */
  for (let i = 1; i < d.length; i++) {
    const l = d[i], prev = d[i - 1];
    if (!Number.isFinite(l.t0) || !Number.isFinite(l.t1) || l.t1 <= l.t0) continue;
    if (!Number.isFinite(prev.t1)) continue;
    const gap = l.t0 - prev.t1;
    if (gap < 1.2 || gap > 4) continue;
    const toks = (String(l.text || '').match(/[A-Za-z0-9'’À-ÿ]+/g) || []).length;
    const dur = l.t1 - l.t0;
    if (toks / dur >= 4) continue;   /* 语速已经很快的走截尾规则 */
    if (speechIn(intervals, prev.t1, l.t0)) continue;   /* 空隙里有静音=自然停顿, 不动 */
    const old = l.t0;
    l.t0 = +(prev.t1 + 0.15).toFixed(2);
    changed++; lines++;
    console.log(`ep${ep} #${i + 1} 截头: t0 ${old.toFixed(2)} → ${l.t0.toFixed(2)} (空隙 ${gap.toFixed(1)}s 无静音)`);
  }
  /* pass 1: 截尾延长 */
  for (let i = 0; i < d.length; i++) {
    const l = d[i];
    if (!Number.isFinite(l.t0) || !Number.isFinite(l.t1) || l.t1 <= l.t0) continue;
    const toks = (String(l.text || '').match(/[A-Za-z0-9'’À-ÿ]+/g) || []).length;
    const dur = l.t1 - l.t0;
    if (dur <= 0.5 || toks / dur <= 4.5) continue;
    const next = d[i + 1];
    const avail = Number.isFinite(next?.t0) ? next.t0 - 0.1 - l.t0 : dur + 5;
    const target = Math.max(dur, Math.min(toks * 0.45, avail));
    if (target > dur + 0.05) {
      l.t1 = +(l.t0 + target).toFixed(2);
      changed++; lines++;
      console.log(`ep${ep} #${i + 1}: ${dur.toFixed(1)}s → ${target.toFixed(1)}s (${toks}词)`);
    }
  }
  if (changed && !DRY) fs.writeFileSync(file, JSON.stringify(j));
  touched += changed;
}
console.log(DRY ? `[dry] 将修复 ${lines} 句` : `完成: 修复 ${lines} 句`);
