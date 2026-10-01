// TTS 合成音频管线（21 §6.1/§6.2：受控原创脚本 → 可播放音频，绑定版本/时长/校对稿/逐段意义依据）。
//
// 双引擎：
// · qwen（默认）：Qwen3-TTS Flash 云端神经合成，逐段 POST → output.audio.url → WAV（24kHz 单声道）。
//   返回的 RIFF 头 data 长度是占位值（0x7FFFFFFF），必须按实际字节重写，否则时长/哈希全错。
//   段级缓存 scripts/.tts-cache/<sha256(model|voice|text)>.wav，重跑只补缺失段。
//   密钥/端点运行时解析：环境变量 > 本项目 .env.local > ../vgallery/.env.local——绝不打印、绝不入库。
// · sapi（--engine sapi）：Windows SAPI（Microsoft Zira）离线兜底。SSML <prosody> 实测致语速减半，禁用。
//
// 约束与诚实声明：
// · 产物全部标注 synthetic（受控练习音频，不得冒充真实 podcast）——神经合成不改变这个边界；
// · 两套声源（Cherry/Serena）使『换材料换声音』成立（l1d 用 B 声源）；单脚本内跨讲者对话仍无，
//   待真人录音补足；
// · '设备播放与自然度试听' 是人的检查，管线只负责：文件可解码（RIFF 头合法）、时长>0、sha256 固定
//   （21 §6.2），真人试听记录留给用户。
// 用法：node scripts/make-tts-audio.mjs [--force] [--engine qwen|sapi]
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ASSET_DIR = join(ROOT, 'server', 'assets', 'audio')
const CACHE_DIR = join(HERE, '.tts-cache')
const FORCE = process.argv.includes('--force')
const ENGINE_FLAG = process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : null
const QWEN_MODEL = 'qwen3-tts-flash'

const spec = JSON.parse(readFileSync(join(HERE, 'tts-scripts.json'), 'utf8'))

// ---- WAV 工具（无第三方依赖：自拼头、自解析）----

function wavHeader(dataBytes, sampleRate, channels = 1, bitsPerSample = 16) {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16) // PCM fmt chunk size
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(channels, 22)
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28) // byte rate
  b.writeUInt16LE(channels * bitsPerSample / 8, 32) // block align
  b.writeUInt16LE(bitsPerSample, 34)
  b.write('data', 36)
  b.writeUInt32LE(dataBytes, 40)
  return b
}
/** 解析 WAV：校验 RIFF/PCM 并返回 { sampleRate, channels, bits, dataBytes, durationMs } */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('NOT_A_WAV: RIFF/WAVE 头缺失')
  }
  let off = 12
  let fmt = null
  let dataBytes = 0
  let headerBytes = 44
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }
    } else if (id === 'data') {
      dataBytes = size
      headerBytes = off + 8
      break
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || fmt.channels < 1 || !fmt.sampleRate) throw new Error('BAD_WAV_FMT')
  // data 长度可信时用它；占位/越界（如云端流式头的 0x7FFFFFFF）按到文件尾算
  const actual = buf.length - headerBytes
  if (dataBytes <= 0 || dataBytes > actual) dataBytes = actual
  const durationMs = Math.round((dataBytes / (fmt.sampleRate * fmt.channels * fmt.bits / 8)) * 1000)
  return { ...fmt, dataBytes, durationMs, headerBytes }
}
/** 云端返回的 WAV 头 data 长度是占位值——按实际字节重写 RIFF/data 两个长度字段 */
function fixWavHeader(buf) {
  const parsed = parseWav(buf)
  const fixed = Buffer.from(buf)
  fixed.writeUInt32LE(buf.length - 8, 4)
  fixed.writeUInt32LE(parsed.dataBytes, parsed.headerBytes - 4)
  return fixed
}

// ---- 引擎：Qwen3-TTS（默认） ----

const envFromFile = (p) => {
  try {
    return Object.fromEntries(readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
  } catch { return {} }
}
function qwenCredentials() {
  const env = { ...envFromFile(join(ROOT, '.env.local')), ...envFromFile(resolve(ROOT, '../../vgallery/.env.local')) }
  const key = process.env.QWEN_TTS_API_KEY || env.QWEN_TTS_API_KEY
  const ep = process.env.QWEN_TTS_ENDPOINT || env.QWEN_TTS_ENDPOINT
  if (!key || !ep) throw new Error('Qwen 引擎缺凭据：QWEN_TTS_API_KEY / QWEN_TTS_ENDPOINT（环境变量、本项目 .env.local 或 ../vgallery/.env.local）')
  return { key, ep }
}
async function synthesizeSegmentQwen(voice, text, label, scriptId) {
  const { key, ep } = qwenCredentials()
  const cacheKey = createHash('sha256').update(`${QWEN_MODEL}|${voice}|${text}`).digest('hex')
  const cached = join(CACHE_DIR, `${cacheKey}.wav`)
  if (existsSync(cached)) {
    const buf = fixWavHeader(readFileSync(cached))
    const parsed = parseWav(buf)
    if (parsed.durationMs >= 300) return buf
    console.warn(`  缓存段异常（${label} ${parsed.durationMs}ms），重调云端`)
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: QWEN_MODEL, input: { text, voice } }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`)
      const url = (await r.json())?.output?.audio?.url
      if (!url) throw new Error('响应无 output.audio.url')
      const fixed = fixWavHeader(Buffer.from(await (await fetch(url)).arrayBuffer()))
      const parsed = parseWav(fixed)
      if (parsed.durationMs < 300) throw new Error(`时长异常 ${parsed.durationMs}ms`)
      writeFileSync(cached, fixed)
      return fixed
    } catch (e) {
      lastErr = e
      console.warn(`  段重试 ${attempt}/3（${scriptId}/${label}）：${String(e.message ?? e).slice(0, 120)}`)
      await new Promise((res) => setTimeout(res, attempt * 2000))
    }
  }
  throw new Error(`${scriptId} 段「${label}」三次合成失败：${lastErr}`)
}

// ---- 引擎：SAPI（离线兜底） ----

const powerShell = (file, content) => {
  const ps = resolve(HERE, '.tmp-tts.ps1')
  writeFileSync(ps, content, 'utf8')
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { stdio: 'pipe', timeout: 120_000 })
  } finally {
    try { unlinkSync(ps) } catch { /* 忽略 */ }
  }
  return file
}
async function synthesizeSegmentSapi(entry, text, label, sampleRate) {
  const tmp = join(ASSET_DIR, `.${entry.scriptId}.tmp.wav`)
  const plain = text.replace(/'/g, "''")
  powerShell(tmp, `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('${entry.voice}')
$s.Rate = ${Number(entry.voiceParams?.rate ?? 0)}
$s.SetOutputToWaveFile('${tmp.replace(/\\/g, '\\\\')}', (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${sampleRate}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)))
$s.Speak('${plain}')
$s.Dispose()
`)
  const segBuf = readFileSync(tmp)
  try { unlinkSync(tmp) } catch { /* 忽略 */ }
  const parsed = parseWav(segBuf)
  if (parsed.durationMs < 300) throw new Error(`${entry.scriptId} 段 ${label} 时长异常: ${parsed.durationMs}ms`)
  return segBuf.subarray(parsed.headerBytes) // 剥头（SAPI 头里可能有 LIST/fact 块，按实际 data 偏移剥）
}

// ---- 组装：逐段合成 + 500ms 静音 → 整课 WAV ----

const engineFor = (entry) => ENGINE_FLAG ?? entry.engine ?? 'qwen'
async function synthesize(entry) {
  mkdirSync(ASSET_DIR, { recursive: true })
  const engine = engineFor(entry)
  const segs = entry.segments ?? (entry.sameSegmentsAs
    ? spec.scripts.find((s) => s.scriptId === entry.sameSegmentsAs).segments
    : [])
  if (!segs.length) throw new Error(`${entry.scriptId}: 无可合成段落`)
  let sampleRate = null
  const bodies = []
  for (const seg of segs) {
    let body
    if (engine === 'sapi') {
      body = await synthesizeSegmentSapi(entry, seg.text, seg.label, 16_000)
      sampleRate ??= 16_000
    } else {
      const segWav = await synthesizeSegmentQwen(entry.voice, seg.text, seg.label, entry.scriptId)
      const parsed = parseWav(segWav)
      sampleRate ??= parsed.sampleRate
      if (parsed.sampleRate !== sampleRate) throw new Error(`${entry.scriptId} 段「${seg.label}」采样率不一致: ${parsed.sampleRate} ≠ ${sampleRate}`)
      body = segWav.subarray(parsed.headerBytes)
    }
    bodies.push({ seg, body })
  }
  const silence = (ms) => Buffer.alloc(Math.round(sampleRate * ms / 1000) * 2)
  const parts = []
  for (const { seg, body } of bodies) {
    if (parts.length) parts.push(silence(500))
    seg.startMs = parts.reduce((acc, p) => acc + p.length, 0) // 前置字节累计 → 末尾统一换算
    parts.push(body)
  }
  const bodyAll = Buffer.concat(parts)
  const wav = Buffer.concat([wavHeader(bodyAll.length, sampleRate), bodyAll])
  const { durationMs } = parseWav(wav)
  // startMs 换算（16bit 单声道：2 字节/样本）
  for (const { seg } of bodies) seg.startMs = Math.round((seg.startMs / 2 / sampleRate) * 1000)
  return { wav, durationMs, segments: segs, sampleRate }
}

// ---- 主流程 ----

const manifest = []
const specSegments = (entry) => entry.segments
  ?? (entry.sameSegmentsAs ? spec.scripts.find((s) => s.scriptId === entry.sameSegmentsAs).segments : [])
for (const entry of spec.scripts) {
  const out = join(ASSET_DIR, `${entry.mediaId}.wav`)
  const text = specSegments(entry).map((s) => s.text).join(' ')
  if (!FORCE && existsSync(out)) {
    const buf = readFileSync(out)
    const parsed = parseWav(buf)
    manifest.push(rowFor(entry, buf, parsed.durationMs, text, specSegments(entry), parsed.sampleRate))
    console.log(`= ${entry.scriptId}: 已存在，跳过（--force 重做）`)
    continue
  }
  const { wav, durationMs, segments, sampleRate } = await synthesize(entry)
  writeFileSync(out, wav)
  manifest.push(rowFor(entry, wav, durationMs, text, segments, sampleRate))
  console.log(`+ ${entry.scriptId}: ${wav.length}B ${durationMs}ms ${sampleRate}Hz ${engineFor(entry)} sha256=${createHash('sha256').update(wav).digest('hex').slice(0, 12)}…`)
}

function rowFor(entry, buf, durationMs, text, segments, sampleRate) {
  const engine = ENGINE_FLAG ?? entry.engine ?? 'qwen'
  return {
    mediaId: entry.mediaId,
    kind: 'lesson_audio',
    sourceType: 'synthetic',
    licenseStatus: 'confirmed',
    licenseNote: engine === 'sapi'
      ? 'Windows SAPI 合成语音（Microsoft Zira en-US）；本项目原创受控脚本；标注 synthetic，仅用于受控练习，不冒充真实 podcast（21 §6.2）'
      : `Qwen3-TTS Flash 云端合成语音（voice=${entry.voice}，非真人）；本项目原创受控脚本；标注 synthetic，仅用于受控练习，不冒充真实 podcast（21 §6.2）`,
    speakerLabel: entry.speakerLabel,
    activityIds: entry.activityIds,
    scriptId: entry.scriptId,
    version: entry.version,
    voice: entry.voice,
    voiceParams: entry.voiceParams,
    mime: 'audio/wav',
    bytes: buf.length,
    durationMs,
    sha256: createHash('sha256').update(buf).digest('hex'),
    sampleRate,
    transcript: text, // synthetic 产物 = 脚本原文逐字一致 → 校对稿按构造成立；origin 记 synthetic_exact
    segments: segments ?? null,
    madeAt: Date.now(),
  }
}

const outPath = join(ROOT, 'server', 'data', 'audio-manifest.json')
// 合并写入：脚本只更新自己产出的行（按 scriptId），其他行（如复审后手工入账的
// real_material 真实素材）原样保留——重跑合成不得抹掉三核入账记录（复审 P2）
let previous = { notice: '', assets: [] }
if (existsSync(outPath)) {
  try { previous = JSON.parse(readFileSync(outPath, 'utf8')) } catch { /* 损坏清单视为空 */ }
}
const scriptIds = new Set(spec.scripts.map((s) => s.scriptId))
const preserved = (previous.assets ?? []).filter((a) => !scriptIds.has(a.scriptId))
writeFileSync(outPath, JSON.stringify({ notice: spec.notice, assets: [...preserved, ...manifest] }, null, 2) + '\n')
console.log(`manifest → ${outPath}（脚本 ${manifest.length} 条 + 保留 ${preserved.length} 条）`)
