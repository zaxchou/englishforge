'use strict';
// 考试页交卷按钮接线(2026-11-05 线上事故): 确认态会把 #fe-submit 换成
// #fe-submit-now/#fe-submit-cancel, 绑定必须判空, 否则确认按钮点了没反应。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const start = html.indexOf('const FE=');
const end = html.indexOf('function reviewEntries(');
assert.ok(start > 0 && end > start, '考试页函数块在 index.html 中');

function boot() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {id, innerHTML: '', textContent: '', onclick: null, hidden: false, style: {}, dataset: {}, querySelectorAll: () => [], querySelector: () => null});
    return nodes.get(id);
  };
  const host = node('fe-body');
  const ctx = {
    console, Date, Math, JSON, Object, String, Number, Array, Promise, setTimeout,
    FE: null, esc: x => String(x), $: id => node(id),
    REC: {course: {}}, nav() {}, csCourseGo() {}, cpOpenLesson() {}, gqOpenFamilies() {},
    fmt: x => String(x), localDay: d => d.toISOString().slice(0, 10),
    document: {addEventListener() {}, querySelectorAll: () => []},
  };
  vm.createContext(ctx);
  // host.querySelectorAll 需要返回空数组, 其余 id 元素按需创建
  ctx.$ = id => id === 'fe-body' ? host : node(id);
  vm.runInContext(html.slice(start, end) + ';this.__={FE,fePaint};', ctx);
  return {ctx, host, node, FE: ctx.__.FE};
}

test('confirm step paints without throwing and wires the confirm button', () => {
  const {ctx, host, node, FE} = boot();
  ctx.FE = FE;
  const paper = {
    id: 'ndf-01-final', title: 'Synthetic', total: 1, untimed: true, questions: [{
      id: 'e01', number: 1, lessonNo: 1, lessonId: 'ndf-01-01', lessonTitle: 'Synthetic', type: 'meaning',
      stem: 'Synthetic stem?', options: {A: {t: 'a'}, B: {t: 'b'}, C: {t: 'c'}, D: {t: 'd'}},
    }],
  };
  Object.assign(ctx.__.FE, {
    id: 'ndf-01-final', paper, phase: 'answer', ix: 0, answers: {}, unsure: {}, confirm: false, busy: false, err: '',
    active: {id: 'run-1', answers: {}, unsure: {}},
  });
  // 第一次渲染: 正常态, 应有 #fe-submit 处理
  assert.doesNotThrow(() => vm.runInContext('fePaint()', ctx));
  assert.equal(typeof node('fe-submit').onclick, 'function');

  // 进入确认态: 真实 DOM 不再有 #fe-submit —— 旧实现在这里抛 TypeError
  ctx.__.FE.confirm = true;
  node('fe-submit').onclick = null;
  assert.doesNotThrow(() => vm.runInContext('fePaint()', ctx), 'confirm paint must not crash');
  assert.ok(host.innerHTML.includes('确认交卷'));
  assert.equal(typeof node('fe-submit-now').onclick, 'function', 'confirm button receives the submit handler');
  assert.equal(typeof node('fe-submit-cancel').onclick, 'function', 'cancel returns to answering');
});

test('submit is guarded against a stale confirm click while a save is pending', async () => {
  const {ctx, FE} = boot();
  vm.runInContext('feRequest=()=>{throw Error("should not be called")}', ctx);
  Object.assign(FE, {id: 'ndf-01-final', paper: {total: 1, questions: []}, phase: 'answer', busy: true, confirm: true, active: {id: 'run-1'}});
  await vm.runInContext('feSubmit()', ctx);
  assert.equal(FE.phase, 'answer', 'a pending save blocks re-entrant submit');
});
