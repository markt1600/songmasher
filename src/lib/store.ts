"use client";
import { create } from "zustand";
import { upload } from "@vercel/blob/client";
import { barToTime, type SongAnalysis } from "./audio/analysis";
import { audioBufferToChannels, channelsToAudioBuffer } from "./audio/wav";
import { decodeArrayBuffer, decodeFile, getAudioContext, toMono } from "./engine/context";
import { Engine, type EngineDecks } from "./engine/engine";
import { runAnalysis, runQuickStems } from "./workers";
import { CLIP_LANES, type Clip, type DeckId, type DeckState, type Foundation, type Project, type StemKey } from "./types";
import { computeSuggestions, type Suggestion, type SuggestionAction } from "./advisor";

export const engine = new Engine();

let idSeq = 0;
const newId = () => `c${Date.now().toString(36)}${(idSeq++).toString(36)}`;

function emptyDeck(id: DeckId): DeckState {
  return {
    id,
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
  stems: boolean;
  stemsNeedCode: boolean;
}

export interface ClaudePlan {
  summary: string;
  foundation: { deck: DeckId; startBar: number; reason: string };
  masterBpm: number;
  pitchShift: { deck: DeckId; semitones: number; reason: string } | null;
  arrangement: { deck: DeckId; srcBar: number; lengthBars: number; startBar: number; lane: number; label: string; stem: StemKey }[];
  tips: string[];
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
  stemsCode: string;

  loadConfig: () => Promise<void>;
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
  addClip: (deckId: DeckId, srcBar: number, lengthBeats: number, opts?: { lane?: number; startBeat?: number; stem?: StemKey }) => void;
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
  setStemsCode: (code: string) => void;
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
    const s = get();
    if (s.project.foundation?.deckId === deckId) {
      set({ project: { ...s.project, masterBpm: analysis.bpm } });
      engine.invalidateAll();
    }
    refreshSuggestions();
    void restartIfPlaying();
  };

  const storeImpl = {
    decks: { A: emptyDeck("A"), B: emptyDeck("B") },
    project: { masterBpm: 120, foundation: null, clips: [], lengthBars: 16, loop: true },
    playing: false,
    previewDeck: null,
    busy: null,
    selectedClipId: null,
    zoom: 14,
    config: { loaded: false, ai: false, stems: false, stemsNeedCode: false },
    suggestions: [],
    claudePlan: null,
    claudeBusy: false,
    claudeError: null,
    toast: null,
    stemsCode: "",

    showToast: (msg: string) => {
      set({ toast: msg });
      window.setTimeout(() => {
        if (get().toast === msg) set({ toast: null });
      }, 4000);
    },

    loadConfig: async () => {
      try {
        const r = await fetch("/api/config");
        const j = await r.json();
        set({ config: { loaded: true, ai: !!j.ai, stems: !!j.stems, stemsNeedCode: !!j.stemsNeedCode } });
      } catch {
        set({ config: { loaded: true, ai: false, stems: false, stemsNeedCode: false } });
      }
      try {
        const code = window.localStorage.getItem("songmasher.stemsCode") ?? "";
        set({ stemsCode: code });
      } catch {
        /* ignore */
      }
    },

    loadFile: async (deckId, file) => {
      const name = file.name.replace(/\.[^.]+$/, "");
      set((s) => ({
        decks: { ...s.decks, [deckId]: { ...emptyDeck(deckId), name, file, status: "decoding", progressLabel: "Decoding audio" } },
      }));
      engine.invalidateDeck(deckId);
      try {
        const buffer = await decodeFile(file);
        setDeck(deckId, {
          buffers: { full: buffer },
          duration: buffer.duration,
          sampleRate: buffer.sampleRate,
          status: "analyzing",
          progressLabel: "Listening for the beat",
          progress: 0.05,
        });
        const mono = toMono(buffer);
        const analysis = await runAnalysis(mono, buffer.sampleRate, (p) => {
          const labels: Record<string, string> = {
            waveform: "Drawing waveform",
            spectrum: "Listening to the spectrum",
            tempo: "Finding the tempo",
            beats: "Locking the beat grid",
            key: "Detecting the key",
            done: "Ready",
          };
          setDeck(deckId, { progress: p.value, progressLabel: labels[p.stage] ?? p.stage });
        });
        setDeck(deckId, { analysis, status: "ready", progress: 1, progressLabel: "" });
        const s = get();
        // First loaded song becomes the foundation automatically.
        if (!s.project.foundation) {
          set({
            project: {
              ...s.project,
              masterBpm: analysis.bpm,
              foundation: { deckId, stem: "full", startBar: 0, gain: 1 },
              lengthBars: Math.max(8, Math.min(s.project.lengthBars, analysis.totalBars)),
            },
          });
          engine.invalidateAll();
        }
        refreshSuggestions();
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
        get().showToast(`Quick stems ready for ${d.name}`);
        void restartIfPlaying();
      } catch (err) {
        setDeck(deckId, { stemBusy: false, stemProgress: "" });
        get().showToast(`Quick stems failed: ${(err as Error).message}`);
      }
    },

    setStemsCode: (code) => {
      set({ stemsCode: code });
      try {
        window.localStorage.setItem("songmasher.stemsCode", code);
      } catch {
        /* ignore */
      }
    },

    separateAI: async (deckId) => {
      const d = get().decks[deckId];
      const full = d.buffers.full;
      if (!full || !d.file) return;
      const code = get().stemsCode;
      setDeck(deckId, { stemBusy: true, stemProgress: "Uploading song" });
      try {
        const blob = await upload(`songmasher/${Date.now()}-${d.file.name}`, d.file, {
          access: "public",
          handleUploadUrl: "/api/stems/upload",
          clientPayload: JSON.stringify({ code }),
        });
        setDeck(deckId, { stemProgress: "Starting Demucs" });
        const startRes = await fetch("/api/stems", {
          method: "POST",
          headers: { "content-type": "application/json", "x-stems-code": code },
          body: JSON.stringify({ audioUrl: blob.url }),
        });
        if (!startRes.ok) throw new Error((await startRes.json()).error ?? "Could not start separation");
        const { id } = await startRes.json();
        let output: Record<string, string> | null = null;
        const started = Date.now();
        while (Date.now() - started < 15 * 60 * 1000) {
          await new Promise((r) => setTimeout(r, 3000));
          const st = await fetch(`/api/stems?id=${encodeURIComponent(id)}`, { headers: { "x-stems-code": code } });
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
        for (const k of ["vocals", "drums", "bass", "other"]) if (output[k]) want[k] = output[k];
        if (!want.vocals) throw new Error("No vocal stem returned");
        setDeck(deckId, { stemProgress: "Downloading stems" });
        const decoded: Record<string, AudioBuffer> = {};
        await Promise.all(
          Object.entries(want).map(async ([k, url]) => {
            const r = await fetch(`/api/stems/fetch?url=${encodeURIComponent(url)}`, { headers: { "x-stems-code": code } });
            if (!r.ok) throw new Error(`Could not download ${k}`);
            decoded[k] = await decodeArrayBuffer(await r.arrayBuffer());
          }),
        );
        const ctx = getAudioContext();
        const mix = (keys: string[]): AudioBuffer | undefined => {
          const parts = keys.map((k) => decoded[k]).filter(Boolean);
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
        const buffers: Partial<Record<StemKey, AudioBuffer>> = {
          full,
          vocals: decoded.vocals,
          instrumental: mix(["drums", "bass", "other"]),
          drums: decoded.drums,
          melodic: mix(["bass", "other"]),
        };
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
        case "setFoundation":
          g.setFoundation(action.deckId, { startBar: action.startBar });
          break;
        case "setPitch":
          g.setDeckPitch(action.deckId, action.semitones);
          break;
        case "addClip":
          g.addClip(action.deckId, action.srcBar, action.lengthBeats);
          break;
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
        const r2 = (arr: Float32Array) => Array.from(arr).map((v) => Math.round(v * 100) / 100);
        return {
          deck: id,
          name: d.name,
          bpm: Math.round(a.bpm * 10) / 10,
          key: a.key.name,
          camelot: a.key.camelot,
          durationSec: Math.round(a.duration),
          totalBars: a.totalBars,
          barEnergy: r2(a.barEnergy),
          barOnset: r2(a.barOnset),
          barVocal: r2(a.barVocal),
          stems: Object.keys(d.buffers),
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
        set({ claudePlan: j.plan as ClaudePlan, claudeBusy: false });
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
      const fDeck = s.decks[plan.foundation.deck];
      if (fDeck.analysis) g.setFoundation(plan.foundation.deck, { startBar: Math.max(0, Math.min(fDeck.analysis.totalBars - 1, plan.foundation.startBar)) });
      if (plan.masterBpm) g.setMasterBpm(plan.masterBpm);
      if (plan.pitchShift) g.setDeckPitch(plan.pitchShift.deck, plan.pitchShift.semitones);
      const clips: Clip[] = [];
      for (const seg of plan.arrangement) {
        const d = s.decks[seg.deck];
        if (!d.analysis) continue;
        const stem: StemKey = d.buffers[seg.stem] ? seg.stem : "full";
        clips.push({
          id: newId(),
          deckId: seg.deck,
          stem,
          srcBar: Math.max(0, Math.min(d.analysis.totalBars - 1, seg.srcBar)),
          lengthBeats: Math.max(4, seg.lengthBars * 4),
          startBeat: Math.max(0, seg.startBar * 4),
          lane: Math.max(1, Math.min(CLIP_LANES, seg.lane || 1)),
          gain: 1,
        });
      }
      const st = get();
      set({ project: { ...st.project, clips, lengthBars: growToFit(clips, 8) }, selectedClipId: null });
      g.showToast("Applied Claude's plan");
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
