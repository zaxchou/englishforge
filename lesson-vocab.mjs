/* 课程驱动认读：课级会话状态机。
   纯逻辑，不读写文件；由 server.mjs 在同一 records 事务里调用。 */
export const LESSON_ID = 'cfcm-01-01';
export const FIRST_INTERVAL_MIN = 3 * 24 * 60;   // 首次认出约 3 天
const ACTIONS = new Set(['know', 'again', 'continue']);

export const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

export function indexCards(payload) {
  const cards = payload.cards || [];
  const byKey = new Map();
  for (const c of cards) {
    if (!c.key || byKey.has(c.key)) throw new Error('duplicate lesson card key: ' + c.key);
    byKey.set(c.key, c);
  }
  return { lessonId: payload.lessonId, title: payload.title, total: cards.length, cards, byKey };
}

export function newSession(index, now, roundId) {
  const order = index.cards.map(c => c.key);
  return {
    v: 1, lessonId: index.lessonId, roundId,
    startedAt: now, updatedAt: now, completedAt: null,
    order: order.slice(), queue: order.slice(), front: 0,
    tries: {}, done: {}, events: {}, history: []
  };
}

export function publicSession(s) {
  if (!s) return null;
  const doneCount = Object.keys(s.done || {}).length;
  const current = s.queue[0] || null;
  const again = s.queue.filter(k => !s.done[k] && (s.tries[k] || 0) > 0).length;
  let first = 0, later = 0;
  for (const item of Object.values(s.done || {})) (item.first === 'know' ? first++ : later++);
  return {
    roundId: s.roundId, startedAt: s.startedAt, updatedAt: s.updatedAt,
    completedAt: s.completedAt || null,
    total: s.order.length, remaining: s.queue.length, doneCount, again,
    current, front: s.front ? 1 : 0,
    done: s.done, summary: { first, later },
    history: (s.history || []).slice(-5)
  };
}

export function startSession(existing, index, now, roundId, restart) {
  if (existing && !restart) return existing;
  const fresh = newSession(index, now, roundId);
  if (existing && existing.history) fresh.history = existing.history.slice(-4);
  return fresh;
}

/* 新课首次认出的初始状态：已毕业、约三天后再见，保留规范字段。 */
export function initialKnown(now) {
  return {
    e: 2.5, i: FIRST_INTERVAL_MIN, s: 99, r: 1, n: 1,
    at: now, born: now, due: now + FIRST_INTERVAL_MIN * 60000
  };
}

export function applyAction({ session, index, vocab, key, action, now, nextExisting }) {
  if (!ACTIONS.has(action)) throw httpError(400, 'invalid action');
  if (!index.byKey.has(key)) throw httpError(400, 'word not in lesson');
  if (session.completedAt) throw httpError(409, 'lesson already completed');
  const current = session.queue[0];
  if (key !== current) throw httpError(409, 'not current word');
  if (action === 'again') {
    if (session.front) throw httpError(409, 'card already open');
    session.front = 1;
  } else if (action === 'continue') {
    if (!session.front) throw httpError(409, 'card not open');
    session.front = 0;
    session.tries[key] = (session.tries[key] || 0) + 1;
    session.queue.shift();
    session.queue.push(key);
  } else {
    if (session.front) throw httpError(409, 'close card before knowing');
    const existing = vocab[key] || null;
    let st = null, introduced = false;
    if (!existing) {
      st = initialKnown(now);
      introduced = true;
    } else if (existing.due <= now) {
      st = nextExisting(existing, now);
      if (!st) throw httpError(409, 'existing schedule rejected');
    }
    const tries = session.tries[key] || 0;
    session.done[key] = { tries, first: tries === 0 ? 'know' : 'again', at: now };
    session.queue.shift();
    session.front = 0;
    if (st) {
      st.n = (existing?.n || 0) + 1;
      st.at = now;
      if (existing?.born) st.born = existing.born;
      vocab[key] = st;
    }
    if (session.queue.length === 0) {
      session.completedAt = now;
      session.history.push({ completedAt: now, total: session.order.length, summary: publicSession(session).summary });
      session.history = session.history.slice(-5);
    }
    session.updatedAt = now;
    return { session, wrote: !!st, introduced, st: vocab[key] || null };
  }
  session.updatedAt = now;
  return { session, wrote: false, introduced: false, st: vocab[key] || null };
}

export function acceptEvent(session, id, key, action, now) {
  session.events ||= {};
  const seen = session.events[id];
  if (seen) {
    if (seen.key !== key || seen.action !== action) throw httpError(409, 'event id reused with different payload');
    return true;
  }
  session.events[id] = { key, action, at: now };
  const ids = Object.keys(session.events);
  if (ids.length > 800) for (const old of ids.slice(0, ids.length - 800)) delete session.events[old];
  return false;
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
