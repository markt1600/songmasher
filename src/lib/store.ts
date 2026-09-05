"use client";
import { create } from "zustand";
import { barToTime, type SongAnalysis } from "./audio/analysis";
import { audioBufferToChannels, channelsToAudioBuffer } from "./audio/wav";
import { firstOnsetOffset } from "./audio/align";
import { decodeArrayBuffer, decodeFile, getAudioContext, toMono } from "./engine/context";
import { Engine, type EngineDecks } from "./engine/engine";
import { runAnalysis, runQuickStems, runSections } from "./workers";
import { CLIP_LANES, emptyAutomation, type AutomationPoint, type Clip, type CuePoint, type DeckId, type DeckState, type DemucsVariant, type Foundation, type LoopRegion, type Project, type StemKey, type TransportOptions } from "./types";
import { playWindow } from "./engine/engine";
import { computeSuggestions, type Suggestion, type SuggestionAction } from "./advisor";
import { describeSong, sanitizePlan } from "./planRules";
import * as lib from "./library";
import type { LibraryMix, LibraryProject, LibrarySong } from "./library";
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
  arrangement: { deck: DeckId; srcBar: number; lengthBars: number; startBar: number; lane: number; label: string; stem: StemKey; mode: "layer" | "swap" }[];
  tips: string[];
  /** which songs would benefit from (better) stems, and which Demucs variant to use */
  stemAdvice?: { deck: DeckId; variant: DemucsVariant; reason: string }[];
  /** edits the app's own rules made to the plan */
  notes?: string[];
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
  setMasterBpm: (bpm: number) => void;
  adoptDeckTempo: (deckId: DeckId) => void;
  nudgeDownbeat: (deckId: DeckId, beats: number) => void;
  nudgeGridMs: (deckId: DeckId, ms: number) => void;
  scaleTempo: (deckId: DeckId, factor: number) => void;
  setDeckBpm: (deckId: DeckId, bpm: number) => void;
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
  const refreshSections = async (deckId: DeckId) => {
    const d = get().decks[deckId];
    const a = d.analysis;
    const full = d.buffers.full;
    if (!a || !full) return;
    const stamp = `${a.bpm}:${a.firstDownbeat}`;
    try {
      const sections = await runSections(toMono(full), full.sampleRate, { firstDownbeat: a.firstDownbeat, beatInterval: a.beatInterval, totalBars: a.totalBars });
      const cur = get().decks[deckId].analysis;
      if (!cur || `${cur.bpm}:${cur.firstDownbeat}` !== stamp) return; // grid changed again meanwhile
      const next = { ...cur, sections };
      setDeck(deckId, { analysis: next });
      const songId = get().decks[deckId].songId;
      if (songId) void persistSong(songId, { analysis: next });
    } catch (err) {
      console.warn("Section detection failed", err);
    }
  };

  const applyAnalysis = (deckId: DeckId, analysis: SongAnalysis) => {
    engine.invalidateDeck(deckId);
    setDeck(deckId, { analysis: { ...analysis, sections: undefined }, selection: null });
    void refreshSections(deckId);
    const songId = get().decks[deckId].songId;
    if (songId) void persistSong(songId, { analysis, bpm: analysis.bpm, keyName: analysis.key.name, camelot: analysis.key.camelot });
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
      const blob = await lib.getFile(`${song.id}:full`);
      if (!blob) return undefined;
      set({ syncing: `Uploading ${song.name}` });
      try {
        const url = await withCode((code) => cloud.cloudUploadSong(song.id, blob, song.fileName, code));
        if (!url) return undefined;
        await persistSong(song.id, { fileUrl: url, cloud: true }, true);
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
        } else if (l.cloud) {
          // deleted from another device
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
      const song = await lib.getSong(d.songId);
      if (!song) {
        get().showToast("Save the song to the library first");
        return;
      }
      setDeck(deckId, { stemBusy: true, stemProgress: "Uploading song" });
      try {
        const audioUrl = await ensureCloudFile(song);
        if (!audioUrl) throw new Error("Upload cancelled");
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
      set({ previewDeck: null, busy: { label: "Syncing", value: 0 } });
      try {
        engine.onEnded = () => set({ playing: false });
        await engine.play(s.project, decks, start, s.transport, (label, value) => set({ busy: { label, value } }));
        set({ playing: true, busy: null });
      } catch (err) {
        set({ busy: null, playing: false });
        get().showToast(`Playback failed: ${(err as Error).message}`);
      }
    },

    pause: () => {
      engine.stop();
      set({ playing: false, previewDeck: null });
    },

    stop: () => {
      engine.stop();
      set({ playing: false, previewDeck: null });
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
      set({ busy: { label: "Syncing", value: 0 }, previewDeck: deckId });
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

    askClaude: async () => {
      const s = get();
      const payload = (["A", "B"] as DeckId[]).map((id) => {
        const d = s.decks[id];
        const a = d.analysis;
        if (!a) return null;
        return {
          deck: id,
          name: d.name,
          bpm: Math.round(a.bpm * 10) / 10,
          key: a.key.name,
          camelot: a.key.camelot,
          durationSec: Math.round(a.duration),
          totalBars: a.totalBars,
          stems: Object.keys(d.buffers),
          ...describeSong(a),
        };
      });
      set({ claudeBusy: true, claudeError: null, planHistory: [] });
      try {
        const r = await fetch("/api/advise", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ songs: payload.filter(Boolean) }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Advisor failed");
        const plan = j.plan as ClaudePlan;
        const checked = sanitizePlan(plan, get().decks);
        set({ claudePlan: { ...plan, notes: checked?.notes ?? [] }, claudeBusy: false });
      } catch (err) {
        set({ claudeBusy: false, claudeError: (err as Error).message });
      }
    },

    refinePlan: async (instruction) => {
      const s = get();
      const prev = s.claudePlan;
      if (!prev || !instruction.trim()) return;
      const payload = (["A", "B"] as DeckId[]).map((id) => {
        const d = s.decks[id];
        const a = d.analysis;
        if (!a) return null;
        return { deck: id, name: d.name, bpm: Math.round(a.bpm * 10) / 10, key: a.key.name, camelot: a.key.camelot, durationSec: Math.round(a.duration), totalBars: a.totalBars, stems: Object.keys(d.buffers), ...describeSong(a) };
      });
      const history = [...s.planHistory, { instruction: instruction.trim(), plan: prev }];
      set({ claudeBusy: true, claudeError: null });
      try {
        const r = await fetch("/api/advise", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            songs: payload.filter(Boolean),
            history: history.map((h) => ({ instruction: h.instruction, plan: { ...h.plan, notes: undefined } })),
          }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Advisor failed");
        const plan = j.plan as ClaudePlan;
        const checked = sanitizePlan(plan, get().decks);
        set({ claudePlan: { ...plan, notes: checked?.notes ?? [] }, planHistory: history, claudeBusy: false });
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
      setProject({ ...st.project, clips, lengthBars: growToFit(clips, 8) });
      set({ selectedClipIds: [] });
      g.showToast(checked.notes.length ? "Applied Claude's plan (with a few rule fixes)" : "Applied Claude's plan");
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
