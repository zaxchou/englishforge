/* 课级调度状态机纯单元测试：不启服务、不落盘。运行：node pipeline/test_vocab_lesson_unit.mjs */
import assert from 'assert/strict';
import * as LV from '../lesson-vocab.mjs';

const NOW = 1_800_000_000_000;
const DAY = 86400000;
const sm2Like = (prev) => ({ e: prev.e, i: Math.max(1, Math.round(prev.i * prev.e)), s: prev.s, r: prev.r + 1, due: NOW + Math.max(1, Math.round(prev.i * prev.e)) * 60000 });

function makeIndex(words) {
  return LV.indexCards({ lessonId: 't', title: 't', total: words.length, cards: words.map(w => ({ key: w, word: w })) });
}
function fresh(keys) {
  const index = makeIndex(keys);
  return { index, session: LV.newSession(index, NOW, 'r0'), vocab: {} };
}
const know = (s, index, vocab, key) => LV.applyAction({ session: s, index, vocab, key, action: 'know', now: NOW, nextExisting: sm2Like });
const again = (s, index, key) => LV.applyAction({ session: s, index, vocab: {}, key, action: 'again', now: NOW });
const cont = (s, index, vocab, key) => LV.applyAction({ session: s, index, vocab, key, action: 'continue', now: NOW });

// —— C2：新词两种认出路径（首次 3 天 / 看卡后次日）
{
  const { index, session, vocab } = fresh(['a', 'b']);
  know(session, index, vocab, 'a');
  assert.equal(vocab.a.i, LV.FIRST_INTERVAL_MIN);
  assert.equal(vocab.a.s, 99);
  again(session, index, 'b'); cont(session, index, vocab, 'b');
  know(session, index, vocab, 'b');
  assert.equal(vocab.b.i, LV.RELEARN_INTERVAL_MIN);
  assert.equal(vocab.b.e, 2.5);
  assert.equal(vocab.b.born, NOW);
}

// —— C1：已有记录的词，看卡后认出一律按遗忘处理（到期与未到期都是）
{
  const { index, session, vocab } = fresh(['a', 'b']);
  vocab.a = { e: 2.5, i: 100, s: 99, r: 2, n: 1, born: NOW - DAY, due: NOW - 1000 };      // 到期
  vocab.b = { e: 2.5, i: 100, s: 99, r: 2, n: 1, born: NOW - DAY, due: NOW + DAY };       // 未到期
  know(session, index, vocab, 'a');                    // 到期 + tries0 → 正常成功
  assert.equal(vocab.a.i, Math.round(100 * 2.5));
  again(session, index, 'b'); cont(session, index, vocab, 'b');
  const before = { ...vocab.b };
  know(session, index, vocab, 'b');                    // 未到期 + tries1 → 遗忘信号
  assert.equal(vocab.b.i, LV.RELEARN_INTERVAL_MIN);
  assert.equal(vocab.b.e, 2.3);
  assert.equal(vocab.b.n, before.n + 1);
  assert.equal(vocab.b.due, NOW + LV.RELEARN_INTERVAL_MIN * 60000);   // 未到期旧词同样被重置到次日
  const { index: i2, session: s2, vocab: v2 } = fresh(['c']);
  v2.c = { e: 2.5, i: 100, s: 99, r: 2, n: 1, born: NOW - DAY, due: NOW - 1000 };
  again(s2, i2, 'c'); cont(s2, i2, v2, 'c');
  know(s2, i2, v2, 'c');                               // 到期 + tries1 → 遗忘，而非延长
  assert.equal(v2.c.i, LV.RELEARN_INTERVAL_MIN);
  assert.equal(v2.c.e, 2.3);
}

// —— R2.2-1：到期旧词看卡两次后认出，仍是遗忘（1 天、ease-0.2），不被拉长
{
  const { index, session, vocab } = fresh(['a', 'b', 'c']);
  vocab.a = { e: 2.5, i: 100, s: 99, r: 2, n: 1, born: NOW - DAY, due: NOW - 1000 };
  again(session, index, 'a'); cont(session, index, vocab, 'a');
  know(session, index, vocab, 'b');
  know(session, index, vocab, 'c');
  again(session, index, 'a'); cont(session, index, vocab, 'a');   // tries=2
  know(session, index, vocab, 'a');
  assert.equal(vocab.a.i, LV.RELEARN_INTERVAL_MIN);
  assert.equal(vocab.a.e, 2.3);
  assert.ok(session.rechecked.a === 1);
}

// —— 未到期 + tries0 认出：不写（不变量 3）
{
  const { index, session, vocab } = fresh(['a']);
  vocab.a = { e: 2.5, i: 100, s: 99, r: 2, n: 1, born: NOW - DAY, due: NOW + DAY };
  const before = { ...vocab.a };
  know(session, index, vocab, 'a');
  assert.deepEqual(vocab.a, before);
}

// —— 4.3：continue 回插 10 张之后；轮末打乱重考；归档；nextDueAt
{
  const words = Array.from({ length: 14 }, (_, i) => 'w' + String(i).padStart(2, '0'));
  const { index, session, vocab } = fresh(words);
  again(session, index, 'w00'); cont(session, index, vocab, 'w00');
  assert.equal(session.queue[10], 'w00');                  // 隔 10 张之后重现
  assert.equal(session.queue[0], 'w01');
  let relearnWrite = null;
  while (!session.completedAt) {
    const k = session.queue[0];
    assert.ok(k, 'queue has work');
    const before = vocab[k] ? { ...vocab[k] } : null;
    const inRecheck = !!(session.rechecked && session.rechecked[k]);
    const r = know(session, index, vocab, k);
    if (inRecheck && before) assert.deepEqual(vocab[k], before, '重考通过不重复写调度');
    if (k === 'w00' && r.wrote) relearnWrite = { ...vocab.w00 };
  }
  assert.ok(session.completedAt);
  assert.equal(session.rechecked.w00, 1);
  assert.equal(session.history[0].tries.w00, 1);
  assert.ok(session.nextDueAt === null || session.nextDueAt > NOW);
  assert.equal(relearnWrite.i, LV.RELEARN_INTERVAL_MIN);
  const pub = LV.publicSession(session);
  assert.ok(pub.summary.later >= 1);
}

// —— 重考又忘了：认出时不重复惩罚，且不再进下一轮末尾
{
  const { index, session, vocab } = fresh(['a', 'b']);
  again(session, index, 'a'); cont(session, index, vocab, 'a');   // a 回插到 b 之后
  know(session, index, vocab, 'b');
  know(session, index, vocab, 'a');                    // 认出 → 次日语 + 进重考
  const afterLapse = { ...vocab.a };
  assert.equal(session.queue[0], 'a');                 // 队列空 → 重考 [a]
  again(session, index, 'a'); cont(session, index, vocab, 'a');   // 重考又忘
  know(session, index, vocab, 'a');                    // 再认出：inRecheck → 不写
  assert.deepEqual(vocab.a, afterLapse);
  assert.ok(session.completedAt);
}

// —— planStart：完成后到期词 → 复习轮；无到期 → 原样；restart → 新认读轮
{
  const words = ['a', 'b'];
  const { index, session, vocab } = fresh(words);
  for (const k of words) know(session, index, vocab, k);
  assert.ok(session.completedAt);
  const p0 = LV.planStart(session, index, vocab, NOW + 1000, 'r1', false);
  assert.equal(p0.resumed, true);
  vocab.a.due = NOW - 1000;
  const p1 = LV.planStart(session, index, vocab, NOW + 2000, 'r2', false);
  assert.equal(p1.resumed, false);
  assert.equal(p1.session.phase, 'review');
  assert.deepEqual(p1.session.order, ['a']);
  const p2 = LV.planStart(session, index, vocab, NOW + 2000, 'r3', true);
  assert.equal(p2.session.phase, 'first');
  assert.equal(p2.session.order.length, 2);
  assert.ok(p2.session.history.length >= 1);
}

// —— 复习轮：同族相邻 + 单轮上限
{
  const idx = LV.indexCards({lessonId:'t',title:'t',total:5,cards:[
    {key:'a',word:'a',group:2},{key:'b',word:'b',group:1},{key:'c',word:'c',group:2},
    {key:'d',word:'d',group:1},{key:'e',word:'e',group:3}]});
  const sess = LV.newSession(idx, NOW, 'r0'); sess.completedAt = NOW - 1000;
  const v = {};
  for (const k of ['a','b','c','d','e']) v[k] = {e:2.5,i:10,s:99,r:1,n:1,born:NOW-1,due:NOW-1000};
  const p = LV.planStart(sess, idx, v, NOW+1, 'r2', false, {reviewCap:3});
  assert.equal(p.session.phase, 'review');
  assert.equal(p.session.order.length, 3);           // 上限 3
  const gs = p.session.order.map(k => idx.byKey.get(k).group);
  const seen = new Set(); let prev = null;
  for (const g of gs) { if (g !== prev) { assert.ok(!seen.has(g), '同族应相邻'); seen.add(g); prev = g; } }
}

// —— R4.2-5：到期量超过单轮上限时按族内最早到期时间取，最久未复习的族不会被连续漏掉
{
  const cards = [], v = {};
  for (let g = 1; g <= 6; g++) for (let j = 0; j < 2; j++) {
    const k = 'g' + g + 'w' + j;
    cards.push({ key: k, word: k, group: g });
    v[k] = { e: 2.5, i: 10, s: 99, r: 1, n: 1, born: NOW - 1, due: NOW - 1000 - g * 60000 };
  }
  const idx = LV.indexCards({ lessonId: 't', title: 't', total: cards.length, cards });
  const sess = LV.newSession(idx, NOW, 'r0'); sess.completedAt = NOW - 1000;
  const p = LV.planStart(sess, idx, v, NOW + 1, 'r2', false, { reviewCap: 4 });
  assert.equal(p.session.order.length, 4);
  const fams = [...new Set(p.session.order.map(k => idx.byKey.get(k).group))];
  assert.deepEqual(fams, [6, 5], '族 6 最久到期；上限只截掉后面的族');
}

// —— 事件幂等与冲突
{
  const { index, session, vocab } = fresh(['a']);
  assert.equal(LV.acceptEvent(session, 'ev-1', 'a', 'know', NOW), false);
  assert.equal(LV.acceptEvent(session, 'ev-1', 'a', 'know', NOW), true);
  assert.throws(() => LV.acceptEvent(session, 'ev-1', 'a', 'again', NOW), /event id reused/);
}

console.log('PASS lesson unit: new-word 3d/relearn, lapse on seen-card (due & not-due), not-due freeze, insert@10 + shuffled round-end recheck + archive + nextDueAt, recheck-fail no double penalty, planStart review/restart (oldest family first under cap), event idempotency');
