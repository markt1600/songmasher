import type { SongAnalysis } from "./audio/analysis";

export type DeckId = "A" | "B";
export type StemKey = "full" | "vocals" | "instrumental" | "drums" | "melodic";
export type StemSource = "none" | "quick" | "ai";

export const STEM_LABELS: Record<StemKey, string> = {
  full: "Full mix",
  vocals: "Vocals",
  instrumental: "Instrumental",
  drums: "Drums",
  melodic: "Bass + music",
};

export interface DeckState {
  id: DeckId;
  /** library id (content hash) of the loaded song */
  songId: string | null;
  name: string;
  file: File | null;
  status: "empty" | "decoding" | "analyzing" | "ready" | "error";
  progress: number; // 0..1
  progressLabel: string;
  error?: string;
  sampleRate: number;
  duration: number;
  buffers: Partial<Record<StemKey, AudioBuffer>>;
  stemSource: StemSource;
  stemBusy: boolean;
  stemProgress: string;
  analysis: SongAnalysis | null;
  activeStem: StemKey;
  selection: { startBar: number; lengthBeats: number } | null;
  semitones: number;
}

export interface Clip {
  id: string;
  deckId: DeckId;
  stem: StemKey;
  /** bar index in the source song (on its own beat grid) */
  srcBar: number;
  lengthBeats: number;
  /** position on the mash timeline, in master beats */
  startBeat: number;
  lane: number; // 1..CLIP_LANES
  gain: number; // 0..1.5
  /** layer = play over the foundation; swap = the foundation is muted while this clip plays */
  mode?: "layer" | "swap";
}

export interface Foundation {
  deckId: DeckId;
  stem: StemKey;
  startBar: number;
  gain: number;
}

export interface Project {
  masterBpm: number;
  foundation: Foundation | null;
  clips: Clip[];
  lengthBars: number;
  loop: boolean;
}

export const CLIP_LANES = 3;

export const DECK_COLORS: Record<DeckId, { main: string; soft: string; glow: string }> = {
  A: { main: "#22d3ee", soft: "rgba(34,211,238,0.18)", glow: "rgba(34,211,238,0.55)" },
  B: { main: "#f472b6", soft: "rgba(244,114,182,0.18)", glow: "rgba(244,114,182,0.55)" },
};
