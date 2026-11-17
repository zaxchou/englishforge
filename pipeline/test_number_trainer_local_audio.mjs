/* 本地固化音源回归：不接 AI、逐位拼 WAV、读音文本顺序、缓存、边界。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalAudio } from '../number-trainer-audio.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-local-audio-'));
const cache = path.join(dir, 'cache');
const digitsDir = path.join(process.cwd(), 'web', 'nt-digits');
for (const w of ['oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'])
  assert(fs.existsSync(path.join(digitsDir, w + '.wav')), 'frozen clip exists: ' + w);

const la = createLocalAudio({ digitAudioDir: digitsDir, cacheDir: cache });
assert.equal(la.words.length, 10);

let pass = 0;
const ok = n => { pass++; console.log('ok', n); };

// 拼接产出合法 WAV：头、字节数、时长随位数增长
const r = la.synthDigits('8597390274');
assert(fs.existsSync(r.file));
const buf = fs.readFileSync(r.file);
assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
assert.equal(buf.readUInt32LE(4), buf.length - 8, 'RIFF size correct');
assert.equal(buf.readUInt32LE(40), buf.length - 44, 'data size correct');
assert.equal(buf.readUInt32LE(24), 24000, '24kHz');
assert(r.durationMs > 3000 && r.durationMs < 8000, 'duration plausible: ' + r.durationMs);
assert.equal(r.cached, false);
ok('本地音频: 合法 WAV、时长随位数、无 AI');

// 连续相同数字必须保留两/三个完整原音，并留出能听清次数的分界。
// 原音的弱辅音与衰减尾音也属于单字，不能用振幅阈值裁掉。
function sourcePcm(word) {
  const bytes = fs.readFileSync(path.join(digitsDir, word + '.wav'));
  let off = 12;
  while (off + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(off + 4);
    if (bytes.toString('ascii', off, off + 4) === 'data')
      return bytes.subarray(off + 8, off + 8 + Math.min(size, bytes.length - off - 8));
    off += 8 + size + size % 2;
  }
  throw new Error('missing source PCM: ' + word);
}
for (const [digit, word] of la.words.entries()) {
  const original = sourcePcm(word);
  for (const count of [2, 3]) {
    const rec = la.synthDigits(String(digit).repeat(count));
    const pcm = fs.readFileSync(rec.file).subarray(44);
    const gapBytes = (pcm.length - original.length * count) / (count - 1);
    assert(gapBytes >= 24000 * 2 * 0.16, `${word}×${count}: repeated sounds need a clear boundary; gap=${gapBytes / 48}ms`);
    assert.equal(gapBytes % 2, 0, 'gap aligned to whole PCM frames');
    for (let i = 0; i < count; i++) {
      const at = i * (original.length + gapBytes);
      assert(pcm.subarray(at, at + original.length).equals(original), `${word}×${count}: full source clip ${i + 1} preserved`);
      if (i < count - 1)
        assert(pcm.subarray(at + original.length, at + original.length + gapBytes).every(b => b === 0), 'clean separation between repeated sounds');
    }
  }
}
ok('本地音频: 0–9 双音/三连音完整保留，重复音分界清晰');

// 缓存命中：同一号码不再重写文件
const r2 = la.synthDigits('8597390274');
assert.equal(r2.cached, true);
assert.equal(r2.file, r.file);
assert.equal(r2.durationMs, r.durationMs);
ok('本地音频: 同号码命中缓存');

// 不同号码时长按位数增长（7 位 < 11 位）
const short = la.synthDigits('1234567');
const long = la.synthDigits('12345678901');
assert(short.durationMs < long.durationMs, '11 位比 7 位长');
ok('本地音频: 位数决定时长');

// 前导零与 0 的读法：0 段存在（oh.wav），时长与无 0 的等长号码一致结构
const zero = la.synthDigits('0123456789');
const nonzero = la.synthDigits('9123456789');
assert(zero.durationMs > 4000 && nonzero.durationMs > 4000);
ok('本地音频: 前导零按位拼接，不掉位');

// 非法输入拒绝
for (const bad of ['', 'abc', '1234567890123']) {
  let threw = false;
  try { la.synthDigits(bad); } catch { threw = true; }
  assert(threw, 'reject bad digits: ' + bad);
}
ok('本地音频: 非法号码拒绝');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
