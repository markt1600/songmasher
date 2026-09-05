/**
 * Finds the first clear onset near a source time so a clip can be nudged onto the beat.
 * Returns the offset in seconds (positive = the onset is after `t`), or null if nothing stands out.
 */
export function firstOnsetOffset(buffer: AudioBuffer, t: number, beatInterval: number): number | null {
  const sr = buffer.sampleRate;
  const before = Math.min(0.25, beatInterval * 0.5);
  const after = Math.min(0.6, beatInterval * 1.5);
  const s0 = Math.max(0, Math.floor((t - before) * sr));
  const s1 = Math.min(buffer.length, Math.floor((t + after) * sr));
  if (s1 - s0 < sr * 0.05) return null;
  const hop = Math.floor(sr * 0.004);
  const chs = buffer.numberOfChannels;
  const data = Array.from({ length: chs }, (_, c) => buffer.getChannelData(c));
  const env: number[] = [];
  for (let p = s0; p + hop <= s1; p += hop) {
    let e = 0;
    for (let c = 0; c < chs; c++) {
      const d = data[c];
      for (let i = p; i < p + hop; i++) e += d[i] * d[i];
    }
    env.push(Math.sqrt(e / (hop * chs)));
  }
  let max = 0;
  for (const v of env) if (v > max) max = v;
  if (max < 1e-4) return null;
  // Onset = first frame whose rise over the previous 20 ms exceeds 35% of the peak level.
  const lag = 5;
  for (let i = lag; i < env.length; i++) {
    const rise = env[i] - env[i - lag];
    if (rise > 0.35 * max && env[i] > 0.4 * max) {
      const onsetSec = (s0 + i * hop) / sr;
      return onsetSec - t;
    }
  }
  return null;
}
