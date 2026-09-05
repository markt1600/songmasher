/**
 * Fast, fully in-browser "stem" approximation using mid/side processing.
 *  - instrumental: side signal (L-R) + low-passed centre, which removes most centre-panned vocals
 *  - vocals: band-passed centre signal (rough, but useful for a hook)
 * Everything is deterministic and runs in a worker-friendly pure function.
 */

class Biquad {
  private a1 = 0; private a2 = 0; private b0 = 1; private b1 = 0; private b2 = 0;
  private z1 = 0; private z2 = 0;
  static lowpass(fc: number, sr: number, q = 0.7071): Biquad {
    const w0 = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    const f = new Biquad();
    f.b0 = ((1 - cw) / 2) / a0; f.b1 = (1 - cw) / a0; f.b2 = ((1 - cw) / 2) / a0;
    f.a1 = (-2 * cw) / a0; f.a2 = (1 - alpha) / a0;
    return f;
  }
  static highpass(fc: number, sr: number, q = 0.7071): Biquad {
    const w0 = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    const f = new Biquad();
    f.b0 = ((1 + cw) / 2) / a0; f.b1 = (-(1 + cw)) / a0; f.b2 = ((1 + cw) / 2) / a0;
    f.a1 = (-2 * cw) / a0; f.a2 = (1 - alpha) / a0;
    return f;
  }
  process(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length);
    let z1 = this.z1; let z2 = this.z2;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      out[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
    return out;
  }
}

export interface QuickStems {
  instrumental: Float32Array[];
  vocals: Float32Array[];
}

export function quickStems(channels: Float32Array[], sampleRate: number): QuickStems {
  const L = channels[0];
  const R = channels.length > 1 ? channels[1] : channels[0];
  const n = L.length;
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = (L[i] + R[i]) * 0.5;
    side[i] = (L[i] - R[i]) * 0.5;
  }
  // Keep bass & kick from the centre (below ~140 Hz), twice for a steeper slope.
  const lowMid = Biquad.lowpass(140, sampleRate).process(Biquad.lowpass(140, sampleRate).process(mid));
  // Keep air from the centre above ~9 kHz (hi-hats, cymbals) which vocals rarely dominate.
  const airMid = Biquad.highpass(9000, sampleRate).process(mid);
  const instL = new Float32Array(n);
  const instR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = lowMid[i] + 0.7 * airMid[i];
    instL[i] = side[i] * 1.4 + c;
    instR[i] = -side[i] * 1.4 + c;
  }
  // Vocals: centre band 180 Hz .. 7 kHz
  let voc = Biquad.highpass(180, sampleRate).process(mid);
  voc = Biquad.highpass(180, sampleRate).process(voc);
  voc = Biquad.lowpass(7000, sampleRate).process(voc);
  return { instrumental: [instL, instR], vocals: [voc, voc.slice()] };
}
