import { analyzeSong } from "../src/lib/audio/analysis";
const sr = 44100;
function synth(bpm: number, offset: number, seconds: number, soft: boolean, chords: boolean) {
  const n = Math.floor(seconds * sr); const x = new Float32Array(n); const beat = 60 / bpm;
  const roots = [57, 53, 60, 55];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bar = chords ? Math.max(0, Math.floor((t - offset) / (4 * beat))) % 4 : 0;
    const root = roots[bar];
    let v = 0;
    for (const iv of [0, 3, 7, 12]) v += 0.08 * Math.sin(2 * Math.PI * 440 * Math.pow(2, (root + iv - 69) / 12) * t);
    x[i] = v;
  }
  let k = 0;
  for (let t = offset; t < seconds; t += beat, k++) {
    const s0 = Math.floor(t * sr); const isDown = k % 4 === 0; const isSnare = k % 2 === 1;
    const attack = soft ? sr * 0.02 : 1;
    for (let i = 0; i < sr * 0.15 && s0 + i < n; i++) {
      const env = Math.exp(-i / (sr * 0.04)) * Math.min(1, i / attack);
      x[s0 + i] += Math.sin(2 * Math.PI * 55 * (i / sr)) * env * (isDown ? 0.9 : 0.6) + (isSnare ? (Math.random() * 2 - 1) * env * 0.4 : 0);
    }
  }
  return x;
}
for (const [bpm, offset, soft, chords] of [[128, 0.37, false, false], [128, 0.37, true, true], [94.5, 1.1, false, true], [172, 0.2, true, true], [76, 0.5, false, true]] as [number, number, boolean, boolean][]) {
  const a = analyzeSong(synth(bpm, offset, 45, soft, chords), sr);
  const exp = offset % (4 * 60 / bpm);
  console.log(`bpm ${bpm} -> ${a.bpm.toFixed(2)} conf ${a.bpmConfidence.toFixed(2)} | downbeat ${a.firstDownbeat.toFixed(3)} expected ${exp.toFixed(3)} (err ${((a.firstDownbeat - exp) * 1000).toFixed(0)}ms, beat=${(60 / bpm).toFixed(3)}) | key ${a.key.name} soft=${soft} chords=${chords}`);
}
