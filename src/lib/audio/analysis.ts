import { FFT, hannWindow } from "./fft";
import { camelotOf, keyName, type KeyInfo, type Mode } from "./music";

export interface SongAnalysis {
  duration: number; // seconds
  bpm: number;
  bpmConfidence: number; // 0..1
  beatInterval: number; // seconds per beat
  firstDownbeat: number; // seconds; bar 0 starts here (always within the first bar of audio)
  key: KeyInfo;
  /** Waveform overview: max |x| per bucket, length = PEAK_BUCKETS */
  peaks: Float32Array;
  /** RMS per bucket, same length as peaks */
  rms: Float32Array;
  /** RMS energy per bar on the detected grid, normalised 0..1 */
  barEnergy: Float32Array;
  /** Onset strength per bar (how "beaty" the bar is), normalised 0..1 */
  barOnset: Float32Array;
  /** Estimated vocal presence per bar (mid-band centre energy), normalised 0..1 */
  barVocal: Float32Array;
  totalBars: number;
}

export const PEAK_BUCKETS = 2400;
const TARGET_SR = 22050;
const FRAME = 1024;
const HOP = 256;

export interface AnalysisProgress {
  stage: string;
  value: number; // 0..1
}

const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function downsample(mono: Float32Array, sr: number): { data: Float32Array; sr: number } {
  const factor = Math.max(1, Math.round(sr / TARGET_SR));
  if (factor === 1) return { data: mono, sr };
  const out = new Float32Array(Math.floor(mono.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) s += mono[base + k];
    out[i] = s / factor;
  }
  return { data: out, sr: sr / factor };
}

function normalise(arr: Float32Array): Float32Array {
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (max <= 0) return arr;
  for (let i = 0; i < arr.length; i++) arr[i] /= max;
  return arr;
}

/** Beat-aligned time helpers shared by the engine and the UI. */
export function barToTime(a: Pick<SongAnalysis, "firstDownbeat" | "beatInterval">, bar: number): number {
  return a.firstDownbeat + bar * 4 * a.beatInterval;
}
export function timeToBar(a: Pick<SongAnalysis, "firstDownbeat" | "beatInterval">, t: number): number {
  return (t - a.firstDownbeat) / (4 * a.beatInterval);
}

/**
 * Full offline analysis of a mono signal: tempo, beat grid, downbeats, key and waveform overview.
 * Designed to run inside a Web Worker; `onProgress` is optional.
 */
export function analyzeSong(
  monoIn: Float32Array,
  sampleRateIn: number,
  onProgress?: (p: AnalysisProgress) => void,
): SongAnalysis {
  const duration = monoIn.length / sampleRateIn;
  const { data: mono, sr } = downsample(monoIn, sampleRateIn);

  // ---- Waveform overview -------------------------------------------------
  const peaks = new Float32Array(PEAK_BUCKETS);
  const rms = new Float32Array(PEAK_BUCKETS);
  {
    const per = mono.length / PEAK_BUCKETS;
    for (let b = 0; b < PEAK_BUCKETS; b++) {
      const start = Math.floor(b * per);
      const end = Math.min(mono.length, Math.floor((b + 1) * per));
      let mx = 0;
      let sq = 0;
      for (let i = start; i < end; i++) {
        const v = mono[i];
        const av = v < 0 ? -v : v;
        if (av > mx) mx = av;
        sq += v * v;
      }
      peaks[b] = mx;
      rms[b] = end > start ? Math.sqrt(sq / (end - start)) : 0;
    }
  }
  onProgress?.({ stage: "waveform", value: 0.05 });

  // ---- STFT: spectral flux, low-band flux, chroma, mid-band energy ---------
  const fft = new FFT(FRAME);
  const win = hannWindow(FRAME);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const frame = new Float32Array(FRAME);
  const bins = FRAME / 2 + 1;
  const mag = new Float32Array(bins);
  const prevMag = new Float32Array(bins);
  const prevLin = new Float32Array(bins);
  const nFrames = Math.max(1, Math.floor((mono.length - FRAME) / HOP));
  const flux = new Float32Array(nFrames);
  const lowFlux = new Float32Array(nFrames);
  const midEnergy = new Float32Array(nFrames);
  const chromaFrames: Float32Array[] = [];
  const chromaTotal = new Float32Array(12);
  const binHz = sr / FRAME;
  const lowBin = Math.ceil(150 / binHz);
  const midLo = Math.ceil(250 / binHz);
  const midHi = Math.floor(4000 / binHz);
  // Precompute pitch class per bin for 55Hz..5kHz
  const binPc = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    if (f < 55 || f > 5000) continue;
    if (f > 2000 && f < 5000) {
      // keep for key detection only via a lighter weight? Simpler: skip noisy highs for chroma
      continue;
    }
    const midi = 69 + 12 * Math.log2(f / 440);
    binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const chromaHop = 8; // keep one chroma vector per 8 frames (~93 ms)
  let chromaAcc = new Float32Array(12);

  for (let n = 0; n < nFrames; n++) {
    const off = n * HOP;
    for (let i = 0; i < FRAME; i++) frame[i] = mono[off + i] * win[i];
    fft.magnitudes(frame, mag, re, im);
    let f = 0;
    let lf = 0;
    let me = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.log1p(mag[k] * 20);
      const d = m - prevMag[k];
      if (d > 0) f += d;
      prevMag[k] = m;
      if (k < lowBin) {
        const dl = mag[k] - prevLin[k];
        if (dl > 0) lf += dl;
        prevLin[k] = mag[k];
      }
      if (k >= midLo && k <= midHi) me += mag[k];
      const pc = binPc[k];
      if (pc >= 0) {
        const e = mag[k] * mag[k];
        chromaAcc[pc] += e;
        chromaTotal[pc] += e;
      }
    }
    flux[n] = f;
    lowFlux[n] = lf;
    midEnergy[n] = me;
    if ((n + 1) % chromaHop === 0) {
      chromaFrames.push(chromaAcc);
      chromaAcc = new Float32Array(12);
    }
    if (n % 2000 === 0) onProgress?.({ stage: "spectrum", value: 0.05 + 0.5 * (n / nFrames) });
  }

  // ---- Onset envelope ----------------------------------------------------
  const fps = sr / HOP;
  const onset = new Float32Array(nFrames);
  const lowOnset = new Float32Array(nFrames);
  {
    const w = Math.round(fps * 0.35);
    let sum = 0;
    let lsum = 0;
    const q: number[] = [];
    const lq: number[] = [];
    for (let n = 0; n < nFrames; n++) {
      q.push(flux[n]);
      lq.push(lowFlux[n]);
      sum += flux[n];
      lsum += lowFlux[n];
      if (q.length > w) {
        sum -= q.shift()!;
        lsum -= lq.shift()!;
      }
      const mean = sum / q.length;
      const lmean = lsum / lq.length;
      onset[n] = Math.max(0, flux[n] - mean);
      lowOnset[n] = Math.max(0, lowFlux[n] - lmean);
    }
    normalise(onset);
    normalise(lowOnset);
  }
  onProgress?.({ stage: "tempo", value: 0.6 });

  // ---- Tempo via autocorrelation + harmonic comb ---------------------------
  const minLag = Math.floor((60 / 220) * fps);
  const maxLag = Math.ceil((60 / 50) * fps);
  const acf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let n = 0; n + lag < nFrames; n++) s += onset[n] * onset[n + lag];
    acf[lag] = s / (nFrames - lag);
  }
  const score = new Float32Array(maxLag + 1);
  const ac = (lag: number) => (lag >= minLag && lag <= maxLag ? acf[lag] : 0);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    // Log-gaussian preference centred at 118 BPM (Ellis-style prior)
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 122) / 0.8, 2));
    const half = Math.round(lag / 2);
    score[lag] = prior * (ac(lag) + 0.6 * ac(lag * 2) + 0.35 * ac(lag * 3) + 0.25 * ac(half));
  }
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score[lag] > score[bestLag]) bestLag = lag;
  // Second-best peak (outside +-8% of best) for confidence
  let second = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = lag / bestLag;
    let related = false;
    for (const h of [1, 0.5, 2, 1 / 3, 3, 2 / 3, 1.5, 0.75, 4 / 3]) if (Math.abs(r - h) / h < 0.06) related = true;
    if (related) continue;
    if (score[lag] > second) second = score[lag];
  }
  const bpmConfidence = score[bestLag] > 0 ? Math.max(0, Math.min(1, 1 - second / score[bestLag])) : 0;

  // ---- Refine period + phase with a grid search over the whole song ---------
  const smooth = new Float32Array(nFrames);
  for (let n = 0; n < nFrames; n++) {
    const a = n > 0 ? onset[n - 1] : 0;
    const b = n + 1 < nFrames ? onset[n + 1] : 0;
    const combined = 0.55 * onset[n] + 0.45 * lowOnset[n];
    const ca = n > 0 ? 0.55 * a + 0.45 * lowOnset[n - 1] : 0;
    const cb = n + 1 < nFrames ? 0.55 * b + 0.45 * lowOnset[n + 1] : 0;
    smooth[n] = Math.max(combined, 0.7 * ca, 0.7 * cb);
  }
  const gridScore = (period: number, phase: number): number => {
    let s = 0;
    let c = 0;
    for (let t = phase; t < nFrames; t += period) {
      s += smooth[Math.round(t)];
      c++;
    }
    return c > 0 ? s / c : 0;
  };
  let bestPeriod = bestLag;
  let bestPhase = 0;
  let bestGrid = -1;
  const searchPeriod = (lo: number, hi: number, steps: number) => {
    for (let i = 0; i <= steps; i++) {
      const p = lo + ((hi - lo) * i) / steps;
      const phaseSteps = Math.max(8, Math.round(p));
      for (let j = 0; j < phaseSteps; j++) {
        const ph = (p * j) / phaseSteps;
        const g = gridScore(p, ph);
        if (g > bestGrid) {
          bestGrid = g;
          bestPeriod = p;
          bestPhase = ph;
        }
      }
    }
  };
  searchPeriod(bestLag * 0.97, bestLag * 1.03, 60);
  searchPeriod(bestPeriod * 0.997, bestPeriod * 1.003, 40);
  // Octave check: if onsets land just as consistently on every half-beat, the
  // true tempo is probably double (classic backbeat ambiguity).
  {
    const doubleBpm = (60 * fps) / (bestPeriod / 2);
    if (doubleBpm <= 185) {
      const savedP = bestPeriod;
      const savedPh = bestPhase;
      const savedG = bestGrid;
      bestGrid = -1;
      searchPeriod(savedP / 2 * 0.995, savedP / 2 * 1.005, 20);
      if (bestGrid < 0.62 * savedG) {
        bestPeriod = savedP;
        bestPhase = savedPh;
        bestGrid = savedG;
      }
    }
  }
  onProgress?.({ stage: "beats", value: 0.8 });

  const beatInterval = bestPeriod / fps;
  const bpm = 60 / beatInterval;

  // ---- Downbeat: pick the beat phase (0..3) with strongest bass onsets + harmonic change
  const chromaAt = (frameIdx: number, spanFrames: number): Float32Array | null => {
    const c0 = Math.floor(frameIdx / chromaHop);
    const c1 = Math.floor((frameIdx + spanFrames) / chromaHop);
    if (c0 < 0 || c1 > chromaFrames.length || c1 <= c0) return null;
    const acc = new Float32Array(12);
    for (let ci = c0; ci < c1; ci++) {
      const v = chromaFrames[ci];
      for (let i = 0; i < 12; i++) acc[i] += v[i];
    }
    return acc;
  };
  const chromaDist = (a: Float32Array | null, b: Float32Array | null): number => {
    if (!a || !b) return 0;
    let na = 0;
    let nb = 0;
    let dot = 0;
    for (let i = 0; i < 12; i++) {
      na += a[i] * a[i];
      nb += b[i] * b[i];
      dot += a[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return 1 - dot / Math.sqrt(na * nb);
  };
  const dbScore = [0, 0, 0, 0];
  {
    let k = 0;
    for (let t = bestPhase; t < nFrames; t += bestPeriod, k++) {
      const n = Math.round(t);
      const lo = Math.max(0, n - 1);
      const hi = Math.min(nFrames - 1, n + 1);
      let lowMax = 0;
      let onMax = 0;
      for (let i = lo; i <= hi; i++) {
        if (lowOnset[i] > lowMax) lowMax = lowOnset[i];
        if (onset[i] > onMax) onMax = onset[i];
      }
      const span = Math.round(bestPeriod);
      const before = chromaAt(Math.round(t - bestPeriod), span);
      const after = chromaAt(Math.round(t + 2), span);
      dbScore[k % 4] += 2.0 * lowMax + 0.25 * onMax + 1.2 * chromaDist(before, after);
    }
  }
  let dbOffset = 0;
  for (let i = 1; i < 4; i++) if (dbScore[i] > dbScore[dbOffset]) dbOffset = i;
  // Frame index of first downbeat; frame n covers samples starting at n*HOP with centre at +FRAME/2
  // With log-compressed flux the peak lands on the first frame that contains the
  // transient at all, i.e. the onset sits near the end of that frame.
  let firstDownbeat = ((bestPhase + dbOffset * bestPeriod) * HOP + FRAME - HOP) / sr;
  const barLen = 4 * beatInterval;
  while (firstDownbeat - barLen >= 0) firstDownbeat -= barLen;
  while (firstDownbeat < 0) firstDownbeat += barLen;

  // ---- Key detection -------------------------------------------------------
  const key = detectKey(chromaTotal);
  onProgress?.({ stage: "key", value: 0.9 });

  // ---- Per-bar descriptors ---------------------------------------------------
  const totalBars = Math.max(1, Math.floor((duration - firstDownbeat) / barLen));
  const barEnergy = new Float32Array(totalBars);
  const barOnset = new Float32Array(totalBars);
  const barVocal = new Float32Array(totalBars);
  for (let b = 0; b < totalBars; b++) {
    const t0 = firstDownbeat + b * barLen;
    const s0 = Math.floor(t0 * sr);
    const s1 = Math.min(mono.length, Math.floor((t0 + barLen) * sr));
    let sq = 0;
    for (let i = s0; i < s1; i++) sq += mono[i] * mono[i];
    barEnergy[b] = s1 > s0 ? Math.sqrt(sq / (s1 - s0)) : 0;
    const f0 = Math.floor(s0 / HOP);
    const f1 = Math.min(nFrames, Math.floor(s1 / HOP));
    let on = 0;
    let me = 0;
    for (let n = f0; n < f1; n++) {
      on += onset[n];
      me += midEnergy[n];
    }
    barOnset[b] = f1 > f0 ? on / (f1 - f0) : 0;
    barVocal[b] = f1 > f0 ? me / (f1 - f0) : 0;
  }
  normalise(barEnergy);
  normalise(barOnset);
  normalise(barVocal);
  onProgress?.({ stage: "done", value: 1 });

  return {
    duration,
    bpm,
    bpmConfidence,
    beatInterval,
    firstDownbeat,
    key,
    peaks,
    rms,
    barEnergy,
    barOnset,
    barVocal,
    totalBars,
  };
}

function detectKey(chroma: Float32Array): KeyInfo {
  const c = Array.from(chroma);
  const corr = (profile: number[], shift: number): number => {
    const mp = profile.reduce((a, b) => a + b, 0) / 12;
    const mc = c.reduce((a, b) => a + b, 0) / 12;
    let num = 0;
    let dp = 0;
    let dc = 0;
    for (let i = 0; i < 12; i++) {
      const p = profile[(i - shift + 12) % 12] - mp;
      const x = c[i] - mc;
      num += p * x;
      dp += p * p;
      dc += x * x;
    }
    return dp > 0 && dc > 0 ? num / Math.sqrt(dp * dc) : 0;
  };
  let best = { root: 0, mode: "major" as Mode, r: -2 };
  let second = -2;
  for (let root = 0; root < 12; root++) {
    for (const mode of ["major", "minor"] as Mode[]) {
      const r = corr(mode === "major" ? KRUMHANSL_MAJOR : KRUMHANSL_MINOR, root);
      if (r > best.r) {
        second = best.r;
        best = { root, mode, r };
      } else if (r > second) second = r;
    }
  }
  const confidence = Math.max(0, Math.min(1, (best.r - second) * 4 + 0.3));
  return {
    root: best.root,
    mode: best.mode,
    name: keyName(best.root, best.mode),
    camelot: camelotOf(best.root, best.mode),
    confidence,
  };
}
