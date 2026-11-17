/* 播放控制器：单实例媒体元素 + 播放代次，避免旧回调启动新题。
   计时以媒体事件为锚：正常播放的 ended 才算有效起点。
   自动播放被拒时交给界面显示播放按钮，不偷偷跳题。 */

export function createPlayer({ onInvalidate = () => {} } = {}) {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.playsInline = true;
  audio.preservesPitch = true;
  let seq = 0, cancelLoad = null, cancelPlay = null, warmEl = null;

  function stop() {
    seq++;
    try { audio.pause(); } catch { /* 忽略 */ }
    if (cancelLoad) cancelLoad();
    if (cancelPlay) cancelPlay();
  }

  /** 预取音频；不播放。换题或离页时同时取消旧加载，清理监听与超时。 */
  function load(url) {
    stop();
    const mine = seq;
    return new Promise(resolve => {
      let settled = false, timer;
      const finish = out => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeEventListener('canplaythrough', ready);
        audio.removeEventListener('error', error);
        cancelLoad = null;
        resolve(out);
      };
      const ready = () => { if (mine === seq) finish({ ok: true }); };
      const error = () => { if (mine === seq) finish({ ok: false, reason: 'load' }); };
      cancelLoad = () => finish({ ok: false, reason: 'stopped' });
      audio.addEventListener('canplaythrough', ready);
      audio.addEventListener('error', error);
      timer = setTimeout(() => {
        if (mine === seq) finish({ ok: audio.readyState >= 3, reason: audio.readyState >= 3 ? null : 'timeout' });
      }, 8000);
      audio.src = url;
      try { audio.load(); } catch { error(); }
    });
  }

  /** rate 只改变播放速度、保持音高；只有真实 ended 才视为完整播放。 */
  function play({ rate = 1 } = {}) {
    stop();
    const mine = seq;
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    return new Promise(resolve => {
      let settled = false;
      const finish = out => {
        if (settled) return;
        settled = true;
        audio.removeEventListener('ended', ended);
        audio.removeEventListener('error', error);
        cancelPlay = null;
        resolve(out);
      };
      const ended = () => { if (mine === seq) finish({ ok: true, endedAt: performance.now(), reason: null }); };
      const error = () => { if (mine === seq) finish({ ok: false, reason: 'play' }); };
      cancelPlay = () => finish({ ok: false, reason: 'stopped' });
      audio.addEventListener('ended', ended);
      audio.addEventListener('error', error);
      try {
        audio.currentTime = 0;
        const promise = audio.play();
        if (promise && typeof promise.catch === 'function') promise.catch(e => {
          if (mine === seq) finish({ ok: false, reason: e?.name === 'NotAllowedError' ? 'autoplay' : 'play' });
        });
      } catch { error(); }
    });
  }

  /** 独立元素仅预热 HTTP 缓存，不播放、不打断当前音频。 */
  function warm(url) {
    if (!url) return;
    try {
      if (!warmEl) { warmEl = new Audio();warmEl.preload = 'auto'; }
      if (warmEl.src !== url) warmEl.src = url;
    } catch { /* 忽略 */ }
  }
  function dispose() {
    stop();
    for (const el of [audio, warmEl]) {
      if (el) try { el.removeAttribute('src');el.load(); } catch { /* 忽略 */ }
    }
  }
  function interrupt(reason = 'hidden') {
    if (!cancelPlay) return false;
    stop();onInvalidate(reason);return true;
  }
  return { load, play, stop, dispose, interrupt, warm, element: audio };
}
