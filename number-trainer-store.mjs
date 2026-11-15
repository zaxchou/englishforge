'use strict';
/* 数字听写独立存储：与主站 records 完全分账。
   结构：number-trainer/attempts/YYYY-MM-DD.json（权威作答）、sessions/<id>.json、settings.json。
   写入采用临时文件 + fsync + 备份 + 重命名；坏文件明确报错并把原件改名保留，不静默覆盖。 */
import fs from 'node:fs';
import path from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9-]{6,64}$/i;

export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, data);fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* 备份失败不阻塞主写入 */ }
  }
  fs.renameSync(tmp, file);
}

export function createStore({ recordsDir, now = () => Date.now() }) {
  const root = path.join(recordsDir, 'number-trainer');
  const attemptsDir = path.join(root, 'attempts');
  const sessionsDir = path.join(root, 'sessions');
  const settingsFile = path.join(root, 'settings.json');

  function ensure() {
    fs.mkdirSync(attemptsDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
  function quarantine(file, err) {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const dest = `${file}.corrupt-${stamp}`;
    try { fs.renameSync(file, dest); } catch { /* 保持原状 */ }
    const e = new Error('NUMBER_TRAINER_STORE_CORRUPT');
    e.corruptFile = dest;e.cause = err;throw e;
  }
  function readJson(file) {
    const raw = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(raw); } catch (err) { return quarantine(file, err); }
  }

  function dayFile(date) {
    if (!DATE_RE.test(date)) throw new Error('BAD_DATE');
    return path.join(attemptsDir, date + '.json');
  }
  function readDay(date) {
    const file = dayFile(date);
    if (!fs.existsSync(file)) return { version: 1, date, events: {}, savedAt: null };
    const data = readJson(file);
    if (!data || typeof data !== 'object' || typeof data.events !== 'object' || data.events === null) quarantine(file, new Error('BAD_SHAPE'));
    return data;
  }
  function writeDay(date, data) {
    atomicWrite(dayFile(date), JSON.stringify(data));
  }
  function findEvent(eventId, date) {
    if (!ID_RE.test(eventId)) throw new Error('BAD_EVENT_ID');
    const day = readDay(date);
    return day.events[eventId] || null;
  }
  function appendEvent(event, date) {
    const day = readDay(date);
    if (day.events[event.eventId]) return { duplicate: true, existing: day.events[event.eventId] };
    day.events[event.eventId] = event;
    day.savedAt = new Date(now()).toISOString();
    writeDay(date, day);
    return { duplicate: false };
  }

  function saveSession(session) {
    if (!session || !ID_RE.test(session.id)) throw new Error('BAD_SESSION_ID');
    atomicWrite(path.join(sessionsDir, session.id + '.json'), JSON.stringify(session));
  }
  function readSession(id) {
    if (!ID_RE.test(id)) return null;
    const file = path.join(sessionsDir, id + '.json');
    if (!fs.existsSync(file)) return null;
    return readJson(file);
  }
  function updateSession(session) { saveSession(session); }

  function listDates({ from, to } = {}) {
    if (!fs.existsSync(attemptsDir)) return [];
    return fs.readdirSync(attemptsDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, 10))
      .filter(d => (!from || d >= from) && (!to || d <= to))
      .sort();
  }
  function readRange({ days = 90 } = {}) {
    const to = new Date(now()).toISOString().slice(0, 10);
    const fromMs = now() - Math.max(1, days) * 86400000;
    const from = new Date(fromMs).toISOString().slice(0, 10);
    const events = [];
    for (const d of listDates({ from, to })) {
      const day = readDay(d);
      for (const e of Object.values(day.events)) events.push(e);
    }
    events.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
    return events;
  }
  function readSettings() {
    if (!fs.existsSync(settingsFile)) return {};
    return readJson(settingsFile);
  }
  function writeSettings(next) { atomicWrite(settingsFile, JSON.stringify(next)); }

  /* 清理过旧会话，保留最近 days 天；作答分卷永不自动删除。 */
  function pruneSessions(days = 30) {
    if (!fs.existsSync(sessionsDir)) return 0;
    const cutoff = now() - days * 86400000;let n = 0;
    for (const f of fs.readdirSync(sessionsDir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(sessionsDir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p);n++; } } catch { /* 单个失败忽略 */ }
    }
    return n;
  }

  return { root, ensure, readDay, writeDay, appendEvent, findEvent, saveSession, readSession, updateSession, readRange, listDates, readSettings, writeSettings, pruneSessions };
}

