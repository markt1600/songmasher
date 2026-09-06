"use client";
import { create } from "zustand";
import { barToTime, type SongAnalysis } from "./audio/analysis";
import { vocalProfileMatches } from "./audio/vocal";
import { audioBufferToChannels, channelsToAudioBuffer } from "./audio/wav";
import { firstOnsetOffset } from "./audio/align";
import { decodeArrayBuffer, decodeFile, getAudioContext, toMono } from "./engine/context";
import { Engine, type EngineDecks } from "./engine/engine";
import { runAnalysis, runQuickStems, runSections, runVocalProfile } from "./workers";
import { CLIP_LANES, emptyAutomation, type AutomationPoint, type Clip, type CuePoint, type DeckId, type DeckState, type DemucsVariant, type Foundation, type LoopRegion, type Project, type StemKey, type TransportOptions } from "./types";
import { playWindow } from "./engine/engine";
import { computeSuggestions, type Suggestion, type SuggestionAction } from "./advisor";
import { describeSong, sanitizePlan } from "./planRules";
import { planMashup, type PlanCandidate, type PlanConstraints, type PlannerSong } from "./mash/planner";
import * as lib from "./library";
import type { LibraryMix, LibraryProject, LibrarySong } from "./library";
import type { Section } from "./audio/sections";
import * as cloud from "./cloud";
import { AccessCodeError } from "./cloud";

export const engine = new Engine();

let idSeq = 0;
const newId = () => `c${Date.now().toString(36)}${(idSeq++).toString(36)}`;

function emptyDeck(id: DeckId): DeckState {
  return {
    id,
    songId: null,
    name: "",
    file: null,
    status: "empty",
    progress: 0,
    progressLabel: "",
    sampleRate: 44100,
    duration: 0,
    buffers: {},
    stemSource: "none",
    stemBusy: false,
    stemProgress: "",
    analysis: null,
    vocal: null,
    activeStem: "full",
    selection: null,
    semitones: 0,
  };
}

/** Recompute derived per-bar data after the user edits the grid. */
export function regrid(a: SongAnalysis, bpm: number, firstDownbeat: number): SongAnalysis {
  const beatInterval = 60 / bpm;
  const barLen = beatInterval * 4;
  let fd = firstDownbeat;
  while (fd - barLen >= 0) fd -= barLen;
  while (fd < 0) fd += barLen;
  const totalBars = Math.max(1, Math.floor((a.duration - fd) / barLen));
  const barEnergy = new Float32Array(totalBars);
  const barOnset = new Float32Array(totalBars);
  const barVocal = new Float32Array(totalBars);
  const bucketsPerSec = a.rms.length / a.duration;
  const oldBarLen = a.beatInterval * 4;
  let maxE = 0;
  for (let b = 0; b < totalBars; b++) {
    const t0 = fd + b * barLen;
    const i0 = Math.floor(t0 * bucketsPerSec);
    const i1 = Math.min(a.rms.length, Math.floor((t0 + barLen) * bucketsPerSec));
    let s = 0;
    for (let i = i0; i < i1; i++) s += a.rms[i] * a.rms[i];
    barEnergy[b] = i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
    if (barEnergy[b] > maxE) maxE = barEnergy[b];
    // resample old descriptors by time
    const ob0 = Math.max(0, Math.floor((t0 - a.firstDownbeat) / oldBarLen));
    const ob1 = Math.max(ob0 + 1, Math.floor((t0 + barLen - a.firstDownbeat) / oldBarLen));
    let so = 0;
    let sv = 0;
    let c = 0;
    for (let ob = ob0; ob < ob1 && ob < a.barOnset.length; ob++) {
      so += a.barOnset[ob];
      sv += a.barVocal[ob];
      c++;
    }
    barOnset[b] = c ? so / c : 0;
    barVocal[b] = c ? sv / c : 0;
  }
  if (maxE > 0) for (let b = 0; b < totalBars; b++) barEnergy[b] /= maxE;
  return { ...a, bpm, beatInterval, firstDownbeat: fd, totalBars, barEnergy, barOnset, barVocal };
}

export interface ExportOptions {
  format: "wav" | "mp3";
  range: "all" | "loop";
  normalize: boolean;
  /** also keep the render in the library (and share it when the cloud library is on) */
  save?: boolean;
}

export interface SessionSnapshot {
  songs: Partial<Record<DeckId, string>>;
  songNames: Partial<Record<DeckId, string>>;
  deckSettings: Partial<Record<DeckId, { semitones: number; activeStem: StemKey }>>;
  project: Project;
  currentProject: { id: string; name: string } | null;
  at: number;
}

export interface AppConfig {
  loaded: boolean;
  ai: boolean;
  /** Vercel Blob is configured: the library syncs across devices */
  cloud: boolean;
  stems: boolean;
  needCode: boolean;
}

export interface ClaudePlan {
  summary: string;
  foundation: { deck: DeckId; startBar: number; stem: StemKey; reason: string };
  masterBpm: number;
  pitchShift: { deck: DeckId; semitones: number; reason: string } | null;
  arrangement: { deck: DeckId; srcBar: number; lengthBars: number; startBar: number; lane: number; label: string; stem: StemKey; mode: "layer" | "swap"; exact?: { startBeat: number; lengthBeats: number; fadeIn: number; fadeOut: number } }[];
  tips: string[];
  /** arrangement length in bars (includes the outro after the last clip) */
  lengthBars?: number;
  /** which songs would benefit from (better) stems, and which Demucs variant to use */
  stemAdvice?: { deck: DeckId; variant: DemucsVariant; reason: string }[];
  /** edits the app's own rules made to the plan */
  notes?: string[];
}

export interface ClaudeNotes {
  summary: string;
  tips: string[];
  clipLabels: string[];
  stemAdvice: { deck: DeckId; variant: DemucsVariant; reason: string }[];
  choice: string | null;
}

interface Store {
  decks: Record<DeckId, DeckState>;
  project: Project;
  playing: boolean;
  previewDeck: DeckId | null;
  busy: { label: string; value: number } | null;
  selectedClipIds: string[];
  transport: TransportOptions;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number; // px per beat
  config: AppConfig;
  suggestions: Suggestion[];
  claudePlan: ClaudePlan | null;
  claudeBusy: boolean;
  claudeError: string | null;
  /** planner output */
  candidates: PlanCandidate[];
  selectedCandidateId: string | null;
  planConstraints: PlanConstraints;
  claudeNotes: ClaudeNotes | null;
  auditioning: boolean;
  /** clip currently playing on its own (click on a clip); null when the arrangement or nothing is playing */
  soloClipId: string | null;
  /** play one clip by itself, on the master tempo and pitch it would have in the mix; call again to stop */
  soloClip: (id: string) => Promise<void>;
  planMashup: (constraints?: PlanConstraints) => PlanCandidate[];
  selectCandidate: (id: string) => void;
  auditionCandidate: (id: string) => Promise<void>;
  stopAudition: () => void;
  applyCandidate: (id: string) => void;
  toast: string | null;
  accessCode: string;
  library: LibrarySong[];
  libraryBusy: { name: string; label: string; value: number } | null;
  storage: { usage: number; quota: number } | null;
  /** cloud sync status text, or null when idle */
  syncing: string | null;
  cloudBytes: number;
  cloudError: string | null;
  projects: LibraryProject[];
  mixes: LibraryMix[];
  currentProject: { id: string; name: string } | null;
  dirty: boolean;
  restorable: SessionSnapshot | null;

  loadConfig: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
  saveProject: (name?: string) => Promise<void>;
  saveProjectAs: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  renameProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  newProject: () => void;
  restoreSession: () => Promise<void>;
  dismissRestore: () => void;
  deleteMix: (id: string) => Promise<void>;
  shareLink: (id: string) => string | null;
  playMix: (id: string) => Promise<string | null>;
  importFiles: (files: File[]) => Promise<void>;
  loadFromLibrary: (deckId: DeckId, id: string) => Promise<void>;
  deleteFromLibrary: (id: string) => Promise<void>;
  loadFile: (deckId: DeckId, file: File) => Promise<void>;
  clearDeck: (deckId: DeckId) => void;
  /** empty both decks and the arrangement, forget the plan, and start from a blank studio (the library is untouched) */
  startOver: () => void;
  setMasterBpm: (bpm: number) => void;
  adoptDeckTempo: (deckId: DeckId) => void;
  nudgeDownbeat: (deckId: DeckId, beats: number) => void;
  nudgeGridMs: (deckId: DeckId, ms: number) => void;
  scaleTempo: (deckId: DeckId, factor: number) => void;
  setDeckBpm: (deckId: DeckId, bpm: number) => void;
  setSections: (deckId: DeckId, sections: Section[]) => void;
  resetSections: (deckId: DeckId) => void;
  setFoundation: (deckId: DeckId, patch?: Partial<Foundation>) => void;
  clearFoundation: () => void;
  setDeckStem: (deckId: DeckId, stem: StemKey) => void;
  setDeckPitch: (deckId: DeckId, semitones: number) => void;
  setSelection: (deckId: DeckId, sel: DeckState["selection"]) => void;
  addClip: (deckId: DeckId, srcBar: number, lengthBeats: number, opts?: { lane?: number; startBeat?: number; stem?: StemKey; mode?: "layer" | "swap" }) => void;
  repeatClip: (id: string) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  removeClip: (id: string) => void;
  clearClips: () => void;
  selectClip: (id: string | null, opts?: { add?: boolean }) => void;
  selectClips: (ids: string[]) => void;
  selectAll: () => void;
  removeSelected: () => void;
  repeatSelected: () => void;
  copySelected: () => void;
  paste: () => void;
  moveClips: (ids: string[], deltaBeats: number, deltaLane: number) => void;
  nudgeClip: (id: string, ms: number) => void;
  autoAlignClip: (id: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  toggleMetronome: () => void;
  toggleCountIn: () => void;
  addCue: (beat?: number, label?: string) => void;
  updateCue: (id: string, patch: Partial<CuePoint>) => void;
  removeCue: (id: string) => void;
  setLoopRegion: (region: LoopRegion | null) => void;
  loopSelected: () => void;
  setAutomation: (param: "level" | "filter", points: AutomationPoint[]) => void;
  setLengthBars: (n: number) => void;
  toggleLoop: () => void;
  /** turn automatic level matching on or off for this arrangement */
  setLevelMatch: (on: boolean) => void;
  /** dB trims the engine applied at the last play, by clip id (and "foundation") */
  levelTrims: Record<string, number>;
  setZoom: (z: number) => void;
  separateQuick: (deckId: DeckId) => Promise<void>;
  separateAI: (deckId: DeckId, variant?: DemucsVariant) => Promise<void>;
  refinePlan: (instruction: string) => Promise<void>;
  planHistory: { instruction: string; plan: ClaudePlan }[];
  setAccessCode: (code: string) => void;
  changeAccessCode: () => void;
  play: (from?: number) => Promise<void>;
  pause: () => void;
  stop: () => void;
  seek: (sec: number) => void;
  previewSelection: (deckId: DeckId) => Promise<void>;
  exportMix: (opts?: ExportOptions) => Promise<void>;
  applySuggestion: (action: SuggestionAction) => void;
  askClaude: () => Promise<void>;
  applyClaudePlan: () => void;
  showToast: (msg: string) => void;
}

function engineDecks(decks: Record<DeckId, DeckState>): EngineDecks {
  const out: EngineDecks = {};
  for (const id of ["A", "B"] as DeckId[]) {
    const d = decks[id];
    if (d.status === "ready" && d.analysis) out[id] = { id, analysis: d.analysis, buffers: d.buffers, semitones: d.semitones };
  }
  return out;
}

function laneEnd(clips: Clip[], lane: number): number {
  let end = 0;
  for (const c of clips) if (c.lane === lane) end = Math.max(end, c.startBeat + c.lengthBeats);
  return end;
}

export const useStore = create<Store>((set, get) => {
  const refreshSuggestions = () => {
    const { decks, project } = get();
    set({ suggestions: computeSuggestions(decks, project) });
  };

  const restartIfPlaying = async () => {
    const s = get();
    if (!s.playing || s.previewDeck) return;
    if (s.soloClipId) {
      // an edit while a clip plays alone: stop the solo rather than launching the whole arrangement
      engine.stop();
      set({ playing: false, soloClipId: null });
      return;
    }
    const pos = engine.position();
    await get().play(pos);
  };

  const growToFit = (clips: Clip[], lengthBars: number): number => {
    let maxBeat = lengthBars * 4;
    for (const c of clips) maxBeat = Math.max(maxBeat, c.startBeat + c.lengthBeats);
    return Math.ceil(maxBeat / 4);
  };

  const setDeck = (deckId: DeckId, patch: Partial<DeckState>) =>
    set((s) => ({ decks: { ...s.decks, [deckId]: { ...s.decks[deckId], ...patch } } }));

  /** Recompute section labels for a deck's current grid (runs in a worker, updates when done). */
  const refreshSections = async (deckId: DeckId, force = false) => {
    const d = get().decks[deckId];
    const a = d.analysis;
    const full = d.buffers.full;
    if (!a || !full) return;
    if (a.sectionsEdited && !force && a.sections && a.barChroma) return; // keep the user's edits
    const stamp = `${a.bpm}:${a.firstDownbeat}`;
    try {
      const { sections, barChroma } = await runSections(toMono(full), full.sampleRate, { firstDownbeat: a.firstDownbeat, beatInterval: a.beatInterval, totalBars: a.totalBars });
      const cur = get().decks[deckId].analysis;
      if (!cur || `${cur.bpm}:${cur.firstDownbeat}` !== stamp) return; // grid changed again meanwhile
      const keepEdits = cur.sectionsEdited && cur.sections && !force;
      const next = { ...cur, sections: keepEdits ? cur.sections : sections, sectionsEdited: keepEdits ? true : false, barChroma };
      if (get().decks[deckId].stemSource === "ai") void computeVocalProfile(deckId);
      setDeck(deckId, { analysis: next });
      const songId = get().decks[deckId].songId;
      if (songId) void persistSong(songId, { analysis: next });
    } catch (err) {
      console.warn("Section detection failed", err);
    }
  };

  const applyAnalysis = (deckId: DeckId, analysis: SongAnalysis) => {
    engine.invalidateDeck(deckId);
    const prev = get().decks[deckId].analysis;
    const barsUnchanged = !!prev && Math.abs(prev.bpm - analysis.bpm) < 1e-6 && prev.totalBars === analysis.totalBars;
    const keep = barsUnchanged && prev?.sectionsEdited && prev.sections;
    setDeck(deckId, { analysis: { ...analysis, sections: keep ? prev!.sections : undefined, sectionsEdited: keep ? true : false }, selection: null, vocal: null });
    void refreshSections(deckId, !keep);
    const songId = get().decks[deckId].songId;
    if (songId) void persistSong(songId, { analysis, vocal: null, bpm: analysis.bpm, keyName: analysis.key.name, camelot: analysis.key.camelot });
    const s = get();
    if (s.project.foundation?.deckId === deckId) {
      set({ project: { ...s.project, masterBpm: analysis.bpm } });
      engine.invalidateAll();
    }
    refreshSuggestions();
    void restartIfPlaying();
  };

  const PROGRESS_LABELS: Record<string, string> = {
    waveform: "Drawing waveform",
    spectrum: "Listening to the spectrum",
    tempo: "Finding the tempo",
    beats: "Locking the beat grid",
    key: "Detecting the key",
    done: "Ready",
  };

  /** Returns the library record for a file, analysing and storing it on first sight. */
  const ensureInLibrary = async (file: File, onProgress: (label: string, value: number) => void): Promise<LibrarySong> => {
    const data = await file.arrayBuffer();
    const id = await lib.hashFile(data, file);
    const existing = await lib.getSong(id);
    if (existing) {
      await lib.updateSong(id, { lastUsedAt: Date.now() });
      return existing;
    }
    onProgress("Decoding audio", 0.02);
    const buffer = await decodeArrayBuffer(data);
    onProgress("Listening for the beat", 0.05);
    const analysis = await runAnalysis(toMono(buffer), buffer.sampleRate, (p) => onProgress(PROGRESS_LABELS[p.stage] ?? p.stage, p.value));
    const song: LibrarySong = {
      id,
      name: file.name.replace(/\.[^.]+$/, ""),
      fileName: file.name,
      mimeType: file.type || "audio/mpeg",
      size: file.size,
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
      duration: buffer.duration,
      bpm: analysis.bpm,
      keyName: analysis.key.name,
      camelot: analysis.key.camelot,
      analysis,
      semitones: 0,
      stemSource: "none",
      aiStems: [],
    };
    try {
      await lib.putFile(`${id}:full`, new Blob([data], { type: song.mimeType }));
      await lib.putSong(song);
      void lib.requestPersistence();
    } catch (err) {
      console.warn("Library save failed", err);
    }
    if (get().config.cloud) void syncSongToCloud(song);
    return song;
  };

  /**
   * A deck can outlive its library record (a cloud refresh once dropped freshly added songs). Rebuild the
   * record from the deck's own file and analysis so stems, sections and projects can be saved again.
   */
  const resaveDeckSong = async (deckId: DeckId): Promise<LibrarySong | undefined> => {
    const d = get().decks[deckId];
    if (!d.songId || !d.file || !d.analysis) return undefined;
    const song: LibrarySong = {
      id: d.songId,
      name: d.name,
      fileName: d.file.name,
      mimeType: d.file.type || "audio/mpeg",
      size: d.file.size,
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
      duration: d.duration,
      bpm: d.analysis.bpm,
      keyName: d.analysis.key.name,
      camelot: d.analysis.key.camelot,
      analysis: d.analysis,
      vocal: d.vocal,
      semitones: d.semitones,
      stemSource: "none",
      aiStems: [],
    };
    try {
      await lib.putFile(`${song.id}:full`, d.file);
      await lib.putSong(song);
    } catch (err) {
      console.warn("Could not re-save the song", err);
      return undefined;
    }
    set((s) => ({ library: [song, ...s.library.filter((x) => x.id !== song.id)] }));
    get().showToast(`${song.name} was missing from the library and has been saved again`);
    if (get().config.cloud) void syncSongToCloud(song);
    return song;
  };

  // ---- Cloud sync helpers -------------------------------------------------

  /** Resolves the access code, prompting once if the server requires one. Returns undefined if the user cancels. */
  const withCode = async <T,>(fn: (code: string) => Promise<T>): Promise<T | undefined> => {
    const s = get();
    let code = s.accessCode;
    if (s.config.needCode && !code) {
      const c = window.prompt("This library is protected. Enter the access code:");
      if (!c) return undefined;
      get().setAccessCode(c.trim());
      code = c.trim();
    }
    try {
      return await fn(code);
    } catch (err) {
      if (err instanceof AccessCodeError) {
        const c = window.prompt("That access code was rejected. Enter the access code:");
        if (!c) return undefined;
        get().setAccessCode(c.trim());
        return await fn(c.trim());
      }
      throw err;
    }
  };

  const metaTimers = new Map<string, number>();
  /** Debounced metadata write to the cloud (grid nudges fire many updates in a row). */
  const scheduleCloudMeta = (song: LibrarySong) => {
    if (!get().config.cloud) return;
    const prev = metaTimers.get(song.id);
    if (prev) window.clearTimeout(prev);
    metaTimers.set(
      song.id,
      window.setTimeout(() => {
        metaTimers.delete(song.id);
        void withCode((code) => cloud.cloudPutMeta({ ...song, cloud: true }, code)).catch((err) => set({ cloudError: (err as Error).message }));
      }, 1000),
    );
  };

  /** Update a song locally and mirror the change to the cloud. */
  const persistSong = async (id: string, patch: Partial<LibrarySong>, immediate = false): Promise<LibrarySong | undefined> => {
    const next = await lib.updateSong(id, patch);
    if (!next) return undefined;
    set((s) => ({ library: s.library.map((x) => (x.id === id ? next : x)) }));
    if (get().config.cloud && next.cloud) {
      if (immediate) {
        const prev = metaTimers.get(id);
        if (prev) window.clearTimeout(prev);
        await withCode((code) => cloud.cloudPutMeta(next, code)).catch((err) => set({ cloudError: (err as Error).message }));
      } else scheduleCloudMeta(next);
    }
    return next;
  };

  const uploading = new Map<string, Promise<string | undefined>>();
  /** Makes sure the original file is in Blob; returns its URL. */
  const ensureCloudFile = (song: LibrarySong): Promise<string | undefined> => {
    if (song.fileUrl) return Promise.resolve(song.fileUrl);
    const inflight = uploading.get(song.id);
    if (inflight) return inflight;
    const p = (async () => {
      let blob: Blob | undefined = await lib.getFile(`${song.id}:full`);
      if (!blob) {
        // The library record can outlive its stored file; a deck that has the song loaded still holds the original.
        const deck = (["A", "B"] as DeckId[]).map((d) => get().decks[d]).find((d) => d.songId === song.id && d.file);
        if (deck?.file) {
          blob = deck.file;
          try {
            await lib.putFile(`${song.id}:full`, blob);
          } catch {
            /* keep going with the in-memory file */
          }
        }
      }
      if (!blob) throw new Error(`The original audio for “${song.name}” is not on this device. Add the file again to upload it.`);
      set({ syncing: `Uploading ${song.name}` });
      try {
        const url = await withCode((code) => cloud.cloudUploadSong(song.id, blob, song.fileName, code));
        if (!url) throw new Error("The cloud library needs its access code before it can upload");
        // Write the cloud record first; only a song the cloud actually lists may be flagged as cloud-backed,
        // otherwise a refresh could mistake it for one deleted elsewhere and drop it locally.
        const withUrl = (await lib.updateSong(song.id, { fileUrl: url })) ?? { ...song, fileUrl: url };
        await withCode((code) => cloud.cloudPutMeta({ ...withUrl, cloud: true }, code));
        await persistSong(song.id, { fileUrl: url, cloud: true });
        return url;
      } finally {
        uploading.delete(song.id);
        set({ syncing: null });
      }
    })();
    uploading.set(song.id, p);
    return p;
  };

  /** Push a local-only song (file, stems, metadata) to the cloud library. */
  const syncSongToCloud = async (song: LibrarySong) => {
    try {
      const url = await ensureCloudFile(song);
      if (!url) return;
      const current = (await lib.getSong(song.id)) ?? song;
      const stemUrls = { ...(current.stemUrls ?? {}) };
      for (const k of current.aiStems) {
        if (stemUrls[k]) continue;
        const blob = await lib.getFile(`${song.id}:${k}`);
        if (!blob) continue;
        set({ syncing: `Uploading ${song.name} · ${k}` });
        const u = await withCode((code) => cloud.cloudUploadStem(song.id, k, blob, code));
        if (u) stemUrls[k] = u;
      }
      await persistSong(song.id, { stemUrls, cloud: true }, true);
      set({ syncing: null, cloudError: null });
    } catch (err) {
      set({ syncing: null, cloudError: `Sync failed: ${(err as Error).message}` });
    }
  };

  const buildAiBuffers = (full: AudioBuffer, decoded: Partial<Record<lib.AiStemKey, AudioBuffer>>): Partial<Record<StemKey, AudioBuffer>> => {
    const ctx = getAudioContext();
    const mix = (keys: lib.AiStemKey[]): AudioBuffer | undefined => {
      const parts = keys.map((k) => decoded[k]).filter((b): b is AudioBuffer => !!b);
      if (parts.length === 0) return undefined;
      const len = Math.max(...parts.map((p) => p.length));
      const chans = Math.max(...parts.map((p) => p.numberOfChannels));
      const out = ctx.createBuffer(chans, len, parts[0].sampleRate);
      for (let c = 0; c < chans; c++) {
        const dst = out.getChannelData(c);
        for (const p of parts) {
          const src = p.getChannelData(Math.min(c, p.numberOfChannels - 1));
          for (let i = 0; i < src.length; i++) dst[i] += src[i];
        }
      }
      return out;
    };
    return {
      full,
      vocals: decoded.vocals,
      instrumental: mix(["drums", "bass", "other"]),
      drums: decoded.drums,
      melodic: mix(["bass", "other"]),
    };
  };

  /** Decode a library song (and its stored stems) into a deck. */
  const loadSongIntoDeck = async (deckId: DeckId, song: LibrarySong, file: File) => {
    engine.stop();
    set({ playing: false, previewDeck: null });
    engine.invalidateDeck(deckId);
    set((s) => ({
      decks: { ...s.decks, [deckId]: { ...emptyDeck(deckId), songId: song.id, name: song.name, file, status: "decoding", progressLabel: "Decoding audio", progress: 0.3 } },
    }));
    const buffer = await decodeFile(file);
    setDeck(deckId, {
      buffers: { full: buffer },
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      analysis: song.analysis,
      vocal: vocalProfileMatches(song.vocal, song.analysis) ? song.vocal : null,
      semitones: song.semitones,
      status: "ready",
      progress: 1,
      progressLabel: "",
    });
    const s = get();
    if (!s.project.foundation) {
      set({
        project: {
          ...s.project,
          masterBpm: song.analysis.bpm,
          foundation: { deckId, stem: "full", startBar: 0, gain: 1 },
          lengthBars: Math.max(8, Math.min(s.project.lengthBars, song.analysis.totalBars)),
        },
      });
      engine.invalidateAll();
    }
    refreshSuggestions();
    void get().refreshLibrary();
    if (!song.analysis.sections) void refreshSections(deckId); // older library records
    // Restore stems in the background
    if (song.stemSource === "ai" && song.aiStems.length > 0) {
      setDeck(deckId, { stemBusy: true, stemProgress: "Loading saved stems" });
      try {
        const decoded: Partial<Record<lib.AiStemKey, AudioBuffer>> = {};
        await Promise.all(
          song.aiStems.map(async (k) => {
            let blob = await lib.getFile(`${song.id}:${k}`);
            const url = song.stemUrls?.[k];
            if (!blob && url) {
              const bytes = await withCode((code) => cloud.cloudFetch(url, code));
              if (bytes) {
                blob = new Blob([bytes], { type: "audio/mpeg" });
                await lib.putFile(`${song.id}:${k}`, blob);
              }
            }
            if (blob) decoded[k] = await decodeArrayBuffer(await blob.arrayBuffer());
          }),
        );
        if (get().decks[deckId].songId !== song.id) return; // deck changed meanwhile
        engine.invalidateDeck(deckId);
        setDeck(deckId, { buffers: buildAiBuffers(buffer, decoded), stemSource: "ai", stemBusy: false, stemProgress: "" });
        if (!get().decks[deckId].vocal || !song.analysis.barChroma) void computeVocalProfile(deckId);
        refreshSuggestions();
      } catch {
        setDeck(deckId, { stemBusy: false, stemProgress: "" });
      }
    } else if (song.stemSource === "quick") {
      void get().separateQuick(deckId);
    }
  };

  // ---- Undo / redo (snapshots of `project`, coalesced within 250 ms) ---------
  const history = { past: [] as Project[], future: [] as Project[], lastAt: 0, lastKey: "", muted: false };
  /** Every call is one undo step, except rapid repeats of the same `coalesce` key (slider drags). */
  const setProject = (next: Project, coalesce?: string) => {
    const prev = get().project;
    if (prev === next) return;
    if (!history.muted) {
      const now = Date.now();
      const merge = !!coalesce && coalesce === history.lastKey && now - history.lastAt < 600 && history.past.length > 0;
      if (!merge) {
        history.past.push(prev);
        if (history.past.length > 100) history.past.shift();
      }
      history.lastAt = now;
      history.lastKey = coalesce ?? "";
      history.future = [];
    }
    set({ project: next, canUndo: history.past.length > 0, canRedo: history.future.length > 0, dirty: true });
    autosave();
  };
  let clipboard: Clip[] = [];

  /** Two-way sync of small metadata records (projects, mixes) between IndexedDB and the cloud. */
  const syncRecords = async <T extends { id: string; cloud?: boolean; updatedAt?: number; createdAt?: number }>(
    kind: "projects" | "mixes",
    local: T[],
    putLocal: (r: T) => Promise<void>,
    deleteLocal: (id: string) => Promise<void>,
    apply: (list: T[]) => void,
  ) => {
    try {
      const remote = await withCode((code) => cloud.cloudListKind<T>(kind, code));
      if (!remote) return;
      const remoteById = new Map(remote.map((r) => [r.id, r]));
      const merged: T[] = [];
      for (const l of local) {
        const r = remoteById.get(l.id);
        if (r) {
          remoteById.delete(l.id);
          const remoteNewer = (r.updatedAt ?? r.createdAt ?? 0) > (l.updatedAt ?? l.createdAt ?? 0);
          const next = remoteNewer ? { ...l, ...r, cloud: true } : { ...l, cloud: true };
          await putLocal(next);
          if (!remoteNewer && (l.updatedAt ?? 0) > (r.updatedAt ?? 0)) void withCode((code) => cloud.cloudPutKind(kind, next, code));
          merged.push(next);
        } else if (l.cloud) {
          await deleteLocal(l.id);
        } else {
          merged.push(l);
          if (kind === "projects" || (l as unknown as LibraryMix).url) {
            const next = { ...l, cloud: true };
            void withCode((code) => cloud.cloudPutKind(kind, next, code)).then(() => putLocal(next));
          }
        }
      }
      for (const r of remoteById.values()) {
        await putLocal({ ...r, cloud: true });
        merged.push({ ...r, cloud: true });
      }
      apply(merged);
    } catch (err) {
      set({ cloudError: (err as Error).message });
    }
  };

  const snapshot = (): SessionSnapshot => {
    const s = get();
    const songs: SessionSnapshot["songs"] = {};
    const songNames: SessionSnapshot["songNames"] = {};
    const deckSettings: SessionSnapshot["deckSettings"] = {};
    for (const id of ["A", "B"] as DeckId[]) {
      const d = s.decks[id];
      if (d.status === "ready" && d.songId) {
        songs[id] = d.songId;
        songNames[id] = d.name;
        deckSettings[id] = { semitones: d.semitones, activeStem: d.activeStem };
      }
    }
    return { songs, songNames, deckSettings, project: s.project, currentProject: s.currentProject, at: Date.now() };
  };

  let autosaveTimer: number | null = null;
  const autosave = () => {
    if (autosaveTimer) window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      try {
        const snap = snapshot();
        if (Object.keys(snap.songs).length === 0) return;
        window.localStorage.setItem("songmasher.session", JSON.stringify(snap));
      } catch {
        /* storage full or unavailable */
      }
    }, 800);
  };

  /** Load a snapshot (saved project or autosaved session) into the decks and timeline. */
  const restoreSnapshot = async (snap: Omit<SessionSnapshot, "at" | "currentProject">, current: { id: string; name: string } | null) => {
    engine.stop();
    set({ playing: false, previewDeck: null, busy: { label: "Opening mashup", value: 0.1 } });
    try {
      for (const id of ["A", "B"] as DeckId[]) {
        const songId = snap.songs[id];
        if (!songId) {
          if (get().decks[id].status !== "empty") get().clearDeck(id);
          continue;
        }
        if (get().decks[id].songId !== songId || get().decks[id].status !== "ready") await get().loadFromLibrary(id, songId);
        const d = get().decks[id];
        if (d.status !== "ready") throw new Error(`${snap.songNames[id] ?? "A song"} is no longer in the library`);
        const ds = snap.deckSettings[id];
        if (ds) {
          setDeck(id, { semitones: ds.semitones, activeStem: d.buffers[ds.activeStem] ? ds.activeStem : "full" });
          engine.invalidateDeck(id);
        }
      }
      history.past = [];
      history.future = [];
      set({ project: { ...snap.project, automation: snap.project.automation ?? emptyAutomation(), cues: snap.project.cues ?? [], loopRegion: snap.project.loopRegion ?? null }, currentProject: current, dirty: false, canUndo: false, canRedo: false, selectedClipIds: [] });
      engine.invalidateAll();
      refreshSuggestions();
    } finally {
      set({ busy: null });
    }
  };

  const plannerSongs = (): [PlannerSong, PlannerSong] | null => {
    const s = get();
    const list: PlannerSong[] = [];
    for (const id of ["A", "B"] as DeckId[]) {
      const d = s.decks[id];
      if (d.status !== "ready" || !d.analysis) continue;
      const vocal = vocalProfileMatches(d.vocal, d.analysis) ? d.vocal : null;
      if (!vocal && d.vocal) {
        // stale profile (grid changed, or an older save without a grid stamp): drop it and measure again
        setDeck(id, { vocal: null });
        if (d.stemSource === "ai" && d.buffers.vocals) void computeVocalProfile(id);
      }
      list.push({ deck: id, name: d.name, analysis: d.analysis, vocal, stems: Object.keys(d.buffers) as StemKey[] });
    }
    return list.length === 2 ? [list[0], list[1]] : null;
  };

  /** Derive phrases / vocal energy / melody chroma from the isolated vocal stem and persist it. */
  const computeVocalProfile = async (deckId: DeckId) => {
    const d = get().decks[deckId];
    const a = d.analysis;
    const voc = d.buffers.vocals;
    if (!a || !voc || d.stemSource !== "ai") return;
    try {
      const profile = await runVocalProfile(toMono(voc), voc.sampleRate, { firstDownbeat: a.firstDownbeat, beatInterval: a.beatInterval, totalBars: a.totalBars });
      if (get().decks[deckId].songId !== d.songId) return;
      setDeck(deckId, { vocal: profile });
      if (d.songId) void persistSong(d.songId, { vocal: profile });
      refreshSuggestions();
    } catch (err) {
      console.warn("Vocal profile failed", err);
    }
  };

  const candidateToPlan = (c: PlanCandidate, labels?: string[]): ClaudePlan => ({
    summary: c.description,
    foundation: { deck: c.foundation.deck, startBar: c.foundation.startBar, stem: c.foundation.stem, reason: "" },
    masterBpm: c.masterBpm,
    lengthBars: c.lengthBars,
    pitchShift: c.semitones ? { deck: c.vocalDeck, semitones: c.semitones, reason: "" } : null,
    arrangement: c.clips.map((k, i) => ({
      deck: k.deck,
      srcBar: k.srcBar,
      lengthBars: k.slotBars,
      startBar: k.startBeat / 4,
      lane: k.lane,
      label: labels?.[i] ?? k.label,
      stem: k.stem,
      mode: k.mode,
      exact: { startBeat: k.startBeat, lengthBeats: k.lengthBeats, fadeIn: k.fadeIn, fadeOut: k.fadeOut },
    })),
    tips: [],
  });

  const songSummaries = () => {
    const s = get();
    return (["A", "B"] as DeckId[])
      .map((id) => {
        const d = s.decks[id];
        const a = d.analysis;
        if (!a) return null;
        const desc = describeSong(a);
        const loudest = d.vocal ? d.vocal.barVocal.map((v, i) => [v, i] as [number, number]).sort((x, y) => y[0] - x[0]).slice(0, 6).map((x) => x[1]).sort((x, y) => x - y) : [];
        return {
          deck: id,
          name: d.name,
          bpm: Math.round(a.bpm * 10) / 10,
          key: a.key.name,
          camelot: a.key.camelot,
          durationSec: Math.round(a.duration),
          totalBars: a.totalBars,
          stems: Object.keys(d.buffers),
          sections: desc.sections,
          vocal: d.vocal ? { phrases: d.vocal.phrases.length, firstPhraseBar: d.vocal.phrases.length ? Math.floor(d.vocal.phrases[0].startBeat / 4) : null, loudestBars: loudest } : null,
        };
      })
      .filter(Boolean);
  };

  const candidatesForClaude = (cands: PlanCandidate[]) =>
    cands.slice(0, 6).map((c) => ({
      id: c.id,
      template: c.template,
      description: c.description,
      score: Math.round(c.score * 100) / 100,
      breakdown: { harmony: r2(c.breakdown.harmony), phrases: r2(c.breakdown.phrases), energy: r2(c.breakdown.energy), stretch: r2(c.breakdown.stretch) },
      foundation: c.foundation,
      vocalDeck: c.vocalDeck,
      semitones: c.semitones,
      masterBpm: c.masterBpm,
      lengthBars: c.lengthBars,
      clips: c.clips.map((k) => ({ label: k.label, deck: k.deck, srcBar: Math.round(k.srcBar * 4) / 4, lengthBars: k.slotBars, startBar: Math.round(k.startBeat) / 4, stem: k.stem, mode: k.mode, fit: r2(k.fit) })),
    }));
  const r2 = (v: number) => Math.round(v * 100) / 100;

  const consultClaude = async (instruction?: string) => {
    const s = get();
    let cands = s.candidates.length ? s.candidates : get().planMashup(s.planConstraints);
    if (cands.length === 0) throw new Error("Nothing to plan yet: load two songs first");
    const history = s.planHistory.map((h) => ({ instruction: h.instruction, summary: h.plan.summary }));
    const call = async (list: PlanCandidate[], instr?: string) => {
      const r = await fetch("/api/advise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ songs: songSummaries(), candidates: candidatesForClaude(list), instruction: instr, history }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Advisor failed");
      return j.result as { choice: string | null; constraints: Partial<Record<keyof PlanConstraints, unknown>> | null; summary: string; tips: string[]; clipLabels: string[]; stemAdvice: ClaudeNotes["stemAdvice"] };
    };
    let res = await call(cands, instruction);
    if (res.constraints) {
      const next: PlanConstraints = { ...s.planConstraints };
      for (const [k, v] of Object.entries(res.constraints)) if (v !== null && v !== undefined) (next as Record<string, unknown>)[k] = v;
      cands = get().planMashup(next);
      if (cands.length && (!res.choice || !cands.some((c) => c.id === res.choice))) {
        // let Claude pick among the re-searched candidates and describe them
        res = await call(cands, instruction ? `${instruction} (the candidates now reflect your constraints; choose one)` : undefined);
      }
    }
    const chosen = cands.find((c) => c.id === res.choice) ?? cands[0];
    if (!chosen) throw new Error("The planner found no workable arrangement");
    const notes: ClaudeNotes = { summary: res.summary, tips: res.tips, clipLabels: res.clipLabels ?? [], stemAdvice: res.stemAdvice ?? [], choice: chosen.id };
    const plan = candidateToPlan(chosen, notes.clipLabels.length === chosen.clips.length ? notes.clipLabels : undefined);
    plan.summary = res.summary;
    plan.tips = res.tips;
    plan.stemAdvice = res.stemAdvice;
    set({ candidates: cands, selectedCandidateId: chosen.id, claudeNotes: notes, claudePlan: { ...plan, notes: sanitizePlan(plan, get().decks)?.notes ?? [] } });
    return plan;
  };

  const storeImpl = {
    decks: { A: emptyDeck("A"), B: emptyDeck("B") },
    project: { masterBpm: 120, foundation: null, clips: [], lengthBars: 16, loop: true, automation: emptyAutomation(), cues: [], loopRegion: null },
    playing: false,
    previewDeck: null,
    busy: null,
    selectedClipIds: [],
    transport: { metronome: false, countIn: false },
    canUndo: false,
    canRedo: false,
    zoom: 14,
    config: { loaded: false, ai: false, cloud: false, stems: false, needCode: false },
    suggestions: [],
    claudePlan: null,
    candidates: [],
    selectedCandidateId: null,
    planConstraints: {},
    claudeNotes: null,
    auditioning: false,
    soloClipId: null,
    levelTrims: {},
    planHistory: [],
    claudeBusy: false,
    claudeError: null,
    toast: null,
    accessCode: "",
    library: [],
    libraryBusy: null,
    storage: null,
    syncing: null,
    cloudBytes: 0,
    cloudError: null,
    projects: [],
    mixes: [],
    currentProject: null,
    dirty: false,
    restorable: null,

    showToast: (msg: string) => {
      set({ toast: msg });
      window.setTimeout(() => {
        if (get().toast === msg) set({ toast: null });
      }, 4000);
    },

    loadConfig: async () => {
      try {
        const code = window.localStorage.getItem("songmasher.accessCode") ?? window.localStorage.getItem("songmasher.stemsCode") ?? "";
        set({ accessCode: code });
      } catch {
        /* ignore */
      }
      try {
        const r = await fetch("/api/config");
        const j = await r.json();
        set({ config: { loaded: true, ai: !!j.ai, cloud: !!j.cloud, stems: !!j.stems, needCode: !!j.needCode } });
      } catch {
        set({ config: { loaded: true, ai: false, cloud: false, stems: false, needCode: false } });
      }
      await get().refreshLibrary();
      try {
        const raw = window.localStorage.getItem("songmasher.session");
        if (raw) {
          const snap = JSON.parse(raw) as SessionSnapshot;
          if (snap && snap.project && Object.keys(snap.songs ?? {}).length > 0 && Date.now() - (snap.at ?? 0) < 30 * 24 * 3600 * 1000) set({ restorable: snap });
        }
      } catch {
        /* ignore */
      }
    },

    refreshLibrary: async () => {
      const [local, storage, localProjects, localMixes] = await Promise.all([lib.listSongs(), lib.storageEstimate(), lib.listProjects(), lib.listMixes()]);
      set({ storage, projects: localProjects, mixes: localMixes });
      const cfg = get().config;
      if (!cfg.loaded || !cfg.cloud) {
        set({ library: local });
        return;
      }
      void syncRecords("projects", localProjects, lib.putProject, lib.deleteProject, (list) => set({ projects: list.sort((a, b) => b.updatedAt - a.updatedAt) }));
      void syncRecords("mixes", localMixes, lib.putMix, lib.deleteMix, (list) => set({ mixes: list.sort((a, b) => b.createdAt - a.createdAt) }));
      let remote: { songs: LibrarySong[]; bytes: number } | undefined;
      try {
        remote = await withCode((code) => cloud.cloudList(code));
        set({ cloudError: null });
      } catch (err) {
        set({ cloudError: (err as Error).message, library: local });
        return;
      }
      if (!remote) {
        set({ library: local });
        return;
      }
      const remoteById = new Map(remote.songs.map((r) => [r.id, r]));
      const onDeck = (id: string) => (["A", "B"] as DeckId[]).some((d) => get().decks[d].songId === id && get().decks[d].status !== "empty");
      const merged: LibrarySong[] = [];
      const toUpload: LibrarySong[] = [];
      for (const l of local) {
        const r = remoteById.get(l.id);
        if (r) {
          remoteById.delete(l.id);
          const remoteNewer = (r.updatedAt ?? 0) > (l.updatedAt ?? 0);
          const next: LibrarySong = remoteNewer
            ? { ...l, ...r, cloud: true }
            : { ...l, cloud: true, fileUrl: l.fileUrl ?? r.fileUrl, stemUrls: { ...r.stemUrls, ...l.stemUrls } };
          await lib.putSong(next);
          if (!remoteNewer && (l.updatedAt ?? 0) > (r.updatedAt ?? 0)) scheduleCloudMeta(next);
          merged.push(next);
        } else if (l.cloud && !onDeck(l.id) && Date.now() - (l.updatedAt ?? l.addedAt) > 10 * 60_000) {
          // deleted from another device (cloud listings can lag a freshly written record by a while, so
          // anything touched in the last ten minutes, or sitting on a deck, is kept and re-synced instead)
          await lib.deleteSong(l.id);
        } else {
          merged.push(l);
          toUpload.push(l);
        }
      }
      for (const r of remoteById.values()) {
        await lib.putSong(r);
        merged.push(r);
      }
      merged.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      set({ library: merged, cloudBytes: remote.bytes });
      for (const song of toUpload) void syncSongToCloud(song);
    },

    importFiles: async (files) => {
      for (const file of files) {
        const s = get();
        const target = (["A", "B"] as DeckId[]).find((id) => s.decks[id].status === "empty");
        if (target) await get().loadFile(target, file);
        else {
          set({ libraryBusy: { name: file.name, label: "Reading file", value: 0 } });
          try {
            await ensureInLibrary(file, (label, value) => set({ libraryBusy: { name: file.name, label, value } }));
          } catch (err) {
            get().showToast(`Could not add ${file.name}: ${(err as Error).message}`);
          } finally {
            set({ libraryBusy: null });
          }
        }
      }
      await get().refreshLibrary();
    },

    loadFromLibrary: async (deckId, id) => {
      const song = await lib.getSong(id);
      if (!song) {
        get().showToast("That song is no longer in the library");
        await get().refreshLibrary();
        return;
      }
      let blob = await lib.getFile(`${id}:full`);
      if (!blob && song.fileUrl) {
        set((s) => ({ decks: { ...s.decks, [deckId]: { ...emptyDeck(deckId), songId: id, name: song.name, status: "decoding", progressLabel: "Downloading from your library", progress: 0.1 } } }));
        try {
          const bytes = await withCode((code) => cloud.cloudFetch(song.fileUrl!, code));
          if (!bytes) {
            set((s) => ({ decks: { ...s.decks, [deckId]: emptyDeck(deckId) } }));
            return;
          }
          blob = new Blob([bytes], { type: song.mimeType });
          await lib.putFile(`${id}:full`, blob);
        } catch (err) {
          setDeck(deckId, { status: "error", error: `Download failed: ${(err as Error).message}` });
          return;
        }
      }
      if (!blob) {
        get().showToast("The audio for that song is missing");
        return;
      }
      await lib.updateSong(id, { lastUsedAt: Date.now() });
      const file = new File([blob], song.fileName, { type: song.mimeType });
      await loadSongIntoDeck(deckId, song, file);
    },

    saveProject: async (name) => {
      const s = get();
      const snap = snapshot();
      if (Object.keys(snap.songs).length === 0) {
        get().showToast("Load a song before saving a mashup");
        return;
      }
      let current = s.currentProject;
      if (!current) {
        const suggested = name ?? Object.values(snap.songNames).filter(Boolean).join(" × ") ?? "Mashup";
        const n = name ?? window.prompt("Name this mashup", suggested);
        if (!n) return;
        current = { id: lib.randomId(), name: n.trim() || suggested };
      } else if (name) current = { ...current, name };
      const existing = await lib.getProject(current.id);
      const rec: LibraryProject = {
        id: current.id,
        name: current.name,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        songs: snap.songs,
        songNames: snap.songNames,
        deckSettings: snap.deckSettings,
        project: snap.project,
        cloud: get().config.cloud,
      };
      await lib.putProject(rec);
      set({ currentProject: current, dirty: false, projects: [rec, ...get().projects.filter((p) => p.id !== rec.id)] });
      if (get().config.cloud) {
        try {
          await withCode((code) => cloud.cloudPutKind("projects", rec, code));
        } catch (err) {
          set({ cloudError: (err as Error).message });
        }
      }
      get().showToast(`Saved “${current.name}”`);
    },

    saveProjectAs: async () => {
      const s = get();
      const n = window.prompt("Save a copy as", s.currentProject ? `${s.currentProject.name} copy` : "Mashup");
      if (!n) return;
      set({ currentProject: null });
      await get().saveProject(n.trim() || "Mashup");
    },

    openProject: async (id) => {
      const p = await lib.getProject(id);
      if (!p) {
        get().showToast("That mashup is no longer in the library");
        return;
      }
      if (get().dirty && get().currentProject && !window.confirm("Discard unsaved changes to the current mashup?")) return;
      try {
        await restoreSnapshot(p, { id: p.id, name: p.name });
        get().showToast(`Opened “${p.name}”`);
      } catch (err) {
        get().showToast(`Could not open: ${(err as Error).message}`);
      }
    },

    renameProject: async (id) => {
      const p = await lib.getProject(id);
      if (!p) return;
      const n = window.prompt("Rename mashup", p.name);
      if (!n || !n.trim()) return;
      const rec = { ...p, name: n.trim(), updatedAt: Date.now() };
      await lib.putProject(rec);
      set({ projects: get().projects.map((x) => (x.id === id ? rec : x)), currentProject: get().currentProject?.id === id ? { id, name: rec.name } : get().currentProject });
      if (get().config.cloud) void withCode((code) => cloud.cloudPutKind("projects", rec, code)).catch((err) => set({ cloudError: (err as Error).message }));
    },

    deleteProject: async (id) => {
      const p = await lib.getProject(id);
      await lib.deleteProject(id);
      set({ projects: get().projects.filter((x) => x.id !== id), currentProject: get().currentProject?.id === id ? null : get().currentProject });
      if (get().config.cloud && p?.cloud !== false) {
        try {
          await withCode((code) => cloud.cloudDeleteKind("projects", id, code));
        } catch (err) {
          get().showToast(`Removed here, but the cloud copy could not be deleted: ${(err as Error).message}`);
        }
      }
    },

    newProject: () => {
      if (get().dirty && get().currentProject && !window.confirm("Discard unsaved changes to the current mashup?")) return;
      engine.stop();
      history.past = [];
      history.future = [];
      const s = get();
      set({
        playing: false,
        previewDeck: null,
        currentProject: null,
        dirty: false,
        canUndo: false,
        canRedo: false,
        selectedClipIds: [],
        project: { ...s.project, clips: [], automation: emptyAutomation(), cues: [], loopRegion: null, lengthBars: 16 },
      });
      engine.invalidateAll();
    },

    restoreSession: async () => {
      const snap = get().restorable;
      if (!snap) return;
      set({ restorable: null });
      try {
        await restoreSnapshot(snap, snap.currentProject);
        get().showToast(snap.currentProject ? `Restored “${snap.currentProject.name}”` : "Restored your last session");
      } catch (err) {
        get().showToast(`Could not restore: ${(err as Error).message}`);
      }
    },

    dismissRestore: () => {
      set({ restorable: null });
      try {
        window.localStorage.removeItem("songmasher.session");
      } catch {
        /* ignore */
      }
    },

    deleteMix: async (id) => {
      const m = await lib.getMix(id);
      await lib.deleteMix(id);
      set({ mixes: get().mixes.filter((x) => x.id !== id) });
      if (get().config.cloud && m?.cloud !== false) {
        try {
          await withCode((code) => cloud.cloudDeleteKind("mixes", id, code));
        } catch (err) {
          get().showToast(`Removed here, but the cloud copy could not be deleted: ${(err as Error).message}`);
        }
      }
    },

    shareLink: (id) => {
      const m = get().mixes.find((x) => x.id === id);
      if (!m?.url) return null;
      return `${window.location.origin}/m/${id}`;
    },

    playMix: async (id) => {
      const m = get().mixes.find((x) => x.id === id);
      const blob = await lib.getFile(`mix:${id}`);
      if (blob) return URL.createObjectURL(blob);
      return m?.url ?? null;
    },

    deleteFromLibrary: async (id) => {
      const song = await lib.getSong(id);
      await lib.deleteSong(id);
      set((s) => ({ library: s.library.filter((x) => x.id !== id) }));
      if (get().config.cloud && song?.cloud !== false) {
        try {
          await withCode((code) => cloud.cloudDelete(id, code));
        } catch (err) {
          get().showToast(`Removed here, but the cloud copy could not be deleted: ${(err as Error).message}`);
        }
      }
      await get().refreshLibrary();
    },

    loadFile: async (deckId, file) => {
      const name = file.name.replace(/\.[^.]+$/, "");
      set((s) => ({
        decks: { ...s.decks, [deckId]: { ...emptyDeck(deckId), name, file, status: "decoding", progressLabel: "Reading file" } },
      }));
      engine.invalidateDeck(deckId);
      try {
        const song = await ensureInLibrary(file, (label, value) => setDeck(deckId, { progressLabel: label, progress: value, status: value < 0.05 ? "decoding" : "analyzing" }));
        await loadSongIntoDeck(deckId, song, file);
      } catch (err) {
        setDeck(deckId, { status: "error", error: (err as Error).message || "Could not decode this file" });
      }
    },

    clearDeck: (deckId) => {
      engine.stop();
      engine.invalidateDeck(deckId);
      set((s) => {
        const clips = s.project.clips.filter((c) => c.deckId !== deckId);
        const foundation = s.project.foundation?.deckId === deckId ? null : s.project.foundation;
        return { decks: { ...s.decks, [deckId]: emptyDeck(deckId) }, project: { ...s.project, clips, foundation }, playing: false, previewDeck: null, selectedClipIds: [] };
      });
      refreshSuggestions();
    },

    startOver: () => {
      engine.stop();
      engine.invalidateAll();
      history.past = [];
      history.future = [];
      if (autosaveTimer) window.clearTimeout(autosaveTimer);
      clipboard = [];
      set({
        decks: { A: emptyDeck("A"), B: emptyDeck("B") },
        project: { masterBpm: 120, foundation: null, clips: [], lengthBars: 16, loop: true, automation: emptyAutomation(), cues: [], loopRegion: null },
        playing: false,
        previewDeck: null,
        auditioning: false,
        soloClipId: null,
        levelTrims: {},
        selectedClipIds: [],
        currentProject: null,
        dirty: false,
        canUndo: false,
        canRedo: false,
        restorable: null,
        suggestions: [],
        claudePlan: null,
        candidates: [],
        selectedCandidateId: null,
        planConstraints: {},
        claudeNotes: null,
        claudeError: null,
        planHistory: [],
      });
      try {
        window.localStorage.removeItem("songmasher.session");
      } catch {
        /* ignore */
      }
    },

    setMasterBpm: (bpm) => {
      const v = Math.max(40, Math.min(240, bpm));
      setProject({ ...get().project, masterBpm: v });
      engine.invalidateAll();
      void restartIfPlaying();
    },

    adoptDeckTempo: (deckId) => {
      const a = get().decks[deckId].analysis;
      if (a) get().setMasterBpm(a.bpm);
    },

    nudgeDownbeat: (deckId, beats) => {
      const a = get().decks[deckId].analysis;
      if (!a) return;
      applyAnalysis(deckId, regrid(a, a.bpm, a.firstDownbeat + beats * a.beatInterval));
    },

    nudgeGridMs: (deckId, ms) => {
      const a = get().decks[deckId].analysis;
      if (!a) return;
      applyAnalysis(deckId, regrid(a, a.bpm, a.firstDownbeat + ms / 1000));
    },

    scaleTempo: (deckId, factor) => {
      const a = get().decks[deckId].analysis;
      if (!a) return;
      applyAnalysis(deckId, regrid(a, a.bpm * factor, a.firstDownbeat));
    },

    setDeckBpm: (deckId, bpm) => {
      const a = get().decks[deckId].analysis;
      if (!a || !(bpm > 30 && bpm < 300)) return;
      applyAnalysis(deckId, regrid(a, bpm, a.firstDownbeat));
    },

    setFoundation: (deckId, patch) => {
      const s = get();
      const d = s.decks[deckId];
      if (!d.analysis) return;
      const prev = s.project.foundation;
      const base: Foundation =
        prev && prev.deckId === deckId ? prev : { deckId, stem: d.activeStem, startBar: 0, gain: 1 };
      const foundation = { ...base, ...patch };
      const masterBpm = prev?.deckId === deckId ? s.project.masterBpm : d.analysis.bpm;
      const onlyGain = !!prev && prev.deckId === deckId && patch && Object.keys(patch).every((k) => k === "gain");
      setProject({ ...s.project, foundation, masterBpm }, onlyGain ? "foundation-gain" : undefined);
      if (onlyGain) {
        engine.setLevel("foundation", foundation.gain);
        return;
      }
      if (masterBpm !== s.project.masterBpm) engine.invalidateAll();
      refreshSuggestions();
      void restartIfPlaying();
    },

    clearFoundation: () => {
      setProject({ ...get().project, foundation: null });
      void restartIfPlaying();
    },

    setDeckStem: (deckId, stem) => {
      setDeck(deckId, { activeStem: stem });
      set({ dirty: true });
      autosave();
    },

    setDeckPitch: (deckId, semitones) => {
      const v = Math.max(-12, Math.min(12, Math.round(semitones)));
      setDeck(deckId, { semitones: v });
      set({ dirty: true });
      autosave();
      const songId = get().decks[deckId].songId;
      if (songId) void persistSong(songId, { semitones: v });
      engine.invalidateDeck(deckId);
      refreshSuggestions();
      void restartIfPlaying();
    },

    setSelection: (deckId, sel) => setDeck(deckId, { selection: sel }),

    setSections: (deckId, sections) => {
      const d = get().decks[deckId];
      if (!d.analysis) return;
      const clean = [...sections]
        .filter((x) => x.endBar > x.startBar)
        .sort((x, y) => x.startBar - y.startBar)
        .map((x, i) => ({ ...x, startBar: Math.max(0, Math.round(x.startBar)), endBar: Math.min(d.analysis!.totalBars, Math.round(x.endBar)), cluster: x.cluster ?? i }));
      const next = { ...d.analysis, sections: clean, sectionsEdited: true };
      setDeck(deckId, { analysis: next });
      if (d.songId) void persistSong(d.songId, { analysis: next });
      refreshSuggestions();
    },

    resetSections: (deckId) => {
      const d = get().decks[deckId];
      if (!d.analysis) return;
      setDeck(deckId, { analysis: { ...d.analysis, sectionsEdited: false } });
      void refreshSections(deckId, true);
    },

    addClip: (deckId, srcBar, lengthBeats, opts) => {
      const s = get();
      const d = s.decks[deckId];
      if (!d.analysis) return;
      const lane = opts?.lane ?? 1;
      const startBeat = opts?.startBeat ?? laneEnd(s.project.clips, lane);
      const clip: Clip = {
        id: newId(),
        deckId,
        stem: opts?.stem ?? d.activeStem,
        srcBar,
        lengthBeats,
        startBeat,
        lane: Math.max(1, Math.min(CLIP_LANES, lane)),
        gain: 1,
        mode: opts?.mode ?? "layer",
      };
      const clips = [...s.project.clips, clip];
      setProject({ ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) });
      set({ selectedClipIds: [clip.id] });
      void restartIfPlaying();
    },

    repeatClip: (id) => {
      const s = get();
      const c = s.project.clips.find((x) => x.id === id);
      if (!c) return;
      const copy: Clip = { ...c, id: newId(), startBeat: c.startBeat + c.lengthBeats };
      // push later clips in this lane out of the way
      const clips = s.project.clips.map((x) =>
        x.lane === c.lane && x.startBeat >= copy.startBeat ? { ...x, startBeat: x.startBeat + c.lengthBeats } : x,
      );
      clips.push(copy);
      setProject({ ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) });
      set({ selectedClipIds: [copy.id] });
      void restartIfPlaying();
    },

    updateClip: (id, patch) => {
      const s = get();
      const clips = s.project.clips.map((c) => (c.id === id ? { ...c, ...patch } : c));
      const onlyGain = Object.keys(patch).every((k) => k === "gain") && typeof patch.gain === "number";
      setProject({ ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) }, onlyGain ? `gain:${id}` : undefined);
      if (onlyGain && typeof patch.gain === "number") {
        engine.setLevel(id, patch.gain);
        return;
      }
      void restartIfPlaying();
    },

    removeClip: (id) => {
      const s = get();
      setProject({ ...s.project, clips: s.project.clips.filter((c) => c.id !== id) });
      set({ selectedClipIds: s.selectedClipIds.filter((x) => x !== id) });
      void restartIfPlaying();
    },

    clearClips: () => {
      setProject({ ...get().project, clips: [] });
      set({ selectedClipIds: [] });
      void restartIfPlaying();
    },

    selectClip: (id, opts) => {
      if (id === null) {
        set({ selectedClipIds: [] });
        return;
      }
      const cur = get().selectedClipIds;
      if (opts?.add) set({ selectedClipIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
      else set({ selectedClipIds: [id] });
    },

    selectClips: (ids) => set({ selectedClipIds: ids }),

    selectAll: () => set({ selectedClipIds: get().project.clips.map((c) => c.id) }),

    removeSelected: () => {
      const s = get();
      if (s.selectedClipIds.length === 0) return;
      const sel = new Set(s.selectedClipIds);
      setProject({ ...s.project, clips: s.project.clips.filter((c) => !sel.has(c.id)) });
      set({ selectedClipIds: [] });
      void restartIfPlaying();
    },

    repeatSelected: () => {
      const s = get();
      if (s.selectedClipIds.length === 0) return;
      const sel = s.project.clips.filter((c) => s.selectedClipIds.includes(c.id));
      if (sel.length === 1) {
        get().repeatClip(sel[0].id);
        return;
      }
      // Repeat the whole selection as a block right after its end.
      const start = Math.min(...sel.map((c) => c.startBeat));
      const end = Math.max(...sel.map((c) => c.startBeat + c.lengthBeats));
      const span = end - start;
      const copies = sel.map((c) => ({ ...c, id: newId(), startBeat: c.startBeat + span }));
      const clips = [...s.project.clips, ...copies];
      setProject({ ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) });
      set({ selectedClipIds: copies.map((c) => c.id) });
      void restartIfPlaying();
    },

    copySelected: () => {
      const s = get();
      clipboard = s.project.clips.filter((c) => s.selectedClipIds.includes(c.id)).map((c) => ({ ...c }));
      if (clipboard.length) get().showToast(`Copied ${clipboard.length} clip${clipboard.length === 1 ? "" : "s"}`);
    },

    paste: () => {
      const s = get();
      if (clipboard.length === 0) return;
      const spb = 60 / s.project.masterBpm;
      const at = Math.round(engine.position() / spb / 4) * 4;
      const start = Math.min(...clipboard.map((c) => c.startBeat));
      const copies = clipboard.map((c) => ({ ...c, id: newId(), startBeat: at + (c.startBeat - start) }));
      const clips = [...s.project.clips, ...copies];
      setProject({ ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) });
      set({ selectedClipIds: copies.map((c) => c.id) });
      void restartIfPlaying();
    },

    moveClips: (ids, deltaBeats, deltaLane) => {
      const s = get();
      const sel = new Set(ids);
      const moving = s.project.clips.filter((c) => sel.has(c.id));
      if (moving.length === 0) return;
      const minStart = Math.min(...moving.map((c) => c.startBeat));
      const db = Math.max(-minStart, deltaBeats);
      const minLane = Math.min(...moving.map((c) => c.lane));
      const maxLane = Math.max(...moving.map((c) => c.lane));
      const dl = Math.max(1 - minLane, Math.min(CLIP_LANES - maxLane, deltaLane));
      if (db === 0 && dl === 0) return;
      const clips = s.project.clips.map((c) => (sel.has(c.id) ? { ...c, startBeat: c.startBeat + db, lane: c.lane + dl } : c));
      setProject({ ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) });
      void restartIfPlaying();
    },

    nudgeClip: (id, ms) => {
      const c = get().project.clips.find((x) => x.id === id);
      if (!c) return;
      get().updateClip(id, { offsetMs: Math.max(-500, Math.min(500, Math.round((c.offsetMs ?? 0) + ms))) });
    },

    autoAlignClip: async (id) => {
      const s = get();
      const c = s.project.clips.find((x) => x.id === id);
      if (!c) return;
      const d = s.decks[c.deckId];
      const buf = d.buffers[c.stem] ?? d.buffers.full;
      if (!d.analysis || !buf) return;
      const srcT = barToTime(d.analysis, c.srcBar);
      const off = firstOnsetOffset(buf, srcT, d.analysis.beatInterval);
      if (off === null) {
        get().showToast("No clear onset found near the start of this clip");
        return;
      }
      get().updateClip(id, { offsetMs: Math.round(off * 1000) });
      get().showToast(`Aligned: first hit moved ${off >= 0 ? "+" : ""}${Math.round(off * 1000)} ms onto the beat`);
    },

    undo: () => {
      const prev = history.past.pop();
      if (!prev) return;
      history.future.push(get().project);
      history.muted = true;
      set({ project: prev, canUndo: history.past.length > 0, canRedo: true, selectedClipIds: get().selectedClipIds.filter((id) => prev.clips.some((c) => c.id === id)) });
      history.muted = false;
      engine.invalidateAll();
      void restartIfPlaying();
    },

    redo: () => {
      const next = history.future.pop();
      if (!next) return;
      history.past.push(get().project);
      history.muted = true;
      set({ project: next, canUndo: true, canRedo: history.future.length > 0 });
      history.muted = false;
      engine.invalidateAll();
      void restartIfPlaying();
    },

    toggleMetronome: () => {
      set((s) => ({ transport: { ...s.transport, metronome: !s.transport.metronome } }));
      void restartIfPlaying();
    },

    toggleCountIn: () => set((s) => ({ transport: { ...s.transport, countIn: !s.transport.countIn } })),

    addCue: (beat, label) => {
      const s = get();
      const spb = 60 / s.project.masterBpm;
      const b = Math.max(0, Math.round((beat ?? engine.position() / spb) * 4) / 4);
      const cue: CuePoint = { id: newId(), beat: b, label: label ?? `Cue ${s.project.cues.length + 1}` };
      setProject({ ...s.project, cues: [...s.project.cues, cue].sort((x, y) => x.beat - y.beat) });
    },

    updateCue: (id, patch) => {
      const s = get();
      setProject({ ...s.project, cues: s.project.cues.map((c) => (c.id === id ? { ...c, ...patch } : c)).sort((x, y) => x.beat - y.beat) });
    },

    removeCue: (id) => {
      const s = get();
      setProject({ ...s.project, cues: s.project.cues.filter((c) => c.id !== id) });
    },

    setLoopRegion: (region) => {
      const s = get();
      const r = region && region.endBeat - region.startBeat >= 1 ? { startBeat: Math.max(0, region.startBeat), endBeat: Math.min(s.project.lengthBars * 4, region.endBeat) } : null;
      setProject({ ...s.project, loopRegion: r });
      void restartIfPlaying();
    },

    loopSelected: () => {
      const s = get();
      const sel = s.project.clips.filter((c) => s.selectedClipIds.includes(c.id));
      if (sel.length === 0) {
        get().setLoopRegion(null);
        return;
      }
      get().setLoopRegion({ startBeat: Math.min(...sel.map((c) => c.startBeat)), endBeat: Math.max(...sel.map((c) => c.startBeat + c.lengthBeats)) });
    },

    setAutomation: (param, points) => {
      const s = get();
      const sorted = [...points].sort((a, b) => a.beat - b.beat);
      setProject({ ...s.project, automation: { ...s.project.automation, [param]: sorted } });
      void restartIfPlaying();
    },

    setLengthBars: (n) => {
      const s = get();
      const v = Math.max(1, Math.min(256, Math.round(n)));
      setProject({ ...s.project, lengthBars: growToFit(s.project.clips, v) });
      void restartIfPlaying();
    },

    toggleLoop: () => {
      setProject({ ...get().project, loop: !get().project.loop });
      void restartIfPlaying();
    },

    setLevelMatch: (on) => {
      setProject({ ...get().project, levelMatch: on });
      if (!on) set({ levelTrims: {} });
      void restartIfPlaying();
    },

    setZoom: (z) => set({ zoom: Math.max(4, Math.min(60, z)) }),

    separateQuick: async (deckId) => {
      const d = get().decks[deckId];
      const full = d.buffers.full;
      if (!full) return;
      setDeck(deckId, { stemBusy: true, stemProgress: "Splitting centre & sides" });
      try {
        const res = await runQuickStems(audioBufferToChannels(full), full.sampleRate);
        const ctx = getAudioContext();
        const instrumental = channelsToAudioBuffer(ctx, res.instrumental, full.sampleRate);
        const vocals = channelsToAudioBuffer(ctx, res.vocals, full.sampleRate);
        engine.invalidateDeck(deckId);
        setDeck(deckId, {
          buffers: { full, instrumental, vocals },
          stemSource: "quick",
          stemBusy: false,
          stemProgress: "",
        });
        if (d.songId && d.stemSource !== "ai") void persistSong(d.songId, { stemSource: "quick" });
        get().showToast(`Quick stems ready for ${d.name}`);
        void restartIfPlaying();
      } catch (err) {
        setDeck(deckId, { stemBusy: false, stemProgress: "" });
        get().showToast(`Quick stems failed: ${(err as Error).message}`);
      }
    },

    setAccessCode: (code) => {
      set({ accessCode: code });
      try {
        window.localStorage.setItem("songmasher.accessCode", code);
      } catch {
        /* ignore */
      }
    },

    changeAccessCode: () => {
      const c = window.prompt("Enter the access code for this library:", get().accessCode);
      if (c === null) return;
      get().setAccessCode(c.trim());
      void get().refreshLibrary();
    },

    separateAI: async (deckId, variant = "htdemucs") => {
      const d = get().decks[deckId];
      const full = d.buffers.full;
      if (!full || !d.songId) return;
      const song = (await lib.getSong(d.songId)) ?? (await resaveDeckSong(deckId));
      if (!song) {
        get().showToast("This song is no longer in the library and its file is gone. Add it again from the file to separate stems.");
        return;
      }
      setDeck(deckId, { stemBusy: true, stemProgress: "Uploading song" });
      try {
        const audioUrl = await ensureCloudFile(song);
        if (!audioUrl) throw new Error("The song could not be uploaded for separation");
        const code = get().accessCode;
        setDeck(deckId, { stemProgress: "Starting Demucs" });
        const startRes = await fetch("/api/stems", {
          method: "POST",
          headers: { "content-type": "application/json", "x-access-code": code },
          body: JSON.stringify({ audioUrl, variant }),
        });
        if (!startRes.ok) throw new Error((await startRes.json()).error ?? "Could not start separation");
        const { id } = await startRes.json();
        let output: Record<string, string> | null = null;
        const started = Date.now();
        while (Date.now() - started < 15 * 60 * 1000) {
          await new Promise((r) => setTimeout(r, 3000));
          const st = await fetch(`/api/stems?id=${encodeURIComponent(id)}`, { headers: { "x-access-code": code } });
          if (!st.ok) throw new Error((await st.json()).error ?? "Status check failed");
          const j = await st.json();
          setDeck(deckId, { stemProgress: `Demucs: ${j.status}${j.logs ? ` · ${j.logs}` : ""}` });
          if (j.status === "succeeded") {
            output = j.output;
            break;
          }
          if (j.status === "failed" || j.status === "canceled") throw new Error(j.error ?? "Separation failed");
        }
        if (!output) throw new Error("Separation timed out");
        const want: Record<string, string> = {};
        for (const k of lib.AI_STEM_KEYS) if (output[k]) want[k] = output[k];
        if (!want.vocals) throw new Error("No vocal stem returned");
        setDeck(deckId, { stemProgress: "Saving stems to your library" });
        const stemUrls = (await withCode((c) => cloud.cloudSaveStems(song.id, want, c))) as Partial<Record<lib.AiStemKey, string>> | undefined;
        if (!stemUrls) throw new Error("Could not save stems");
        setDeck(deckId, { stemProgress: "Downloading stems" });
        const decoded: Partial<Record<lib.AiStemKey, AudioBuffer>> = {};
        const stored: lib.AiStemKey[] = [];
        await Promise.all(
          (Object.entries(stemUrls) as [lib.AiStemKey, string][]).map(async ([k, url]) => {
            const bytes = await withCode((c) => cloud.cloudFetch(url, c));
            if (!bytes) throw new Error(`Could not download ${k}`);
            await lib.putFile(`${song.id}:${k}`, new Blob([bytes], { type: "audio/mpeg" }));
            stored.push(k);
            decoded[k] = await decodeArrayBuffer(bytes);
          }),
        );
        const buffers = buildAiBuffers(full, decoded);
        await persistSong(song.id, { stemSource: "ai", aiStems: stored, stemUrls, cloud: true }, true);
        engine.invalidateDeck(deckId);
        setDeck(deckId, { buffers, stemSource: "ai", stemBusy: false, stemProgress: "" });
        void computeVocalProfile(deckId);
        get().showToast(`AI stems ready for ${d.name}`);
        void restartIfPlaying();
      } catch (err) {
        setDeck(deckId, { stemBusy: false, stemProgress: "" });
        get().showToast(`AI stems failed: ${(err as Error).message}`);
      }
    },

    play: async (from?: number) => {
      const s = get();
      const decks = engineDecks(s.decks);
      if (Object.keys(decks).length === 0) return;
      const start = typeof from === "number" ? from : engine.position();
      set({ previewDeck: null, soloClipId: null, busy: { label: "Syncing", value: 0 } });
      try {
        engine.onEnded = () => set({ playing: false });
        await engine.play(s.project, decks, start, s.transport, (label, value) => set({ busy: { label, value } }));
        set({ playing: true, busy: null, levelTrims: engine.trimsDb() });
      } catch (err) {
        set({ busy: null, playing: false });
        get().showToast(`Playback failed: ${(err as Error).message}`);
      }
    },

    pause: () => {
      engine.stop();
      set({ playing: false, previewDeck: null, soloClipId: null });
    },

    stop: () => {
      engine.stop();
      set({ playing: false, previewDeck: null, soloClipId: null });
      engine.seek(0);
    },

    seek: (sec) => {
      const s = get();
      if (s.playing && !s.previewDeck) void get().play(sec);
      else engine.seek(sec);
    },

    previewSelection: async (deckId) => {
      const s = get();
      const d = s.decks[deckId];
      if (!d.analysis || !d.selection) return;
      const decks = engineDecks(s.decks);
      const project: Project = {
        masterBpm: s.project.masterBpm,
        foundation: null,
        clips: [
          { id: "preview", deckId, stem: d.activeStem, srcBar: d.selection.startBar, lengthBeats: d.selection.lengthBeats, startBeat: 0, lane: 1, gain: 1 },
        ],
        lengthBars: Math.max(1, d.selection.lengthBeats / 4),
        loop: true,
        automation: emptyAutomation(),
        cues: [],
        loopRegion: null,
      };
      set({ busy: { label: "Syncing", value: 0 }, previewDeck: deckId, soloClipId: null });
      try {
        engine.onEnded = () => set({ playing: false, previewDeck: null });
        await engine.play(project, decks, 0, { metronome: false, countIn: false }, (label, value) => set({ busy: { label, value } }));
        set({ playing: true, busy: null });
      } catch (err) {
        set({ busy: null, playing: false, previewDeck: null });
        get().showToast(`Preview failed: ${(err as Error).message}`);
      }
    },

    exportMix: async (opts) => {
      const o: ExportOptions = { format: "wav", range: "all", normalize: false, ...opts };
      const s = get();
      const decks = engineDecks(s.decks);
      if (Object.keys(decks).length === 0) return;
      set({ busy: { label: "Rendering", value: 0 } });
      try {
        const win = o.range === "loop" && s.project.loopRegion ? playWindow(s.project) : { start: 0, end: playWindow({ ...s.project, loopRegion: null }).end };
        const { channels, sampleRate } = await engine.renderRange(s.project, decks, win.start, win.end, (label, value) => set({ busy: { label, value } }));
        const { finalizeMix } = await import("./audio/master");
        const blob = await finalizeMix(channels, sampleRate, o, (label, value) => set({ busy: { label, value } }));
        const names = ["A", "B"].map((id) => s.decks[id as DeckId].name).filter(Boolean).join(" x ") || "mashup";
        if (o.save) {
          const id = lib.randomId();
          const songNames = ["A", "B"].map((d) => s.decks[d as DeckId].name).filter(Boolean);
          const mix: LibraryMix = { id, name: s.currentProject?.name ?? names, createdAt: Date.now(), durationSec: win.end - win.start, format: o.format, size: blob.size, songNames };
          await lib.putFile(`mix:${id}`, blob);
          await lib.putMix(mix);
          set({ mixes: [mix, ...get().mixes] });
          if (get().config.cloud) {
            set({ busy: { label: "Uploading mix", value: 0.95 } });
            try {
              const url = await withCode((code) => cloud.cloudUploadMix(id, blob, o.format, code));
              if (url) {
                const rec = { ...mix, url, cloud: true };
                await lib.putMix(rec);
                await withCode((code) => cloud.cloudPutKind("mixes", rec, code));
                set({ mixes: get().mixes.map((x) => (x.id === id ? rec : x)) });
                const link = `${window.location.origin}/m/${id}`;
                try {
                  await navigator.clipboard.writeText(link);
                  get().showToast("Saved to library · share link copied");
                } catch {
                  get().showToast("Saved to library · use Share on the mix to copy its link");
                }
              }
            } catch (err) {
              get().showToast(`Saved locally, but the upload failed: ${(err as Error).message}`);
            }
          } else get().showToast("Saved to library");
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${names} - SongMasher.${o.format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        if (!o.save) get().showToast(`Mashup exported as ${o.format.toUpperCase()}`);
      } catch (err) {
        get().showToast(`Export failed: ${(err as Error).message}`);
      } finally {
        set({ busy: null });
      }
    },

    applySuggestion: (action) => {
      const g = get();
      switch (action.type) {
        case "setFoundation": {
          const d = g.decks[action.deckId];
          g.setFoundation(action.deckId, { startBar: action.startBar, stem: d.buffers.instrumental ? "instrumental" : d.activeStem });
          break;
        }
        case "setPitch":
          g.setDeckPitch(action.deckId, action.semitones);
          break;
        case "addClip": {
          // Prefer the vocal stem over the beat; a full mix can only take over, so it swaps the foundation out.
          const d = g.decks[action.deckId];
          const stem: StemKey = d.buffers.vocals ? "vocals" : d.activeStem;
          const bringsDrums = stem === "full" || stem === "instrumental" || stem === "drums";
          g.addClip(action.deckId, action.srcBar, action.lengthBeats, { stem, mode: bringsDrums && g.project.foundation ? "swap" : "layer" });
          break;
        }
        case "halveTempo":
          g.scaleTempo(action.deckId, 0.5);
          break;
        case "doubleTempo":
          g.scaleTempo(action.deckId, 2);
          break;
        case "setMasterBpm":
          g.setMasterBpm(action.bpm);
          break;
      }
    },

    planMashup: (constraints) => {
      const songs = plannerSongs();
      if (!songs) return [];
      const c = constraints ?? get().planConstraints;
      const cands = planMashup(songs, c);
      // A re-search with the same constraints keeps the user's pick; changed constraints show their new best answer.
      const sameConstraints = JSON.stringify(c) === JSON.stringify(get().planConstraints);
      const prev = sameConstraints ? get().selectedCandidateId : null;
      const selected = cands.some((x) => x.id === prev) ? prev : (cands[0]?.id ?? null);
      set({ candidates: cands, selectedCandidateId: selected, planConstraints: c, claudePlan: cands.length ? { ...candidateToPlan(cands.find((x) => x.id === selected) ?? cands[0]), notes: [] } : null });
      return cands;
    },

    selectCandidate: (id) => {
      const c = get().candidates.find((x) => x.id === id);
      if (!c) return;
      const notes = get().claudeNotes;
      set({ selectedCandidateId: id, claudePlan: { ...candidateToPlan(c, notes?.choice === id ? notes.clipLabels : undefined), summary: notes?.choice === id ? notes.summary : c.description, tips: notes?.choice === id ? notes.tips : [], notes: [] } });
    },

    auditionCandidate: async (id) => {
      const s = get();
      const c = s.candidates.find((x) => x.id === id);
      if (!c) return;
      const decks = engineDecks(s.decks);
      // First hook: the foundation under the first layered vocal clip (or the first swap section)
      const first = c.clips.find((k) => k.mode === "layer") ?? c.clips[0];
      if (!first) return;
      const startBeat = Math.max(0, Math.floor(first.startBeat / 4) * 4);
      const bars = Math.max(4, Math.min(8, Math.ceil(first.lengthBeats / 4)));
      const project: Project = {
        masterBpm: c.masterBpm,
        foundation: { deckId: c.foundation.deck, stem: c.foundation.stem, startBar: c.foundation.startBar + startBeat / 4, gain: 1 },
        clips: [{ id: "audition", deckId: first.deck, stem: first.stem, srcBar: first.srcBar, lengthBeats: first.lengthBeats, startBeat: first.startBeat - startBeat, lane: 1, gain: 1, mode: first.mode }],
        lengthBars: bars,
        loop: true,
        automation: emptyAutomation(),
        cues: [],
        loopRegion: null,
      };
      // temporary pitch shift on the vocal deck for the audition
      const vd = decks[c.vocalDeck];
      const prevSemis = vd?.semitones ?? 0;
      if (vd && vd.semitones !== c.semitones) {
        vd.semitones = c.semitones;
        engine.invalidateDeck(c.vocalDeck);
      }
      set({ busy: { label: "Preparing audition", value: 0 }, auditioning: true, previewDeck: null, soloClipId: null });
      try {
        engine.onEnded = () => set({ playing: false, auditioning: false });
        await engine.play(project, decks, 0, { metronome: false, countIn: false }, (label, value) => set({ busy: { label, value } }));
        set({ playing: true, busy: null });
      } catch (err) {
        set({ busy: null, playing: false, auditioning: false });
        get().showToast(`Audition failed: ${(err as Error).message}`);
      } finally {
        if (vd && vd.semitones !== prevSemis) {
          // restore the deck's real pitch for the next normal playback
          vd.semitones = prevSemis;
          engine.invalidateDeck(c.vocalDeck);
        }
      }
    },

    soloClip: async (id) => {
      const s = get();
      if (s.soloClipId === id) {
        engine.stop();
        set({ playing: false, soloClipId: null });
        return;
      }
      const clip = s.project.clips.find((c) => c.id === id);
      if (!clip) return;
      const decks = engineDecks(s.decks);
      if (!decks[clip.deckId]) return;
      // The clip alone, from the top of a scratch arrangement: same tempo, stem, pitch, gain and fades as in the mix.
      const project: Project = {
        masterBpm: s.project.masterBpm,
        foundation: null,
        clips: [{ ...clip, startBeat: 0, mode: "layer" }],
        lengthBars: Math.max(0.25, clip.lengthBeats / 4),
        loop: false,
        automation: emptyAutomation(),
        cues: [],
        loopRegion: null,
      };
      set({ busy: { label: "Preparing clip", value: 0 }, soloClipId: id, auditioning: false, previewDeck: null });
      try {
        engine.onEnded = () => set((st) => (st.soloClipId === id ? { playing: false, soloClipId: null } : {}));
        await engine.play(project, decks, 0, { metronome: false, countIn: false }, (label, value) => set({ busy: { label, value } }));
        if (get().soloClipId !== id) return; // something else started meanwhile
        set({ playing: true, busy: null });
      } catch (err) {
        set({ busy: null, playing: false, soloClipId: null });
        get().showToast(`Could not play clip: ${(err as Error).message}`);
      }
    },

    stopAudition: () => {
      engine.stop();
      set({ playing: false, auditioning: false, soloClipId: null });
    },

    applyCandidate: (id) => {
      const c = get().candidates.find((x) => x.id === id);
      if (!c) return;
      const notes = get().claudeNotes;
      const plan = candidateToPlan(c, notes?.choice === id ? notes.clipLabels : undefined);
      set({ claudePlan: { ...plan, notes: [] } });
      get().applyClaudePlan();
    },

    askClaude: async () => {
      if (!plannerSongs()) return;
      set({ claudeBusy: true, claudeError: null, planHistory: [], claudeNotes: null });
      try {
        get().planMashup(get().planConstraints);
        await consultClaude();
        set({ claudeBusy: false });
      } catch (err) {
        set({ claudeBusy: false, claudeError: (err as Error).message });
      }
    },

    refinePlan: async (instruction) => {
      const s = get();
      const prev = s.claudePlan;
      if (!prev || !instruction.trim()) return;
      set({ claudeBusy: true, claudeError: null });
      try {
        const plan = await consultClaude(instruction.trim());
        set({ planHistory: [...get().planHistory, { instruction: instruction.trim(), plan }], claudeBusy: false });
      } catch (err) {
        set({ claudeBusy: false, claudeError: (err as Error).message });
      }
    },

    applyClaudePlan: () => {
      const s = get();
      const plan = s.claudePlan;
      if (!plan) return;
      const g = get();
      engine.stop();
      set({ playing: false, previewDeck: null });
      const checked = sanitizePlan(plan, s.decks);
      if (!checked) return;
      g.setFoundation(checked.foundation.deckId, { startBar: checked.foundation.startBar, stem: checked.foundation.stem, gain: 1 });
      if (plan.masterBpm) g.setMasterBpm(plan.masterBpm);
      if (plan.pitchShift) g.setDeckPitch(plan.pitchShift.deck, plan.pitchShift.semitones);
      const clips: Clip[] = checked.clips.map((c) => ({ ...c, id: newId() }));
      const st = get();
      // The timeline takes the plan's length (clips plus outro), never shorter than the clips need,
      // and never longer than the foundation song can supply from its start bar.
      const fDeck = st.decks[checked.foundation.deckId];
      const fa = fDeck.analysis;
      let lengthBars = Math.max(plan.lengthBars ?? 0, growToFit(clips, 8));
      if (fa) {
        const ratio = fa.bpm / st.project.masterBpm;
        const spb = 60 / st.project.masterBpm;
        const available = Math.floor(((fa.duration - barToTime(fa, checked.foundation.startBar)) * ratio) / spb / 4);
        if (available >= 8 && lengthBars > available) lengthBars = Math.max(growToFit(clips, 8), available);
      }
      // A loop region from earlier work would hold playback inside a slice of the new arrangement.
      const hadRegion = !!st.project.loopRegion;
      setProject({ ...st.project, clips, lengthBars, loopRegion: null, cues: st.project.cues.filter((c) => c.beat <= lengthBars * 4) });
      set({ selectedClipIds: [] });
      engine.seek(0);
      g.showToast(`${checked.notes.length ? "Applied the plan with a few rule fixes" : "Applied the plan"} · ${lengthBars} bars${hadRegion ? " · loop region cleared" : ""}`);
    },
  } satisfies Store;

  return storeImpl;
});

export function deckSourceTime(deckId: DeckId, position: number): number | null {
  const s = useStore.getState();
  const d = s.decks[deckId];
  if (!d.analysis) return null;
  if (s.previewDeck) {
    if (s.previewDeck !== deckId || !d.selection) return null;
    const ratio = d.analysis.bpm / s.project.masterBpm;
    return barToTime(d.analysis, d.selection.startBar) + position / ratio;
  }
  const pos = engine.sourcePositions(s.project, engineDecks(s.decks), position)[deckId];
  return pos ? pos.time : null;
}
