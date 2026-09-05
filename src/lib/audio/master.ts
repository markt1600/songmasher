/** Export finishing: optional loudness normalisation to -14 LUFS, then WAV or MP3 encoding. */
import { encodeWav } from "./wav";
import type { ExportOptions } from "../store";

/** Integrated loudness (simplified ITU-R BS.1770: K-weighting + gated mean square). */
export function integratedLufs(channels: Float32Array[], sampleRate: number): number {
  const chs = channels.map((c) => kWeight(c, sampleRate));
  const block = Math.floor(sampleRate * 0.4);
  const step = Math.floor(sampleRate * 0.1);
  const blocks: number[] = [];
  for (let p = 0; p + block <= chs[0].length; p += step) {
    let ms = 0;
    for (const c of chs) {
      let s = 0;
      for (let i = p; i < p + block; i++) s += c[i] * c[i];
      ms += s / block;
    }
    blocks.push(ms);
  }
  if (blocks.length === 0) return -70;
  const toLufs = (ms: number) => -0.691 + 10 * Math.log10(ms + 1e-12);
  const abs = blocks.filter((b) => toLufs(b) > -70);
  if (abs.length === 0) return -70;
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = toLufs(meanAbs) - 10;
  const gated = abs.filter((b) => toLufs(b) > rel);
  const mean = (gated.length ? gated : abs).reduce((a, b) => a + b, 0) / (gated.length || abs.length);
  return toLufs(mean);
}

function kWeight(x: Float32Array, sr: number): Float32Array {
  // Stage 1: high shelf (+4 dB above ~1.5 kHz), Stage 2: high-pass at ~38 Hz. Coefficients from BS.1770 for 48 kHz,
  // re-derived for the actual sample rate via bilinear transform of the analogue prototypes.
  const shelf = biquad(x, shelfCoefs(sr));
  return biquad(shelf, hpCoefs(sr));
}

function biquad(x: Float32Array, c: number[]): Float32Array {
  const [b0, b1, b2, a1, a2] = c;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o;
    y[i] = o;
  }
  return y;
}

function shelfCoefs(sr: number): number[] {
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
}

function hpCoefs(sr: number): number[] {
  const f0 = 38.13547087602444, Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sr);
  const a0 = 1 + K / Q + K * K;
  return [1 / a0, -2 / a0, 1 / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
}

export async function finalizeMix(channels: Float32Array[], sampleRate: number, opts: ExportOptions, onProgress?: (label: string, v: number) => void): Promise<Blob> {
  let out = channels;
  if (opts.normalize) {
    onProgress?.("Measuring loudness", 0.6);
    const lufs = integratedLufs(channels, sampleRate);
    const gainDb = Math.max(-20, Math.min(20, -14 - lufs));
    let g = Math.pow(10, gainDb / 20);
    // never push the true peak past -1 dBFS
    let peak = 0;
    for (const c of channels) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > peak) peak = Math.abs(c[i]);
    if (peak * g > 0.891) g = 0.891 / peak;
    out = channels.map((c) => {
      const o = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) o[i] = c[i] * g;
      return o;
    });
  }
  if (opts.format === "mp3") {
    onProgress?.("Encoding MP3", 0.75);
    const { encodeMp3 } = await import("./mp3");
    return encodeMp3(out, sampleRate, 256, (v) => onProgress?.("Encoding MP3", 0.75 + v * 0.25));
  }
  onProgress?.("Encoding WAV", 0.9);
  return encodeWav(out, sampleRate);
}
