import { barToTime, type SongAnalysis } from "../audio/analysis";
import { audioBufferToChannels, channelsToAudioBuffer, encodeWav } from "../audio/wav";
import type { Clip, DeckId, Project, StemKey } from "../types";
import { runStretch } from "../workers";
import { getAudioContext } from "./context";

export interface EngineDeck {
  id: DeckId;
  analysis: SongAnalysis;
  buffers: Partial<Record<StemKey, AudioBuffer>>;
  semitones: number;
}
export type EngineDecks = Partial<Record<DeckId, EngineDeck>>;

interface PlayEvent {
  deckId: DeckId;
  stem: StemKey;
  key: string; // processed buffer cache key
  startSec: number; // timeline seconds
  durationSec: number;
  bufferOffsetSec: number; // seconds into the processed buffer
  gain: number;
  clipId?: string;
}

interface Scheduled {
  nodes: AudioScheduledSourceNode[];
  gains: GainNode[];
  endCtxTime: number;
}

const FADE = 0.006;

export function stretchRatio(deck: EngineDeck, masterBpm: number): number {
  return deck.analysis.bpm / masterBpm;
}

function cacheKey(deck: EngineDeck, stem: StemKey, masterBpm: number): string {
  const ratio = stretchRatio(deck, masterBpm);
  const needs = Math.abs(ratio - 1) > 0.0005 || deck.semitones !== 0;
  return needs ? `${deck.id}:${stem}:${ratio.toFixed(5)}:${deck.semitones}` : `${deck.id}:${stem}:raw`;
}

export function buildEvents(project: Project, decks: EngineDecks): PlayEvent[] {
  const spb = 60 / project.masterBpm;
  const events: PlayEvent[] = [];
  const totalBeats = project.lengthBars * 4;
  const f = project.foundation;
  if (f && decks[f.deckId]?.buffers[f.stem]) {
    const deck = decks[f.deckId]!;
    const ratio = stretchRatio(deck, project.masterBpm);
    const srcT = barToTime(deck.analysis, f.startBar);
    const remaining = (deck.analysis.duration - srcT) * ratio;
    const duration = Math.max(0, Math.min(totalBeats * spb, remaining));
    if (duration > 0)
      events.push({
        deckId: f.deckId,
        stem: f.stem,
        key: cacheKey(deck, f.stem, project.masterBpm),
        startSec: 0,
        durationSec: duration,
        bufferOffsetSec: srcT * ratio,
        gain: f.gain,
      });
  }
  for (const clip of project.clips) {
    const deck = decks[clip.deckId];
    if (!deck || !deck.buffers[clip.stem]) continue;
    const ratio = stretchRatio(deck, project.masterBpm);
    const srcT = barToTime(deck.analysis, clip.srcBar);
    if (srcT < 0) continue;
    const remaining = (deck.analysis.duration - srcT) * ratio;
    const duration = Math.max(0, Math.min(clip.lengthBeats * spb, remaining, (totalBeats - clip.startBeat) * spb));
    if (duration <= 0) continue;
    events.push({
      deckId: clip.deckId,
      stem: clip.stem,
      key: cacheKey(deck, clip.stem, project.masterBpm),
      startSec: clip.startBeat * spb,
      durationSec: duration,
      bufferOffsetSec: srcT * ratio,
      gain: clip.gain,
      clipId: clip.id,
    });
  }
  return events;
}

export class Engine {
  private cache = new Map<string, AudioBuffer | Promise<AudioBuffer>>();
  private scheduled: Scheduled[] = [];
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: number | null = null;
  private playing = false;
  private startCtxTime = 0;
  private startOffset = 0;
  private loopLength = 0;
  private looping = false;
  private nextIterStart = 0;
  private current: { project: Project; decks: EngineDecks; events: PlayEvent[] } | null = null;
  onEnded: (() => void) | null = null;

  get ctx(): AudioContext {
    return getAudioContext();
  }

  private ensureGraph() {
    if (!this.master) {
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.82;
      this.master.connect(this.analyser);
      this.analyser.connect(ctx.destination);
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  invalidateDeck(deckId: DeckId) {
    for (const k of Array.from(this.cache.keys())) if (k.startsWith(`${deckId}:`)) this.cache.delete(k);
  }

  invalidateAll() {
    this.cache.clear();
  }

  /** Returns the processed (tempo-matched, pitch-shifted) buffer for an event, computing it if needed. */
  private getBuffer(ev: PlayEvent, decks: EngineDecks, masterBpm: number, onProgress?: (label: string, v: number) => void): Promise<AudioBuffer> {
    const cached = this.cache.get(ev.key);
    if (cached) return Promise.resolve(cached);
    const deck = decks[ev.deckId]!;
    const src = deck.buffers[ev.stem]!;
    if (ev.key.endsWith(":raw")) {
      this.cache.set(ev.key, src);
      return Promise.resolve(src);
    }
    const ratio = stretchRatio(deck, masterBpm);
    const p = (async () => {
      const chans = audioBufferToChannels(src);
      const out = await runStretch(chans, src.sampleRate, ratio, deck.semitones, (v) =>
        onProgress?.(`Syncing ${deck.id} · ${ev.stem}`, v),
      );
      const buf = channelsToAudioBuffer(this.ctx, out, src.sampleRate);
      this.cache.set(ev.key, buf);
      return buf;
    })();
    this.cache.set(ev.key, p);
    p.catch(() => this.cache.delete(ev.key));
    return p;
  }

  async prepare(project: Project, decks: EngineDecks, onProgress?: (label: string, v: number) => void): Promise<PlayEvent[]> {
    const events = buildEvents(project, decks);
    const keys = new Set<string>();
    const unique = events.filter((e) => (keys.has(e.key) ? false : (keys.add(e.key), true)));
    for (const ev of unique) await this.getBuffer(ev, decks, project.masterBpm, onProgress);
    return events;
  }

  private scheduleIteration(ctx: BaseAudioContext, dest: AudioNode, events: PlayEvent[], from: number, at: number, project: Project): Scheduled {
    const nodes: AudioScheduledSourceNode[] = [];
    const gains: GainNode[] = [];
    const total = project.lengthBars * 4 * (60 / project.masterBpm);
    let endCtx = at + (total - from);
    for (const ev of events) {
      const buf = this.cache.get(ev.key);
      if (!buf || buf instanceof Promise) continue;
      const evEnd = ev.startSec + ev.durationSec;
      if (evEnd <= from) continue;
      const skip = Math.max(0, from - ev.startSec);
      const when = at + Math.max(0, ev.startSec - from);
      const offset = ev.bufferOffsetSec + skip;
      const dur = ev.durationSec - skip;
      if (dur <= 0.01 || offset >= buf.duration) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(ev.gain, when + FADE);
      g.gain.setValueAtTime(ev.gain, when + dur - FADE);
      g.gain.linearRampToValueAtTime(0, when + dur);
      src.connect(g);
      g.connect(dest);
      src.start(when, offset, Math.min(dur, buf.duration - offset));
      nodes.push(src);
      gains.push(g);
      endCtx = Math.max(endCtx, when + dur);
    }
    return { nodes, gains, endCtxTime: endCtx };
  }

  async play(project: Project, decks: EngineDecks, from: number, onProgress?: (label: string, v: number) => void): Promise<void> {
    this.stop();
    const ctx = this.ctx;
    if (ctx.state !== "running") await ctx.resume();
    this.ensureGraph();
    const events = await this.prepare(project, decks, onProgress);
    if (!this.master) return;
    const total = project.lengthBars * 4 * (60 / project.masterBpm);
    this.loopLength = total;
    this.looping = project.loop;
    const start = Math.max(0, Math.min(from, total - 0.01));
    const at = ctx.currentTime + 0.08;
    this.current = { project, decks, events };
    this.startCtxTime = at;
    this.startOffset = start;
    this.playing = true;
    this.scheduled.push(this.scheduleIteration(ctx, this.master, events, start, at, project));
    this.nextIterStart = at + (total - start);
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  private tick() {
    if (!this.playing || !this.current) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // prune finished iterations
    this.scheduled = this.scheduled.filter((s) => {
      if (s.endCtxTime + 0.2 < now) {
        s.nodes.forEach((n) => n.disconnect());
        s.gains.forEach((g) => g.disconnect());
        return false;
      }
      return true;
    });
    if (this.looping) {
      if (now > this.nextIterStart - 0.7) {
        const { project, events } = this.current;
        this.scheduled.push(this.scheduleIteration(ctx, this.master!, events, 0, this.nextIterStart, project));
        this.nextIterStart += this.loopLength;
      }
    } else if (now >= this.nextIterStart) {
      this.stop();
      this.onEnded?.();
    }
  }

  position(): number {
    if (!this.playing) return this.startOffset;
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    const p = this.startOffset + elapsed;
    if (elapsed < 0) return this.startOffset;
    if (this.looping && this.loopLength > 0) return ((p % this.loopLength) + this.loopLength) % this.loopLength;
    return Math.min(p, this.loopLength);
  }

  seek(sec: number) {
    if (this.playing) return;
    this.startOffset = Math.max(0, sec);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  stop() {
    this.playing = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const now = this.ctx.currentTime;
    for (const s of this.scheduled) {
      for (const g of s.gains) {
        try {
          g.gain.cancelScheduledValues(now);
          g.gain.setValueAtTime(g.gain.value, now);
          g.gain.linearRampToValueAtTime(0, now + 0.02);
        } catch {
          /* ignore */
        }
      }
      for (const n of s.nodes) {
        try {
          n.stop(now + 0.03);
        } catch {
          /* already stopped */
        }
      }
    }
    this.scheduled = [];
  }

  /** Which source-time each deck is currently at (for waveform playheads). */
  sourcePositions(project: Project, decks: EngineDecks, position: number): Partial<Record<DeckId, { time: number; clipId?: string }>> {
    const out: Partial<Record<DeckId, { time: number; clipId?: string }>> = {};
    const events = this.current?.events ?? buildEvents(project, decks);
    for (const ev of events) {
      if (position < ev.startSec || position >= ev.startSec + ev.durationSec) continue;
      const deck = decks[ev.deckId];
      if (!deck) continue;
      const ratio = stretchRatio(deck, project.masterBpm);
      const t = (ev.bufferOffsetSec + (position - ev.startSec)) / ratio;
      if (!out[ev.deckId] || !ev.clipId) out[ev.deckId] = { time: t, clipId: ev.clipId };
    }
    return out;
  }

  async render(project: Project, decks: EngineDecks, onProgress?: (label: string, v: number) => void): Promise<Blob> {
    const events = await this.prepare(project, decks, onProgress);
    const sr = 44100;
    const total = project.lengthBars * 4 * (60 / project.masterBpm);
    const off = new OfflineAudioContext(2, Math.ceil(total * sr) + sr, sr);
    const master = off.createGain();
    master.gain.value = 0.9;
    master.connect(off.destination);
    // Buffers created on the realtime context are plain AudioBuffers and can be reused here.
    this.scheduleIteration(off, master, events, 0, 0.02, project);
    onProgress?.("Rendering", 0.5);
    const rendered = await off.startRendering();
    // trim tail
    const len = Math.ceil(total * sr) + Math.floor(0.05 * sr);
    const chans = [0, 1].map((c) => rendered.getChannelData(c).slice(0, len));
    onProgress?.("Encoding", 0.9);
    return encodeWav(chans, sr);
  }
}

export function clipEndBeat(c: Clip): number {
  return c.startBeat + c.lengthBeats;
}
