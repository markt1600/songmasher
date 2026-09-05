/**
 * Structural segmentation: labels bars of a song as intro / verse / chorus / bridge / break / outro.
 * Per-bar chroma + energy + rhythm + vocal features -> self-similarity -> novelty boundaries ->
 * clustering of segments -> heuristic labels.
 */
import { FFT, hannWindow } from "./fft";

export interface Section {
  startBar: number; // inclusive
  endBar: number; // exclusive
  label: SectionLabel;
  cluster: number;
}
export type SectionLabel = "Intro" | "Verse" | "Chorus" | "Bridge" | "Break" | "Outro";

export interface GridForSections {
  firstDownbeat: number;
  beatInterval: number;
  totalBars: number;
}

const FRAME = 2048;
const HOP = 1024;

function barFeatures(mono: Float32Array, sr: number, grid: GridForSections): Float32Array[] {
  const fft = new FFT(FRAME);
  const win = hannWindow(FRAME);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const frame = new Float32Array(FRAME);
  const bins = FRAME / 2 + 1;
  const mag = new Float32Array(bins);
  const prev = new Float32Array(bins);
  const binHz = sr / FRAME;
  const binPc = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    if (f < 60 || f > 2200) continue;
    binPc[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
  }
  const midLo = Math.ceil(250 / binHz);
  const midHi = Math.floor(4000 / binHz);
  const barLen = grid.beatInterval * 4;
  const feats: Float32Array[] = [];
  for (let b = 0; b < grid.totalBars; b++) {
    const t0 = grid.firstDownbeat + b * barLen;
    const s0 = Math.max(0, Math.floor(t0 * sr));
    const s1 = Math.min(mono.length - FRAME, Math.floor((t0 + barLen) * sr));
    const f = new Float32Array(16);
    let n = 0;
    let energy = 0;
    let flux = 0;
    let mid = 0;
    let total = 0;
    prev.fill(0);
    for (let p = s0; p + FRAME <= s1 + FRAME && p < s1; p += HOP) {
      for (let i = 0; i < FRAME; i++) frame[i] = mono[p + i] * win[i];
      fft.magnitudes(frame, mag, re, im);
      let fl = 0;
      for (let k = 1; k < bins; k++) {
        const m = mag[k];
        const pc = binPc[k];
        if (pc >= 0) f[pc] += m * m;
        if (k >= midLo && k <= midHi) mid += m;
        total += m;
        const d = Math.log1p(m * 20) - prev[k];
        if (d > 0) fl += d;
        prev[k] = Math.log1p(m * 20);
      }
      if (n > 0) flux += fl;
      n++;
    }
    for (let i = s0; i < s1; i++) energy += mono[i] * mono[i];
    // normalise chroma
    let cs = 0;
    for (let i = 0; i < 12; i++) cs += f[i];
    for (let i = 0; i < 12; i++) f[i] = cs > 0 ? f[i] / cs : 0;
    f[12] = s1 > s0 ? Math.sqrt(energy / (s1 - s0)) : 0;
    f[13] = n > 1 ? flux / (n - 1) : 0;
    f[14] = total > 0 ? mid / total : 0;
    f[15] = 0;
    feats.push(f);
  }
  // scale the scalar features to 0..1 and weight them against chroma
  for (const idx of [12, 13, 14]) {
    let mx = 0;
    for (const f of feats) if (f[idx] > mx) mx = f[idx];
    for (const f of feats) f[idx] = mx > 0 ? f[idx] / mx : 0;
  }
  for (const f of feats) {
    for (let i = 0; i < 12; i++) f[i] *= 1.6; // chroma carries harmony
    f[12] *= 2.5; // loudness separates verse from chorus even when chords overlap
    f[13] *= 1.0;
    f[14] *= 2.0;
  }
  return feats;
}

export function detectSections(mono: Float32Array, sr: number, grid: GridForSections): Section[] {
  const N = grid.totalBars;
  if (N < 8) return N > 0 ? [{ startBar: 0, endBar: N, label: "Verse", cluster: 0 }] : [];
  const F = barFeatures(mono, sr, grid);
  const rawEnergy = F.map((f) => f[12]);
  const rawVocal = F.map((f) => f[14]);
  // z-score every dimension so loudness and density count as much as harmony, then Gaussian similarity
  const D = F[0].length;
  for (let k = 0; k < D; k++) {
    let m = 0;
    for (const f of F) m += f[k];
    m /= N;
    let v = 0;
    for (const f of F) v += (f[k] - m) ** 2;
    const sd = Math.sqrt(v / N) || 1;
    for (const f of F) f[k] = (f[k] - m) / sd;
  }
  const dist = (a: Float32Array, b: Float32Array) => {
    let d = 0;
    for (let k = 0; k < D; k++) d += (a[k] - b[k]) ** 2;
    return Math.sqrt(d);
  };
  const dists: number[] = [];
  for (let i = 0; i < N; i += 2) for (let j = i + 1; j < N; j += 3) dists.push(dist(F[i], F[j]));
  dists.sort((x, y) => x - y);
  const sigma = dists[Math.floor(dists.length / 2)] || 1;
  const S: Float32Array[] = F.map((a) => Float32Array.from(F.map((b) => Math.exp(-(dist(a, b) ** 2) / (2 * sigma * sigma)))));

  // Foote novelty with a checkerboard kernel
  const K = 4;
  const novelty = new Float32Array(N);
  for (let b = K; b < N - K; b++) {
    let s = 0;
    for (let i = 1; i <= K; i++)
      for (let j = 1; j <= K; j++) {
        const w = Math.exp(-((i * i + j * j) / (K * K)));
        s += w * (S[b - i][b - j] + S[b + i - 1][b + j - 1] - S[b - i][b + j - 1] - S[b + i - 1][b - j]);
      }
    novelty[b] = s;
  }
  let maxNov = 0;
  for (let b = 0; b < N; b++) if (novelty[b] > maxNov) maxNov = novelty[b];
  // Local-contrast peak picking: a boundary must stand out from its own neighbourhood, not the whole song.
  const localMean = (b: number) => {
    let s = 0;
    let c = 0;
    for (let i = Math.max(0, b - 8); i <= Math.min(N - 1, b + 8); i++) {
      if (Math.abs(i - b) <= 1) continue;
      s += novelty[i];
      c++;
    }
    return c ? s / c : 0;
  };
  const bounds: number[] = [0];
  for (let b = 2; b < N - 2; b++) {
    const isPeak = novelty[b] >= novelty[b - 1] && novelty[b] >= novelty[b + 1] && novelty[b] > novelty[b - 2] && novelty[b] > novelty[b + 2];
    if (isPeak && novelty[b] > 0.08 * maxNov && novelty[b] > 1.6 * localMean(b)) {
      // snap to the phrase grid (4 bars) when close, else to 2 bars
      const snapped = Math.abs(b - Math.round(b / 4) * 4) <= 1 ? Math.round(b / 4) * 4 : Math.round(b / 2) * 2;
      if (snapped - bounds[bounds.length - 1] >= 4 && snapped < N - 2) bounds.push(snapped);
    }
  }
  bounds.push(N);
  // merge tiny trailing segment
  if (bounds.length > 2 && N - bounds[bounds.length - 2] < 4) bounds.splice(bounds.length - 2, 1);

  const segs: { start: number; end: number; feat: Float32Array; cluster: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const s = bounds[i];
    const e = bounds[i + 1];
    const feat = new Float32Array(16);
    for (let b = s; b < e; b++) for (let k = 0; k < 16; k++) feat[k] += F[b][k] / (e - s);
    segs.push({ start: s, end: e, feat, cluster: i });
  }
  // Complete-linkage agglomerative clustering: merge the closest pair of clusters whose
  // members are all within 0.25 sigma of each other.
  const MERGE = 0.25 * sigma;
  for (;;) {
    let bestD = Infinity;
    let pair: [number, number] | null = null;
    const ids = Array.from(new Set(segs.map((x) => x.cluster)));
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const A = segs.filter((x) => x.cluster === ids[i]);
        const B = segs.filter((x) => x.cluster === ids[j]);
        let maxD = 0;
        for (const a of A) for (const b of B) maxD = Math.max(maxD, dist(a.feat, b.feat));
        if (maxD < MERGE && maxD < bestD) {
          bestD = maxD;
          pair = [ids[i], ids[j]];
        }
      }
    if (!pair) break;
    for (const x of segs) if (x.cluster === pair[1]) x.cluster = pair[0];
  }
  // renumber clusters by first appearance
  const order = new Map<number, number>();
  for (const s of segs) if (!order.has(s.cluster)) order.set(s.cluster, order.size);
  for (const s of segs) s.cluster = order.get(s.cluster)!;

  // cluster statistics
  const stats = new Map<number, { count: number; energy: number; vocal: number; bars: number }>();
  for (const s of segs) {
    const st = stats.get(s.cluster) ?? { count: 0, energy: 0, vocal: 0, bars: 0 };
    st.count++;
    st.bars += s.end - s.start;
    let e = 0;
    let v = 0;
    for (let b = s.start; b < s.end; b++) {
      e += rawEnergy[b];
      v += rawVocal[b];
    }
    st.energy += e / (s.end - s.start);
    st.vocal += v / (s.end - s.start);
    stats.set(s.cluster, st);
  }
  for (const st of stats.values()) {
    st.energy /= st.count;
    st.vocal /= st.count;
  }
  let maxEnergy = 0;
  for (const st of stats.values()) if (st.energy > maxEnergy) maxEnergy = st.energy;
  const score = (c: number) => {
    const st = stats.get(c)!;
    return st.energy * 0.65 + st.vocal * 0.35 + (st.count >= 2 ? 0.15 : 0);
  };
  const clusters = Array.from(stats.keys());
  const chorus = clusters.reduce((a, c) => (score(c) > score(a) ? c : a), clusters[0]);
  const remaining = clusters.filter((c) => c !== chorus);
  const verse = remaining.length ? remaining.reduce((a, c) => (stats.get(c)!.bars > stats.get(a)!.bars ? c : a), remaining[0]) : -1;

  const labels: Section[] = segs.map((s, i) => {
    const st = stats.get(s.cluster)!;
    let label: SectionLabel;
    if (s.cluster === chorus) label = "Chorus";
    else if (i === 0 && (st.energy < 0.75 * maxEnergy || st.count === 1)) label = "Intro";
    else if (i === segs.length - 1 && (st.energy < 0.75 * maxEnergy || st.count === 1)) label = "Outro";
    else if (st.energy < 0.5 * maxEnergy && st.vocal < 0.5) label = "Break";
    else if (s.cluster === verse) label = "Verse";
    else label = "Bridge";
    return { startBar: s.start, endBar: s.end, label, cluster: s.cluster };
  });
  // Merge adjacent segments with the same label and cluster (keeps the map readable)
  const out: Section[] = [];
  for (const s of labels) {
    const last = out[out.length - 1];
    if (last && last.label === s.label && last.cluster === s.cluster && last.endBar === s.startBar) last.endBar = s.endBar;
    else out.push({ ...s });
  }
  return out;
}
