/** Encode browser-decoded samples as bounded 16-bit PCM. Decode failure remains a draft. */
export function pcmWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  if (!channels.length || channels.length > 8 || sampleRate < 8000 || sampleRate > 192000 || channels.some(c => c.length !== channels[0].length)) throw new Error('Invalid audio samples')
  const size = channels[0].length * channels.length * 2
  if (!size || size > 32 * 1024 * 1024) throw new Error('Recording is empty or too large')
  const buf = new ArrayBuffer(44 + size), v = new DataView(buf)
  const str = (at: number, s: string) => { for (let i=0;i<s.length;i++) v.setUint8(at+i,s.charCodeAt(i)) }
  str(0,'RIFF');v.setUint32(4,36+size,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels.length,true);v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*channels.length*2,true);v.setUint16(32,channels.length*2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,size,true)
  let at=44
  for (let i=0;i<channels[0].length;i++) for (const channel of channels) {
    const n=Math.max(-1,Math.min(1,Number.isFinite(channel[i]) ? channel[i] : 0));v.setInt16(at,Math.round(n*(n<0 ? 32768 : 32767)),true);at+=2
  }
  return buf
}
export async function decodeRecordingWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    return new Blob([pcmWav(Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i)),decoded.sampleRate)],{type:'audio/wav'})
  } finally { await ctx.close() }
}
