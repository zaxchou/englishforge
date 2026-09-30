// 课程音频（21 §6.1/§6.2）：synthetic 合成练习音频，manifest 驱动。
//
// 为什么不进 media_assets：那张表 account_id NOT NULL REFERENCES accounts——课程音频是
// 公共受控内容，不属任何账户（'__global__' 行会撞 FK，见 W5 的教训）。清单
// server/data/audio-manifest.json 在 git 里版本化；WAV 在 server/assets/audio/ 随包分发；
// 分发前必过 sha256 完整性校验（进程内缓存结果，坏文件一次发现永不再发）。
//
// 诚实边界：synthetic 标注必须一路带到前端（不得冒充真实 podcast）；转写不随音频下发
// （首听隐藏脚本），只在 transcriptShownByDefault 的活动里出现。
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError } from './db.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = resolve(HERE, 'assets', 'audio')

let manifestCache = null
const verified = new Map() // mediaId -> true | Error

export function loadAudioManifest() {
  if (!manifestCache) manifestCache = JSON.parse(readFileSync(join(HERE, 'data', 'audio-manifest.json'), 'utf8'))
  return manifestCache
}

export function audioByMediaId(mediaId) {
  return loadAudioManifest().assets.find((a) => a.mediaId === mediaId) ?? null
}

export function audioForActivity(activityId) {
  return loadAudioManifest().assets.find((a) => (a.activityIds ?? []).includes(activityId)) ?? null
}

/** 纯函数：单条清单行 + 字节 → 完整性结论（供测试注入坏哈希） */
export function verifyAudioEntry(entry, buf) {
  if (!entry) return 'missing'
  if (entry.kind !== 'lesson_audio' || entry.licenseStatus !== 'confirmed') return 'unlicensed'
  if (!buf?.length) return 'empty'
  if (createHash('sha256').update(buf).digest('hex') !== entry.sha256) return 'hash_mismatch'
  return 'ok'
}

/** 读音频字节：清单有行 + 许可确认 + 文件存在 + sha256 一致，四关全过才分发 */
export function readLessonAudio(mediaId) {
  const entry = audioByMediaId(mediaId)
  if (!entry) throw new ApiError(404, 'MEDIA_NOT_FOUND: ' + mediaId)
  const cached = verified.get(mediaId)
  if (cached instanceof Error) throw cached
  const path = join(ASSET_DIR, mediaId + '.wav')
  if (!existsSync(path)) {
    const err = new ApiError(404, 'MEDIA_FILE_MISSING: ' + mediaId)
    verified.set(mediaId, err)
    throw err
  }
  const buf = readFileSync(path)
  const verdict = verifyAudioEntry(entry, buf)
  if (verdict !== 'ok') {
    const err = new ApiError(409, 'MEDIA_INTEGRITY_' + verdict.toUpperCase() + ': ' + mediaId)
    verified.set(mediaId, err)
    throw err
  }
  verified.set(mediaId, true)
  return { entry, buf, mime: entry.mime ?? 'audio/wav' }
}

/** 给活动卡/课包用的音频描述（不含转写与任何答案） */
export function audioPublicInfo(activity) {
  if (!activity?.audioRef) return null
  const entry = audioByMediaId(activity.audioRef)
  if (!entry) return null
  return {
    mediaId: entry.mediaId,
    synthetic: entry.sourceType === 'synthetic',
    speakerLabel: entry.speakerLabel,
    durationMs: entry.durationMs,
    licenseNote: entry.licenseNote,
  }
}
