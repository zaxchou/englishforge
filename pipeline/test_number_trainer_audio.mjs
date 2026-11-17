/* 媒体控制器回归：取消/错误/重听都必须结算并清理旧回调，不得假报完整播放。 */
import assert from 'node:assert/strict';
import { createPlayer } from '../web/number-trainer-audio.mjs';
class Media extends EventTarget {
  constructor() { super();this.paused = true;this.readyState = 0;this.src = ''; }
  pause() { this.paused = true; }
  load() { }
  play() { this.paused = false;return Promise.resolve(); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
globalThis.Audio = Media;
const player = createPlayer();
const loading = player.load('/first.wav');
player.stop();
assert.deepEqual(await loading, {ok:false,reason:'stopped'});
const ready = player.load('/second.wav');
player.element.dispatchEvent(new Event('canplaythrough'));
assert.deepEqual(await ready, {ok:true});
const first = player.play({rate:0.6});
assert.equal(player.element.playbackRate, 0.6);
assert.equal(player.element.preservesPitch, true);
const replay = player.play({rate:0.8});
assert.equal((await first).reason, 'stopped');
player.element.dispatchEvent(new Event('ended'));
assert.equal((await replay).ok, true);
const broken = player.play();
player.element.dispatchEvent(new Event('error'));
assert.deepEqual(await broken, {ok:false,reason:'play'});
const final = player.play();
player.dispose();
assert.equal((await final).reason, 'stopped');
assert.equal(player.element.paused, true);
console.log('1 group passed: 取消加载/重听隔离/真实 ended/媒体错误/音高保持');
