/* 数字听写作答的待传队列：独立键前缀，服务端确认后才删除。
   - 每次作答先本地持久化，再尝试上传，保证刷新/断网不丢。
   - 同一条事件重试保持相同 id 与载荷。
   - 409/400 这类永久性问题移出队列，避免一条坏记录永久阻塞后续。 */

const PREFIX = 'nt:queue:';
const REJECT_PREFIX = 'nt:rejected:';

function keys(storage) {
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(PREFIX)) out.push(k);
  }
  return out.sort();
}

export function createQueue({ storage = globalThis.localStorage, endpoint = '/api/number-trainer/attempt', fetchImpl = (...a) => fetch(...a), onChange = () => {}, maxRetain = 200 } = {}) {
  let flushing = null;

  function pendingCount() { return keys(storage).length; }
  function enqueue(event) {
    storage.setItem(PREFIX + event.eventId, JSON.stringify(event));
    onChange(pendingCount());
    return event.eventId;
  }
  function remove(eventId) {
    try { storage.removeItem(PREFIX + eventId); } catch { /* 忽略 */ }
    onChange(pendingCount());
  }
  function reject(eventId, body) {
    try { storage.setItem(REJECT_PREFIX + eventId, JSON.stringify({ at: Date.now(), body })); } catch { /* 忽略 */ }
    // 只保留最近若干条，防止永久性失败无限增长
    try {
      const rk = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i);if (k && k.startsWith(REJECT_PREFIX)) rk.push(k); }
      while (rk.length > maxRetain) storage.removeItem(rk.shift());
    } catch { /* 忽略 */ }
    remove(eventId);
  }

  async function sendOne(event) {
    let r;
    try {
      r = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event), credentials: 'same-origin',
      });
    } catch {
      return { status: 'offline' };
    }
    if (r.ok) {
      let body = null;
      try { body = await r.json(); } catch { /* 空响应按不确认处理 */ }
      if (!body || body.ok !== true) return { status: 'retry' };
      remove(event.eventId);
      return { status: 'sent', body };
    }
    if (r.status === 409 || r.status === 400 || r.status === 415 || r.status === 404) {
      let body = null;try { body = await r.json(); } catch { /* 忽略 */ }
      reject(event.eventId, body);
      return { status: 'rejected', body };
    }
    return { status: 'retry' };
  }

  /** 串行补传；新作答在上一轮结束后不会被跳过，因为每轮重新扫描队列。 */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const results = [];
      for (const k of keys(storage)) {
        const raw = storage.getItem(k);
        if (!raw) continue;
        let event;
        try { event = JSON.parse(raw); } catch { storage.removeItem(k);continue; }
        const out = await sendOne(event);
        results.push(out.status);
        if (out.status === 'offline') break;
      }
      onChange(pendingCount());
      return results;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  return { enqueue, flush, pendingCount, keys: () => keys(storage) };
}

export const QUEUE_PREFIX = PREFIX;
