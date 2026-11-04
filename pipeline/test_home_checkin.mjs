'use strict';
// 首页打卡日历(2026-11-04): 连续统计与整月网格。纯函数切片, 无 DOM/网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const html = fs.readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const start = html.indexOf('const CK_CAL=');
const end = html.indexOf('function renderHome(');
assert.ok(start > 0 && end > start, '打卡日历函数块在 index.html 中');
const sandbox = {
  Date, Math, Object, String, Number, Array, JSON, console,
  localDay: date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'),
};
vm.createContext(sandbox);
vm.runInContext(html.slice(start, end) + ';this.__={CK_CAL,ckStats,ckMonthHTML,ckCalHTML,ckMonthKey};', sandbox);
const {CK_CAL, ckStats, ckMonthHTML} = sandbox.__;
const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

test('streak stats count current run, longest run and total active days', () => {
  const cal = {};
  for (let d = 28; d <= 31; d++) cal['2026-10-' + d] = 60;
  for (let d = 1; d <= 4; d++) cal['2026-11-0' + d] = 60;
  assert.deepEqual({...ckStats(cal, at(2026, 11, 4))}, {current: 8, longest: 8, total: 8}, 'month boundary stays continuous');

  const gap = {'2026-10-30': 60, '2026-10-31': 60, '2026-11-02': 60, '2026-11-03': 60, '2026-11-04': 60};
  assert.deepEqual({...ckStats(gap, at(2026, 11, 4))}, {current: 3, longest: 3, total: 5}, 'a missing day breaks the run but not the total');

  assert.deepEqual({...ckStats({'2026-11-03': 60}, at(2026, 11, 4))}, {current: 1, longest: 1, total: 1}, 'today not studied keeps yesterday streak alive');
  assert.deepEqual({...ckStats({'2026-11-04': 59}, at(2026, 11, 4))}, {current: 0, longest: 0, total: 0}, 'under one minute is not a check-in');
});

test('month grid aligns Monday-first, marks levels and leaves blanks', () => {
  const cal = {'2026-11-03': 1200, '2026-11-04': 3600};
  const grid = ckMonthHTML(cal, '2026-11', '2026-11-04', '2026-11-03');
  const cells = grid.match(/class="ck-cell[^"]*"/g) || [];
  const offset = (new Date(2026, 10, 1).getDay() + 6) % 7;
  assert.equal(cells.length % 7, 0, 'grid is whole weeks');
  assert.equal(cells.filter(c => c.includes('blank')).length, offset + (cells.length - offset - 30), 'blanks before and after the month');
  const days = grid.match(/data-ck-day="[^"]+"/g) || [];
  assert.equal(days.length, 30, 'November has 30 day cells');
  assert.match(grid, /data-ck-day="2026-11-03"[^>]*class="ck-cell day on lv2 sel"|class="ck-cell day on lv2 sel"[^>]*data-ck-day="2026-11-03"/);
  assert.match(grid, /2026-11-04/);
  assert.match(grid, /ck-cell day on lv3 today/,'30+ minutes is the strongest level and today is ringed');
  assert.match(grid, /data-ck-day="2026-11-01"[^>]*title="2026-11-01 · 未学习"/);
  assert.match(grid, /title="2026-11-03 · 20 分钟"/);
});

test('calendar expands from the seven-day strip and clamps month navigation', () => {
  assert.match(html, /id="ck-cal-toggle"[\s\S]{0,120}打卡日历/);
  assert.match(html, /CK_CAL\.open\?ckCalHTML\(/,'expanded panel renders only when opened');
  assert.match(html, /数据仍是 study\.cal/);
  CK_CAL.month = '2026-05';
  const cal = {'2026-10-28': 60, '2026-11-04': 60};
  const out = sandbox.__.ckCalHTML(cal, '2026-11-04', ckStats(cal, at(2026, 11, 4)));
  assert.match(out, /2026 年 10 月/, 'cannot page before the first month with data');
  assert.match(out, /id="ck-cal-prev" aria-label="上个月" disabled/);
  assert.match(out, /id="ck-cal-now"/, 'back-to-current-month shortcut exists when not on this month');
  assert.match(out, /当前连续 <b>1<\/b> 天/);
  assert.match(html, /ks\.length > 730/,'check-in history is retained for two years');
});
