import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { Model as M, ensurePlans, summary, startPlan, finishPlan, updateSettings, applyPlanAttempt, questionSignature } from '../course-plan.mjs';
const NOW = Date.parse('2026-10-29T02:00:00Z'), DAY = M.DAY;
const clone = x => structuredClone(x);
function quiz(course = 'ndf-01', no = 1) { return { v: 2, at: NOW - DAY * 30, course, lessonNo: no, questions: [
  { id: 'q1', stem: 'one', options: { A: 'yes', B: 'no' }, answer: 'A' },
  { id: 'q2', stem: 'two', options: { A: 'yes', B: 'no' }, answer: 'B' },
  { id: 'q3', stem: 'extension', tier: 'ext', options: { A: 'yes' }, answer: 'A' },
  { id: 'q4', stem: 'bad', options: { A: 'yes' }, answer: 'A' }], bad: ['q4'] }; }
function fixture(n = 1) { const records = { attempts: {}, course: {} }, quizzes = {}; for (let i = 1; i <= n; i++) quizzes['ndf-01-' + String(i).padStart(2, '0')] = quiz('ndf-01', i); return { records, quizzes }; }
function answer(r, qs, round, q, letter, unsure = false, phase = 'main', now = NOW) {
  return applyPlanAttempt(r, qs, { ref: { qid: 'gen/ndf-01/1/quiz/' + q }, planRound: round, planPhase: phase, answer: letter, unsure }, now);
}
function finishRound(r, qs, now, rating = 'good') {
  const id = startPlan(r, qs, { lessonId: 'ndf-01-01' }, now).plan.active.id;
  answer(r, qs, id, 1, 'A'); answer(r, qs, id, 2, 'B');
  return finishPlan(r, qs, { lessonId: 'ndf-01-01', roundId: id, rating }, now);
}
test('UMD shared rules, managed IDs and valid core only', () => {
  const context = {}; vm.runInNewContext(fs.readFileSync(new URL('../web/course-plan-model.js', import.meta.url), 'utf8'), context);
  assert.equal(context.CoursePlanModel.isManagedQid('gen/cfcm-01/36/quiz/2'), true);
  for (const q of ['gen/ndf-02/1/quiz/1', 'gen/ndf-01/01/quiz/1', 'gen/ndf-01/0/quiz/1']) assert.equal(M.isManagedQid(q), false);
  assert.deepEqual(M.coreQuestions(quiz()).map(q => q.id), ['q1', 'q2']);
  assert.equal(questionSignature({ b: 2, a: 1 }), questionSignature({ a: 1, b: 2 }));
});
test('settings bounds and stale revisions', () => {
  const { records: r, quizzes: qs } = fixture(); ensurePlans(r, qs, NOW);
  for (const bad of [{ target: 0 }, { target: 7 }, { daily: 0 }, { daily: 6 }, { mode: 'sm2' }, { intervals: [0, 7] }, { intervals: [3, 61] }, { intervals: [3] }, { intervals: [1.5, 7] }]) {
    assert.throws(() => updateSettings(r, qs, { ...M.DEFAULTS, ...bad }, NOW), e => e.status === 400);
  }
  updateSettings(r, qs, { target: 6, intervals: [1, 60, 2, 3, 4], daily: 5, mode: 'adaptive' }, NOW);
  assert.throws(() => updateSettings(r, qs, { ...M.DEFAULTS }, NOW), e => e.code === 'settings_conflict');
  assert.throws(() => updateSettings(r, qs, { ...M.DEFAULTS, revision: undefined }, NOW), e => e.code === 'settings_conflict');
  assert.equal(updateSettings(r, qs, { target: 1, intervals: [], daily: 1, mode: 'fixed', revision: 1 }, NOW).settings.revision, 2);
});
test('first answers, cross-day pause, wrong/unsure once, fixed finish idempotency', () => {
  const { records: r, quizzes: qs } = fixture(); ensurePlans(r, qs, NOW);
  const lid = 'ndf-01-01', id = startPlan(r, qs, { lessonId: lid }, NOW).plan.active.id;
  assert.equal(startPlan(r, qs, { lessonId: lid }, NOW + DAY).plan.active.id, id);
  answer(r, qs, id, 1, 'B'); answer(r, qs, id, 1, 'A');
  assert.equal(r.coursePlan.plans[lid].active.answers.q1.ok, false);
  assert.throws(() => finishPlan(r, qs, { lessonId: lid, roundId: id, rating: 'good' }, NOW), e => e.code === 'round_incomplete');
  assert.throws(() => answer(r, qs, id, 1, 'A', false, 'correction'), e => e.code === 'phase_mismatch');
  let p = answer(r, qs, id, 2, 'B', true, 'main', NOW + DAY * 2);
  assert.equal(p.active.phase, 'correction'); assert.deepEqual(p.active.correctionOrder, ['q1', 'q2']);
  answer(r, qs, id, 1, 'B', true, 'correction'); p = answer(r, qs, id, 2, 'A', false, 'correction');
  assert.equal(p.active.phase, 'finish'); assert.equal(p.active.step, null);
  const end = NOW + DAY * 2;
  p = finishPlan(r, qs, { lessonId: lid, roundId: id, rating: 'hard' }, end).plan;
  assert.equal(p.stamps.length, 1); assert.equal(p.stamps[0].right, 1); assert.equal(p.due, end + DAY * 3);
  assert.equal(finishPlan(r, qs, { lessonId: lid, roundId: id, rating: 'easy' }, end + DAY).plan.stamps.length, 1);
  assert.throws(() => startPlan(r, qs, { lessonId: lid }, p.due - 1), e => e.code === 'plan_not_due');
  assert.equal(finishRound(r, qs, p.due).plan.due, p.due + DAY * 7);
  p = finishRound(r, qs, p.due + DAY * 7).plan; assert.equal(p.complete, true); assert.equal(p.due, null);
  assert.throws(() => startPlan(r, qs, { lessonId: lid }, end + DAY * 50), e => e.code === 'plan_complete');
});
test('migration grants at most one unknown historical stamp and stable capacity slots', () => {
  const { records: r, quizzes: qs } = fixture(5);
  for (const [lid, qz] of Object.entries(qs)) {
    r.course[lid] = { done: true };
    for (const q of M.coreQuestions(qz)) r.attempts[M.qid(qz, q)] = { n: 9, history: [{ t: NOW - DAY, answer: 'B', ok: false }] };
  }
  ensurePlans(r, qs, NOW); const initial = clone(r.coursePlan);
  const s = summary(r, qs, NOW); assert.equal(s.recommendations.length, 0);
  for (const p of Object.values(s.plans)) { assert.equal(p.stamps.length, 1); assert.equal(p.stamps[0].at, null); assert.equal(p.pendingHistorical, true); }
  const dues = Object.values(s.plans).map(p => p.due);
  for (let i = 1; i < dues.length; i++) assert.equal(M.dayStart(dues[i]) - M.dayStart(dues[i - 1]), DAY);
  ensurePlans(r, qs, NOW + DAY * 40); assert.deepEqual(r.coursePlan, initial);
  assert.deepEqual(summary(r, qs, dues[0]).recommendations, ['ndf-01-01']);
});
test('historical schedules follow changed intervals and daily capacity without inventing completion dates', () => {
  const {records:r,quizzes:qs}=fixture(3);
  for(const qz of Object.values(qs))for(const q of M.coreQuestions(qz))r.attempts[M.qid(qz,q)]={n:1,history:[{t:NOW-DAY,ok:true}]};
  ensurePlans(r,qs,NOW);
  updateSettings(r,qs,{...M.DEFAULTS,intervals:[60,7],daily:2,revision:0},NOW);
  const ps=Object.values(r.coursePlan.plans);
  assert.equal(ps[0].due,NOW+60*DAY);assert.equal(ps[1].due,NOW+60*DAY);
  assert.equal(M.dayStart(ps[2].due)-M.dayStart(ps[0].due),DAY);
  assert.ok(ps.every(p=>p.stamps.length===1&&p.stamps[0].at===null));
});
test('new course recommendations require exercise evidence, practice never counts toward a round', () => {
  const { records: r, quizzes: qs } = fixture(3); ensurePlans(r, qs, NOW);
  assert.deepEqual(summary(r, qs, NOW).recommendations, []);
  r.course['ndf-01-01'] = { done: true, pos: 600 };
  r.attempts['gen/ndf-01/1/quiz/1'] = { n: 1, last: NOW, history: [{ t: NOW, ok: true }] };
  r.attempts['gen/ndf-01/2/quiz/3'] = { n: 1, last: NOW, history: [{ t: NOW, ok: true }] };
  assert.deepEqual(summary(r, qs, NOW).recommendations, ['ndf-01-01']);
  const before = clone(r.coursePlan); applyPlanAttempt(r, qs, { ref: { qid: 'gen/ndf-01/1/quiz/1' }, answer: 'A' }, NOW); assert.deepEqual(r.coursePlan, before);
  const p = finishRound(r, qs, NOW).plan; assert.equal(summary(r, qs, NOW).todayCompleted, 1); assert.equal(summary(r, qs, NOW).remainingToday, 0);
  const newId = startPlan(r, qs, { lessonId: 'ndf-01-02' }, NOW).plan.active.id;
  assert.ok(newId); assert.deepEqual(summary(r, qs, NOW).recommendations, ['ndf-01-02']); assert.equal(p.stamps.length, 1);
});
test('version drift restarts active safely, earned stamps survive; lowered target invalidates old round', () => {
  const { records: r, quizzes: qs } = fixture(); ensurePlans(r, qs, NOW); const p = finishRound(r, qs, NOW).plan;
  const id = startPlan(r, qs, { lessonId: p.lessonId }, p.due).plan.active.id;
  answer(r, qs, id, 1, 'A'); qs[p.lessonId].questions[0].answer = 'B';
  assert.throws(() => answer(r, qs, id, 2, 'B'), e => e.code === 'question_version_changed');
  ensurePlans(r, qs, p.due, () => 'new-version');
  assert.equal(r.coursePlan.plans[p.lessonId].active.id, 'new-version'); assert.deepEqual(r.coursePlan.plans[p.lessonId].active.answers, {});
  assert.equal(r.coursePlan.plans[p.lessonId].stamps.length, 1);
  updateSettings(r, qs, { target: 1, intervals: [], daily: 1, mode: 'fixed' }, NOW);
  assert.equal(summary(r, qs, NOW).plans[p.lessonId].complete, true);
  assert.throws(() => finishPlan(r, qs, { lessonId: p.lessonId, roundId: id, rating: 'good' }, NOW), e => e.code === 'round_mismatch');
  updateSettings(r, qs, { target: 3, intervals: [3, 7], daily: 1, mode: 'fixed', revision: 1 }, NOW);
  assert.equal(summary(r, qs, NOW).plans[p.lessonId].stamps.length, 1);
});
test('historical coverage rejects revised/stale answers; unsupported/ext-only quizzes excluded', () => {
  const { records: r, quizzes: qs } = fixture(2); qs['ndf-01-02'].questions.forEach(q => q.tier = 'ext');
  qs['vince-01-01'] = { ...quiz(), course: 'vince-01' };
  for (const q of M.coreQuestions(qs['ndf-01-01'])) r.attempts[M.qid(qs['ndf-01-01'], q)] = { n: 1, history: [{ t: NOW - DAY * 31 }] };
  ensurePlans(r, qs, NOW); assert.equal(Object.keys(r.coursePlan.plans).length, 1); assert.equal(r.coursePlan.plans['ndf-01-01'].stamps.length, 0);
});
test('mixed migrated history respects per-day capacity, and new autonomous answers never become legacy stamps', () => {
  const { records: r, quizzes: qs } = fixture(9);
  for (const [lid, qz] of Object.entries(qs)) {
    r.course[lid] = { done: true };
    if (qz.lessonNo % 2) for (const q of M.coreQuestions(qz)) r.attempts[M.qid(qz, q)] = { n: 1, history: [{ t: NOW - DAY }] };
  }
  ensurePlans(r, qs, NOW);
  const days = Object.values(r.coursePlan.plans).map(p => M.dayStart(p.due));
  assert.equal(new Set(days).size, days.length);
  const other = fixture();
  for (const q of M.coreQuestions(other.quizzes['ndf-01-01'])) other.records.attempts[M.qid(other.quizzes['ndf-01-01'], q)] = {
    n: 1, history: [{ t: NOW - 1000, coursePlanAutonomous: true, coursePlanSignature: questionSignature(q) }] };
  ensurePlans(other.records, other.quizzes, NOW);
  assert.equal(other.records.coursePlan.plans['ndf-01-01'].stamps.length, 0);
});
test('adaptive uses performance and rating, bounded intervals and finite completion', () => {
  const runs = ['hard', 'good', 'easy'].map(rating => {
    const { records: r, quizzes: qs } = fixture(); ensurePlans(r, qs, NOW); updateSettings(r, qs, { ...M.DEFAULTS, mode: 'adaptive' }, NOW);
    const p = finishRound(r, qs, NOW, rating).plan; assert.ok(p.due >= NOW + DAY && p.due <= NOW + 60 * DAY);
    let next = p; for (let i = 1; i < 3; i++) next = finishRound(r, qs, next.due, 'hard').plan;
    assert.equal(next.complete, true); assert.equal(next.stamps.length, 3); return p.due;
 });
  assert.ok(runs[0] < runs[1] && runs[1] < runs[2]);
  const { records: r, quizzes: qs } = fixture(); ensurePlans(r, qs, NOW); updateSettings(r, qs, { ...M.DEFAULTS, mode: 'adaptive' }, NOW);
  const id = startPlan(r, qs, { lessonId: 'ndf-01-01' }, NOW).plan.active.id;
  answer(r, qs, id, 1, 'B'); answer(r, qs, id, 2, 'A'); answer(r, qs, id, 1, 'B', false, 'correction'); answer(r, qs, id, 2, 'A', false, 'correction');
  assert.ok(finishPlan(r, qs, { lessonId: 'ndf-01-01', roundId: id, rating: 'good' }, NOW).plan.due < runs[1]);
});

test('pre-activation practice alone never pushes a never-started course (r7)', () => {
  const records = { attempts: {}, course: {} }, quizzes = {};
  quizzes['cfcm-01-01'] = quiz('cfcm-01', 1);
  quizzes['ndf-01-01'] = quiz('ndf-01', 1);
  records.attempts['gen/cfcm-01/1/quiz/1'] = { n: 2, last: NOW - DAY * 5, history: [{ t: NOW - DAY * 5, answer: 'B', ok: true }] };
  records.course['cfcm-01-01'] = { at: NOW - DAY * 6, pos: 543 };
  ensurePlans(records, quizzes, NOW);
  let s = summary(records, quizzes, NOW);
  assert.deepEqual(s.recommendations, [], 'pre-activation practice and sampling watch are not an endorsement');
  assert.equal(s.plans['cfcm-01-01'].begun, false);
  records.attempts['gen/cfcm-01/1/quiz/2'] = { n: 1, last: NOW + 1000, history: [{ t: NOW + 1000, answer: 'A', ok: true }] };
  s = summary(records, quizzes, NOW);
  assert.deepEqual(s.recommendations, ['cfcm-01-01'], 'post-activation practice starts the course');
  assert.equal(s.plans['cfcm-01-01'].begun, true);
});
test('a stray zero-answer round on an unengaged lesson stops being pushed but stays resumable (r7)', () => {
  const records = { attempts: {}, course: {} }, quizzes = {};
  quizzes['cfcm-01-01'] = quiz('cfcm-01', 1);
  ensurePlans(records, quizzes, NOW);
  startPlan(records, quizzes, { lessonId: 'cfcm-01-01' }, NOW);
  let s = summary(records, quizzes, NOW);
  assert.deepEqual(s.recommendations, [], 'auto-started unwanted round is not pushed');
  assert.ok(s.plans['cfcm-01-01'].active, 'round survives on the lesson page');
  applyPlanAttempt(records, quizzes, { ref: { qid: 'gen/cfcm-01/1/quiz/1' }, planRound: s.plans['cfcm-01-01'].active.id, planPhase: 'main', answer: 'A' }, NOW + 1000);
  s = summary(records, quizzes, NOW);
  assert.deepEqual(s.recommendations, ['cfcm-01-01'], 'answered work becomes resumable and pushed');
});
test('post-activation practice counts as started (r7)', () => {
  const records = { attempts: {}, course: {} }, quizzes = {};
  quizzes['cfcm-01-01'] = quiz('cfcm-01', 1);
  ensurePlans(records, quizzes, NOW);
  records.attempts['gen/cfcm-01/1/quiz/1'] = { n: 1, last: NOW + DAY, history: [{ t: NOW + DAY, answer: 'A', ok: true }] };
  const s = summary(records, quizzes, NOW);
  assert.equal(s.plans['cfcm-01-01'].begun, true);
  assert.deepEqual(s.recommendations, ['cfcm-01-01']);
});
