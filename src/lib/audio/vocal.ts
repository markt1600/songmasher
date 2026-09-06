/**
 * Vocal profile from an isolated vocal stem: where the singer actually sings (phrases), how much per
 * bar, and the pitch-class content of the melody per bar. Everything is expressed on the song's beat
 * grid so the planner can reason in bars and beats.
 */
import { FFT, hannWindow } from "./fft";

export interface VocalPhrase {
  /** fractional beats on the song grid (0 = first downbeat) */
  startBeat: number;
  endBeat: number;
  /** peak level 0..1 relative to the loudest phrase */
  level: number;
}

export interface VocalProfile {
  /** vocal energy per bar, 0..1 */
  barVocal: number[];
  /** 12 x totalBars chroma of the vocal stem, each bar L1-normalised */
  barChroma: number[];
  /** sung lines: hard boundaries a clip may start or end on */
  phrases: VocalPhrase[];
  /** short dips inside lines (breaths, quiet syllables), in beats: acceptable places to cut when no line end fits */
  breaths?: number[];
  /** the beat grid and stem length this profile was measured on; a profile is only valid for that grid */
  grid?: { firstDownbeat: number; beatInterval: number; totalBars: number; duration: number };
}

/**
 * A saved profile is only meaningful on the grid it was measured on. If the grid was re-detected or
 * nudged since, or the stem is not the same length as the song, its phrases point at the wrong audio
 * (silence, or the middle of a different line) and it must be recomputed.
 */
export function vocalProfileMatches(profile: VocalProfile | null | undefined, a: GridInfo & { duration: number }): profile is VocalProfile {
  if (!profile?.grid) return false;
  const g = profile.grid;
  return Math.abs(g.beatInterval - a.beatInterval) < 1e-4 && Math.abs(g.firstDownbeat - a.firstDownbeat) < 0.002 && g.totalBars === a.totalBars && Math.abs(g.duration - a.duration) < 1.5;
}

export interface GridInfo {
  firstDownbeat: number;
  beatInterval: number;
  totalBars: number;
}

export function vocalProfile(mono: Float32Array, sr: number, grid: GridInfo): VocalProfile {
  const hop = Math.max(1, Math.floor(sr * 0.01)); // 10 ms
  const nFrames = Math.floor(mono.length / hop);
  const env = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    const p = f * hop;
    for (let i = p; i < p + hop; i++) s += mono[i] * mono[i];
    env[f] = Math.sqrt(s / hop);
  }
  // smooth (30 ms) and find the noise floor / peak
  const sm = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) sm[f] = (env[Math.max(0, f - 1)] + env[f] + env[Math.min(nFrames - 1, f + 1)]) / 3;
  const sorted = Float32Array.from(sm).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const peak = sorted[Math.floor(sorted.length * 0.99)] || 1;
  // Local level: a soft verse must not be gated by the chorus's peak, or its quiet last words vanish
  // and every line looks like it ends early. Rolling max over +-6 s, floored at a fifth of the song peak.
  const win = Math.round((6 * sr) / hop);
  const local = new Float32Array(nFrames);
  {
    // block maxima then a two-pass max filter
    const step = Math.max(1, Math.round(win / 8));
    const blocks = new Float32Array(Math.ceil(nFrames / step));
    for (let f = 0; f < nFrames; f++) if (sm[f] > blocks[Math.floor(f / step)]) blocks[Math.floor(f / step)] = sm[f];
    for (let f = 0; f < nFrames; f++) {
      const b = Math.floor(f / step);
      let m = 0;
      for (let k = Math.max(0, b - 8); k <= Math.min(blocks.length - 1, b + 8); k++) if (blocks[k] > m) m = blocks[k];
      local[f] = Math.max(m, floor + (peak - floor) * 0.2);
    }
  }
  const onAt = (f: number) => floor + (local[f] - floor) * 0.12;
  const offAt = (f: number) => floor + (local[f] - floor) * 0.05;

  // Hysteresis gate -> raw active regions
  const regions: { s: number; e: number; peak: number }[] = [];
  let active = false;
  let start = 0;
  let rpeak = 0;
  for (let f = 0; f < nFrames; f++) {
    const v = sm[f];
    const on = onAt(f);
    const off = offAt(f);
    if (!active && v > on) {
      active = true;
      start = f;
      rpeak = v;
    } else if (active) {
      if (v > rpeak) rpeak = v;
      if (v < off) {
        active = false;
        regions.push({ s: start, e: f, peak: rpeak });
      }
    }
  }
  if (active) regions.push({ s: start, e: nFrames, peak: rpeak });
  // Merge gaps shorter than 220 ms (consonants, quick breaths), drop blips shorter than 250 ms
  const merged: { s: number; e: number; peak: number }[] = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.s - last.e < (0.22 * sr) / hop) {
      last.e = r.e;
      last.peak = Math.max(last.peak, r.peak);
    } else merged.push({ ...r });
  }
  // Split long regions only at long, deep valleys: a breath between two lines under a reverb tail dips
  // far below the line level for a quarter second or more; a quiet syllable inside a line does not.
  const minValley = Math.round((0.24 * sr) / hop);
  const minBreath = Math.round((0.1 * sr) / hop);
  const breathFrames: number[] = [];
  const split: { s: number; e: number; peak: number }[] = [];
  for (const r of merged) {
    let segStart = r.s;
    let segPeak = 0;
    let valleyStart = -1;
    let breathStart = -1;
    for (let f = r.s; f < r.e; f++) {
      const v = sm[f];
      if (v > segPeak) segPeak = v;
      const low = v < floor + (segPeak - floor) * 0.22;
      const dip = v < floor + (segPeak - floor) * 0.35;
      if (dip) {
        if (breathStart < 0) breathStart = f;
      } else if (breathStart >= 0) {
        if (f - breathStart >= minBreath) breathFrames.push(Math.round((breathStart + f) / 2));
        breathStart = -1;
      }
      if (low) {
        if (valleyStart < 0) valleyStart = f;
      } else if (valleyStart >= 0) {
        if (f - valleyStart >= minValley && f - segStart >= (0.25 * sr) / hop) {
          split.push({ s: segStart, e: valleyStart, peak: segPeak });
          segStart = f;
          segPeak = v;
        }
        valleyStart = -1;
      }
    }
    split.push({ s: segStart, e: r.e, peak: segPeak });
  }
  const phrasesRaw = split.filter((r) => (r.e - r.s) * hop >= 0.25 * sr);
  const toBeat = (frame: number) => ((frame * hop) / sr - grid.firstDownbeat) / grid.beatInterval;
  const phrases: VocalPhrase[] = phrasesRaw.map((r) => ({ startBeat: Math.round(toBeat(r.s) * 8) / 8, endBeat: Math.round(toBeat(r.e) * 8) / 8, level: peak > 0 ? Math.min(1, r.peak / peak) : 0 }));
  // breaths that coincide with a line boundary are redundant
  const breaths = breathFrames.map((f) => Math.round(toBeat(f) * 8) / 8).filter((b) => !phrases.some((p) => Math.abs(p.endBeat - b) < 0.3 || Math.abs(p.startBeat - b) < 0.3));

  // Per-bar vocal energy
  const barLen = grid.beatInterval * 4;
  const barVocal = new Array<number>(grid.totalBars).fill(0);
  let maxBar = 0;
  for (let b = 0; b < grid.totalBars; b++) {
    const f0 = Math.max(0, Math.floor(((grid.firstDownbeat + b * barLen) * sr) / hop));
    const f1 = Math.min(nFrames, Math.floor(((grid.firstDownbeat + (b + 1) * barLen) * sr) / hop));
    let s = 0;
    for (let f = f0; f < f1; f++) s += Math.max(0, sm[f] - floor);
    barVocal[b] = f1 > f0 ? s / (f1 - f0) : 0;
    if (barVocal[b] > maxBar) maxBar = barVocal[b];
  }
  if (maxBar > 0) for (let b = 0; b < grid.totalBars; b++) barVocal[b] /= maxBar;

  // Per-bar chroma of the vocal (melody notes)
  const barChroma = chromaPerBar(mono, sr, grid);
  return { barVocal, barChroma, phrases, breaths, grid: { firstDownbeat: grid.firstDownbeat, beatInterval: grid.beatInterval, totalBars: grid.totalBars, duration: mono.length / sr } };
}

/** 12 x totalBars pitch-class energy, each bar normalised to sum 1 (zeros when silent). */
export function chromaPerBar(mono: Float32Array, sr: number, grid: GridInfo, fLo = 100, fHi = 2500): number[] {
  const N = 8192;
  const hop = 2048;
  const fft = new FFT(N);
  const win = hannWindow(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const frame = new Float32Array(N);
  const bins = N / 2 + 1;
  const mag = new Float32Array(bins);
  const binHz = sr / N;
  // Each bin contributes to the nearest pitch class, weighted by how close it sits to that
  // semitone's centre, so leakage between neighbouring bins at low frequencies is discounted.
  const binPc = new Int8Array(bins).fill(-1);
  const binW = new Float32Array(bins);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    if (f < fLo || f > fHi) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const frac = Math.abs(midi - Math.round(midi));
    if (frac > 0.35) continue;
    binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
    binW[k] = 1 - frac / 0.35;
  }
  const out = new Array<number>(12 * grid.totalBars).fill(0);
  const barLen = grid.beatInterval * 4;
  for (let b = 0; b < grid.totalBars; b++) {
    const s0 = Math.max(0, Math.floor((grid.firstDownbeat + b * barLen) * sr));
    const s1 = Math.min(mono.length - N, Math.floor((grid.firstDownbeat + (b + 1) * barLen) * sr));
    const acc = new Float32Array(12);
    for (let p = s0; p < s1; p += hop) {
      for (let i = 0; i < N; i++) frame[i] = mono[p + i] * win[i];
      fft.magnitudes(frame, mag, re, im);
      for (let k = 1; k < bins; k++) {
        const pc = binPc[k];
        if (pc >= 0) acc[pc] += mag[k] * mag[k] * binW[k];
      }
    }
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += acc[i];
    for (let i = 0; i < 12; i++) out[b * 12 + i] = sum > 0 ? acc[i] / sum : 0;
  }
  return out;
}
