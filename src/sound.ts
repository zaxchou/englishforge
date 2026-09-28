/** 轻量反馈音效：Web Audio 合成，无音频文件、零费用
 * 设计原则：不吵人——短（<300ms）、软（正弦/三角波、低音量）、不重复轰炸。
 * 静音状态存 localStorage('sf-sound')，'0' = 静音。 */

let ctx: AudioContext | null = null
let muted = typeof localStorage !== 'undefined' && localStorage.getItem('sf-sound') === '0'

export function isMuted(): boolean {
  return muted
}

export function setMuted(m: boolean) {
  muted = m
  localStorage.setItem('sf-sound', m ? '0' : '1')
}

function audio(): AudioContext | null {
  if (muted) return null
  try {
    if (!ctx) ctx = new (window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** 单音：软软的一声 */
function tone(freq: number, startAt: number, dur: number, vol = 0.12, type: OscillatorType = 'sine') {
  const c = audio()
  if (!c) return
  const t0 = c.currentTime + startAt
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(gain).connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
}

export const sfx = {
  /** 答对：两声上扬（Mi→La），像"叮-咚~"但更轻 */
  correct() {
    tone(659.25, 0, 0.12, 0.10)        // E5
    tone(880.0, 0.09, 0.18, 0.10)       // A5
  },
  /** 答错：低软的一声"噗"，不刺耳、不惩罚感 */
  wrong() {
    tone(196.0, 0, 0.16, 0.07, 'triangle')   // G3
    tone(164.81, 0.08, 0.20, 0.06, 'triangle') // E3
  },
  /** 连击 5：很轻的一声点缀（可选节奏感） */
  combo() {
    tone(1046.5, 0, 0.10, 0.06) // C6
  },
  /** 结算：三音上行琶音，短短的庆祝感 */
  finish() {
    tone(523.25, 0, 0.14, 0.09)   // C5
    tone(659.25, 0.13, 0.14, 0.09) // E5
    tone(783.99, 0.26, 0.24, 0.09)  // G5
  },
}
