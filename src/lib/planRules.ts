/**
 * Musical guard-rails for generated arrangements. Whatever the advisor proposes, these rules make
 * sure the result never stacks two drum tracks or two lead vocals, and that everything lands on
 * phrase boundaries.
 */
import type { SongAnalysis } from "./audio/analysis";
import { CLIP_LANES, type Clip, type DeckId, type DeckState, type Foundation, type StemKey } from "./types";

export interface PlanSegment {
  deck: DeckId;
  srcBar: number;
  lengthBars: number;
  startBar: number;
  lane: number;
  label: string;
  stem: StemKey;
  mode?: "layer" | "swap";
}

export interface PlanInput {
  foundation: { deck: DeckId; startBar: number; stem?: StemKey };
  arrangement: PlanSegment[];
}

export interface SanitizedPlan {
  foundation: Foundation;
  clips: Omit<Clip, "id">[];
  notes: string[];
}

const HAS_DRUMS: StemKey[] = ["full", "instrumental", "drums"];
const HAS_VOCALS: StemKey[] = ["full", "vocals"];

function snap(bar: number, to = 4): number {
  return Math.max(0, Math.round(bar / to) * to);
}

export function sanitizePlan(plan: PlanInput, decks: Record<DeckId, DeckState>): SanitizedPlan | null {
  const notes: string[] = [];
  const fDeck = decks[plan.foundation.deck];
  if (!fDeck.analysis) return null;
  const fa = fDeck.analysis;
  const has = (deck: DeckId, stem: StemKey) => !!decks[deck].buffers[stem];

  const clips: Omit<Clip, "id">[] = [];
  for (const seg of plan.arrangement) {
    const d = decks[seg.deck];
    if (!d.analysis) continue;
    let stem: StemKey = has(seg.deck, seg.stem) ? seg.stem : "full";
    let mode: "layer" | "swap" = seg.mode === "swap" ? "swap" : "layer";
    const wantedVocals = seg.stem === "vocals";
    if (wantedVocals && stem !== "vocals") {
      // No isolated vocal: the full mix can only take over, not sit on top of the beat.
      mode = "swap";
      notes.push(`${d.name} has no vocal stem, so "${seg.label}" swaps in as a full section instead of layering.`);
    }
    if (mode === "layer" && HAS_DRUMS.includes(stem)) {
      if (has(seg.deck, "vocals") && (seg.deck !== plan.foundation.deck || stem === "full")) {
        stem = "vocals";
        notes.push(`"${seg.label}" was switched to the vocal stem so it does not add a second drum track.`);
      } else if (has(seg.deck, "melodic") && stem !== "drums") {
        stem = "melodic";
      } else {
        mode = "swap";
      }
    }
    const lengthBars = Math.max(1, Math.min(64, Math.round(seg.lengthBars)));
    const srcBar = Math.max(0, Math.min(Math.max(0, d.analysis.totalBars - lengthBars), Math.round(seg.srcBar)));
    clips.push({
      deckId: seg.deck,
      stem,
      srcBar,
      lengthBeats: lengthBars * 4,
      startBeat: snap(seg.startBar) * 4,
      lane: Math.max(1, Math.min(CLIP_LANES, Math.round(seg.lane || 1))),
      gain: 1,
      mode,
    });
  }

  // Never two lead vocals at once: later vocal clips move after the earlier one.
  const vocalish = (c: Omit<Clip, "id">) => HAS_VOCALS.includes(c.stem);
  clips.sort((a, b) => a.startBeat - b.startBeat);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!vocalish(c)) continue;
    for (let j = 0; j < i; j++) {
      const p = clips[j];
      if (!vocalish(p)) continue;
      const pEnd = p.startBeat + p.lengthBeats;
      if (c.startBeat < pEnd && c.startBeat + c.lengthBeats > p.startBeat) {
        c.startBeat = Math.ceil(pEnd / 16) * 16;
        notes.push("Two vocal parts overlapped; one was moved later so they take turns.");
      }
    }
  }

  // Foundation stem: instrumental whenever a vocal is layered on top and we have it.
  let fStem: StemKey = plan.foundation.stem && has(plan.foundation.deck, plan.foundation.stem) ? plan.foundation.stem : "full";
  const layeredVocals = clips.some((c) => c.mode === "layer" && vocalish(c) && c.deckId !== plan.foundation.deck);
  if (layeredVocals && HAS_VOCALS.includes(fStem)) {
    if (has(plan.foundation.deck, "instrumental")) {
      fStem = "instrumental";
      notes.push("The foundation uses its instrumental stem so the other song's vocal is not fighting its own.");
    } else {
      notes.push(`Run AI stems on ${fDeck.name} to get an instrumental foundation; until then its vocal will show through under the layered hook.`);
    }
  }

  const startBar = Math.max(0, Math.min(fa.totalBars - 1, snap(plan.foundation.startBar)));
  return { foundation: { deckId: plan.foundation.deck, stem: fStem, startBar, gain: 1 }, clips, notes };
}

/** Top non-overlapping windows of `len` bars ranked by `score`, aligned to 4-bar phrases. */
export function topWindows(a: SongAnalysis, len: number, score: (b: number) => number, k = 3): { bar: number; value: number }[] {
  const cands: { bar: number; value: number }[] = [];
  for (let b = 0; b + len <= a.totalBars; b += 4) {
    let s = 0;
    for (let i = 0; i < len; i++) s += score(b + i);
    cands.push({ bar: b, value: s / len });
  }
  cands.sort((x, y) => y.value - x.value);
  const out: { bar: number; value: number }[] = [];
  for (const c of cands) {
    if (out.some((o) => Math.abs(o.bar - c.bar) < len)) continue;
    out.push(c);
    if (out.length >= k) break;
  }
  return out;
}

/** Compact structural description of a song for the advisor. */
export function describeSong(a: SongAnalysis) {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const phrases: { bar: number; energy: number; beat: number; vocal: number }[] = [];
  for (let b = 0; b < a.totalBars; b += 4) {
    let e = 0;
    let o = 0;
    let v = 0;
    let n = 0;
    for (let i = b; i < Math.min(a.totalBars, b + 4); i++) {
      e += a.barEnergy[i];
      o += a.barOnset[i];
      v += a.barVocal[i];
      n++;
    }
    phrases.push({ bar: b, energy: r2(e / n), beat: r2(o / n), vocal: r2(v / n) });
  }
  return {
    phrases,
    hooks: topWindows(a, 8, (b) => a.barVocal[b] * 0.6 + a.barEnergy[b] * 0.4).map((w) => ({ bar: w.bar, score: r2(w.value) })),
    quietVocals: topWindows(a, 8, (b) => a.barVocal[b] * 0.8 - a.barEnergy[b] * 0.5).map((w) => ({ bar: w.bar, score: r2(w.value) })),
    instrumentalGrooves: topWindows(a, 8, (b) => a.barOnset[b] * 0.7 + a.barEnergy[b] * 0.3 - a.barVocal[b] * 0.6).map((w) => ({ bar: w.bar, score: r2(w.value) })),
  };
}
