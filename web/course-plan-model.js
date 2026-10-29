/* Shared course-plan rules. Adaptive scheduling is bounded course review, not SM-2. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoursePlanModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const COURSES = ['ndf-01', 'cfcm-01'];
  const DEFAULTS = { target: 3, intervals: [3, 7], mode: 'fixed', daily: 1, revision: 0 };
  function parseQid(qid) {
    const m = /^gen\/(ndf-01|cfcm-01)\/([1-9]\d*)\/quiz\/([1-9]\d*)$/.exec(String(qid || ''));
    return m ? { course: m[1], lessonId: m[1] + '-' + m[2].padStart(2, '0'), id: 'q' + m[3] } : null;
  }
  function isManagedQid(qid) { return parseQid(qid) !== null; }
  function qid(quiz, q) { return 'gen/' + quiz.course + '/' + quiz.lessonNo + '/quiz/' + Number(q.id.slice(1)); }
  function coreQuestions(quiz) {
    if (!quiz || !COURSES.includes(quiz.course) || (quiz.v !== 2 && quiz.src !== 'official')) return [];
    const bad = new Set(quiz.bad || []), seen = new Set();
    return (quiz.questions || []).filter(q => {
      if (!q || !/^q[1-9]\d*$/.test(q.id) || seen.has(q.id) || bad.has(q.id) || q.tier === 'ext' ||
          !q.stem || !q.options || typeof q.answer !== 'string' || !Object.hasOwn(q.options, q.answer)) return false;
      seen.add(q.id); return true;
    });
  }
  function validateSettings(input) {
    if (!input || !Number.isInteger(input.target) || input.target < 1 || input.target > 6 ||
        !['fixed', 'adaptive'].includes(input.mode) || !Number.isInteger(input.daily) || input.daily < 1 || input.daily > 5 ||
        !Array.isArray(input.intervals) || input.intervals.length !== input.target - 1 ||
        input.intervals.some(n => !Number.isInteger(n) || n < 1 || n > 60)) throw new Error('invalid course-plan settings');
    return { target: input.target, intervals: [...input.intervals], mode: input.mode, daily: input.daily };
  }
  function dayStart(now) { return Math.floor((now + 8 * 3600000) / DAY) * DAY - 8 * 3600000; }
  return { DAY, COURSES, DEFAULTS, parseQid, isManagedQid, qid, coreQuestions, validateSettings, dayStart };
});
