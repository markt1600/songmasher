/**
 * How well two songs would mash together, judged from what the library already knows about them:
 * key (Camelot wheel, allowing the planner's small pitch shifts) and tempo (allowing half/double time
 * and a modest time-stretch). Used to rank the library against the song on a deck.
 */
import { keysCompatible, suggestedShift, type KeyInfo } from "./audio/music";

export type MatchGrade = "great" | "good" | "fair" | "poor";

export interface MatchInfo {
  /** 0..1 */
  score: number;
  grade: MatchGrade;
  key: "perfect" | "good" | "clash";
  /** semitones the candidate would be shifted to sit with the reference (0 when none needed) */
  shift: number;
  /** effective tempo multiplier after the best octave choice (1 = same speed) */
  tempoRatio: number;
  /** 1 = same tempo, 2 = candidate is half-time, 0.5 = double-time */
  octave: 0.5 | 1 | 2;
  /** percent time-stretch needed */
  stretchPct: number;
  summary: string;
}

const GRADE_MIN: Record<MatchGrade, number> = { great: 0.85, good: 0.65, fair: 0.45, poor: 0 };

export function matchSongs(reference: { bpm: number; key: KeyInfo }, candidate: { bpm: number; key: KeyInfo }): MatchInfo {
  // --- key
  const compat = keysCompatible(reference.key, candidate.key);
  const shift = compat === "clash" ? suggestedShift(candidate.key, reference.key) : 0;
  const keyScore = compat === "perfect" ? 1 : compat === "good" ? 0.85 : Math.abs(shift) <= 1 ? 0.7 : Math.abs(shift) <= 2 ? 0.55 : Math.abs(shift) <= 3 ? 0.4 : 0.15;
  // --- tempo: try same, half and double time, keep the one needing the least stretch
  let octave: 0.5 | 1 | 2 = 1;
  let ratio = candidate.bpm / reference.bpm;
  for (const o of [0.5, 2] as const) {
    const r = (candidate.bpm * o) / reference.bpm;
    if (Math.abs(Math.log(r)) < Math.abs(Math.log(ratio))) {
      ratio = r;
      octave = o;
    }
  }
  const stretchPct = Math.abs(ratio - 1) * 100;
  const tempoScore = Math.max(0, 1 - stretchPct / 20);
  const score = keyScore * 0.55 + tempoScore * 0.45;
  const grade: MatchGrade = score >= GRADE_MIN.great ? "great" : score >= GRADE_MIN.good ? "good" : score >= GRADE_MIN.fair ? "fair" : "poor";

  const keyText =
    compat === "perfect"
      ? reference.key.camelot === candidate.key.camelot
        ? "same key"
        : `relative key (${candidate.key.camelot})`
      : compat === "good"
        ? `neighbouring key (${candidate.key.camelot})`
        : `${shift > 0 ? "+" : ""}${shift} st to fit the key`;
  const tempoText = `${octave === 2 ? "half-time, " : octave === 0.5 ? "double-time, " : ""}${stretchPct < 0.5 ? (octave === 1 ? "same tempo" : "no stretch") : `${stretchPct.toFixed(0)}% stretch`}`;
  return { score, grade, key: compat, shift, tempoRatio: ratio, octave, stretchPct, summary: `${keyText} · ${tempoText}` };
}

export const GRADE_LABEL: Record<MatchGrade, string> = { great: "Great match", good: "Good match", fair: "Workable", poor: "Poor match" };
export const GRADE_COLOR: Record<MatchGrade, string> = { great: "#30d158", good: "#64d2ff", fair: "#ffd60a", poor: "#8e8e93" };
