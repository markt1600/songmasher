import { Mp3Encoder } from "@breezystack/lamejs";

/** Encodes planar float channels to an MP3 Blob (CBR). */
export function encodeMp3(channels: Float32Array[], sampleRate: number, kbps = 256, onProgress?: (v: number) => void): Blob {
  const stereo = channels.length > 1;
  const enc = new Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);
  const n = channels[0].length;
  const toInt = (c: Float32Array): Int16Array => {
    const o = new Int16Array(c.length);
    for (let i = 0; i < c.length; i++) {
      const v = Math.max(-1, Math.min(1, c[i]));
      o[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return o;
  };
  const L = toInt(channels[0]);
  const R = stereo ? toInt(channels[1]) : L;
  const parts: BlobPart[] = [];
  const block = 1152 * 8;
  for (let i = 0; i < n; i += block) {
    const data = stereo ? enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)) : enc.encodeBuffer(L.subarray(i, i + block));
    if (data.length) parts.push(new Uint8Array(data));
    if (onProgress && (i / block) % 50 === 0) onProgress(i / n);
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: "audio/mpeg" });
}
