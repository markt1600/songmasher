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

/**
 * Lag of a stem mix relative to the full mix, in samples (positive = the stems arrive late). Separated
 * stems sometimes come back a few milliseconds offset from the song they were cut from (codec priming,
 * resampling); summed stems are near-identical to the original, so a two-stage cross-correlation on an
 * excerpt pins the lag down to the sample. Returns 0 when nothing correlates.
 */
export function stemLagSamples(full: Float32Array, stems: Float32Array, sr: number): number {
  const n = Math.min(full.length, stems.length);
  if (n < sr * 2) return 0;
  // Excerpt: the loudest of a few 4-second candidates, avoiding the very start and end.
  const seg = Math.min(n - 1, Math.floor(sr * 4));
  let start = 0;
  let bestE = -1;
  for (const frac of [0.25, 0.4, 0.55, 0.7]) {
    const s = Math.min(n - seg, Math.floor(n * frac));
    let e = 0;
    for (let i = s; i < s + seg; i += 16) e += full[i] * full[i];
    if (e > bestE) {
      bestE = e;
      start = s;
    }
  }
  if (bestE <= 0) return 0;
  const maxLag = Math.floor(sr * 0.15);
  // Stage 1: 1 ms envelopes of |x|, lags in 1 ms steps.
  const hop = Math.max(1, Math.floor(sr / 1000));
  const env = (x: Float32Array, s0: number, frames: number) => {
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let a = 0;
      const p = s0 + f * hop;
      for (let i = p; i < p + hop; i++) a += Math.abs(x[i]);
      out[f] = a / hop;
    }
    return out;
  };
  const frames = Math.floor((seg - 2 * maxLag) / hop);
  const ef = env(full, start + maxLag, frames);
  const lagFrames = Math.floor(maxLag / hop);
  let coarse = 0;
  let coarseBest = -Infinity;
  const es = env(stems, start, Math.floor(seg / hop));
  for (let L = -lagFrames; L <= lagFrames; L++) {
    let c = 0;
    const off = lagFrames + L;
    for (let f = 0; f < frames; f++) c += ef[f] * es[f + off];
    if (c > coarseBest) {
      coarseBest = c;
      coarse = L;
    }
  }
  // Stage 2: sample-accurate around the coarse lag on a shorter window.
  const fineSpan = 3 * hop;
  const win = Math.min(seg - 2 * maxLag, Math.floor(sr * 1.5));
  const base = start + maxLag;
  let best = coarse * hop;
  let bestC = -Infinity;
  let sum = 0;
  let count = 0;
  for (let L = coarse * hop - fineSpan; L <= coarse * hop + fineSpan; L++) {
    let c = 0;
    for (let i = 0; i < win; i++) c += full[base + i] * stems[base + i + L];
    sum += c;
    count++;
    if (c > bestC) {
      bestC = c;
      best = L;
    }
  }
  // A real alignment peak stands well above the neighbourhood; otherwise leave the stems alone.
  const mean = count ? sum / count : 0;
  if (!(bestC > 0) || bestC < mean * 1.5 + 1e-9) return 0;
  return best;
}

/**
 * Where the audible beats actually fall around time `t`, relative to a nominal grid: returns the offset
 * (seconds) to add to grid beat times so they sit on the real beats. Uses an onset envelope of the full
 * mix over a few bars and picks the phase where a comb of beats collects the most onset energy. Returns
 * 0 when no clear beat pattern exists there.
 */
export function localBeatPhase(mono: Float32Array, sr: number, t: number, beatInterval: number, bars = 4): number {
  const half = (bars * 4 * beatInterval) / 2;
  const s0 = Math.max(0, Math.floor((t - half) * sr));
  const s1 = Math.min(mono.length, Math.floor((t + half) * sr));
  if (s1 - s0 < sr * beatInterval * 4) return 0;
  const hop = Math.max(1, Math.floor(sr * 0.002));
  const frames = Math.floor((s1 - s0) / hop);
  // Energy envelope with extra weight on the low band (kick and bass carry the beat).
  const env = new Float32Array(frames);
  let lp = 0;
  const a = Math.exp((-2 * Math.PI * 180) / sr);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    let el = 0;
    const p = s0 + f * hop;
    for (let i = p; i < p + hop; i++) {
      const v = mono[i];
      lp = a * lp + (1 - a) * v;
      e += v * v;
      el += lp * lp;
    }
    env[f] = Math.sqrt(e / hop) + 2 * Math.sqrt(el / hop);
  }
  const onset = new Float32Array(frames);
  let total = 0;
  for (let f = 1; f < frames; f++) {
    const d = env[f] - env[f - 1];
    onset[f] = d > 0 ? d : 0;
    total += onset[f];
  }
  if (total <= 0) return 0;
  // Nominal beats inside the window: the grid passes through `t`.
  const beats: number[] = [];
  const first = t - Math.ceil(half / beatInterval) * beatInterval;
  for (let b = first; b < t + half; b += beatInterval) if (b >= s0 / sr && b < s1 / sr) beats.push(b);
  if (beats.length < 4) return 0;
  const step = 0.002;
  const range = beatInterval * 0.35;
  let bestPhi = 0;
  let bestScore = -1;
  const scores: number[] = [];
  for (let phi = -range; phi <= range; phi += step) {
    let s = 0;
    for (const b of beats) {
      const f = Math.round(((b + phi) * sr - s0) / hop);
      if (f < 1 || f >= frames - 1) continue;
      s += onset[f - 1] * 0.5 + onset[f] + onset[f + 1] * 0.5;
    }
    scores.push(s);
    if (s > bestScore) {
      bestScore = s;
      bestPhi = phi;
    }
  }
  // A real beat gives one sharp peak far above the rest; noise gives a flat, wobbly curve.
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length);
  if (sd <= 0 || (bestScore - mean) / sd < 4.5) return 0;
  return bestPhi;
}
