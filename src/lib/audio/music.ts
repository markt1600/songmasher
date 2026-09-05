export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export type Mode = "major" | "minor";

export interface KeyInfo {
  root: number; // 0 = C
  mode: Mode;
  name: string; // e.g. "A minor"
  camelot: string; // e.g. "8A"
  confidence: number; // 0..1
}

// Camelot wheel: number for major keys starting at B major = 1B; minor = relative minor.
const CAMELOT_MAJOR: Record<number, number> = { 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7, 0: 8, 7: 9, 2: 10, 9: 11, 4: 12 };

export function camelotOf(root: number, mode: Mode): string {
  if (mode === "major") return `${CAMELOT_MAJOR[root]}B`;
  // relative major is 3 semitones up
  return `${CAMELOT_MAJOR[(root + 3) % 12]}A`;
}

export function keyName(root: number, mode: Mode): string {
  return `${NOTE_NAMES[root]} ${mode}`;
}

/**
 * Semitone shift (in -6..6) that moves key `from` so it is compatible with key `to`.
 * Compatible = same Camelot number (same or relative key), or +-1 on the wheel.
 * Returns 0 when already compatible, otherwise the smallest shift that lands on the same number.
 */
export function suggestedShift(from: KeyInfo, to: KeyInfo): number {
  const target = camelotNumber(to.root, to.mode);
  let best = 0;
  let bestAbs = 99;
  for (let s = -6; s <= 6; s++) {
    const n = camelotNumber((from.root + s + 12) % 12, from.mode);
    const dist = Math.min((n - target + 12) % 12, (target - n + 12) % 12);
    if (dist === 0 && Math.abs(s) < bestAbs) {
      best = s;
      bestAbs = Math.abs(s);
    }
  }
  return best;
}

export function camelotNumber(root: number, mode: Mode): number {
  return mode === "major" ? CAMELOT_MAJOR[root] : CAMELOT_MAJOR[(root + 3) % 12];
}

export function keysCompatible(a: KeyInfo, b: KeyInfo): "perfect" | "good" | "clash" {
  const na = camelotNumber(a.root, a.mode);
  const nb = camelotNumber(b.root, b.mode);
  const dist = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (dist === 0) return "perfect";
  if (dist === 1) return "good";
  return "clash";
}

export function shiftedKey(k: KeyInfo, semitones: number): KeyInfo {
  const root = ((k.root + semitones) % 12 + 12) % 12;
  return { ...k, root, name: keyName(root, k.mode), camelot: camelotOf(root, k.mode) };
}
