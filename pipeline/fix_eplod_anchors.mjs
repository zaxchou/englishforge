#!/usr/bin/env node
/* 修复 eplod 对话句的坏时间锚点(2026-11-01)。
   现象: 部分句子的 t1 被原始对齐截早(用户实录 0024#5 官方锚 3.3s, 实读需 ~10s),
   「听这句」被提前掐断、同速永远不可能。
   规则(幂等): 语速 >4.5 词/秒 且 下一句开头留有富余时, 把 t1 延长到
     t0 + max(原时长, min(0.45s*词数, next.t0-0.1))
   末句(无 next)最多延 5s。不缩不挪只延, 已合规的行不动 → 重跑零改动。
   用法: node pipeline/fix_eplod_anchors.mjs [build目录] [--dry] */
import fs from 'node:fs';
import path from 'node:path';
const BUILD = path.resolve(process.argv[2] || 'build');
const DRY = process.argv.includes('--dry');
const dir = path.join(BUILD, 'eplod');
let touched = 0, lines = 0;
for (const f of fs.readdirSync(dir).filter(x => /^\d{4}\.json$/.test(x))) {
  const file = path.join(dir, f);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = j.dialogue || [];
  let changed = 0;
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
      console.log(`ep${f.slice(0, -4)} #${i + 1}: ${dur.toFixed(1)}s → ${l.t1 - l.t0 > 0 ? (l.t1 - l.t0).toFixed(1) : '?'}s (${toks}词)`);
    }
  }
  if (changed && !DRY) fs.writeFileSync(file, JSON.stringify(j));
  touched += changed;
}
console.log(DRY ? `[dry] 将修复 ${lines} 句` : `完成: 修复 ${lines} 句`);
