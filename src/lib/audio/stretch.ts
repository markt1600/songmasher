/**
 * WSOLA time-stretching + resampling pitch shift, pure TypeScript.
 * Runs inside a worker; all channels are processed with a shared mono guide so
 * stereo stays phase-coherent.
 */

export interface StretchOptions {
  /** output length / input length. 1 = unchanged, 0.5 = twice as fast. */
  ratio: number;
  /** pitch shift in semitones (resampling + compensating stretch) */
  semitones: number;
  sampleRate: number;
  onProgress?: (v: number) => void;
}

export function processChannels(channels: Float32Array[], opts: StretchOptions): Float32Array[] {
  const { sampleRate } = opts;
  let ratio = opts.ratio;
  let work = channels;
  const semis = opts.semitones;
  if (Math.abs(semis) > 0.01) {
    const f = Math.pow(2, semis / 12);
    work = channels.map((c) => resampleLinear(c, f));
    ratio = ratio * f;
  }
  if (Math.abs(ratio - 1) < 0.0005) {
    return work === channels ? channels.map((c) => c.slice()) : work;
  }
  return wsola(work, ratio, sampleRate, opts.onProgress);
}

/** Reads the input at `step` samples per output sample (step>1 => shorter & higher). */
export function resampleLinear(input: Float32Array, step: number): Float32Array {
  const outLen = Math.max(1, Math.floor((input.length - 1) / step));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const t = pos - j;
    const a = input[j];
    const b = j + 1 < input.length ? input[j + 1] : a;
    out[i] = a + (b - a) * t;
  }
  return out;
}

export function wsola(
  channels: Float32Array[],
  ratio: number,
  sampleRate: number,
  onProgress?: (v: number) => void,
): Float32Array[] {
  const inLen = channels[0].length;
  const N = Math.round(sampleRate * 0.03); // 30 ms analysis frame
  const half = N >> 1;
  const hopOut = half; // 50% overlap
  const hopIn = hopOut / ratio;
  const tol = Math.round(sampleRate * 0.009); // +-9 ms search
  const outLen = Math.round(inLen * ratio);
  const nFrames = Math.ceil(outLen / hopOut) + 1;

  // Mono guide for the correlation search
  const guide = new Float32Array(inLen);
  if (channels.length === 1) guide.set(channels[0]);
  else {
    for (let ch = 0; ch < channels.length; ch++) {
      const c = channels[ch];
      for (let i = 0; i < inLen; i++) guide[i] += c[i];
    }
  }

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const outputs = channels.map(() => new Float32Array(outLen + N));
  const coarse = 3;

  const corrAt = (cand: number, tmpl: number): number => {
    // normalised cross-correlation on the overlap region, strided for speed
    let dot = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i < half; i += 2) {
      const a = guide[cand + i];
      const b = guide[tmpl + i];
      dot += a * b;
      ea += a * a;
      eb += b * b;
    }
    return ea > 0 && eb > 0 ? dot / Math.sqrt(ea * eb) : 0;
  };

  let prevChosen = -1;
  for (let m = 0; m < nFrames; m++) {
    const outPos = m * hopOut;
    const nominal = Math.round(m * hopIn);
    let chosen = nominal;
    if (prevChosen >= 0) {
      const tmpl = prevChosen + hopOut; // natural continuation of the previous grain
      if (tmpl + N < inLen) {
        let best = -Infinity;
        let bestD = 0;
        const lo = Math.max(-tol, -nominal);
        const hi = Math.min(tol, inLen - N - nominal);
        for (let d = lo; d <= hi; d += coarse) {
          const c = corrAt(nominal + d, tmpl);
          if (c > best) {
            best = c;
            bestD = d;
          }
        }
        for (let d = Math.max(lo, bestD - coarse + 1); d <= Math.min(hi, bestD + coarse - 1); d++) {
          if ((d - bestD) % coarse === 0) continue;
          const c = corrAt(nominal + d, tmpl);
          if (c > best) {
            best = c;
            bestD = d;
          }
        }
        chosen = nominal + bestD;
      }
    }
    if (chosen < 0) chosen = 0;
    prevChosen = chosen;
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch];
      const dst = outputs[ch];
      const lim = Math.min(N, inLen - chosen, dst.length - outPos);
      for (let i = 0; i < lim; i++) dst[outPos + i] += src[chosen + i] * win[i];
    }
    if (onProgress && m % 400 === 0) onProgress(m / nFrames);
  }
  onProgress?.(1);
  return outputs.map((o) => o.subarray(0, outLen));
}
