import { useEffect, useRef, useState } from 'react'

/** 浏览器 TTS 朗读英文（en-US） */
export function Speaker({ text }: { text: string }) {
  const speak = () => {
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    u.rate = 1.0
    window.speechSynthesis.speak(u)
  }
  return (
    <button className="speaker" onClick={speak} title="朗读" aria-label="朗读">
      🔊
    </button>
  )
}

/** 结算页撒花（纯 CSS 粒子） */
export function Confetti() {
  const pieces = Array.from({ length: 40 }, (_, i) => i)
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((i) => (
        <span
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            animationDelay: `${(i % 10) * 0.12}s`,
            background: ['#ffb703', '#fb5607', '#8338ec', '#3a86ff', '#06d6a0'][i % 5],
          }}
        />
      ))}
    </div>
  )
}

/** 打铁火花：答对时的短动画 */
export function Spark({ show }: { show: boolean }) {
  const [gone, setGone] = useState(true)
  const t = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (show) {
      setGone(false)
      t.current = window.setTimeout(() => setGone(true), 700)
    }
    return () => window.clearTimeout(t.current)
  }, [show])
  if (gone) return null
  return <span className="spark" aria-hidden>✨</span>
}
