/* 数字听写：全本地音源。用固化的 0–9 单词音频（0 读 oh）在服务端拼成整段 WAV。
   不接 AI、无网络；音质=固化片段的原音，读法=逐位（比自然连读慢且更分明）。
   这是用户在首页主动选择的实验音源，默认仍是自然连读。 */
import fs from 'node:fs';
import path from 'node:path';

const RATE = 24000, CH = 1, BITS = 16;
const VERSION = 'nt-local-v2';
const GAP_MS = 55;          // 不同数字之间的停顿
const REPEAT_GAP_MS = 180;  // 相同数字需明确分界，避免听成一个拖长音

function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('NOT_WAV');
  let off = 12, fmt = null, dataOff = 0, dataBytes = 0, hasData = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && size >= 16 && off + 24 <= buf.length)
      fmt = { ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    else if (id === 'data') { hasData = true; dataOff = off + 8; dataBytes = size; break; }
    off += 8 + size + (size % 2);
  }
  if (!hasData || !fmt || fmt.rate !== RATE || fmt.ch !== CH || fmt.bits !== BITS) throw new Error('BAD_WAV_FMT');
  if (dataBytes > buf.length - dataOff) dataBytes = buf.length - dataOff;
  return { dataOff, dataBytes };
}

export function createLocalAudio({ digitAudioDir, cacheDir = null } = {}) {
  if (!digitAudioDir) throw new Error('digitAudioDir required');
  const words = ['oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const clips = new Map();
  for (const w of words) {
    const buf = fs.readFileSync(path.join(digitAudioDir, w + '.wav'));
    const { dataOff, dataBytes } = parseWav(buf);
    const raw = buf.subarray(dataOff, dataOff + dataBytes);
    const pcm = new Int16Array(dataBytes / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(i * 2);
    // 保留完整原音：低振幅也可能是辅音或尾音，不能按音量当静音切掉。
    clips.set(w, pcm);
  }
  const gap = new Int16Array(Math.round(GAP_MS / 1000 * RATE));
  const repeatGap = new Int16Array(Math.round(REPEAT_GAP_MS / 1000 * RATE));
  const gapAt = (digits, i) => digits[i] === digits[i - 1] ? repeatGap : gap;
  const assembled = new Map();

  function wavBuffer(samples) {
    const dataBytes = samples.length * 2;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(CH, 22);
    buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * CH * BITS / 8, 28); buf.writeUInt16LE(CH * BITS / 8, 32); buf.writeUInt16LE(BITS, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
    return buf;
  }

  /** 由号码串生成 WAV 文件；返回 { file, durationMs, cached }。 */
  function synthDigits(digits) {
    const key = String(digits).replace(/[^0-9]/g, '');
    if (!/^[0-9]{1,12}$/.test(key)) throw new Error('BAD_DIGITS');
    if (assembled.has(key)) return { ...assembled.get(key), cached: true };
    const parts = [];
    let total = 0;
    for (let i = 0; i < key.length; i++) {
      if (i) { const pause = gapAt(key, i); parts.push(pause); total += pause.length; }
      const c = clips.get(words[+key[i]]);
      parts.push(c); total += c.length;
    }
    const out = new Int16Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    const file = writeOut(key, wavBuffer(out));
    const rec = { file, durationMs: Math.round(total / RATE * 1000) };
    assembled.set(key, rec);
    if (assembled.size > 200) { const first = assembled.keys().next().value; try { fs.unlinkSync(assembled.get(first).file); } catch { /* 忽略 */ } assembled.delete(first); }
    return { ...rec, cached: false };
  }

  function writeOut(key, buf) {
    if (!cacheDir) throw new Error('cacheDir required for local audio output');
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, VERSION + '-' + key + '.wav');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
    return file;
  }
  return { version: VERSION, synthDigits, words: [...words], durationMs: (digits) => {
    const key = String(digits).replace(/[^0-9]/g, '');
    let n = 0;
    for (let i = 0; i < key.length; i++) {
      n += clips.get(words[+key[i]]).length;
      if (i) n += gapAt(key, i).length;
    }
    return Math.round(n / RATE * 1000);
  } };
}
