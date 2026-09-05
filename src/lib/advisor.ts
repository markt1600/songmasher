import type { SongAnalysis } from "./audio/analysis";
import { keysCompatible, shiftedKey, suggestedShift } from "./audio/music";
import type { DeckId, DeckState, Project } from "./types";

export type SuggestionAction =
  | { type: "setFoundation"; deckId: DeckId; startBar: number }
  | { type: "setPitch"; deckId: DeckId; semitones: number }
  | { type: "addClip"; deckId: DeckId; srcBar: number; lengthBeats: number }
  | { type: "halveTempo"; deckId: DeckId }
  | { type: "doubleTempo"; deckId: DeckId }
  | { type: "setMasterBpm"; bpm: number };

export interface Suggestion {
  id: string;
  kind: "foundation" | "tempo" | "key" | "hook" | "verse" | "beat" | "info";
  title: string;
  detail: string;
  action?: SuggestionAction;
}

function mean(arr: Float32Array | number[], from = 0, to = arr.length): number {
  let s = 0;
  let c = 0;
  for (let i = from; i < to && i < arr.length; i++) {
    s += arr[i];
    c++;
  }
  return c ? s / c : 0;
}

/** Best window of `len` bars maximising `score`, aligned to `align` bars. */
export function bestWindow(a: SongAnalysis, len: number, score: (b: number) => number, align = 4): { bar: number; value: number } | null {
  if (a.totalBars < len) return null;
  let best = -Infinity;
  let bestBar = 0;
  for (let b = 0; b + len <= a.totalBars; b += align) {
    let s = 0;
    for (let i = 0; i < len; i++) s += score(b + i);
    s /= len;
    if (s > best) {
      best = s;
      bestBar = b;
    }
  }
  return { bar: bestBar, value: best };
}

export function computeSuggestions(decks: Record<DeckId, DeckState>, project: Project): Suggestion[] {
  const out: Suggestion[] = [];
  const A = decks.A.analysis ? decks.A : null;
  const B = decks.B.analysis ? decks.B : null;
  const ready = [A, B].filter((d): d is DeckState => !!d);
  if (ready.length === 0) return out;

  // Foundation: the deck with the more consistent rhythmic content
  if (ready.length === 2 && A && B) {
    const aa = A.analysis!;
    const ba = B.analysis!;
    const beatiness = (a: SongAnalysis) => mean(a.barOnset) * 0.7 + a.bpmConfidence * 0.3;
    const pick = beatiness(aa) >= beatiness(ba) ? A : B;
    const other = pick === A ? B : A;
    const pa = pick.analysis!;
    const beatWin = bestWindow(pa, 8, (b) => pa.barOnset[b] * 0.7 + pa.barEnergy[b] * 0.3 - pa.barVocal[b] * 0.3);
    out.push({
      id: "foundation",
      kind: "foundation",
      title: `Build on ${pick.id} · ${pa.bpm.toFixed(1)} BPM`,
      detail: `${pick.name} has the more consistent groove, so it makes the better foundation. ${other.name} can be sliced into hooks on top.${
        beatWin ? ` A strong instrumental stretch starts at bar ${beatWin.bar + 1}.` : ""
      }`,
      action: { type: "setFoundation", deckId: pick.id, startBar: beatWin?.bar ?? 0 },
    });

    // Tempo relationship
    const ratio = ba.bpm / aa.bpm;
    if (ratio > 1.6 && ratio < 2.4) {
      out.push({
        id: "tempo",
        kind: "tempo",
        title: `Treat ${B.id} as half-time (${(ba.bpm / 2).toFixed(1)} BPM)`,
        detail: `${B.name} was read at ${ba.bpm.toFixed(1)} BPM, almost double ${A.name}. Halving its grid keeps the bars aligned without a huge stretch.`,
        action: { type: "halveTempo", deckId: "B" },
      });
    } else if (ratio < 0.62 && ratio > 0.42) {
      out.push({
        id: "tempo",
        kind: "tempo",
        title: `Treat ${A.id} as half-time (${(aa.bpm / 2).toFixed(1)} BPM)`,
        detail: `${A.name} was read at ${aa.bpm.toFixed(1)} BPM, almost double ${B.name}. Halving its grid keeps the bars aligned without a huge stretch.`,
        action: { type: "halveTempo", deckId: "A" },
      });
    } else if (Math.abs(ratio - 1) > 0.12) {
      const mid = Math.sqrt(aa.bpm * ba.bpm);
      out.push({
        id: "tempo",
        kind: "tempo",
        title: `Meet in the middle at ${mid.toFixed(0)} BPM`,
        detail: `${aa.bpm.toFixed(1)} vs ${ba.bpm.toFixed(1)} BPM is a ${Math.round(Math.abs(ratio - 1) * 100)}% gap. Splitting the difference keeps both stretches subtle.`,
        action: { type: "setMasterBpm", bpm: Math.round(mid) },
      });
    }

    // Key relationship (relative to the foundation deck)
    const foundationDeck = project.foundation ? decks[project.foundation.deckId] : pick;
    const otherDeck = foundationDeck.id === "A" ? B : A;
    const fk = foundationDeck.analysis!.key;
    const okNow = shiftedKey(otherDeck.analysis!.key, otherDeck.semitones);
    const compat = keysCompatible(okNow, fk);
    if (compat === "clash") {
      const shift = suggestedShift(otherDeck.analysis!.key, fk);
      const target = shiftedKey(otherDeck.analysis!.key, shift);
      out.push({
        id: "key",
        kind: "key",
        title: `Shift ${otherDeck.id} by ${shift > 0 ? "+" : ""}${shift} semitones`,
        detail: `${otherDeck.name} is in ${otherDeck.analysis!.key.name} (${otherDeck.analysis!.key.camelot}); ${foundationDeck.name} is in ${fk.name} (${fk.camelot}). Moving to ${target.name} (${target.camelot}) makes them harmonically compatible.`,
        action: { type: "setPitch", deckId: otherDeck.id, semitones: shift },
      });
    } else {
      out.push({
        id: "key",
        kind: "info",
        title: compat === "perfect" ? "Keys match" : "Keys are compatible",
        detail: `${okNow.name} (${okNow.camelot}) sits ${compat === "perfect" ? "right on" : "next to"} ${fk.name} (${fk.camelot}) on the Camelot wheel. No pitch shift needed.`,
      });
    }

    // Hooks from the non-foundation deck
    const oa = otherDeck.analysis!;
    const hook = bestWindow(oa, 8, (b) => oa.barVocal[b] * 0.6 + oa.barEnergy[b] * 0.4);
    if (hook)
      out.push({
        id: "hook",
        kind: "hook",
        title: `Hook: ${otherDeck.id} bars ${hook.bar + 1}–${hook.bar + 8}`,
        detail: `The loudest, most vocal-heavy 8 bars of ${otherDeck.name}. Drop it as a clip and repeat it to build a chorus.`,
        action: { type: "addClip", deckId: otherDeck.id, srcBar: hook.bar, lengthBeats: 32 },
      });
    const verse = bestWindow(oa, 4, (b) => oa.barVocal[b] * 0.8 - oa.barEnergy[b] * 0.5);
    if (verse && (!hook || Math.abs(verse.bar - hook.bar) >= 8))
      out.push({
        id: "verse",
        kind: "verse",
        title: `Sparse vocal: ${otherDeck.id} bars ${verse.bar + 1}–${verse.bar + 4}`,
        detail: `A quieter passage with voice on top. Good for a breakdown before the hook lands.`,
        action: { type: "addClip", deckId: otherDeck.id, srcBar: verse.bar, lengthBeats: 16 },
      });
  } else {
    const d = ready[0];
    const a = d.analysis!;
    out.push({
      id: "single",
      kind: "info",
      title: `${d.name}: ${a.bpm.toFixed(1)} BPM · ${a.key.name}`,
      detail: "Load a second song to get mashup suggestions: which one should carry the beat, how to match keys, and which bars to loop.",
    });
  }
  return out;
}
