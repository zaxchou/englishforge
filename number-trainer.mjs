/* 数字听写服务：会话、音频、幂等作答、摘要。
   与主站学习账分账；只写 number-trainer/ 目录。 */
import crypto from 'node:crypto';
import * as M from './web/number-trainer-model.mjs';
import { createStore } from './number-trainer-store.mjs';

const MAX_RAW = 24;

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function num(v, lo, hi, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback; }

/* 错题归因词（ERROR_LABELS）到训练特征的映射；无法映射的错因不硬凑专项。 */
const ERROR_TO_FEATURE = {
  teenTy: 'teenTy',
  zeroDrop: 'zeroGap', zeroInsert: 'zeroGap', missingDigits: 'zeroGap', extraDigits: 'zeroGap',
  transposition: 'distinctDigits',
};
export function createNumberTrainer({ recordsDir, ttsConfigured = false, ttsSynth = null, now = () => Date.now(), random = Math.random } = {}) {
  const store = createStore({ recordsDir, now });
  store.ensure();

  function publicConfig() {
    return {
      digitMin: M.DIGIT_MIN, digitMax: M.DIGIT_MAX,
      countDefault: 20, countOptions: [10, 20, 30],
      features: M.FEATURE_LABELS, errorLabels: M.ERROR_LABELS, sources: M.SOURCE_LABELS,
      readingVersion: M.READING_VERSION, gradingVersion: M.GRADE_VERSION,
      tts: !!ttsConfigured,
      thresholds: M.THRESHOLDS,
    };
  }

  function sanitizeConfig(input = {}) {
    const mode = input.mode === 'fixed' ? 'fixed' : 'smart';
    const digits = num(input.digits, M.DIGIT_MIN, M.DIGIT_MAX, 3);
    return {
      mode, digits,
      startDigits: num(input.startDigits, M.DIGIT_MIN, M.DIGIT_MAX, 2),
      maxDigits: Math.max(digits, num(input.maxDigits, M.DIGIT_MIN, M.DIGIT_MAX, M.DIGIT_MAX)),
      count: num(input.count, 5, 60, 20),
      rate: [0.8, 1].includes(Number(input.rate)) ? Number(input.rate) : 1,
    };
  }

  function summaryFor(days = 90) {
    const events = store.readRange({ days });
    const summary = M.summarizeAttempts(events, { days, now: now() });
    // 升档看最近 20 个同档有效作答，避免早期错题永久压着；长期弱项仍用全量。
    const level = M.currentLevel(events);
    summary.recent = level == null ? null : M.recentWindow(events, { digits: level });
    summary.level = level;
    return {
      summary,
      advice: M.buildAdvice(summary),
      candidateWeaknesses: M.candidateWeaknesses(summary),
      recommendedDigits: M.currentDigits(summary, { maxDigits: M.DIGIT_MAX, startDigits: 2 }, summary.recent),
    };
  }

  function createSession(input) {
    const config = sanitizeConfig(input);
    const { summary } = summaryFor(90);
    const focus = Array.isArray(input.focus)
      ? [...new Set(input.focus.map(f => Object.hasOwn(M.FEATURE_LABELS, f) ? f : ERROR_TO_FEATURE[f]).filter(Boolean))].slice(0, 3)
      : [];
    let plan;
    if (focus.length) {
      // 错题重练：只按本轮错因出同类新数字，仍然不重复具体旧题。
      const count = Math.max(5, Math.min(20, config.count));
      const digits = config.mode === 'fixed' ? config.digits : Math.max(2, M.currentDigits(summary, { maxDigits: M.DIGIT_MAX, startDigits: 2 }));
      const room = new Map(focus.map(f => [f, M.featureCapacity(f, digits)]));
      const slots = [];
      for (let i = 0; i < count; i++) {
        const open = focus.filter(f => (room.get(f) || 0) > 0);
        if (!open.length) { slots.push({ source: 'probe', feature: null, digits });continue; }
        const f = open[i % open.length];
        room.set(f, room.get(f) - 1);
        slots.push({ source: 'focus', feature: f, digits });
      }
      plan = { slots, baseDigits: digits, focusTags: focus, reviewTags: [], version: M.PLAN_VERSION + '+retry' };
    } else {
      plan = M.planRound({ summary, config, rng: random, now: now() });
    }
    const questions = M.buildSessionQuestions({ plan, rng: random });
    const id = 's' + now().toString(36) + crypto.randomBytes(4).toString('hex');
    const date = new Date(now()).toISOString().slice(0, 10);
    const session = {
      id, date, createdAt: new Date(now()).toISOString(), config,
      plan: { version: plan.version, baseDigits: plan.baseDigits, focusTags: plan.focusTags, reviewTags: plan.reviewTags },
      questions: questions.map(q => ({ id: q.id, value: q.value, text: q.text, digits: q.digits, feature: q.feature, features: q.features, source: q.source, readingVersion: q.readingVersion })),
      state: 'active', finishedAt: null,
    };
    store.saveSession(session);
    store.pruneSessions(30);
    return {
      id, config, createdAt: session.createdAt,
      plan: session.plan,
      advice: M.buildAdvice(summary),
      questions: session.questions.map(q => ({ ...q, audioUrl: `/api/number-trainer/audio?s=${encodeURIComponent(id)}&q=${encodeURIComponent(q.id)}` })),
    };
  }

  function sessionView(session) {
    const answered = {};
    try {
      for (const e of Object.values(store.readDay(session.date).events)) {
        if (e.sessionId !== session.id) continue;
        answered[e.questionId] = { correct: !!e.correct, raw: e.raw, skip: !!e.skip, assisted: !!e.assisted, errorTags: e.errorTags || [] };
      }
    } catch { /* 分卷损坏时不影响会话继续作答 */ }
    return {
      id: session.id, config: session.config, createdAt: session.createdAt, plan: session.plan,
      state: session.state, finishedAt: session.finishedAt, answered,
      questions: session.questions.map(q => ({ ...q, audioUrl: `/api/number-trainer/audio?s=${encodeURIComponent(session.id)}&q=${encodeURIComponent(q.id)}` })),
    };
  }

  function gradeAttempt(input) {
    const session = store.readSession(String(input.sessionId || ''));
    if (!session) throw Object.assign(new Error('SESSION_NOT_FOUND'), { code: 404 });
    const q = session.questions.find(x => x.id === input.questionId);
    if (!q) throw Object.assign(new Error('QUESTION_NOT_FOUND'), { code: 404 });
    const raw = typeof input.raw === 'string' ? input.raw.slice(0, MAX_RAW) : '';
    const skip = input.skip === true;
    if (!skip && !raw.trim()) throw Object.assign(new Error('ANSWER_EMPTY'), { code: 400 });
    const graded = skip ? { status: 'skipped', correct: false, normalized: null } : M.gradeAnswer(q.value, raw);
    if (graded.status === 'invalid') throw Object.assign(new Error('ANSWER_FORMAT'), { code: 400 });
    const correct = graded.correct === true;
    const errorTags = correct || skip ? [] : M.classifyError(q.value, graded.normalized);
    const timingValid = input.timingValid === true && !input.invalidReason;
    const event = {
      eventId: String(input.eventId || ''), sessionId: session.id, questionId: q.id,
      sessionAt: session.createdAt, submittedAt: new Date(now()).toISOString(),
      target: q.value, text: q.text, digits: q.digits, feature: q.feature, features: q.features, source: q.source,
      raw, normalized: graded.normalized || null, correct, skip,
      assisted: !!(input.replay === true || input.hint === true), replay: input.replay === true, hint: input.hint === true,
      plays: num(input.plays, 1, 20, 1),
      firstInputMs: Number.isFinite(input.firstInputMs) ? Math.round(input.firstInputMs) : null,
      inputMs: Number.isFinite(input.inputMs) ? Math.round(input.inputMs) : null,
      submitMs: Number.isFinite(input.submitMs) ? Math.round(input.submitMs) : null,
      timingValid, invalidReason: typeof input.invalidReason === 'string' ? input.invalidReason.slice(0, 40) : null,
      rate: Number(input.rate) === 0.8 ? 0.8 : 1,
      voice: input.voice === 'browser' ? 'browser' : 'server',
      device: typeof input.device === 'string' ? input.device.slice(0, 40) : null,
      clientAt: typeof input.clientAt === 'string' ? input.clientAt.slice(0, 40) : null,
      errorTags, gradingVersion: M.GRADE_VERSION, classifyVersion: M.CLASSIFY_VERSION,
    };
    event.fingerprint = sha(JSON.stringify([event.sessionId, event.questionId, event.raw, event.skip, event.replay, event.hint, event.plays, event.submitMs, event.voice, event.rate]));
    const old = store.findEvent(event.eventId, session.date);
    if (old) {
      if (old.fingerprint !== event.fingerprint) throw Object.assign(new Error('EVENT_CONFLICT'), { code: 409 });
      return { duplicate: true, result: resultOf(old) };
    }
    store.appendEvent(event, session.date);
    return { duplicate: false, result: resultOf(event) };
  }
  function resultOf(e) {
    return { correct: !!e.correct, answer: e.target, text: e.text, errorTags: e.errorTags || [], skip: !!e.skip, normalized: e.normalized ?? null };
  }

  /** 返回 true 表示已处理该请求。 */
  async function handle(req, res, p, readBody, sendJSON, sendFile) {
    if (!p.startsWith('/api/number-trainer')) return false;
    const m = {
      config: p === '/api/number-trainer/config',
      sessions: p === '/api/number-trainer/sessions',
      sessionOne: /^\/api\/number-trainer\/sessions\/([a-z0-9-]{6,64})$/i.exec(p),
      finish: /^\/api\/number-trainer\/sessions\/([a-z0-9-]{6,64})\/finish$/i.exec(p),
      audio: p === '/api/number-trainer/audio',
      attempt: p === '/api/number-trainer/attempt',
      summary: p === '/api/number-trainer/summary',
      attempts: p === '/api/number-trainer/attempts',
      history: p === '/api/number-trainer/history',
      settings: p === '/api/number-trainer/settings',
    };
    if (!Object.values(m).some(Boolean)) { sendJSON(res, 404, { error: 'NOT_FOUND' });return true; }

    const write = ['sessions', 'finish', 'attempt', 'settings'].some(k => m[k]);
    if (write && req.method !== 'POST') { sendJSON(res, 405, { error: 'method' });return true; }
    if (!write && req.method !== 'GET') { sendJSON(res, 405, { error: 'method' });return true; }

    let body = null;
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(origin)) { sendJSON(res, 403, { error: 'cross-origin rejected' });return true; }
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { sendJSON(res, 415, { error: 'application/json required' });return true; }
      try { body = JSON.parse((await readBody(req, 16384)).toString('utf8') || '{}'); } catch { sendJSON(res, 400, { error: 'bad json' });return true; }
      if (!isObject(body)) { sendJSON(res, 400, { error: 'bad json' });return true; }
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (m.config) { sendJSON(res, 200, publicConfig());return true; }

      if (m.sessions) {
        const created = createSession(body || {});
        sendJSON(res, 200, created);return true;
      }
      if (m.sessionOne) {
        const s = store.readSession(m.sessionOne[1]);
        if (!s) { sendJSON(res, 404, { error: 'SESSION_NOT_FOUND' });return true; }
        sendJSON(res, 200, sessionView(s));return true;
      }
      if (m.finish) {
        const s = store.readSession(m.finish[1]);
        if (!s) { sendJSON(res, 404, { error: 'SESSION_NOT_FOUND' });return true; }
        if (s.state !== 'finished') { s.state = 'finished';s.finishedAt = new Date(now()).toISOString();store.updateSession(s); }
        const events = Object.values(store.readDay(s.date).events).filter(e => e.sessionId === s.id);
        sendJSON(res, 200, { id: s.id, state: s.state, finishedAt: s.finishedAt, attempts: events.length, summary: M.summarizeAttempts(events, { now: now() }), advice: M.buildAdvice(M.summarizeAttempts(events, { now: now() })) });return true;
      }
      if (m.audio) {
        const sid = String(url.searchParams.get('s') || ''), qid = String(url.searchParams.get('q') || '');
        const s = store.readSession(sid);
        if (!s) { sendJSON(res, 404, { error: 'SESSION_NOT_FOUND' });return true; }
        const q = s.questions.find(x => x.id === qid);
        if (!q) { sendJSON(res, 404, { error: 'QUESTION_NOT_FOUND' });return true; }
        if (!ttsConfigured || typeof ttsSynth !== 'function') { sendJSON(res, 503, { error: 'TTS_NOT_CONFIGURED' });return true; }
        let file;
        try { file = await ttsSynth(q.text); }
        catch (e) { sendJSON(res, 502, { error: 'TTS_FAILED', message: String(e.message || e).slice(0, 120) });return true; }
        res.setHeader('Cache-Control', 'private, max-age=604800');
        sendFile(req, res, file);
        return true;
      }
      if (m.attempt) {
        const out = gradeAttempt(body || {});
        sendJSON(res, 200, { ok: true, duplicate: out.duplicate, result: out.result });return true;
      }
      if (m.summary) {
        const days = num(url.searchParams.get('days'), 1, 365, 90);
        const data = summaryFor(days);
        sendJSON(res, 200, { ...data, config: publicConfig(), days });return true;
      }
      if (m.attempts) {
        const date = String(url.searchParams.get('date') || new Date(now()).toISOString().slice(0, 10));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { sendJSON(res, 400, { error: 'BAD_DATE' });return true; }
        const day = store.readDay(date);
        const events = Object.values(day.events).sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt))).slice(-500);
        sendJSON(res, 200, { date, events });return true;
      }
      if (m.history) {
        const days = num(url.searchParams.get('days'), 1, 180, 30);
        const limit = num(url.searchParams.get('limit'), 1, 30, 8);
        const rounds = new Map();
        for (const e of store.readRange({ days })) {
          let r = rounds.get(e.sessionId);
          if (!r) {
            r = { sessionId: e.sessionId, startedAt: e.sessionAt || e.submittedAt, endedAt: e.submittedAt, settled: 0, independent: 0, assisted: 0, skipped: 0, times: [], digits: new Set(), errors: {} };
            rounds.set(e.sessionId, r);
          }
          r.endedAt = e.submittedAt;
          r.settled++;
          if (e.skip) r.skipped++;
          else if (e.assisted) r.assisted++;
          else if (e.correct) r.independent++;
          if (e.timingValid && !e.assisted && !e.skip && e.correct && Number.isFinite(e.submitMs)) r.times.push(e.submitMs);
          r.digits.add(String(e.digits || ''));
          for (const t of e.errorTags || []) r.errors[t] = (r.errors[t] || 0) + 1;
        }
        const list = [...rounds.values()]
          .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
          .slice(0, limit)
          .map(r => {
            const times = r.times.sort((x, y) => x - y);
            const top = Object.entries(r.errors).sort((a, b) => b[1] - a[1])[0];
            return {
              sessionId: r.sessionId, startedAt: r.startedAt, endedAt: r.endedAt,
              settled: r.settled, independent: r.independent, assisted: r.assisted, skipped: r.skipped,
              accuracy: r.settled ? r.independent / r.settled : null,
              medianMs: times.length ? times[Math.floor((times.length - 1) / 2)] : null,
              digits: [...r.digits].filter(Boolean).sort().join('/'),
              errorTags: Object.keys(r.errors), topError: top ? top[0] : null,
            };
          });
        sendJSON(res, 200, { rounds: list, days });return true;
      }
      if (m.settings) {
        if (req.method === 'GET') { sendJSON(res, 200, store.readSettings());return true; }
        const next = sanitizeConfig(body || {});
        store.writeSettings({ ...next, updatedAt: new Date(now()).toISOString() });
        sendJSON(res, 200, { ok: true, config: next });return true;
      }
    } catch (e) {
      const code = e.code === 409 ? 409 : e.code === 404 ? 404 : e.code === 400 ? 400 : 503;
      sendJSON(res, code, { error: e.message || 'NUMBER_TRAINER_ERROR' });
      return true;
    }
    sendJSON(res, 404, { error: 'NOT_FOUND' });
    return true;
  }

  return { handle, store, publicConfig, summaryFor };
}
