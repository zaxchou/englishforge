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

test('目录金星: 整篇通过门槛与覆盖次数分别保留', () => {
  sandbox.REC = { course: {} };
  sandbox.EP = { cache: {} };
  sandbox.epDay = () => '2026-11-02';
  vm.runInContext(html.slice(html.indexOf('const EP_STAR='), html.indexOf('function epNavCoverUpdate(')) + ';this.__navCover=epNavCoverHTML;', sandbox);
  const lesson = { id: 'eplod-0023', ep: '0023', dialogue_count: 3 };
  for (const [acc, gold] of [[undefined, false], [.899, false], [.9, true], [.98, true], [NaN, false], [Infinity, false], ['0.98', false]]) {
    for (let rounds = 0; rounds <= 3; rounds++) {
      const stampDays = Object.fromEntries(Array.from({ length: rounds }, (_, i) => ['2026-10-' + (28 + i), [0, 1, 2]]));
      sandbox.REC.course[lesson.id] = { drill: { stampDays, wp: { best: { acc }, latest: { acc: .4 } } } };
      const output = sandbox.__navCover(lesson);
      assert.equal((output.match(/class="ep-round gold/g) || []).length, gold ? 3 : 0, '通过后的三颗星原位变金，不受后来失败成绩影响');
      assert.equal((output.match(/class="ep-round(?: gold)? complete/g) || []).length, rounds, '换色不补填未完成的复背日期');
      assert.equal(output.includes('整篇背诵已通过'), gold, '悬浮与无障碍说明对应真实整篇状态');
      assert.equal((output.match(/role="img"/g) || []).length, 3, '仍只占原来三颗星的位置');
    }
  }
  delete sandbox.REC.course[lesson.id];
  assert.doesNotMatch(sandbox.__navCover(lesson), /ep-round gold/, '没有学习记录时不出现整篇成就');
});

test('index.html 接线: 入口卡/取消钩子/刷新点/版本号在位', () => {
  assert.match(html, /id="ep-whole"/);
  assert.match(html, /epWholeUpdate\(\);\s*\/\/ 逐句背诵通过数变化/);
  assert.match(html, /st\.wpPending\){st\.wpPending\.cancelled=true/);
  assert.match(html, /整篇过=当天这一遍盖满/);
  assert.match(html, /id="ep-whole-history"/, '历史成绩回看入口在位');
  assert.match(html, /phase:'result',result:best,history:true/, '历史回看复用结果页渲染');
  assert.match(html, /历史回看/, '结果页标注历史回看');
  // 2026-11-09: 整篇背诵键盘 空格=开始/结束, Esc=取消/收起(按阶段路由, 单句朗读互不干扰)
  assert.match(html, /\['rec','processing','result','error'\]\.includes/);
  assert.match(html, /空格 重背一次 · Esc 收起/);
  assert.match(html, /eplod-records\.js\?v=\d+/);
  assert.match(html, /desk\.css\?v=\d{8}r\d+/);   /* 只断言缓存击穿在位, 不钉具体版本号(升级不必改测试) */
  // 2026-11-04 用户反馈: 录音中可直接取消(不上传), 有结果时原文只出现一次
  assert.match(html, /class="ep-rec-cancel"[\s\S]*?hidden>取消<\/button>/, 'cancel sits next to the record button');
  const wire = html.slice(html.indexOf("card.querySelectorAll('.ep-rec-cancel')"), html.indexOf('const lm=card.querySelector'));
  assert.match(wire, /epCancelRecording\(st\)/, 'cancel never routes through ASR');
  assert.doesNotMatch(wire, /epArchiveTake|epProcessTake/, 'cancel uploads nothing');
  assert.match(html, /function epSyncOrigHint\(card,st,i\)/);
  assert.match(html, /if\(hint\)hint\.hidden=shown/, '原文 hint yields to the result panel');
  // r11: 整篇录音对象必须是本体(浅拷贝包装曾让音量计守卫恒真 → 每次都报「没收到声音」)
  assert.match(html, /st\.wpTake=r;/, 'levelTimer/stop/cancel share one identity');
  assert.doesNotMatch(html, /st\.wpTake=\{phase:'rec'/, 'no wrapper object');
  const toggle = html.slice(html.indexOf('async function epWholeToggle('), html.indexOf('async function epWholeProcess('));
  assert.doesNotMatch(toggle, /t\.cancelled=true/, 'stop means submit, not cancel');
  assert.match(toggle, /epStopCapture\(st,t,true\)/, 'settle-window stop releases capture through the shared cleanup');
  // ASR 请求不带 ep/i(终考无偏置)
  const proc = html.slice(html.indexOf('async function epWholeProcess('), html.indexOf('function epStamp('));
  assert.doesNotMatch(proc, /ep:String|ep: st\.l\.ep/);
  assert.match(proc, /JSON\.stringify\(\{audio:take\.audio\}\)/);
  // 人名走音赦免只挂在语音判分路径; 听写/默写提交保持精确
  assert.match(html, /epDiff\(u\.text,text,true\)/, 'per-sentence voice diff uses fuzzy');
  assert.match(html, /epDiff\(d\.map\(x=>x\.text\)\.join\(' '\),text,true\)/, 'whole-passage diff uses fuzzy');
  assert.match(html, /epDiff\(text,result\.text\|\|'',result&&result\.mode==='voice'\)/, 'display fuzziness follows the stored mode');
  const dictSubmit = html.slice(html.indexOf("placeholder=\"写出你听到的内容"), html.indexOf('placeholder="看中文线索'));
  assert.doesNotMatch(dictSubmit, /epDiff\([^)]*true\)/, 'dictation submit stays exact');
  // R3/R6/R7(2026-11-02): 整篇背诵隔离提示; 严格评分版本随结果落盘; 显示共用 tokenSegments
  assert.match(html, /function epWholeIsolation\(st,locked=epWholeLocked\(st\)\)/, 'whole take hides hint surfaces');
  assert.match(html, /const marked=EplodRecords\.tokenSegments\(text\)\.map/, 'word display shares the scorer tokenization');
  assert.ok((html.match(/scoringVersion:EplodRecords\.SCORING_VERSION/g) || []).length >= 2, 'voice and whole results carry the scoring version');
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'desk.css'), 'utf8');
  assert.match(cssSrc, /\.ep-whole-hidden\{display:none!important\}/, 'isolation class is plain display:none');
});
