/* 课程驱动认读：课级会话状态机。
   纯逻辑，不读写文件；由 server.mjs 在同一 records 事务里调用。
   调度语义（审计 2026-11-10 C1/C2 后定稿）：
   - tries=0 首次就认出：新词 3 天；到期旧词按良好延长；未到期旧词不写。
   - tries=1 看卡后认出：新词次日（1 天）；已有记录一律按遗忘处理（间隔重置 1 天、ease-0.2）。
   - tries>=2 或轮末再确认（rechecked）：只确认，不再写调度。 */
export const LESSON_ID = 'cfcm-01-01';
export const FIRST_INTERVAL_MIN = 3 * 24 * 60;   // 首次认出约 3 天（用户定的策略）
export const RELEARN_INTERVAL_MIN = 24 * 60;     // 看卡后认出：次日再确认
export const REVIEW_CAP = 40;                   // 单个复习轮最多处理多少到期词（防 176 词同日洪峰）
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

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function newSession(index, now, roundId) {
  const order = index.cards.map(c => c.key);
  return {
    v: 2, lessonId: index.lessonId, roundId, phase: 'first',
    startedAt: now, updatedAt: now, completedAt: null, nextDueAt: null,
    order: order.slice(), queue: order.slice(), front: 0,
    tries: {}, done: {}, rechecked: {}, pendingRecheck: [], events: {}, history: []
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
    roundId: s.roundId, phase: s.phase || 'first',
    startedAt: s.startedAt, updatedAt: s.updatedAt,
    completedAt: s.completedAt || null, nextDueAt: s.nextDueAt || null,
    total: s.order.length, remaining: s.queue.length, doneCount, again,
    current, front: s.front ? 1 : 0,
    done: s.done, rechecked: s.rechecked || {},
    summary: { first, later },
    history: (s.history || []).slice(-5)
  };
}

/* start 语义：有未完成会话→续做；已完成→若有到期词则开复习轮，否则原样返回；
   restart→强制新认读轮（保留最近历史）。 */
/* 复习轮：同族相邻（先词根线索）；族按族内最早到期时间排序（最久未复习的先走，
   到期量超过单轮上限也不会让同一族连续几轮被截掉），同一时刻到期的族随机排序。
   单轮上限只管条数，防洪峰。 */
export function createReviewSession(index, vocab, now, roundId, opts = {}) {
  const due = dueKeys(index, vocab, now);
  if (!due.length) return null;
  const cap = Math.max(1, Math.min(200, Number(opts.reviewCap) || REVIEW_CAP));
  const byGroup = new Map();
  for (const k of due) {
    const g = Number((index.byKey.get(k) || {}).group || 0);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(k);
  }
  const blocks = [];
  for (const [g, list] of byGroup) {
    list.sort((a, b) => Number(vocab[a].due) - Number(vocab[b].due));
    blocks.push({ list, due: Number(vocab[list[0]].due), tie: Math.random() });
  }
  blocks.sort((a, b) => a.due - b.due || a.tie - b.tie);
  const order = [];
  for (const b of blocks) order.push(...b.list);
  const picked = order.slice(0, cap);
  const fresh = newSession(index, now, roundId);
  fresh.phase = 'review';
  fresh.order = picked.slice();
  fresh.queue = picked.slice();
  return fresh;
}

export function planStart(existing, index, vocab, now, roundId, restart, opts = {}) {
  if (existing && !restart) {
    if (!existing.completedAt) return { session: existing, resumed: true };
    const review = createReviewSession(index, vocab, now, roundId, opts);
    if (!review) return { session: existing, resumed: true };
    if (existing.history) review.history = existing.history.slice(-4);
    return { session: review, resumed: false };
  }
  const fresh = newSession(index, now, roundId);
  if (existing && existing.history) fresh.history = existing.history.slice(-4);
  return { session: fresh, resumed: false };
}

function dueKeys(index, vocab, now) {
  const out = [];
  for (const k of index.byKey.keys()) {
    const st = vocab && vocab[k];
    if (st && Number(st.due) <= now) out.push(k);
  }
  return out;
}

/* 首次认出（本来就认识/到期复习成功）：3 天。 */
export function initialKnown(now) {
  return { e: 2.5, i: FIRST_INTERVAL_MIN, s: 99, r: 1, due: now + FIRST_INTERVAL_MIN * 60000 };
}

/* 看卡后认出：次日再确认（新词，ease 不动）。 */
export function relearnKnown(now) {
  return { e: 2.5, i: RELEARN_INTERVAL_MIN, s: 99, r: 0, due: now + RELEARN_INTERVAL_MIN * 60000 };
}

/* 看卡后认出（已有记录）：按遗忘处理——间隔重置 1 天、ease-0.2，不改阶梯。 */
export function lapsedKnown(existing, now) {
  return {
    e: Math.max(1.3, Math.round(((existing ? existing.e : 2.5) - 0.2) * 1000) / 1000),
    i: RELEARN_INTERVAL_MIN, s: 99, r: 0,
    due: now + RELEARN_INTERVAL_MIN * 60000
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
    session.queue.splice(Math.min(10, session.queue.length), 0, key);   // 4.3：隔约 10 张重现
  } else {
    if (session.front) throw httpError(409, 'close card before knowing');
    const existing = vocab[key] || null;
    const preTries = session.tries[key] || 0;
    const inRecheck = !!(session.rechecked && session.rechecked[key]);
    let st = null, introduced = false;
    if (!existing) {
      st = preTries === 0 ? initialKnown(now) : relearnKnown(now);
      introduced = true;
    } else if (preTries >= 1 && !inRecheck) {   // 看卡任意多次后认出都是遗忘（R2.2-1）
      st = lapsedKnown(existing, now);            // 看卡后认出 = 遗忘信号（C1）
    } else if (existing.due <= now) {
      st = nextExisting(existing, now);           // 到期正常成功
    }
    if (st) {
      st.n = (existing ? existing.n || 0 : 0) + 1;
      st.at = now;
      if (existing && Number.isFinite(existing.born) && existing.born > 0) st.born = existing.born;
      else st.born = now;
      vocab[key] = st;
    }
    session.done[key] = { tries: preTries, first: preTries === 0 ? 'know' : 'again', at: now };
    session.queue.shift();
    session.front = 0;
    // 看卡后认出的词：本轮末尾打乱后再确认一次（4.3）
    if (preTries >= 1 && !inRecheck) {
      session.rechecked ||= {};
      session.rechecked[key] = 1;
      session.pendingRecheck ||= [];
      session.pendingRecheck.push(key);
    }
    if (session.queue.length === 0) {
      if ((session.pendingRecheck || []).length) {
        session.queue = shuffle(session.pendingRecheck);
        session.pendingRecheck = [];
      } else {
        session.completedAt = now;
        session.nextDueAt = computeNextDue(session, vocab, now);
        session.history.push({
          completedAt: now, roundId: session.roundId, phase: session.phase,
          total: session.order.length, summary: publicSession(session).summary,
          tries: { ...session.tries }   // C5：逐词结果归档
        });
        session.history = session.history.slice(-5);
      }
    }
    session.updatedAt = now;
    return { session, wrote: !!st, introduced, st: vocab[key] || null };
  }
  session.updatedAt = now;
  return { session, wrote: false, introduced: false, st: vocab[key] || null };
}

function computeNextDue(session, vocab, now) {
  let min = null;
  for (const k of session.order) {
    const st = vocab && vocab[k];
    if (st && Number(st.due) > now && (min === null || st.due < min)) min = st.due;
  }
  return min;
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
