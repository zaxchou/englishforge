import { it, expect } from 'vitest'
import { inspectAudioBytes } from './v3oral.mjs'
function wav() {
 const b=Buffer.alloc(44+32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32000,40);return b
}
it('WAV needs bounded real data and coherent PCM format, not a declared chunk length',()=>{
 const good=wav();expect(inspectAudioBytes(good)).toMatchObject({playable:true,durationMs:1000})
 expect(inspectAudioBytes(good.subarray(0,44)).playable).toBe(false)
 const bad=Buffer.from(good);bad.writeUInt32LE(320000,40);expect(inspectAudioBytes(bad).playable).toBe(false)
 const codec=Buffer.from(good);codec.writeUInt16LE(99,20);expect(inspectAudioBytes(codec).playable).toBe(false)
 const ch=Buffer.from(good);ch.writeUInt16LE(0,22);expect(inspectAudioBytes(ch).playable).toBe(false)
 const align=Buffer.from(good);align.writeUInt16LE(4,32);expect(inspectAudioBytes(align).playable).toBe(false)
})
it('WebM VINT and TimecodeScale give metadata duration, never playable without decoding',()=>{
 const elem=(id,data)=>Buffer.concat([Buffer.from(id),Buffer.from([128+data.length]),data])
 const duration=Buffer.alloc(8);duration.writeDoubleBE(1000)
 const info=elem([0x15,0x49,0xa9,0x66],Buffer.concat([elem([0x2a,0xd7,0xb1],Buffer.from([0x0f,0x42,0x40])),elem([0x44,0x89],duration)]))
 const b=Buffer.concat([elem([0x1a,0x45,0xdf,0xa3],Buffer.alloc(0)),elem([0x18,0x53,0x80,0x67],info)])
 expect(inspectAudioBytes(b)).toMatchObject({playable:false,durationMs:1000,formatNote:'webm_decode_required'})
 expect(inspectAudioBytes(b.subarray(0,b.length-1)).playable).toBe(false)
})
