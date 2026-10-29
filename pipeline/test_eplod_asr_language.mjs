import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const server = read('../server.mjs');
const html = read('../web/index.html');
const m = server.match(/function epAsrLooksForeign\(text\) \{[\s\S]*?\n\}/);
assert.ok(m, 'epAsrLooksForeign present');
const ctx = vm.createContext({});
vm.runInContext(m[0] + ';this.foreign=epAsrLooksForeign;', ctx);

test('English transcription is accepted', () => {
  for (const s of ['Turn left here!', 'OK, make a left here... no wait, make a right.', '5:58 and five fifty-eight', "I'm in, let's go!", '']) {
    assert.equal(ctx.foreign(s), false, s);
  }
});

test('Japanese, Chinese, Korean and Cyrillic output is rejected', () => {
  for (const s of ['ここで左に曲がってください', '在这里左转', '왼쪽으로 가세요', 'Поверните налево', 'はい、わかりました']) {
    assert.equal(ctx.foreign(s), true, s);
  }
});

test('a stray foreign character inside English is tolerated', () => {
  assert.equal(ctx.foreign('Make a left here あ'), false);
  assert.equal(ctx.foreign('OK make a left here then stop'), false);
});

test('EnglishPod ASR asks for English and falls back when the hint is rejected', () => {
  assert.match(server, /asr_options: \{ enable_itn: false, \.\.\.extra \}/);
  assert.match(server, /let rr = await ask\(\{ language: 'en' \}\)/);
  assert.match(server, /if \(rr\.status === 400\) rr = await ask\(\{\}\)/);
  assert.match(server, /asr_not_english/);
});

test('client keeps the take for retry and does not score a foreign transcription', () => {
  assert.match(html, /e\.code==='asr_not_english'/);
  const fn = html.slice(html.indexOf('async function epProcessTake('), html.indexOf('async function epRecToggle('));
  assert.match(fn, /if\(!j\.ok\)throw Error/);
  assert.ok(fn.indexOf('saveAttempt') > fn.indexOf("const text=String(j.text"), 'no attempt is saved before the ASR response is accepted');
  assert.match(html, /if \(j\.code\) code = j\.code;/);
});
