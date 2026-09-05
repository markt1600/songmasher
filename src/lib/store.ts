"use client";
import { create } from "zustand";
import { barToTime, type SongAnalysis } from "./audio/analysis";
import { audioBufferToChannels, channelsToAudioBuffer } from "./audio/wav";
import { decodeArrayBuffer, decodeFile, getAudioContext, toMono } from "./engine/context";
import { Engine, type EngineDecks } from "./engine/engine";
import { runAnalysis, runQuickStems } from "./workers";
import { CLIP_LANES, type Clip, type DeckId, type DeckState, type Foundation, type Project, type StemKey } from "./types";
import { computeSuggestions, type Suggestion, type SuggestionAction } from "./advisor";
import { describeSong, sanitizePlan } from "./planRules";
import * as lib from "./library";
import type { LibrarySong } from "./library";
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
  /** edits the app's own rules made to the plan */
  notes?: string[];
}

interface Store {
  decks: Record<DeckId, DeckState>;
  project: Project;
  playing: boolean;
  previewDeck: DeckId | null;
  busy: { label: string; value: number } | null;
  selectedClipId: string | null;
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

  loadConfig: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
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
  selectClip: (id: string | null) => void;
  setLengthBars: (n: number) => void;
  toggleLoop: () => void;
  setZoom: (z: number) => void;
  separateQuick: (deckId: DeckId) => Promise<void>;
  separateAI: (deckId: DeckId) => Promise<void>;
  setAccessCode: (code: string) => void;
  changeAccessCode: () => void;
  play: (from?: number) => Promise<void>;
  pause: () => void;
  stop: () => void;
  seek: (sec: number) => void;
  previewSelection: (deckId: DeckId) => Promise<void>;
  exportMix: () => Promise<void>;
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

  const applyAnalysis = (deckId: DeckId, analysis: SongAnalysis) => {
    engine.invalidateDeck(deckId);
    setDeck(deckId, { analysis, selection: null });
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

  const storeImpl = {
    decks: { A: emptyDeck("A"), B: emptyDeck("B") },
    project: { masterBpm: 120, foundation: null, clips: [], lengthBars: 16, loop: true },
    playing: false,
    previewDeck: null,
    busy: null,
    selectedClipId: null,
    zoom: 14,
    config: { loaded: false, ai: false, cloud: false, stems: false, needCode: false },
    suggestions: [],
    claudePlan: null,
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
    },

    refreshLibrary: async () => {
      const [local, storage] = await Promise.all([lib.listSongs(), lib.storageEstimate()]);
      set({ storage });
      const cfg = get().config;
      if (!cfg.loaded || !cfg.cloud) {
        set({ library: local });
        return;
      }
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
        return { decks: { ...s.decks, [deckId]: emptyDeck(deckId) }, project: { ...s.project, clips, foundation }, playing: false, previewDeck: null };
      });
      refreshSuggestions();
    },

    setMasterBpm: (bpm) => {
      const v = Math.max(40, Math.min(240, bpm));
      set((s) => ({ project: { ...s.project, masterBpm: v } }));
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
      set({ project: { ...s.project, foundation, masterBpm } });
      const onlyGain = !!prev && prev.deckId === deckId && patch && Object.keys(patch).every((k) => k === "gain");
      if (onlyGain) {
        engine.setLevel("foundation", foundation.gain);
        return;
      }
      if (masterBpm !== s.project.masterBpm) engine.invalidateAll();
      refreshSuggestions();
      void restartIfPlaying();
    },

    clearFoundation: () => {
      set((s) => ({ project: { ...s.project, foundation: null } }));
      void restartIfPlaying();
    },

    setDeckStem: (deckId, stem) => {
      setDeck(deckId, { activeStem: stem });
    },

    setDeckPitch: (deckId, semitones) => {
      const v = Math.max(-12, Math.min(12, Math.round(semitones)));
      setDeck(deckId, { semitones: v });
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
      set({ project: { ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) }, selectedClipId: clip.id });
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
      set({ project: { ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) }, selectedClipId: copy.id });
      void restartIfPlaying();
    },

    updateClip: (id, patch) => {
      const s = get();
      const clips = s.project.clips.map((c) => (c.id === id ? { ...c, ...patch } : c));
      set({ project: { ...s.project, clips, lengthBars: growToFit(clips, s.project.lengthBars) } });
      if (Object.keys(patch).every((k) => k === "gain") && typeof patch.gain === "number") {
        engine.setLevel(id, patch.gain);
        return;
      }
      void restartIfPlaying();
    },

    removeClip: (id) => {
      const s = get();
      set({ project: { ...s.project, clips: s.project.clips.filter((c) => c.id !== id) }, selectedClipId: s.selectedClipId === id ? null : s.selectedClipId });
      void restartIfPlaying();
    },

    clearClips: () => {
      set((s) => ({ project: { ...s.project, clips: [] }, selectedClipId: null }));
      void restartIfPlaying();
    },

    selectClip: (id) => set({ selectedClipId: id }),

    setLengthBars: (n) => {
      const s = get();
      const v = Math.max(1, Math.min(256, Math.round(n)));
      set({ project: { ...s.project, lengthBars: growToFit(s.project.clips, v) } });
      void restartIfPlaying();
    },

    toggleLoop: () => {
      set((s) => ({ project: { ...s.project, loop: !s.project.loop } }));
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

    separateAI: async (deckId) => {
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
          body: JSON.stringify({ audioUrl }),
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
        await engine.play(s.project, decks, start, (label, value) => set({ busy: { label, value } }));
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
      };
      set({ busy: { label: "Syncing", value: 0 }, previewDeck: deckId });
      try {
        engine.onEnded = () => set({ playing: false, previewDeck: null });
        await engine.play(project, decks, 0, (label, value) => set({ busy: { label, value } }));
        set({ playing: true, busy: null });
      } catch (err) {
        set({ busy: null, playing: false, previewDeck: null });
        get().showToast(`Preview failed: ${(err as Error).message}`);
      }
    },

    exportMix: async () => {
      const s = get();
      const decks = engineDecks(s.decks);
      if (Object.keys(decks).length === 0) return;
      set({ busy: { label: "Rendering", value: 0 } });
      try {
        const blob = await engine.render(s.project, decks, (label, value) => set({ busy: { label, value } }));
        const a = document.createElement("a");
        const names = ["A", "B"].map((id) => s.decks[id as DeckId].name).filter(Boolean).join(" x ") || "mashup";
        a.href = URL.createObjectURL(blob);
        a.download = `${names} - SongMasher.wav`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        get().showToast("Mashup exported as WAV");
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
      set({ claudeBusy: true, claudeError: null });
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
      set({ project: { ...st.project, clips, lengthBars: growToFit(clips, 8) }, selectedClipId: null });
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
