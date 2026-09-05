import { FFT, hannWindow } from "./fft";
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

// ---------------------------------------------------------------------------
// Formant preservation
// ---------------------------------------------------------------------------

/**
 * Re-imposes the spectral envelope of `reference` onto `shifted` frame by frame, so a
 * resampled (pitch-shifted) vocal keeps its original formants instead of sounding
 * chipmunked or boomy. Both inputs must have the same length; `shifted` is modified in place.
 * The envelope is estimated by cepstral liftering.
 */
export function restoreFormants(shifted: Float32Array, reference: Float32Array, sampleRate: number, onProgress?: (v: number) => void): Float32Array {
  const N = 2048;
  const hop = N / 4;
  const fft = new FFT(N);
  const win = hannWindow(N);
  const bins = N / 2 + 1;
  // ~2.9 ms quefrency cut: resolves formants ~350 Hz apart yet stays below the pitch period of most vocals (F0 < 340 Hz)
  const lifter = Math.round(sampleRate / 350);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const re2 = new Float32Array(N);
  const im2 = new Float32Array(N);
  const out = new Float32Array(shifted.length);
  const norm = new Float32Array(shifted.length);
  const envOf = (frame: Float32Array, tmpRe: Float32Array, tmpIm: Float32Array, env: Float32Array) => {
    tmpRe.set(frame);
    tmpIm.fill(0);
    fft.transform(tmpRe, tmpIm);
    // log magnitude (symmetric), cepstrum via inverse FFT (real input => use forward FFT of log-mag, scaled)
    const logMag = new Float32Array(N);
    for (let k = 0; k < bins; k++) {
      const m = Math.hypot(tmpRe[k], tmpIm[k]);
      logMag[k] = Math.log(m + 1e-6);
    }
    for (let k = bins; k < N; k++) logMag[k] = logMag[N - k];
    const cRe = new Float32Array(logMag);
    const cIm = new Float32Array(N);
    fft.transform(cRe, cIm); // cepstrum (up to scale, symmetric)
    for (let q = lifter; q < N - lifter; q++) {
      cRe[q] = 0;
      cIm[q] = 0;
    }
    fft.transform(cRe, cIm); // back to log-spectrum domain (scaled by N, mirrored)
    for (let k = 0; k < bins; k++) env[k] = cRe[k] / N;
  };
  const envS = new Float32Array(bins);
  const envR = new Float32Array(bins);
  const frame = new Float32Array(N);
  const frameR = new Float32Array(N);
  const nFrames = Math.ceil((shifted.length - N) / hop);
  for (let f = 0; f < nFrames; f++) {
    const pos = f * hop;
    for (let i = 0; i < N; i++) {
      frame[i] = shifted[pos + i] * win[i];
      frameR[i] = reference[pos + i] * win[i];
    }
    envOf(frameR, re2, im2, envR);
    envOf(frame, re, im, envS); // leaves the shifted spectrum in re/im? no: envOf overwrote re/im with cepstral work; recompute
    re.set(frame);
    im.fill(0);
    fft.transform(re, im);
    for (let k = 0; k < bins; k++) {
      const gain = Math.exp(Math.max(-4, Math.min(4, envR[k] - envS[k])));
      re[k] *= gain;
      im[k] *= gain;
      if (k > 0 && k < bins - 1) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    // inverse FFT via conjugate trick
    for (let k = 0; k < N; k++) im[k] = -im[k];
    fft.transform(re, im);
    for (let i = 0; i < N; i++) {
      out[pos + i] += (re[i] / N) * win[i];
      norm[pos + i] += win[i] * win[i];
    }
    if (onProgress && f % 200 === 0) onProgress(f / nFrames);
  }
  // Keep the loudness of the plain shift: envelope correction should change colour, not level.
  let eIn = 0;
  let eOut = 0;
  for (let i = 0; i < out.length; i++) {
    const v = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
    out[i] = v;
    eIn += shifted[i] * shifted[i];
    eOut += v * v;
  }
  const g = eOut > 0 ? Math.sqrt(eIn / eOut) : 1;
  for (let i = 0; i < out.length; i++) shifted[i] = out[i] * g;
  return shifted;
}

/**
 * Pitch shift + stretch with formant preservation: the reference for the envelope is the
 * input stretched (without pitch change) to the same length as the shifted output.
 */
export function processChannelsFormant(channels: Float32Array[], opts: StretchOptions): Float32Array[] {
  const shifted = processChannels(channels, opts);
  if (Math.abs(opts.semitones) < 0.01) return shifted;
  const reference = processChannels(channels, { ...opts, semitones: 0, onProgress: undefined });
  return shifted.map((ch, i) => {
    const ref = reference[Math.min(i, reference.length - 1)];
    const len = Math.min(ch.length, ref.length);
    return restoreFormants(ch.subarray(0, len), ref.subarray(0, len), opts.sampleRate, (v) => opts.onProgress?.(0.7 + 0.3 * v));
  });
}
