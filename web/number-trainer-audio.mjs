/* 播放控制器：单实例媒体元素 + 播放代次，避免旧回调启动新题。
   计时以媒体事件为锚：正常播放的 ended 才算有效起点。
   自动播放被拒时交给界面显示播放按钮，不偷偷跳题。 */

export function createPlayer({ onInvalidate = () => {} } = {}) {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.playsInline = true;
  let seq = 0;
  let current = null; // 当前题对象
  let inflight = null;
  let stopped = false;

  function stop() {
    seq++;
    stopped = true;
    try { audio.pause(); } catch { /* 忽略 */ }
    if (inflight) { const r = inflight;inflight = null;r({ ok: false, reason: 'stopped' }); }
  }

  /** 预取音频；不播放。返回是否可播。 */
  function load(url) {
    current = null;
    stop();
    stopped = false;
    const mine = ++seq;
    audio.src = url;
    try { audio.load(); } catch { /* 忽略 */ }
    return new Promise(resolve => {
      const done = (ok) => { cleanup();resolve(ok ? { ok: true } : { ok: false, reason: 'load' }); };
      const cleanup = () => {
        audio.removeEventListener('canplaythrough', ok);
        audio.removeEventListener('error', bad);
      };
      const ok = () => { if (mine === seq) done(true); };
      const bad = () => { if (mine === seq) done(false); };
      audio.addEventListener('canplaythrough', ok, { once: true });
      audio.addEventListener('error', bad, { once: true });
      setTimeout(() => { if (mine === seq) { cleanup();resolve({ ok: audio.readyState >= 3, reason: audio.readyState >= 3 ? null : 'timeout' }); } }, 8000);
    });
  }

  /**
   * 播放当前题。返回 {ok, endedAt, reason}。
   * rate 只改变播放速度，不重新合成音频。
   */
  function play({ rate = 1 } = {}) {
    stop();
    stopped = false;
    const mine = ++seq;
    audio.playbackRate = rate;
    return new Promise(resolve => {
      inflight = (out) => { inflight = null;resolve(out); };
      const settle = (out) => { if (mine !== seq) return;if (inflight) inflight(out); };
      const onEnded = () => {
        if (mine !== seq) return;
        audio.removeEventListener('ended', onEnded);
        settle({ ok: true, endedAt: performance.now(), reason: null });
      };
      audio.addEventListener('ended', onEnded, { once: true });
      audio.currentTime = 0;
      const pr = audio.play();
      if (pr && typeof pr.catch === 'function') {
        pr.catch(() => settle({ ok: false, reason: 'autoplay' }));
      }
      if (stopped && mine !== seq) settle({ ok: false, reason: 'stopped' });
    });
  }

  /** 用独立元素预热下一题（只借 HTTP 缓存，不打断当前播放）。 */
  let warmEl = null;
  function warm(url) {
    if (!url) return;
    try {
      if (!warmEl) { warmEl = new Audio();warmEl.preload = 'auto'; }
      if (warmEl.src !== url) warmEl.src = url;
    } catch { /* 忽略 */ }
  }

  function dispose() { stop();try { audio.removeAttribute('src');audio.load(); } catch { /* 忽略 */ } }

  /** 页面不可见时中断，返回是否确有中断。 */
  function interrupt(reason = 'hidden') {
    if (!inflight) return false;
    stop();
    onInvalidate(reason);
    return true;
  }
  return { load, play, stop, dispose, interrupt, warm, element: audio };
}
