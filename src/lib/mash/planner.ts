/**
 * Computational mashup planner. Searches foundation start bars, vocal segments, pitch shifts and
 * arrangement templates, scoring each candidate on harmonic fit (bar-by-bar chroma agreement),
 * phrase completeness, energy shape and tempo stretch. Deterministic and fast (milliseconds).
 */
import type { SongAnalysis } from "../audio/analysis";
import type { VocalProfile } from "../audio/vocal";
import type { DeckId, StemKey } from "../types";

export interface PlannerSong {
  deck: DeckId;
  name: string;
  analysis: SongAnalysis;
  vocal?: VocalProfile | null;
  stems: StemKey[];
}

export interface PlanConstraints {
  /** which deck carries the beat; undefined = let the planner decide */
  foundation?: DeckId;
  /** total arrangement length in bars */
  lengthBars?: number;
  /** bar (0-based, multiple of 4) where the first vocal enters */
  vocalEntryBar?: number;
  hookBars?: 4 | 8 | 16;
  energy?: "higher" | "lower";
  /** max |semitones| allowed for the pitch shift */
  maxShift?: number;
  template?: TemplateId;
}

export type TemplateId = "classic" | "vocal-first" | "call-response" | "extended";
type SlotKind = "hook" | "verse" | "swap";
interface Slot {
  kind: SlotKind;
  startBar: number; // timeline
  bars: number;
}

export interface PlannedClip {
  deck: DeckId;
  stem: StemKey;
  srcBar: number; // may be fractional (pickup)
  lengthBeats: number;
  startBeat: number; // timeline beats
  lane: number;
  mode: "layer" | "swap";
  label: string;
  fit: number; // 0..1 harmonic fit of this clip
  /** bars the part occupies on the timeline grid (the next part starts after this) */
  slotBars: number;
  fadeIn: number; // beats
  fadeOut: number;
}

export interface PlanCandidate {
  id: string;
  template: TemplateId;
  foundation: { deck: DeckId; startBar: number; stem: StemKey };
  vocalDeck: DeckId;
  masterBpm: number;
  semitones: number; // applied to the vocal deck
  lengthBars: number;
  clips: PlannedClip[];
  score: number;
  breakdown: { harmony: number; phrases: number; energy: number; stretch: number };
  description: string;
}

// ---------------------------------------------------------------------------
// Harmonic scoring
// ---------------------------------------------------------------------------

function chromaAt(arr: ArrayLike<number> | undefined, bar: number): Float32Array | null {
  if (!arr || bar < 0 || (bar + 1) * 12 > arr.length) return null;
  const out = new Float32Array(12);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    out[i] = arr[bar * 12 + i];
    sum += out[i];
  }
  if (sum <= 1e-6) return null;
  return out;
}

/** Fit of a vocal chroma (rolled up by `shift` semitones) against a foundation chroma: agreement minus semitone clashes. */
export function harmonicFit(vocal: Float32Array, found: Float32Array, shift: number): number {
  let dot = 0;
  let nv = 0;
  let nf = 0;
  let clash = 0;
  for (let i = 0; i < 12; i++) {
    const v = vocal[(((i - shift) % 12) + 12) % 12];
    const f = found[i];
    dot += v * f;
    nv += v * v;
    nf += f * f;
    clash += v * (found[(i + 1) % 12] + found[(i + 11) % 12]);
  }
  const cos = nv > 0 && nf > 0 ? dot / Math.sqrt(nv * nf) : 0;
  return Math.max(0, Math.min(1, cos - 0.6 * clash));
}

// ---------------------------------------------------------------------------
// Candidate vocal segments
// ---------------------------------------------------------------------------

export interface VocalSegment {
  srcBar: number; // fractional when there is a pickup
  /** whole bars occupied on the grid (anchor bar to the bar line after the last phrase) */
  bars: number;
  pickupBeats: number;
  /** exact audio length in beats from srcBar: runs to the end of the last phrase, not a bar line */
  audioBeats: number;
  kind: "hook" | "verse";
  energy: number;
  phraseFit: number; // 1 = starts and ends on phrase boundaries
  label: string;
}

function vocalEnergyOf(song: PlannerSong, bar: number): number {
  if (song.vocal) return song.vocal.barVocal[bar] ?? 0;
  return song.analysis.barVocal[bar] ?? 0;
}

export function vocalSegments(song: PlannerSong, bars: number): VocalSegment[] {
  const a = song.analysis;
  const segs: VocalSegment[] = [];
  const sectionOf = (bar: number) => a.sections?.find((s) => bar >= s.startBar && bar < s.endBar);
  const kindOf = (bar: number, energy: number): "hook" | "verse" => {
    const sec = sectionOf(bar);
    if (sec?.label === "Chorus") return "hook";
    // The loudest singing is hook material whatever the section map says; clearly quiet singing is not.
    if (energy >= 0.75) return "hook";
    if (energy < 0.5) return "verse";
    if (sec?.label === "Verse" || sec?.label === "Bridge" || sec?.label === "Pre-chorus") return "verse";
    return energy > 0.6 ? "hook" : "verse";
  };
  const meanVocal = (b0: number, n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += vocalEnergyOf(song, b0 + i);
    return n > 0 ? s / n : 0;
  };
  const phrases = song.vocal?.phrases ?? [];
  if (phrases.length > 0) {
    // Phrase groups: runs of phrases separated by less than a bar of silence. A clip starts at a phrase
    // start (with its pickup) and ends where a phrase ends, never at an arbitrary bar line.
    const sorted = [...phrases].sort((x, y) => x.startBeat - y.startBeat);
    const groups: (typeof sorted)[] = [];
    for (const ph of sorted) {
      const g = groups[groups.length - 1];
      if (g && ph.startBeat - g[g.length - 1].endBeat <= 4) g.push(ph);
      else groups.push([ph]);
    }
    const seen = new Set<string>();
    for (const g of groups) {
      for (let i = 0; i < g.length; i++) {
        const p = g[i].startBeat;
        const nextBar = Math.ceil(p / 4);
        const pickup = nextBar * 4 - p;
        const isPickup = pickup > 0 && pickup <= 1.5;
        const anchorBar = isPickup ? nextBar : Math.floor(p / 4);
        const pickupBeats = isPickup ? Math.ceil(pickup * 4) / 4 : 0;
        if (anchorBar < 0) continue;
        // Candidate ends: the end of any later line in the group (clean), or a breath inside a long
        // line (acceptable). Prefer the span closest to the requested length, clean ends first.
        type End = { endBeat: number; spanBars: number; diff: number; clean: boolean };
        const pick: { best: End | null } = { best: null };
        const consider = (endBeat: number, clean: boolean) => {
          const spanBars = Math.ceil(endBeat / 4) - anchorBar;
          if (spanBars < 2 || anchorBar + spanBars > a.totalBars) return;
          const diff = Math.abs(spanBars - bars);
          if (diff > 2) return;
          const b = pick.best;
          const better = !b || (clean && !b.clean && diff <= b.diff + 1) || (clean === b.clean && (diff < b.diff || (diff === b.diff && spanBars > b.spanBars)));
          if (better) pick.best = { endBeat, spanBars, diff, clean };
        };
        for (let j = i; j < g.length; j++) consider(g[j].endBeat, true);
        if (!pick.best || !pick.best.clean) {
          const groupEnd = g[g.length - 1].endBeat;
          for (const br of song.vocal?.breaths ?? []) if (br > p + 4 && br < groupEnd) consider(br, false);
        }
        const best = pick.best;
        if (!best) continue;
        const key = `${anchorBar}:${best.spanBars}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const energy = meanVocal(anchorBar, best.spanBars);
        if (energy < 0.12) continue;
        const srcStartBeat = anchorBar * 4 - pickupBeats;
        const slotBars = best.spanBars % 2 === 1 ? best.spanBars + 1 : best.spanBars; // parts land on even bars
        // Tail after the last word: up to 0.6 beat of room for the note to ring, but never into the next line.
        const following = sorted.find((q) => q.startBeat > best.endBeat + 0.1);
        const gap = following ? following.startBeat - best.endBeat : 8;
        const tail = best.clean ? Math.max(0.25, Math.min(0.6, gap * 0.5)) : 0.1;
        segs.push({
          srcBar: anchorBar - pickupBeats / 4,
          bars: slotBars,
          pickupBeats,
          audioBeats: best.endBeat - srcStartBeat + tail,
          kind: kindOf(anchorBar, energy),
          energy,
          phraseFit: (best.clean ? 1 : 0.7) - best.diff * 0.1,
          label: `${song.name} bars ${anchorBar + 1}–${anchorBar + best.spanBars}`,
        });
      }
    }
  }
  // Grid candidates (every 4 bars) as a fallback with a lower phrase score, so a sparse phrase list never starves the search.
  const taken = new Set(segs.map((s) => Math.round(s.srcBar + s.pickupBeats / 4)));
  for (let b = 0; b + bars <= a.totalBars; b += 4) {
    if (taken.has(b)) continue;
    const energy = meanVocal(b, bars);
    if (energy < 0.2) continue;
    let phraseFit = 0.45;
    let audioBeats = bars * 4;
    if (phrases.length > 0) {
      const startBeat = b * 4;
      const endBeat = (b + bars) * 4;
      // When we know where the lines are, a bar-line clip may never start or end inside one.
      const cutsIn = phrases.some((q) => q.startBeat < startBeat - 0.5 && q.endBeat > startBeat + 0.5);
      if (cutsIn) continue;
      const cutsOut = phrases.find((q) => q.startBeat < endBeat - 0.5 && q.endBeat > endBeat + 0.5);
      phraseFit = cutsOut ? 0.35 : 0.5;
      if (cutsOut) {
        const inside = phrases.filter((q) => q.endBeat <= endBeat && q.endBeat > startBeat);
        if (inside.length) audioBeats = Math.max(4, inside[inside.length - 1].endBeat - startBeat + 0.5);
        else {
          // one long line fills the window: stop at the last breath inside it, or skip the window
          const br = (song.vocal?.breaths ?? []).filter((x) => x > startBeat + 4 && x <= endBeat);
          if (!br.length) continue;
          audioBeats = br[br.length - 1] - startBeat + 0.1;
          phraseFit = 0.3;
        }
      }
    }
    segs.push({ srcBar: b, bars, pickupBeats: 0, audioBeats, kind: kindOf(b, energy), energy, phraseFit, label: `${song.name} bars ${b + 1}–${b + bars}` });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function template(id: TemplateId, c: PlanConstraints, availableBars: number): { slots: Slot[]; length: number; hook: number } {
  // Short songs get shorter hooks and a shorter entry so the arrangement still fits.
  const hook = c.hookBars ?? (availableBars < 40 ? 4 : 8);
  const entry = c.vocalEntryBar ?? (id === "vocal-first" ? 0 : availableBars < 40 ? 4 : 8);
  const slots: Slot[] = [];
  let t = entry;
  const push = (kind: SlotKind, bars: number) => {
    slots.push({ kind, startBar: t, bars });
    t += bars;
  };
  switch (id) {
    case "classic":
      push("hook", hook);
      push("hook", hook);
      push("verse", hook);
      push("hook", hook);
      break;
    case "vocal-first":
      push("hook", hook);
      push("verse", hook);
      push("hook", hook);
      push("hook", hook);
      break;
    case "call-response":
      push("hook", hook);
      push("swap", hook);
      push("hook", hook);
      push("swap", hook);
      push("hook", hook);
      break;
    case "extended":
      push("verse", hook);
      push("hook", hook);
      push("hook", hook);
      push("verse", hook);
      push("hook", hook);
      push("hook", hook);
      break;
  }
  let length = c.lengthBars ?? t + 4;
  if (length > availableBars) length = Math.max(8, Math.floor(availableBars / 4) * 4);
  return { slots: slots.filter((s) => s.startBar + s.bars <= length), length, hook };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function pickFoundation(a: PlannerSong, b: PlannerSong, c: PlanConstraints): [PlannerSong, PlannerSong] {
  if (c.foundation) return c.foundation === a.deck ? [a, b] : [b, a];
  // The song with an isolated vocal is the vocal source: that is why it was separated.
  if (a.vocal && !b.vocal) return [b, a];
  if (b.vocal && !a.vocal) return [a, b];
  const beatiness = (s: PlannerSong) => {
    let o = 0;
    let v = 0;
    for (let i = 0; i < s.analysis.totalBars; i++) {
      o += s.analysis.barOnset[i];
      v += s.vocal ? s.vocal.barVocal[i] : s.analysis.barVocal[i];
    }
    const n = s.analysis.totalBars || 1;
    // steady beat, confident tempo, and not vocal-heavy
    return (o / n) * 0.6 + s.analysis.bpmConfidence * 0.2 - (v / n) * 0.4;
  };
  return beatiness(a) >= beatiness(b) ? [a, b] : [b, a];
}

export function planMashup(songs: [PlannerSong, PlannerSong], constraints: PlanConstraints = {}): PlanCandidate[] {
  const [F, V] = pickFoundation(songs[0], songs[1], constraints);
  const fa = F.analysis;
  const va = V.analysis;
  const fStem: StemKey = F.stems.includes("instrumental") ? "instrumental" : "full";
  const vStem: StemKey = V.stems.includes("vocals") ? "vocals" : "full";
  const layered = vStem === "vocals";
  const vChroma = V.vocal?.barChroma ?? va.barChroma;
  const fChroma = fa.barChroma;

  const ratio = va.bpm / fa.bpm;
  const octave = ratio > 1.6 ? 0.5 : ratio < 0.62 ? 2 : 1;
  const vBpmEff = va.bpm * octave;
  let masterBpm = fa.bpm;
  const gap = Math.abs(Math.log(vBpmEff / fa.bpm));
  if (gap > 0.08) masterBpm = Math.sqrt(fa.bpm * vBpmEff);
  const stretchPenalty = Math.min(1, Math.abs(Math.log(vBpmEff / masterBpm)) / 0.15 + Math.abs(Math.log(fa.bpm / masterBpm)) / 0.15);

  const maxShift = constraints.maxShift ?? 3;
  const templates: TemplateId[] = constraints.template ? [constraints.template] : layered ? ["classic", "vocal-first", "extended", "call-response"] : ["call-response", "classic"];
  const results: PlanCandidate[] = [];
  const segsByBars = new Map<number, VocalSegment[]>();
  const segsFor = (bars: number) => {
    if (!segsByBars.has(bars)) segsByBars.set(bars, vocalSegments(V, bars));
    return segsByBars.get(bars)!;
  };

  // Foundation start candidates: any bar with a real groove (chord cycles rarely align on 4-bar
  // boundaries between two songs); phrase-aligned starts get a small bonus in scoring.
  const fStarts: number[] = [];
  for (let b = 0; b + 8 <= fa.totalBars; b += 1) {
    let onset = 0;
    let voc = 0;
    for (let i = 0; i < 8; i++) {
      onset += fa.barOnset[b + i];
      voc += fa.barVocal[b + i];
    }
    if (onset / 8 < 0.25) continue;
    if (fStem === "full" && voc / 8 > 0.7) continue;
    fStarts.push(b);
  }
  if (fStarts.length === 0) fStarts.push(0);

  for (const tid of templates) {
    const { slots, length: tplLength, hook } = template(tid, constraints, fa.totalBars);
    if (slots.length === 0) continue;
    for (let shift = -maxShift; shift <= maxShift; shift++) {
      for (const fStart of fStarts) {
        if (fStart + Math.min(tplLength, 12) > fa.totalBars) continue;
        const clips: PlannedClip[] = [];
        let harmony = 0;
        let phrases = 0;
        let energyFit = 0;
        let slotTotal = 0;
        let n = 0;
        const used = new Set<number>();
        let ok = true;
        // Parts are placed one after another; each part's length comes from the phrases it contains,
        // so the timeline grows or shrinks with the material instead of chopping lines to fit a slot.
        let cursor = slots[0].startBar;
        let placed = 0;
        for (const slot of slots) {
          const slotStart = cursor;
          if (fStart + slotStart + 2 > fa.totalBars) break;
          placed++;
          if (slot.kind === "swap") {
            const all = segsFor(hook);
            const cands = all.filter((s) => s.kind === "hook" || s.energy > 0.5);
            const pick = [...(cands.length ? cands : all)].sort((x, y) => y.energy - x.energy)[0];
            if (!pick) {
              ok = false;
              break;
            }
            clips.push({ deck: V.deck, stem: "full", srcBar: Math.floor(pick.srcBar), lengthBeats: pick.bars * 4, startBeat: slotStart * 4, lane: 1, mode: "swap", label: "Drop", fit: 1, slotBars: pick.bars, fadeIn: 0, fadeOut: 0.5 });
            cursor += pick.bars;
            continue;
          }
          let best: { seg: VocalSegment; fit: number; score: number } | null = null;
          for (const seg of segsFor(hook)) {
            if (fStart + slotStart + seg.bars > fa.totalBars) continue;
            let fit = 0;
            let w = 0;
            for (let i = 0; i < seg.bars; i++) {
              const vb = Math.floor(seg.srcBar + seg.pickupBeats / 4 + 1e-6) + i;
              const fb = fStart + slotStart + i;
              const vc = chromaAt(vChroma, vb);
              const fc = chromaAt(fChroma, fb);
              const weight = 0.3 + vocalEnergyOf(V, vb);
              if (vc && fc) fit += harmonicFit(vc, fc, shift) * weight;
              w += weight;
            }
            fit = w > 0 ? fit / w : 0;
            // Hooks must be hooks: the chorus (or the loudest singing) in hook slots, quieter verses in breakdowns.
            const kindBonus = seg.kind === slot.kind ? 0.25 : seg.kind === "hook" && slot.kind === "verse" ? -0.1 : 0;
            const reuse = used.has(seg.srcBar) ? (slot.kind === "hook" ? 0.05 : -0.1) : 0;
            const energyTarget = slot.kind === "hook" ? 0.9 : 0.45;
            const eFit = 1 - Math.min(1, Math.abs(seg.energy - energyTarget) / 0.6);
            // Cutting into a line is the most audible mistake a mashup can make: phrases weigh heavily.
            const score = fit * 0.4 + seg.phraseFit * 0.3 + eFit * 0.2 + kindBonus + reuse;
            if (!best || score > best.score) best = { seg, fit, score };
          }
          if (!best) {
            ok = false;
            break;
          }
          const seg = best.seg;
          const repeated = clips.some((c) => c.srcBar === seg.srcBar && c.label.startsWith("Hook"));
          used.add(seg.srcBar);
          harmony += best.fit;
          phrases += seg.phraseFit;
          energyFit += 1 - Math.min(1, Math.abs(seg.energy - (slot.kind === "hook" ? 0.85 : 0.45)) / 0.7);
          slotTotal += best.score;
          n++;
          const label = slot.kind === "hook" ? (repeated ? "Hook again" : "Hook") : "Breakdown";
          // A pickup cannot start before the timeline: trim it when the part sits at bar 0.
          let startBeat = slotStart * 4 - seg.pickupBeats;
          let srcBar = seg.srcBar;
          let lengthBeats = layered ? seg.audioBeats : seg.bars * 4 + seg.pickupBeats;
          if (startBeat < 0) {
            srcBar += -startBeat / 4;
            lengthBeats += startBeat;
            startBeat = 0;
          }
          clips.push({
            deck: V.deck,
            stem: layered ? "vocals" : "full",
            srcBar,
            lengthBeats,
            startBeat,
            lane: 1,
            mode: layered ? "layer" : "swap",
            label,
            fit: best.fit,
            slotBars: seg.bars,
            fadeIn: seg.pickupBeats > 0 ? 0.1 : 0.05,
            fadeOut: layered ? Math.max(0.25, seg.audioBeats - Math.floor(seg.audioBeats)) : 0.25,
          });
          cursor += seg.bars;
        }
        if (!ok || n === 0) continue;
        const length = Math.min(fa.totalBars - fStart, Math.max(8, Math.ceil((cursor + 4) / 4) * 4));
        harmony /= n;
        phrases /= n;
        energyFit /= n;
        // Rank candidates by the same blended slot score used to choose their parts, plus global terms.
        const missing = slots.length - placed;
        const score = (slotTotal / n) * 0.85 + (1 - stretchPenalty) * 0.1 - Math.abs(shift) * 0.015 + (fStart % 4 === 0 ? 0.02 : 0) + (harmony < 0.45 ? -0.2 : 0) - missing * 0.15;
        results.push({
          id: `${tid}:${fStart}:${shift}`,
          template: tid,
          foundation: { deck: F.deck, startBar: fStart, stem: fStem },
          vocalDeck: V.deck,
          masterBpm: Math.round(masterBpm * 10) / 10,
          semitones: shift,
          lengthBars: length,
          clips,
          score,
          breakdown: { harmony, phrases, energy: energyFit, stretch: 1 - stretchPenalty },
          description: describeCandidate(tid, F, V, fStart, shift, harmony),
        });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  const out: PlanCandidate[] = [];
  for (const r of results) {
    const dup = out.some((o) => o.template === r.template && o.semitones === r.semitones && o.clips.length === r.clips.length && o.clips.every((c, i) => r.clips[i].srcBar === c.srcBar) && Math.abs(o.score - r.score) < 0.02);
    if (!dup) out.push(r);
    if (out.length >= 12) break;
  }
  return out;
}

function describeCandidate(tid: TemplateId, F: PlannerSong, V: PlannerSong, fStart: number, shift: number, harmony: number): string {
  const tpl: Record<TemplateId, string> = {
    classic: "beat alone, then the hook twice, a breakdown, and the hook again",
    "vocal-first": "vocal from the top, a breakdown, then the hook twice",
    "call-response": "sections alternate between the two songs",
    extended: "a longer build: breakdown, hook twice, breakdown, hook twice",
  };
  const shiftTxt = shift === 0 ? "no pitch shift" : `${V.name} shifted ${shift > 0 ? "+" : ""}${shift} st`;
  return `${F.name} from bar ${fStart + 1} under ${V.name}: ${tpl[tid]}; ${shiftTxt}; harmonic fit ${Math.round(harmony * 100)}%.`;
}
