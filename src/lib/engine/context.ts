let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ latencyHint: "interactive" });
  }
  return ctx;
}

export async function decodeFile(file: File): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  return decodeArrayBuffer(data);
}

export async function decodeArrayBuffer(data: ArrayBuffer): Promise<AudioBuffer> {
  // decodeAudioData works on a suspended context, no user gesture needed.
  const c = getAudioContext();
  return await c.decodeAudioData(data.slice(0));
}

export function toMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const mono = new Float32Array(n);
  const chs = buffer.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
  }
  return mono;
}
