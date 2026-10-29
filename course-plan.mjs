import { createHash, randomUUID } from 'node:crypto';
import Model from './web/course-plan-model.js';
export { Model };
const clone = x => JSON.parse(JSON.stringify(x));
function fail(message, code = 'plan_conflict', status = 409) { const e = new Error(message); e.code = code; e.status = status; throw e; }
function canonical(x) {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
export function questionSignature(q) { return createHash('sha256').update(canonical(q)).digest('hex'); }
function version(quiz) {
  return questionSignature(Model.coreQuestions(quiz).map(q => ({ ...q, quizAt: quiz.at || 0 })));
}
function learned(records, quiz, lid) {
  return !!records.course?.[lid]?.done || (quiz.questions || []).some(q => {
    const a = records.attempts?.[Model.qid(quiz, q)]; return a && (a.n > 0 || a.history?.length > 0);
  });
}
function historicalCoverage(records, quiz, cutoff) {
  return Model.coreQuestions(quiz).every(q => (records.attempts?.[Model.qid(quiz, q)]?.history || []).some(h =>
    !h.coursePlanAutonomous && Number.isFinite(h.t) && h.t <= cutoff && h.t >= Math.max(q.revisionAt || 0, quiz.at || 0) &&
    (!h.coursePlanSignature || h.coursePlanSignature === questionSignature(q))));
}
function newRound(quiz, now, id) {
  return { id: id(), version: version(quiz), startedAt: now, order: Model.coreQuestions(quiz).map(q => q.id), answers: {}, corrections: {} };
}
function phase(round) {
  if (round.order.some(id => !Object.hasOwn(round.answers, id))) return 'main';
  if (correctionOrder(round).some(id => !Object.hasOwn(round.corrections, id))) return 'correction';
  return 'finish';
}
function correctionOrder(round) { return round.order.filter(id => round.answers[id] && (!round.answers[id].ok || round.answers[id].unsure)); }
function publicActive(round) {
  if (!round) return null;
  const p = phase(round), corrections = correctionOrder(round);
  return { id: round.id, phase: p, order: [...round.order], answers: clone(round.answers), correctionOrder: corrections,
    corrections: clone(round.corrections), step: p === 'main' ? round.order.find(id => !Object.hasOwn(round.answers, id)) :
      p === 'correction' ? corrections.find(id => !Object.hasOwn(round.corrections, id)) : null };
}
export function publicPlan(root, lid, now) {
  const p = Object.hasOwn(root.plans, lid) ? root.plans[lid] : null; if (!p) return null;
  const complete = p.stamps.length >= root.settings.target;
  return { lessonId: lid, stamps: clone(p.stamps), target: root.settings.target, due: complete ? null : p.due,
    complete, active: complete ? null : publicActive(p.active), pendingHistorical: !!p.stamps.at(-1)?.historical && !complete && p.due > now };
}
// All clocks are supplied by the server; the domain never consumes a client timestamp for scheduling.
export function ensurePlans(records, quizzes, now, id = randomUUID) {
  const initial = !records.coursePlan;
  const root = records.coursePlan ||= { version: 1, activationAt: now, settings: clone(Model.DEFAULTS), plans: {} };
  if (root.version !== 1) fail('unsupported course-plan version');
  const available = Object.entries(quizzes).filter(([lid, q]) => Model.coreQuestions(q).length &&
    lid === q.course + '-' + String(q.lessonNo).padStart(2, '0')).sort(([a], [b]) => a.localeCompare(b));
  const slots = new Map();
  for (const [lid, quiz] of available) {
    let p = root.plans[lid];
    if (!p) {
      p = root.plans[lid] = { lessonId: lid, stamps: [], due: now, active: null, historicalChecked: true };
      // Only the initial snapshot can grant a legacy stamp. Later autonomous practice cannot earn one.
      if (initial && historicalCoverage(records, quiz, root.activationAt)) {
        p.stamps.push({ id: 'historical-' + lid, at: null, historical: true, right: null, total: Model.coreQuestions(quiz).length, rating: null });
      }
      if (initial && learned(records, quiz, lid)) {
        const base = p.stamps.length ? now + (root.settings.intervals[0] || 3) * Model.DAY : now;
        let day = Model.dayStart(base);
        while ((slots.get(day) || 0) >= root.settings.daily) day += Model.DAY;
        slots.set(day, (slots.get(day) || 0) + 1);
        p.due = Math.max(base, day);
        p.historicalSlot = p.due;
      }
    }
    if (p.stamps.length >= root.settings.target) p.active = null;
    else if (p.active && p.active.version !== version(quiz)) p.active = newRound(quiz, now, id);
  }
  return available.map(([lid]) => lid);
}
export function summary(records, quizzes, now) {
  const root = records.coursePlan;
  const availableLessonIds = Object.keys(root.plans).filter(lid => Model.coreQuestions(quizzes[lid]).length);
  const plans = Object.fromEntries(availableLessonIds.map(lid => [lid, publicPlan(root, lid, now)]));
  const completed = new Set(Object.entries(root.plans).filter(([, p]) => p.stamps.some(s => !s.historical && s.at >= Model.dayStart(now) && s.at < Model.dayStart(now) + Model.DAY)).map(([lid]) => lid));
  const todayCompleted = completed.size, remainingToday = Math.max(0, root.settings.daily - todayCompleted);
  const eligible = availableLessonIds.filter(lid => !plans[lid].complete && learned(records, quizzes[lid], lid) &&
    (plans[lid].active || plans[lid].due <= now)).sort((a, b) =>
      Number(!!plans[b].active) - Number(!!plans[a].active) || plans[a].due - plans[b].due || a.localeCompare(b));
  // Resumable rounds remain visible even if another device used today's recommendation capacity.
  const active = eligible.filter(lid => plans[lid].active);
  const recommendations = [...active, ...eligible.filter(lid => !plans[lid].active && !completed.has(lid)).slice(0, Math.max(0, remainingToday - active.length))];
  return { settings: clone(root.settings), plans, recommendations, todayCompleted, remainingToday, activationAt: root.activationAt, availableLessonIds };
}
export function startPlan(records, quizzes, input, now, id = randomUUID) {
  const root = records.coursePlan, p = Object.hasOwn(root.plans, input.lessonId) ? root.plans[input.lessonId] : null, quiz = quizzes[input.lessonId];
  if (!p || !Model.coreQuestions(quiz).length) fail('lesson has no managed core questions', 'lesson_unavailable', 404);
  if (p.active) return { plan: publicPlan(root, input.lessonId, now), settings: clone(root.settings) };
  if (p.stamps.length >= root.settings.target) fail('course plan complete', 'plan_complete');
  if (p.due > now) fail('course plan not due; autonomous practice is available', 'plan_not_due');
  p.active = newRound(quiz, now, id);
  return { plan: publicPlan(root, input.lessonId, now), settings: clone(root.settings) };
}
function interval(settings, stamp, count) {
  const base = settings.intervals[count - 1] || settings.intervals.at(-1) || 3;
  if (settings.mode === 'fixed' || stamp.historical) return base;
  const score = stamp.total ? stamp.right / stamp.total : 0;
  const performance = score < 0.6 ? 0.6 : score < 0.85 ? 0.85 : 1.2;
  const rating = { hard: 0.7, good: 1, easy: 1.3 }[stamp.rating];
  return Math.max(1, Math.min(60, Math.round(base * performance * rating)));
}
export function finishPlan(records, quizzes, input, now) {
  const root = records.coursePlan, p = Object.hasOwn(root.plans, input.lessonId) ? root.plans[input.lessonId] : null;
  if (!['hard', 'good', 'easy'].includes(input.rating)) fail('invalid rating', 'invalid_rating', 400);
  if (!p || typeof input.roundId !== 'string') fail('round not found', 'round_mismatch');
  if (p.stamps.some(s => s.id === input.roundId)) return { plan: publicPlan(root, input.lessonId, now), settings: clone(root.settings) };
  if (!p.active || p.active.id !== input.roundId) fail('round no longer active', 'round_mismatch');
  if (!Model.coreQuestions(quizzes[input.lessonId]).length || p.active.version !== version(quizzes[input.lessonId])) fail('question version changed', 'question_version_changed');
  if (phase(p.active) !== 'finish') fail('core coverage and one correction per wrong/unsure answer required', 'round_incomplete');
  if (p.stamps.length >= root.settings.target) fail('course plan complete', 'plan_complete');
  const stamp = { id: input.roundId, at: now, historical: false, right: p.active.order.filter(id => p.active.answers[id].ok).length,
    total: p.active.order.length, rating: input.rating };
  p.stamps.push(stamp); p.active = null;
  p.due = now + interval(root.settings, stamp, p.stamps.length) * Model.DAY;
  return { plan: publicPlan(root, input.lessonId, now), settings: clone(root.settings) };
}
export function updateSettings(records, quizzes, input, now) {
  const root = records.coursePlan;
  let next; try { next = Model.validateSettings(input); } catch (e) { fail(e.message, 'invalid_settings', 400); }
  if (input.revision !== undefined && input.revision !== root.settings.revision) fail('course-plan settings conflict', 'settings_conflict');
  // Omitted revision is accepted only for the initial configuration, never for a stale overwrite.
  if (input.revision === undefined && root.settings.revision !== 0) fail('settings revision required', 'settings_conflict');
  root.settings = { ...next, revision: root.settings.revision + 1 };
  const historicalSlots = new Map();
  for (const p of Object.values(root.plans).sort((a,b)=>a.lessonId.localeCompare(b.lessonId))) {
    if (p.stamps.length >= next.target) p.active = null;
    else if (p.stamps.length) {
      const last = p.stamps.at(-1);
      if (!last.historical) p.due = last.at + interval(next, last, p.stamps.length) * Model.DAY;
      else if (!p.active) {
        const base = root.activationAt + (next.intervals[0] || 3) * Model.DAY;
        let day = Model.dayStart(base);
        while ((historicalSlots.get(day) || 0) >= next.daily) day += Model.DAY;
        historicalSlots.set(day, (historicalSlots.get(day) || 0) + 1);
        p.due = Math.max(base, day); p.historicalSlot = p.due;
      }
    }
  }
  return summary(records, quizzes, now);
}
export function attemptFingerprint(inc) {
  return canonical({ qid: inc.ref.qid, answer: inc.answer ?? null, delete: !!inc.delete, unsure: inc.unsure === true,
    secs: inc.secs || 0, t: inc.t ?? null, planRound: inc.planRound ?? null, planPhase: inc.planPhase ?? null });
}
export function applyPlanAttempt(records, quizzes, inc, now) {
  const parsed = Model.parseQid(inc.ref.qid);
  if (!inc.planRound && inc.planPhase === undefined) return null;
  if (!parsed || inc.delete || typeof inc.planRound !== 'string' || !['main', 'correction'].includes(inc.planPhase)) fail('invalid plan round/phase', 'round_mismatch');
  const root = records.coursePlan, p = root?.plans[parsed.lessonId], quiz = quizzes[parsed.lessonId];
  if (!p?.active || p.active.id !== inc.planRound) fail('round no longer active', 'round_mismatch');
  if (p.active.version !== version(quiz)) fail('question version changed', 'question_version_changed');
  const q = Model.coreQuestions(quiz).find(q => q.id === parsed.id);
  if (!q || !p.active.order.includes(q.id)) fail('question not in current core round', 'question_version_changed');
  if (typeof inc.answer !== 'string' || !Object.hasOwn(q.options, inc.answer)) fail('answer must be an option letter', 'invalid_answer');
  const r = p.active, dest = inc.planPhase === 'main' ? r.answers : r.corrections;
  // Different devices may answer the same item: the first accepted answer in each phase wins.
  if (!Object.hasOwn(dest, q.id)) {
    if (phase(r) !== inc.planPhase || (inc.planPhase === 'correction' && !correctionOrder(r).includes(q.id))) fail('answer phase mismatch', 'phase_mismatch');
    dest[q.id] = { letter: inc.answer, ok: inc.answer === q.answer, unsure: inc.unsure === true };
  }
  return publicPlan(root, parsed.lessonId, now);
}
export function createCoursePlanHandler(o) {
  function commit(next) {
    if (JSON.stringify(next.coursePlan) === JSON.stringify(o.records().coursePlan)) return;
    next.revision = (o.records().revision || 0) + 1; next.saved_at = new Date(o.now()).toISOString();
    o.save(next); o.setRecords(next);
  }
  return { async handle(req, res, p, readBody, sendJSON) {
    if (p !== '/api/course-plan' && !['/api/course-plan/start', '/api/course-plan/finish', '/api/course-plan/settings'].includes(p)) return false;
    if (req.method !== (p === '/api/course-plan' ? 'GET' : 'POST')) { sendJSON(res, 405, { error: 'method' }); return true; }
    let input = {};
    if (req.method === 'POST') {
      if (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin)) { sendJSON(res, 403, { error: 'cross-origin write rejected' }); return true; }
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { sendJSON(res, 415, { error: 'application/json required' }); return true; }
      try { input = JSON.parse(await readBody(req, 8192)); if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error(); }
      catch { sendJSON(res, 400, { error: 'bad json' }); return true; }
    }
    const next = clone(o.records()), now = o.now(), quizzes = o.quizzes();
    try {
      ensurePlans(next, quizzes, now);
      // Persist safe migration/reconciliation even when an obsolete request is rejected.
      commit(next);
      const work = clone(o.records());
      const out = p.endsWith('/start') ? startPlan(work, quizzes, input, now) : p.endsWith('/finish') ? finishPlan(work, quizzes, input, now) :
        p.endsWith('/settings') ? updateSettings(work, quizzes, input, now) : summary(work, quizzes, now);
      commit(work); sendJSON(res, 200, out);
    } catch (e) { sendJSON(res, e.status || 503, { error: e.message, code: e.code || 'plan_not_persisted', plan: publicPlan(o.records().coursePlan || { plans: {} }, input.lessonId, now) }); }
    return true;
  } };
}
