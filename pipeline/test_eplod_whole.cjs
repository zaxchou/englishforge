'use strict';
// 整篇背诵(r11 2026-10-31): wp 合并 + 整段判分/逐句切分/建议。纯合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../web/eplod-records.js');

test('mergeDrill wp: latest 新者胜, best 按 acc, 双端互合幂等', () => {
  const old = { id: 'a', at: 10, acc: .8, text: 'old' };
  const better = { id: 'c', at: 15, acc: .95, text: 'best' };
  const newer = { id: 'b', at: 20, acc: .7, text: 'newer' };
  // 同端先后两次: latest 跟最新(at), best 跟最高(acc)
  let wp = E.mergeDrill({ wp: { latest: old, best: old } }, { wp: { latest: better, best: better } }).wp;
  assert.equal(wp.latest.id, 'c');
  assert.equal(wp.best.id, 'c');
  // 另一端来了更新但更差的 take: latest 换新, best 保住不回退
  wp = E.mergeDrill({ wp }, { wp: { latest: newer, best: newer } }).wp;
  assert.equal(wp.latest.id, 'b');
  assert.equal(wp.best.id, 'c');
  // 反方向合并一致(多端幂等)
  const back = E.mergeDrill({ wp: { latest: newer, best: newer } }, { wp }).wp;
  assert.equal(back.latest.id, 'b');
  assert.equal(back.best.id, 'c');
  // 无 wp 的 drill 合并不产生 wp, 也不丢已有 wp
  assert.equal(E.mergeDrill({}, { dd: {} }).wp, undefined);
  assert.ok(E.mergeDrill({ dd: {} }, { wp }).wp);
  // 旧端无 wp 键 ↔ 新端有 wp
  assert.equal(E.mergeDrill({ dd: {} }, { wp }).wp.latest.id, 'b');
});

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const start = html.indexOf('function epRdPassed(');
const end = html.indexOf('function epStamp(');
assert.ok(start > 0 && end > start, '整篇背诵函数块在 index.html 中');
const sandbox = { EplodRecords: E, fmtDur: s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'), esc: x => String(x) };
vm.createContext(sandbox);
const epDiffSrc = html.slice(html.indexOf('function epDiff('), html.indexOf('/* ---- 四步训练(用户定案'));
vm.runInContext(epDiffSrc, sandbox);
vm.runInContext(html.slice(start, end) + ';this.__={epRdPassed,epWholeScore,epWholeAdvice};', sandbox);
const { epRdPassed, epWholeScore, epWholeAdvice } = sandbox.__;

const dialogue = [
  { spk: 'A', text: 'Hello, Arthur. What seems to be the problem?', t0: 0, t1: 3 },
  { spk: 'B', text: 'I keep getting headaches, and I feel tired all the time.', t0: 3, t1: 7 },
  { spk: 'A', text: 'How long has this been going on?', t0: 7, t1: 9 },
];
const st = { d: { dialogue }, p: { drill: {} } };

test('epWholeScore: 全对 / 逐句切分 / 漏句与串句', () => {
  const full = dialogue.map(x => x.text).join(' ');
  const perfect = epWholeScore(st, full);
  assert.equal(perfect.acc, 1);
  assert.deepEqual([...perfect.per.map(p => p.acc)], [1, 1, 1], '逐句全对');
  // 中间整句漏背: 该句 0, 其余 1
  const skip = epWholeScore(st, dialogue[0].text + ' ' + dialogue[2].text);
  assert.equal(skip.per[1].acc, 0);
  assert.equal(skip.per[0].acc, 1);
  assert.equal(skip.per[2].acc, 1);
  // 背串: 第 2 句说到第 3 句开头 → 第 2 句弱, 第 3 句仍能对上
  const mixed = epWholeScore(st, full.replace(dialogue[1].text, 'I keep getting headaches.'));
  assert.ok(mixed.per[1].acc < 1);
  assert.equal(mixed.per[2].acc, 1);
  // 多出词计入 extra, 不虚增 acc
  const extra = epWholeScore(st, full + ' banana');
  assert.equal(extra.acc, 1);
  assert.deepEqual([...extra.extra], ['banana']);
  // 空转写
  assert.equal(epWholeScore(st, '').acc, 0);
});

test('epWholeAdvice: 通过/未通过/语速/多出词', () => {
  const perfect = epWholeScore(st, dialogue.map(x => x.text).join(' '));
  const okAdv = epWholeAdvice(st, perfect, 8.2);
  assert.match(okAdv[0], /通过/);
  assert.ok(okAdv.some(x => /用时/.test(x) && /原音/.test(x)), '全锚点句给语速对比');
  const skip = epWholeScore(st, dialogue[0].text + ' ' + dialogue[2].text);
  const failAdv = epWholeAdvice(st, skip, 9);
  assert.match(failAdv[0], /还差一点/);
  assert.match(failAdv[0], /#2/);
  const extraAdv = epWholeAdvice(st, { ...perfect, extra: ['banana'] }, null);
  assert.match(extraAdv.at(-1), /banana/);
});

test('epRdPassed: 逐句 rd 全过才解锁', () => {
  assert.equal(epRdPassed(st), false);
  st.p.drill.rd = { 0: { acc: .95 }, 1: { acc: .5 }, 2: { acc: .95 } };
  assert.equal(epRdPassed(st), false);
  st.p.drill.rd[1].acc = .9;
  assert.equal(epRdPassed(st), true);
});

test('index.html 接线: 入口卡/取消钩子/刷新点/版本号在位', () => {
  assert.match(html, /id="ep-whole"/);
  assert.match(html, /epWholeUpdate\(\);\s*\/\/ 逐句背诵通过数变化/);
  assert.match(html, /st\.wpPending\){st\.wpPending\.cancelled=true/);
  assert.match(html, /整篇过=当天这一遍盖满/);
  assert.match(html, /eplod-records\.js\?v=6/);
  assert.match(html, /desk\.css\?v=20261031r2/);
  // ASR 请求不带 ep/i(终考无偏置)
  const proc = html.slice(html.indexOf('async function epWholeProcess('), html.indexOf('function epStamp('));
  assert.doesNotMatch(proc, /ep:String|ep: st\.l\.ep/);
  assert.match(proc, /JSON\.stringify\(\{audio:take\.audio\}\)/);
});
