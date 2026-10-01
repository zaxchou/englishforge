import { it, expect } from 'vitest'
import { pcmWav } from './recordingWav'
it('encodes clipped interleaved stereo PCM with real data length and exact duration', async () => {
 const b=pcmWav([Float32Array.from([-2,1,0]),Float32Array.from([0,0.5,NaN])],16000),v=new DataView(b)
 expect(v.getUint32(40,true)).toBe(12);expect(b.byteLength).toBe(56);expect(v.getUint32(28,true)).toBe(64000)
 expect(v.getInt16(44,true)).toBe(-32768);expect(v.getInt16(46,true)).toBe(0);expect(v.getInt16(48,true)).toBe(32767);expect(v.getInt16(54,true)).toBe(0)
 expect(()=>pcmWav([new Float32Array(0)],16000)).toThrow()
})
