/* 数字听写训练：纯规则层。浏览器与服务端共用同一份生成、读法、判分和统计规则。
   时间单位统一为毫秒整数；数值一律以字符串保存，避免前导零/科学计数法歧义。 */

export const READING_VERSION = 'nt-us-integer-v2';   // v2: 电话号 0 读 oh、整串朗读
export const GRADE_VERSION = 'nt-grade-v1';
export const CLASSIFY_VERSION = 'nt-classify-v1';
export const PLAN_VERSION = 'nt-plan-v1';
export const DIGIT_MIN = 1;
export const DIGIT_MAX = 6;
export const PLAYBACK_RATES = [0.6, 0.8, 1];
export function normalizeRate(value) {
  const rate = Number(value);
  return PLAYBACK_RATES.includes(rate) ? rate : 1;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [[1000, 'thousand'], [1000000, 'million'], [1000000000, 'billion']];

const FEATURE_ORDER = ['teenTy', 'zeroGap', 'adjacentRepeat', 'distinctDigits', 'crossGroup'];
export const FEATURE_LABELS = {
  teenTy: '13/30 一类混淆',
  zeroGap: '中间漏零',
  adjacentRepeat: '重复数字',
  distinctDigits: '顺序敏感',
  crossGroup: '跨数值组',
};
export const ERROR_LABELS = {
  teenTy: '13/30 一类听混',
  transposition: '相邻换位',
  missingDigits: '漏位',
  extraDigits: '添位',
  zeroDrop: '漏零',
  zeroInsert: '多零',
  substitution: '个别数字替换',
  other: '暂未归因',
};
export const SOURCE_LABELS = { focus: '专项', review: '复测', probe: '随机探针' };

function clampDigits(n) {
  const v = Number(n);
  if (!Number.isInteger(v)) return 3;
  return Math.min(DIGIT_MAX, Math.max(DIGIT_MIN, v));
}
function ri(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000];

export function readNumber(value) {
  const str = String(value);
  if (!/^[0-9]{1,9}$/.test(str)) throw new Error('NUMBER_RANGE');
  let n = Number(str);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('NUMBER_RANGE');
  if (n === 0) return 'zero';
  const parts = [];
  for (let i = SCALES.length - 1; i >= 0; i--) {
    const [unit, name] = SCALES[i];
    if (n >= unit) { parts.push(readGroup(Math.floor(n / unit)) + ' ' + name); n %= unit; }
  }
  if (n) parts.push(readGroup(n));
  return parts.join(' ');
}
function readGroup(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)] + ' hundred'); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '')); }
  else if (n) out.push(ONES[n]);
  return out.join(' ');
}

export function digitsOf(value) { return String(value).replace(/[^0-9]/g, '').length; }

export function featuresOf(value) {
  const s = String(value), n = Number(s), tags = [];
  if (!/^[0-9]+$/.test(s)) return tags;
  if (s.length >= 2) {
    const last2 = Number(s.slice(-2));
    if ((last2 >= 13 && last2 <= 19) || [20, 30, 40, 50, 60, 70, 80, 90].includes(last2)) tags.push('teenTy');
  }
  let zero = false;
  for (let i = 0; i < s.length - 1; i++) if (s[i] === '0' && /[1-9]/.test(s.slice(i + 1))) { zero = true; break; }
  if (zero) tags.push('zeroGap');
  if (/(\d)\1/.test(s)) tags.push('adjacentRepeat');
  if (s.length >= 3 && new Set(s).size === s.length) tags.push('distinctDigits');
  if (n >= 1000 && n % 1000 > 0) tags.push('crossGroup');
  return tags;
}
export function primaryFeature(value) { return featuresOf(value).find(t => FEATURE_ORDER.includes(t)) || null; }

const CAPACITY = new Map();
/** 某位数的某个特征一共有多少种取值；用于避免一轮里重复同一个数字。 */
export function featureCapacity(feature, digits) {
  const d = clampDigits(digits), key = feature + ':' + d;
  if (CAPACITY.has(key)) return CAPACITY.get(key);
  const lo = d === 1 ? 0 : POW10[d - 1], hi = POW10[d] - 1;
  let n = 0;
  for (let v = lo; v <= hi; v++) if (featuresOf(String(v)).includes(feature)) n++;
  CAPACITY.set(key, n);
  return n;
}
export function validFeaturesFor(digits) {
  const d = clampDigits(digits);
  const ok = { teenTy: d >= 2, zeroGap: d >= 3, adjacentRepeat: d >= 2, distinctDigits: d >= 3, crossGroup: d >= 4 };
  return FEATURE_ORDER.filter(f => ok[f]);
}

const CONFUSE = ['13', '30', '14', '40', '15', '50', '16', '60', '17', '70', '18', '80', '19', '90'];
function makeTeenTy(d, rng) {
  const last = CONFUSE[ri(rng, 0, CONFUSE.length - 1)];
  if (d === 2) return last;
  return String(ri(rng, POW10[d - 3], POW10[d - 2] - 1)) + last;
}
function makeZeroGap(d, rng) {
  if (d < 3) return makeRandom(d, rng);
  const arr = [];
  for (let i = 0; i < d; i++) arr.push(String(ri(rng, 0, 9)));
  arr[0] = String(ri(rng, 1, 9));
  arr[d - 1] = String(ri(rng, 1, 9));
  const z = ri(rng, 1, d - 2);
  arr[z] = '0';
  return arr.join('');
}
function makeAdjacentRepeat(d, rng) {
  const arr = [];
  for (let i = 0; i < d; i++) arr.push(String(ri(rng, 0, 9)));
  arr[0] = String(ri(rng, 1, 9));
  const i = ri(rng, 0, d - 2);
  arr[i + 1] = arr[i];
  return arr.join('');
}
function makeDistinct(d, rng) {
  const pool = [...'0123456789'];
  for (let i = pool.length - 1; i > 0; i--) { const j = ri(rng, 0, i);[pool[i], pool[j]] = [pool[j], pool[i]]; }
  const take = pool.slice(0, d);
  if (take[0] === '0') { const k = take.findIndex(x => x !== '0'); if (k > 0) { take[0] = take[k]; take[k] = '0'; } }
  return take.join('');
}
function makeCrossGroup(d, rng) {
  if (d < 4) return makeRandom(d, rng);
  const arr = [];
  for (let i = 0; i < d; i++) arr.push(String(ri(rng, 0, 9)));
  arr[0] = String(ri(rng, 1, 9));
  arr[d - 1] = String(ri(rng, 1, 9));
  return arr.join('');
}
function makeRandom(d, rng) {
  const lo = POW10[d - 1], hi = POW10[d] - 1;
  return String(ri(rng, lo, hi));
}
function makeFeatureValue(feature, d, rng) {
  if (feature === 'teenTy') return makeTeenTy(d, rng);
  if (feature === 'zeroGap') return makeZeroGap(d, rng);
  if (feature === 'adjacentRepeat') return makeAdjacentRepeat(d, rng);
  if (feature === 'distinctDigits') return makeDistinct(d, rng);
  if (feature === 'crossGroup') return makeCrossGroup(d, rng);
  return makeRandom(d, rng);
}

export function makeQuestion({ digits = 3, feature = null, rng = Math.random, recent = [] } = {}) {
  const d = clampDigits(digits);
  const f = feature && validFeaturesFor(d).includes(feature) ? feature : null;
  const seen = new Set(recent.map(String));
  let value = null;
  for (let i = 0; i < 80; i++) {
    const candidate = f ? makeFeatureValue(f, d, rng) : makeRandom(d, rng);
    if (!/^[1-9][0-9]*$/.test(candidate)) continue;
    if (f && !featuresOf(candidate).includes(f)) continue;
    if (seen.has(candidate)) continue;
    value = candidate;break;
  }
  if (value === null) do { value = f ? makeFeatureValue(f, d, rng) : makeRandom(d, rng); } while (!/^[1-9][0-9]*$/.test(value));
  return { value, text: readNumber(value), digits: digitsOf(value), feature: f || primaryFeature(value), features: featuresOf(value) };
}

/* ---------- 电话号码（逐位，不按整数读） ---------- */
export const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
export const PHONE_MIN = 3, PHONE_MAX = 12;

export function phoneLength({ min = 7, max = 11, rng = Math.random } = {}) {
  const lo = Math.min(PHONE_MAX, Math.max(PHONE_MIN, Number(min) || 7));
  const hi = Math.min(PHONE_MAX, Math.max(lo, Number(max) || lo));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** 逐位读法文本：数字之间留空格，浏览器朗读时才不会当成一个整数。 */
export function readDigits(digits) { return [...String(digits)].map(d => DIGIT_WORDS[+d]).join(' '); }

/** 显示分组：>=10 位按 3-3-4，7 位按 3-4，其余 3 位一组，便于对照。 */
export function groupDigits(digits) {
  const s = String(digits);
  if (s.length === 10) return [s.slice(0, 3), s.slice(3, 6), s.slice(6)].join(' ');
  if (s.length === 11) return [s.slice(0, 3), s.slice(3, 7), s.slice(7)].join(' ');
  if (s.length === 7) return [s.slice(0, 3), s.slice(3)].join(' ');
  const out = [];
  for (let i = 0; i < s.length; i += 3) out.push(s.slice(i, i + 3));
  return out.join(' ');
}
export function readPhoneDigits(digits) {
  return [...String(digits)].map(d => (d === '0' ? 'oh' : DIGIT_WORDS[+d])).join(' ');
}
export function phoneFeatures(value) {
  const s = String(value), tags = [];
  if (/^0/.test(s)) tags.push('leadingZero');
  if (/0/.test(s)) tags.push('hasZero');
  if (/(\d)\1/.test(s)) tags.push('adjacentRepeat');
  if (/^(\d)\1{2,}/.test(s)) tags.push('tripleRepeat');
  return tags;
}
export function makePhoneQuestion({ min = 7, max = 11, rng = Math.random, recent = [] } = {}) {
  const seen = new Set(recent.map(String));
  for (let i = 0; i < 80; i++) {
    const len = phoneLength({ min, max, rng });
    const chars = [];
    for (let k = 0; k < len; k++) chars.push(String(Math.floor(rng() * 10)));
    if (chars[0] === '0' && rng() < 0.6) chars[0] = String(1 + Math.floor(rng() * 9)); // 前导零占少数
    const value = chars.join('');
    if (seen.has(value)) continue;
    return { mode: 'phone', value, text: readPhoneDigits(value), digits: value.length, display: groupDigits(value), features: phoneFeatures(value), feature: phoneFeatures(value)[0] || null };
  }
  const value = String(Math.floor(rng() * 9) + 1) + Array.from({ length: 6 }, () => Math.floor(rng() * 10)).join('');
  return { mode: 'phone', value, text: readPhoneDigits(value), digits: value.length, display: groupDigits(value), features: phoneFeatures(value), feature: null };
}

/** 电话号按字符串比对：允许空格/连字符，前导零必须保留。 */
export function gradePhone(target, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { status: 'empty', correct: false, reason: 'empty' };
  if (!/^[0-9][0-9\s-]*$/.test(s)) return { status: 'invalid', correct: false, reason: 'charset' };
  const digits = s.replace(/[\s-]/g, '');
  if (!digits) return { status: 'empty', correct: false, reason: 'empty' };
  return { status: 'graded', correct: digits === String(target), normalized: digits };
}

export function normalizeInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (!/^[0-9][0-9,\s]*$/.test(s)) return { ok: false, reason: 'charset' };
  const digits = s.replace(/[,\s]/g, '');
  if (!digits) return { ok: false, reason: 'empty' };
  if (digits.length > 9) return { ok: false, reason: 'length' };
  return { ok: true, value: String(Number(digits)), formatted: digits };
}
export function gradeAnswer(target, raw) {
  const n = normalizeInput(raw);
  if (!n.ok) return { status: n.reason === 'empty' ? 'empty' : 'invalid', correct: false, reason: n.reason };
  return { status: 'graded', correct: Number(n.value) === Number(target), normalized: n.value };
}
function sortedDigits(s) { return [...String(s)].sort().join(''); }
const TEENS = new Set([13, 14, 15, 16, 17, 18, 19]);
const TENSET = new Set([20, 30, 40, 50, 60, 70, 80, 90]);
export function classifyError(target, answer) {
  const t = String(target).trim(), a = String(answer ?? '').trim();
  if (!/^[0-9]+$/.test(a)) return ['other'];
  if (t === a) return [];
  const tags = [];
  const t2 = Number(t.slice(-2)), a2 = Number(a.slice(-2));
  const samePrefix = t.length >= 2 && a.length >= 2 && t.slice(0, -2) === a.slice(0, -2);
  if (samePrefix && ((TEENS.has(t2) && TENSET.has(a2)) || (TENSET.has(t2) && TEENS.has(a2)))) tags.push('teenTy');
  if (sortedDigits(t) === sortedDigits(a)) tags.push('transposition');
  const zt = (t.match(/0/g) || []).length, za = (a.match(/0/g) || []).length;
  if (a.length < t.length) { tags.push('missingDigits'); if (za < zt) tags.push('zeroDrop'); }
  else if (a.length > t.length) { tags.push('extraDigits'); if (za > zt) tags.push('zeroInsert'); }
  else if (!tags.length) tags.push('substitution');
  return tags.length ? [...new Set(tags)] : ['other'];
}

/* ---------- 统计 ---------- */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}
function bucket() { return { settled: 0, independent: 0, assisted: 0, skipped: 0, errors: 0, times: [] }; }
function addTo(b, e) {
  b.settled++;
  if (e.skip) b.skipped++;
  else if (e.assisted) { b.assisted++; if (!e.correct) b.errors++; }
  else { if (e.correct) b.independent++; else b.errors++; }
  if (e.timingValid && !e.assisted && !e.skip && e.correct) b.times.push(e.submitMs);
}
function finish(b) {
  const times = b.times.filter(Number.isFinite).sort((x, y) => x - y);
  return {
    settled: b.settled, independent: b.independent, assisted: b.assisted, skipped: b.skipped, errors: b.errors,
    independentRate: b.settled ? b.independent / b.settled : null,
    errorRate: b.settled ? b.errors / b.settled : null,
    samples: times.length,
    medianMs: quantile(times, .5), p80Ms: quantile(times, .8),
  };
}
export function summarizeAttempts(events, { days = 90, now = Date.now(), mode = 'number' } = {}) {
  const since = now - days * 86400000;
  const list = (events || []).filter(e => e && e.target && !e.invalid && (e.mode || 'number') === mode && (!e.submittedAt || Date.parse(e.submittedAt) >= since));
  const total = bucket(), byDigits = {}, byFeature = {}, byVoice = {}, errorTags = {};
  const today = new Date(now).toISOString().slice(0, 10);
  const todayBucket = bucket();
  for (const e of list) {
    const d = String(e.digits || digitsOf(e.target));
    (byDigits[d] ||= bucket());addTo(total, e);addTo(byDigits[d], e);
    for (const f of e.features || []) { (byFeature[f] ||= bucket());addTo(byFeature[f], e); }
    const v = e.voice || 'server'; (byVoice[v] ||= bucket());addTo(byVoice[v], e);
    if ((e.submittedAt || '').slice(0, 10) === today) addTo(todayBucket, e);
    if (!e.correct && !e.skip) for (const t of e.errorTags || []) errorTags[t] = (errorTags[t] || 0) + 1;
  }
  const out = { total: finish(total), today: finish(todayBucket), byDigits: {}, byFeature: {}, byVoice: {}, errorTags, samples: list.length };
  for (const [k, b] of Object.entries(byDigits)) out.byDigits[k] = finish(b);
  for (const [k, b] of Object.entries(byFeature)) out.byFeature[k] = finish(b);
  for (const [k, b] of Object.entries(byVoice)) out.byVoice[k] = finish(b);
  return out;
}

// 专项门槛必须和升档门槛对齐：升档只允许 5% 失误，那么超过 5% 的特征就是挡路的那一类。
export const THRESHOLDS = {
  minTag: 5, minTagErrors: 2,
  minWeakSamples: 10, minWeakErrors: 2, minWeakRate: 0.05,
  promoteSamples: 20, promoteRate: 0.95, promoteWindow: 20, promoteMinInWindow: 15,
  demoteRate: 0.7,
};

function weakFeatures(summary, { minSamples = THRESHOLDS.minWeakSamples, minErrors = THRESHOLDS.minWeakErrors, minRate = THRESHOLDS.minWeakRate } = {}) {
  return Object.entries(summary.byFeature || {})
    .filter(([, b]) => b.settled >= minSamples && b.errors >= minErrors && (b.errorRate || 0) >= minRate)
    .map(([tag, b]) => ({ tag, ...b, score: (b.errorRate || 0) * Math.min(1, b.settled / 20) }))
    .sort((a, b) => b.score - a.score);
}
export function candidateWeaknesses(summary) {
  return Object.entries(summary.byFeature || {})
    .filter(([, b]) => b.settled >= THRESHOLDS.minTag && b.errors >= THRESHOLDS.minTagErrors)
    .map(([tag, b]) => ({ tag, settled: b.settled, errors: b.errors, confirmed: b.settled >= THRESHOLDS.minWeakSamples && b.errors >= THRESHOLDS.minWeakErrors }));
}
/** 最近 size 个该档有效作答（按提交时间）；升档看最近表现，避免早期错题永久压着。 */
export function recentWindow(events, { digits = null, size = THRESHOLDS.promoteWindow, mode = 'number' } = {}) {
  const list = (events || []).filter(e => e && e.target && !e.invalid && (e.mode || 'number') === mode && (digits == null || String(e.digits) === String(digits)));
  list.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  const win = list.slice(-size);
  const independent = win.filter(e => !e.skip && !e.assisted && e.correct).length;
  return { digits: digits == null ? null : Number(digits), settled: win.length, independent, rate: win.length ? independent / win.length : null };
}

/** 当前在练哪一档：最近 20 个有效作答里出现最多的位数（并列取高的）。 */
export function currentLevel(events, { size = THRESHOLDS.promoteWindow, mode = 'number' } = {}) {
  const list = (events || []).filter(e => e && e.target && !e.invalid && e.digits && (e.mode || 'number') === mode);
  list.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  const win = list.slice(-size);
  if (!win.length) return null;
  const counts = new Map();
  for (const e of win) { const d = Number(e.digits);counts.set(d, (counts.get(d) || 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

export function currentDigits(summary, config = {}, recent = null) {
  const max = clampDigits(config.maxDigits || 6), start = clampDigits(config.startDigits || 2);
  const levels = Object.keys(summary.byDigits || {}).map(Number).filter(d => (summary.byDigits[d]?.settled || 0) > 0).sort((a, b) => a - b);
  if (!levels.length) return start;
  // 以“当前正在练的档”为准（recent 已按它取窗口），而不是历史最高档，
  // 否则升档失败一次就再也升不上去。
  const level = recent && recent.digits != null ? Number(recent.digits) : levels[levels.length - 1];
  const b = summary.byDigits?.[String(level)];
  const win = recent && Number(recent.digits) === level ? recent : null;
  const n = win ? win.settled : (b?.settled || 0);
  const rate = win && win.rate != null ? win.rate : (b?.independentRate || 0);
  if (n >= THRESHOLDS.promoteMinInWindow && rate >= THRESHOLDS.promoteRate) return Math.min(max, level + 1);
  if (n >= 10 && rate < THRESHOLDS.demoteRate) return Math.max(DIGIT_MIN, level - 1);
  return Math.max(start, Math.min(max, level));
}
export function buildAdvice(summary, config = {}) {
  const advice = [];
  const t = summary.total || { settled: 0 };
  if ((t.settled || 0) < 10) {
    advice.push({ kind: 'baseline', text: '样本还少，先完成一轮，系统再给个人建议。' });
    return advice;
  }
  const weak = weakFeatures(summary);
  const win = summary.recent;
  // 1) 先说清“为什么还没升档、差多少”
  if (win && win.digits != null && win.settled >= 10) {
    const allowed = Math.floor(win.settled * (1 - THRESHOLDS.promoteRate));
    const wrong = win.settled - win.independent;
    const next = Math.min(DIGIT_MAX, win.digits + 1);
    const same = next === win.digits;
    if (win.rate >= THRESHOLDS.promoteRate) {
      advice.push({ kind: 'promote', text: `最近 ${win.settled} 题独立答对 ${win.independent} 题（${pct(win.rate)}），已经达到升档线；下一轮会开始 ${next} 位。` });
    } else if (!same) {
      advice.push({ kind: 'gate', text: `最近 ${win.settled} 题独立答对 ${win.independent} 题（${pct(win.rate)}）；升到 ${next} 位要 ≥95%（最多错 ${allowed} 题），现在多错 ${Math.max(1, wrong - allowed)} 题。` });
    }
  }
  // 2) 再说主要失分点
  if (weak.length) {
    const w = weak[0], label = FEATURE_LABELS[w.tag] || w.tag;
    advice.push({ kind: 'weak', tag: w.tag, text: `「${label}」在 ${w.settled} 题里错 ${w.errors} 次（${pct(w.errorRate)}），是当前主要失分点；下一轮会多练这类的新数字。`, samples: w.settled });
  } else {
    const cand = candidateWeaknesses(summary)[0];
    if (cand && (cand.settled < THRESHOLDS.minWeakSamples)) advice.push({ kind: 'watch', tag: cand.tag, text: `「${FEATURE_LABELS[cand.tag] || cand.tag}」出现了 ${cand.errors} 次，样本还少，先记录。`, samples: cand.settled });
    else if (cand) advice.push({ kind: 'watch', tag: cand.tag, text: `「${FEATURE_LABELS[cand.tag] || cand.tag}」有 ${cand.errors} 次（${pct(cand.errors / cand.settled)}），还在可接受范围，不单独开专项。`, samples: cand.settled });
  }
  // 3) 速度只在准确率稳定时提
  if ((t.independentRate || 0) >= 0.9 && t.samples >= 10 && t.p80Ms) {
    advice.push({ kind: 'speed', text: `正确题中位 ${fmtSec(t.medianMs)}、P80 ${fmtSec(t.p80Ms)}；准确率稳住后再压尾部时间。` });
  }
  if (!advice.length) advice.push({ kind: 'steady', text: '没有明显短板，继续混练即可；随机题会继续检查是否有遗漏。' });
  return advice;
}
function pct(v) { return Math.round((v || 0) * 100) + '%'; }

export const PHONE_FEATURE_LABELS = { leadingZero: '前导零', hasZero: '含 0', adjacentRepeat: '重复数字', tripleRepeat: '三连数字' };

/** 电话号的建议只讲准确率/用时/哪类位串容易错，不涉及升档。 */
export function buildPhoneAdvice(summary) {
  const t = summary.total || {};
  if ((t.settled || 0) < 5) return [{ kind: 'baseline', text: '样本还少，先做一轮；号码从 7 位开始比较稳。' }];
  const out = [{ kind: 'level', text: `逐位正确率 ${pct(t.independentRate)}，中位 ${fmtSec(t.medianMs)}${t.samples ? `（${t.samples} 个有效计时）` : ''}。` }];
  const weak = Object.entries(summary.byFeature || {})
    .filter(([, b]) => b.settled >= 5 && b.errors >= 2 && (b.errorRate || 0) > 0.05)
    .sort((a, b) => (b[1].errorRate || 0) - (a[1].errorRate || 0))[0];
  if (weak) out.push({ kind: 'weak', tag: weak[0], text: `「${PHONE_FEATURE_LABELS[weak[0]] || weak[0]}」在 ${weak[1].settled} 题里错 ${weak[1].errors} 次，下一轮会多出这类号码。` });
  const lens = Object.entries(summary.byDigits || {}).map(([d, b]) => [Number(d), b]).sort((a, b) => a[0] - b[0]);
  const weakest = lens.filter(([, b]) => b.settled >= 3).sort((a, b) => (a[1].independentRate || 0) - (b[1].independentRate || 0))[0];
  if (weakest && (weakest[1].independentRate || 0) < 0.9) out.push({ kind: 'len', text: `${weakest[0]} 位号码目前 ${pct(weakest[1].independentRate)}（${weakest[1].settled} 题），比其他长度弱。` });
  return out;
}

export function fmtSec(ms) { return ms == null ? '—' : (ms / 1000).toFixed(1) + 's'; }

/* ---------- 一轮的题目分配 ---------- */
export function planRound({ summary, config = {}, rng = Math.random, retestGapMs = 20 * 60000, now = Date.now() } = {}) {
  const count = Math.max(5, Math.min(60, Number(config.count) || 20));
  const focusN = Math.round(count * 0.5), reviewN = Math.round(count * 0.3);
  const probeN = count - focusN - reviewN;
  const maxDigits = clampDigits(config.maxDigits || 6);
  const baseDigits = config.mode === 'fixed' ? clampDigits(config.digits || 3) : currentDigits(summary, config, summary.recent || null);
  const weak = weakFeatures(summary);
  const focusTags = weak.slice(0, 2).map(w => w.tag);
  const reviewTags = weak.slice(2, 4).map(w => w.tag);
  const perTag = focusTags.length ? Math.floor(focusN / focusTags.length) : 0;
  const slots = [];
  focusTags.forEach(tag => { for (let i = 0; i < perTag; i++) slots.push({ source: 'focus', feature: tag, digits: baseDigits }); });
  while (slots.length < focusN) slots.push({ source: 'focus', feature: focusTags[0] || null, digits: baseDigits });
  // 没有已确认弱项时，这一档其实是普通练习，不能标成“专项”。
  if (!focusTags.length) for (const slot of slots) slot.source = 'probe';
  const perReview = reviewTags.length ? Math.floor(reviewN / reviewTags.length) : 0;
  const reviewSlots = [];
  reviewTags.forEach(tag => { for (let i = 0; i < perReview; i++) reviewSlots.push({ source: 'review', feature: tag, digits: baseDigits }); });
  while (reviewSlots.length < reviewN) reviewSlots.push({ source: 'probe', feature: null, digits: baseDigits });
  for (let i = 0; i < probeN; i++) slots.push({ source: 'probe', feature: null, digits: baseDigits });
  slots.push(...reviewSlots);
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1));[slots[i], slots[j]] = [slots[j], slots[i]]; }
  // 专项题目不超过整轮约 35% 连续同类：按位置把同特征摊开
  let lastFeature = null, repeat = 0;
  for (const s of slots) {
    if (s.feature && s.feature === lastFeature) repeat++; else { lastFeature = s.feature; repeat = 0; }
    if (repeat >= Math.max(2, Math.ceil(count * 0.2))) { s.feature = null; s.source = 'probe'; repeat = 0; }
  }
  return { slots, baseDigits, maxDigits, focusTags, reviewTags, version: PLAN_VERSION };
}

export function buildSessionQuestions({ plan, rng = Math.random, readingVersion = READING_VERSION }) {
  const recent = [];
  return plan.slots.map((slot, i) => {
    const q = makeQuestion({ digits: slot.digits, feature: slot.feature, rng, recent });
    recent.push(q.value);   // 整轮避重：同一轮里重复出现会被记住而不是听到
    return { id: 'q' + (i + 1), ...q, source: slot.source, readingVersion, audioKey: null };
  });
}
