#!/usr/bin/env node
'use strict';
// 审计精筛: 用判分同款归一(EplodRecords.normTokens)对齐官方与 whisper 转写,
// 不匹配段触及句首/尾 = 边界渗漏丢弃; 句中实质差异才是 qwen 复核候选。
// 读 build/qa/eplod-text-audit/report.json → 写 refined.json。
const fs = require('fs');
const path = require('path');
const E = require('../web/eplod-records.js');

const dir = path.join(__dirname, '..', 'build', 'qa', 'eplod-text-audit');
const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
const cands = report.suspects.filter(s => (s.level === 'suspect' || s.level === 'weak') && s.whisper.trim());

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
  return [pairs, runs(n, ma), runs(m, mb)];
}

const refined = [];
for (const s of cands) {
  const ot = E.normTokens(s.official), ht = E.normTokens(s.whisper);
  if (!ot.length || !ht.length) continue;
  const [, ra, rb] = align(ot, ht);
  const edge = runs => runs.some(([a, b]) => a === 0 || b === ot.length - 1 || b === ht.length - 1);
  // 触及官方或转写任一侧的首/尾 = 渗漏/截断
  const badEdge = ra.some(([a]) => a === 0) || rb.some(([a]) => a === 0)
    || ra.some(([, b]) => b === ot.length - 1) || rb.some(([, b]) => b === ht.length - 1);
  if (badEdge) continue;
  const diffwords = [];
  for (const [a, b] of ra) diffwords.push('官:' + ot.slice(a, b + 1).join(' '));
  for (const [a, b] of rb) diffwords.push('听:' + ht.slice(a, b + 1).join(' '));
  refined.push({...s, diffwords});
}

fs.writeFileSync(path.join(dir, 'refined.json'),
  JSON.stringify({count: refined.length, items: refined}, null, 1), 'utf8');
console.log(`候选 ${cands.length} → 精筛后 ${refined.length}`);
for (const s of refined.slice(0, 30))
  console.log(`  ${String(s.ep).padStart(4, '0')}[${s.i}] sim=${s.sim} | ${s.diffwords.join(' ; ').slice(0, 100)}`);
