import assert from 'node:assert/strict';
import * as M from '../web/number-trainer-model.mjs';

let pass = 0;
const ok = (name) => { pass++;console.log('ok', name); };

// 读法
assert.equal(M.readNumber(0), 'zero');
assert.equal(M.readNumber(7), 'seven');
assert.equal(M.readNumber(13), 'thirteen');
assert.equal(M.readNumber(30), 'thirty');
assert.equal(M.readNumber(45), 'forty-five');
assert.equal(M.readNumber(100), 'one hundred');
assert.equal(M.readNumber(688), 'six hundred eighty-eight');
assert.equal(M.readNumber(1006), 'one thousand six');
assert.equal(M.readNumber(3040), 'three thousand forty');
assert.equal(M.readNumber(12406), 'twelve thousand four hundred six');
assert.equal(M.readNumber(999999), 'nine hundred ninety-nine thousand nine hundred ninety-nine');
assert.equal(M.readNumber(1000000), 'one million');
ok('读法: 0/teen/tens/hundred/thousand/million');

// 特征
assert(M.featuresOf('313').includes('teenTy'));
assert(M.featuresOf('330').includes('teenTy'));
assert(!M.featuresOf('312').includes('teenTy'));
assert(M.featuresOf('1006').includes('zeroGap'));
assert(!M.featuresOf('100').includes('zeroGap'));
assert(M.featuresOf('688').includes('adjacentRepeat'));
assert(M.featuresOf('268').includes('distinctDigits'));
assert(!M.featuresOf('262').includes('distinctDigits'));
assert(M.featuresOf('12406').includes('crossGroup'));
assert(!M.featuresOf('1000').includes('crossGroup'));
ok('特征: teenTy / zeroGap / repeat / distinct / crossGroup');

// 判分
assert.equal(M.gradeAnswer('1006', '1,006').correct, true);
assert.equal(M.gradeAnswer('1006', '001006').correct, true);
assert.equal(M.gradeAnswer('1006', '106').correct, false);
assert.equal(M.gradeAnswer('1006', '10.06').status, 'invalid');
assert.equal(M.gradeAnswer('1006', '1e3').status, 'invalid');
assert.equal(M.gradeAnswer('1006', '').status, 'empty');
assert.equal(M.gradeAnswer('0', '0').correct, true);
ok('判分: 千分位/前导零等价，小数与科学计数法拒绝');

// 错误归因
assert.deepEqual(M.classifyError('313', '330'), ['teenTy']);
assert.deepEqual(M.classifyError('1006', '106'), ['missingDigits', 'zeroDrop']);
assert.deepEqual(M.classifyError('268', '286'), ['transposition']);
assert.deepEqual(M.classifyError('688', '689'), ['substitution']);
assert.deepEqual(M.classifyError('12406', '124006'), ['extraDigits', 'zeroInsert']);
assert.deepEqual(M.classifyError('1006', '1006'), []);
ok('错误归因: teenTy/漏位漏零/换位/替换/多余零');

// 生成：每一位数与每个特征都合法
function rng(seed) { let x = seed >>> 0;return () => { x = (x * 1664525 + 1013904223) >>> 0;return x / 4294967296; }; }
for (let d = 1; d <= 6; d++) {
  const features = M.validFeaturesFor(d);
  for (const f of [null, ...features]) {
    for (let k = 0; k < 40; k++) {
      const q = M.makeQuestion({ digits: d, feature: f, rng: rng(d * 100 + k + 1) });
      assert.equal(q.value.length, d, `${d}/${f}/${q.value} 长度`);
      assert.equal(q.digits, d);
      assert(/^[1-9][0-9]*$/.test(q.value), q.value);
      assert.equal(q.text, M.readNumber(q.value));
      if (f) assert(q.features.includes(f), `${f} 未满足: ${q.value} ${q.features}`);
    }
  }
}
ok('生成: 1–6位 × 全部可行特征 40 次均合法且满足标签');

// 近期去重
const q1 = M.makeQuestion({ digits: 3, rng: rng(9) });
const q2 = M.makeQuestion({ digits: 3, rng: rng(9), recent: [q1.value] });
assert.notEqual(q1.value, q2.value);
ok('生成: 短期避重');

// 统计防偏
const ev = (o) => ({ target: '313', digits: 3, features: ['teenTy'], correct: true, assisted: false, skip: false, timingValid: true, submitMs: 2000, errorTags: [], voice: 'server', submittedAt: new Date().toISOString(), ...o });
const events = [
  ev({}),
  ev({ correct: false, errorTags: ['teenTy'], submitMs: 4000 }),
  ev({ correct: true, assisted: true, replay: true }),
  ev({ skip: true, correct: false }),
  ev({ invalid: true }),
  ev({ correct: true, timingValid: false, submitMs: 100 }),
];
const s = M.summarizeAttempts(events);
assert.equal(s.samples, 5, '无效音频不进入统计');
assert.equal(s.total.settled, 5);
assert.equal(s.total.independent, 2, '计时失效不影响是否独立答对');
assert.equal(s.total.assisted, 1);
assert.equal(s.total.skipped, 1);
assert.equal(s.total.independentRate, 2 / 5, '重听/跳过不从分母消失');
assert.equal(s.total.samples, 1, '只有无辅助的正确且计时有效题进入时间样本');
assert.equal(s.byFeature.teenTy.settled, 5);
assert.equal(s.errorTags.teenTy, 1);
ok('统计: 独立命中分母/辅助与跳过/无效题/时间样本分离');

// 样本门槛：一次错答不判弱项
const one = M.summarizeAttempts([ev({ correct: false, errorTags: ['teenTy'] })]);
assert.equal(M.buildAdvice(one)[0].kind, 'baseline');
assert.equal(M.candidateWeaknesses(one).length, 0);
const many = M.summarizeAttempts(Array.from({ length: 12 }, (_, i) => ev({ correct: i < 3, errorTags: i < 3 ? ['teenTy'] : [] })));
assert(M.candidateWeaknesses(many).some(w => w.tag === 'teenTy'));
assert(M.buildAdvice(many).some(a => a.kind === 'weak' && a.tag === 'teenTy'));
ok('门槛: 少量错答只记录，达到样本与错误数才列优先强化');

// 分配：数量、比例、位数、连续同特征上限
const plan = M.planRound({ summary: many, config: { count: 20, mode: 'fixed', digits: 3 }, rng: rng(3) });
assert.equal(plan.slots.length, 20);
assert(plan.slots.filter(x => x.source === 'focus').length <= 10);
assert(plan.slots.every(x => x.digits === 3), '固定位数不擅自升档');
const firstNums = new Set(plan.slots.map(x => x.digits));
assert.deepEqual([...firstNums], [3]);
let run = 0, maxRun = 0, prev = null;
for (const sl of plan.slots) { if (sl.feature && sl.feature === prev) run++; else run = 0;prev = sl.feature;maxRun = Math.max(maxRun, run); }
assert(maxRun <= Math.max(2, Math.ceil(20 * 0.2)), '同特征连续摊开');
ok('分配: 20题、专项≤50%、固定位数不越档、同特征摊开');

// 无弱项时回到普通覆盖
const healthy = M.summarizeAttempts(Array.from({ length: 30 }, (_, i) => ev({ correct: i % 10 !== 0, errorTags: i % 10 === 0 ? ['substitution'] : [] })));
const p2 = M.planRound({ summary: healthy, config: { count: 20, mode: 'fixed', digits: 3 }, rng: rng(4) });
assert.equal(p2.focusTags.length, 0);
assert.equal(p2.slots.filter(x => x.feature).length, 0);
ok('无确认弱项时不做伪专项，整轮保持普通覆盖');

// 智能升档
const good = M.summarizeAttempts(Array.from({ length: 40 }, () => ev({ correct: true })));
assert.equal(M.currentDigits(good, { maxDigits: 6, startDigits: 2 }), 4);
const empty = M.summarizeAttempts([]);
assert.equal(M.currentDigits(empty, { startDigits: 2 }), 2);
ok('智能档位: 有稳定证据才升一档，无数据从起始位开始');

console.log(`\n${pass} groups passed`);
