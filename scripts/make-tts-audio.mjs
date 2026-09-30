// TTS 合成音频管线（21 §6.1/§6.2：D2 图书馆与 L2 博物馆各得可播放音频，绑定版本/时长/校对稿/逐段意义依据）。
//
// 做法：PowerShell System.Speech（Windows SAPI）逐段合成 PCM WAV → 段间插 500ms 静音 → 拼接
// 成整课 WAV，落 server/assets/audio/<mediaId>.wav；解析 WAV 头得真实时长，算 sha256，
// 生成 server/data/audio-manifest.json（含逐段文本/意义依据/声源标注）。
//
// 约束与诚实声明：
// · 产物全部标注 synthetic（受控练习音频，不得冒充真实 podcast）；
// · 本机仅一个英文声源（Zira）——"两名讲者"做不到，alt 版只是同引擎变调，manifest 里如实标注
//   『非独立讲者』；跨讲者检查缺口开放（18 §2 制作注）；
// · '设备播放与自然度试听' 是人的检查，管线只负责：文件可解码（RIFF 头合法）、时长>0、
//   sha256 固定——HTTP 200 不是验收（21 §6.2），真人试听记录留给用户（23 号报告如实写）。
// 用法：node scripts/make-tts-audio.mjs [--force]
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ASSET_DIR = join(ROOT, 'server', 'assets', 'audio')
const FORCE = process.argv.includes('--force')

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
  const durationMs = Math.round((dataBytes / (fmt.sampleRate * fmt.channels * fmt.bits / 8)) * 1000)
  return { ...fmt, dataBytes, durationMs, headerBytes }
}

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

const SAMPLE_RATE = 16_000
/** ms → 16bit 单声道静音 Buffer */
const silence = (ms) => Buffer.alloc(Math.round(SAMPLE_RATE * ms / 1000) * 2)
/** 逐段合成 + 500ms 段间静音，返回整课 WAV Buffer。
 * 用纯文本 + $s.Rate（SAPI -2..2）控制语速。实测 SSML <prosody> 会让 Zira 语速掉到约一半
 * （同句 6.8s → 17s），不得用 SSML。SAPI 无音高属性 → 无第二"讲者"可言，alt 版已删（18 §2：
 * 不把变速算陌生迁移；跨讲者缺口如实开放）。 */
function synthesize(entry) {
  mkdirSync(ASSET_DIR, { recursive: true })
  const parts = []
  const segs = entry.segments ?? (entry.sameSegmentsAs
    ? spec.scripts.find((s) => s.scriptId === entry.sameSegmentsAs).segments
    : [])
  if (!segs.length) throw new Error(`${entry.scriptId}: 无可合成段落`)
  segs.forEach((seg, i) => {
    if (i > 0) parts.push(silence(500))
    const tmp = join(ASSET_DIR, `.${entry.scriptId}.seg${i}.wav`)
    const plain = seg.text.replace(/'/g, "''")
    powerShell(tmp, `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('${entry.voice}')
$s.Rate = ${Number(entry.voiceParams?.rate ?? 0)}
$s.SetOutputToWaveFile('${tmp.replace(/\\/g, '\\\\')}', (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)))
$s.Speak('${plain}')
$s.Dispose()
`)
    const segBuf = readFileSync(tmp)
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    const parsed = parseWav(segBuf)
    if (parsed.durationMs < 300) throw new Error(`${entry.scriptId} 段 ${i}（${seg.label}）时长异常: ${parsed.durationMs}ms`)
    parts.push(segBuf.subarray(parsed.headerBytes)) // 剥头（SAPI 头里可能有 LIST/fact 块，按实际 data 偏移剥）
    seg.startMs = parts.slice(0, -1).reduce((acc, p) => acc + p.length, 0) // 累计字节数→后面统一换算
  })
  const body = Buffer.concat(parts)
  const wav = Buffer.concat([wavHeader(body.length, SAMPLE_RATE), body])
  const { durationMs } = parseWav(wav)
  // startMs 换算（16bit 单声道：2 字节/样本）
  for (const seg of segs) seg.startMs = Math.round((seg.startMs / 2 / SAMPLE_RATE) * 1000)
  return { wav, durationMs, segments: segs }
}

const manifest = []
const specSegments = (entry) => entry.segments
  ?? (entry.sameSegmentsAs ? spec.scripts.find((s) => s.scriptId === entry.sameSegmentsAs).segments : [])
for (const entry of spec.scripts) {
  const out = join(ASSET_DIR, `${entry.mediaId}.wav`)
  const text = specSegments(entry).map((s) => s.text).join(' ')
  if (!FORCE && existsSync(out)) {
    const buf = readFileSync(out)
    manifest.push(rowFor(entry, buf, parseWav(buf).durationMs, text, specSegments(entry)))
    console.log(`= ${entry.scriptId}: 已存在，跳过（--force 重做）`)
    continue
  }
  const { wav, durationMs, segments } = synthesize(entry)
  writeFileSync(out, wav)
  manifest.push(rowFor(entry, wav, durationMs, text, segments))
  console.log(`+ ${entry.scriptId}: ${wav.length}B ${durationMs}ms sha256=${createHash('sha256').update(wav).digest('hex').slice(0, 12)}…`)
}

function rowFor(entry, buf, durationMs, text, segments) {
  return {
    mediaId: entry.mediaId,
    kind: 'lesson_audio',
    sourceType: 'synthetic',
    licenseStatus: 'confirmed',
    licenseNote: 'Windows SAPI 合成语音（Microsoft Zira en-US）；本项目原创受控脚本；标注 synthetic，仅用于受控练习，不冒充真实 podcast（21 §6.2）',
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
    sampleRate: SAMPLE_RATE,
    transcript: text, // synthetic 产物 = 脚本原文逐字一致 → 校对稿按构造成立；origin 记 synthetic_exact
    segments: segments ?? null,
    madeAt: Date.now(),
  }
}

const outPath = join(ROOT, 'server', 'data', 'audio-manifest.json')
writeFileSync(outPath, JSON.stringify({ notice: spec.notice, assets: manifest }, null, 2) + '\n')
console.log(`manifest → ${outPath}（${manifest.length} 条）`)
