import { integratedLufs } from "../audio/master";
import { barToTime, type SongAnalysis } from "../audio/analysis";
import { audioBufferToChannels, channelsToAudioBuffer } from "../audio/wav";
import type { AutomationPoint, Clip, DeckId, Project, StemKey, TransportOptions } from "../types";
import { runStretch } from "../workers";
import { getAudioContext } from "./context";

export interface EngineDeck {
  id: DeckId;
  analysis: SongAnalysis;
  buffers: Partial<Record<StemKey, AudioBuffer>>;
  semitones: number;
}
export type EngineDecks = Partial<Record<DeckId, EngineDeck>>;

export interface PlayEvent {
  deckId: DeckId;
  stem: StemKey;
  key: string; // processed buffer cache key
  startSec: number; // timeline seconds
  durationSec: number;
  bufferOffsetSec: number; // seconds into the processed buffer
  gain: number;
  /** level-match trim (linear) applied under the user gain; 1 when matching is off */
  trim?: number;
  fadeIn: number; // seconds
  fadeOut: number;
  clipId?: string;
}

interface Scheduled {
  nodes: AudioScheduledSourceNode[];
  disposables: AudioNode[];
  /** level nodes keyed by clip id (or "foundation") so gain can change while playing */
  levels: Map<string, GainNode[]>;
  endCtxTime: number;
}

const MIN_FADE = 0.006;

/** Level matching: every part is trimmed towards this integrated loudness before the user's own gain. */
export const LEVEL_TARGET_LUFS = -16;
/** Parts that play over the foundation (rather than replacing it) sit a little under it. */
const LAYER_OFFSET_DB: Record<StemKey, number> = { full: -4, vocals: -3, instrumental: -1, drums: -1, melodic: -3 };
const TRIM_LIMIT_DB = 12;
/** Regions quieter than this are treated as silence and left alone. */
const SILENCE_LUFS = -45;
/** Longest stretch measured for one part; a foundation's opening 90 s stands in for the whole. */
const MEASURE_MAX_SEC = 90;

export function stretchRatio(deck: EngineDeck, masterBpm: number): number {
  return deck.analysis.bpm / masterBpm;
}

function cacheKey(deck: EngineDeck, stem: StemKey, masterBpm: number): string {
  const ratio = stretchRatio(deck, masterBpm);
  const needs = Math.abs(ratio - 1) > 0.0005 || deck.semitones !== 0;
  const formant = stem === "vocals" && deck.semitones !== 0 ? ":f" : "";
  return needs ? `${deck.id}:${stem}:${ratio.toFixed(5)}:${deck.semitones}${formant}` : `${deck.id}:${stem}:raw`;
}

/** Beat ranges where the foundation is audible: [0, end) minus every swap clip. */
export function foundationIntervals(clips: Clip[], endBeat: number): [number, number][] {
  const holes = clips
    .filter((c) => c.mode === "swap" && c.lengthBeats > 0)
    .map((c) => [c.startBeat, c.startBeat + c.lengthBeats] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let cursor = 0;
  for (const [h0, h1] of holes) {
    if (h1 <= cursor) continue;
    if (h0 > cursor) out.push([cursor, Math.min(h0, endBeat)]);
    cursor = Math.max(cursor, h1);
    if (cursor >= endBeat) break;
  }
  if (cursor < endBeat) out.push([cursor, endBeat]);
  return out.filter(([a, b]) => b > a);
}

export function totalSeconds(project: Project): number {
  return project.lengthBars * 4 * (60 / project.masterBpm);
}

/** The playable window in seconds: the loop region when set, otherwise the whole arrangement. */
export function playWindow(project: Project): { start: number; end: number } {
  const spb = 60 / project.masterBpm;
  const total = totalSeconds(project);
  const r = project.loopRegion;
  if (r && r.endBeat > r.startBeat) return { start: Math.max(0, r.startBeat * spb), end: Math.min(total, r.endBeat * spb) };
  return { start: 0, end: total };
}

/** Linear interpolation of an automation lane at a beat position. */
export function automationValue(points: AutomationPoint[], beat: number, fallback: number): number {
  if (points.length === 0) return fallback;
  const sorted = points;
  if (beat <= sorted[0].beat) return sorted[0].value;
  for (let i = 1; i < sorted.length; i++) {
    if (beat <= sorted[i].beat) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const t = b.beat === a.beat ? 1 : (beat - a.beat) / (b.beat - a.beat);
      return a.value + (b.value - a.value) * t;
    }
  }
  return sorted[sorted.length - 1].value;
}

/** Map the filter automation value (-1..1) to low-pass and high-pass cutoffs in Hz. */
export function filterCutoffs(v: number): { lp: number; hp: number } {
  const lp = v < 0 ? Math.max(80, 20000 * Math.pow(1 + v, 2.5)) : 20000;
  const hp = v > 0 ? Math.min(12000, 20 * Math.pow(600, v)) : 20;
  return { lp, hp };
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
    const remainingBeats = ((deck.analysis.duration - srcT) * ratio) / spb;
    const endBeat = Math.max(0, Math.min(totalBeats, remainingBeats));
    for (const [a, b] of foundationIntervals(project.clips, endBeat)) {
      const duration = (b - a) * spb;
      if (duration <= 0.01) continue;
      events.push({
        deckId: f.deckId,
        stem: f.stem,
        key: cacheKey(deck, f.stem, project.masterBpm),
        startSec: a * spb,
        durationSec: duration,
        bufferOffsetSec: srcT * ratio + a * spb,
        gain: f.gain,
        fadeIn: MIN_FADE,
        fadeOut: MIN_FADE,
      });
    }
  }
  for (const clip of project.clips) {
    const deck = decks[clip.deckId];
    if (!deck || !deck.buffers[clip.stem]) continue;
    const ratio = stretchRatio(deck, project.masterBpm);
    const srcT = barToTime(deck.analysis, clip.srcBar) + (clip.offsetMs ?? 0) / 1000;
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
      fadeIn: Math.max(MIN_FADE, (clip.fadeIn ?? 0) * spb),
      fadeOut: Math.max(MIN_FADE, (clip.fadeOut ?? 0) * spb),
      clipId: clip.id,
    });
  }
  return events;
}

function makeLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1.5;
  lim.knee.value = 0;
  lim.ratio.value = 20;
  lim.attack.value = 0.002;
  lim.release.value = 0.12;
  return lim;
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
  private win = { start: 0, end: 0 };
  private looping = false;
  private nextIterStart = 0;
  private current: { project: Project; decks: EngineDecks; events: PlayEvent[]; options: TransportOptions } | null = null;
  /** integrated loudness per source region, keyed by deck/stem/buffer/region */
  private loudness = new Map<string, number>();
  /** level-match trims (linear) by clip id or "foundation" from the last prepare() */
  private trims = new Map<string, number>();
  onEnded: (() => void) | null = null;

  get ctx(): AudioContext {
    return getAudioContext();
  }

  private ensureGraph() {
    if (!this.master) {
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      const limiter = makeLimiter(ctx);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.82;
      this.master.connect(limiter);
      limiter.connect(this.analyser);
      this.analyser.connect(ctx.destination);
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  invalidateDeck(deckId: DeckId) {
    for (const k of Array.from(this.cache.keys())) if (k.startsWith(`${deckId}:`)) this.cache.delete(k);
    for (const k of Array.from(this.loudness.keys())) if (k.startsWith(`${deckId}:`)) this.loudness.delete(k);
  }

  invalidateAll() {
    this.cache.clear();
  }

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
      const preserveFormants = ev.stem === "vocals" && deck.semitones !== 0;
      const out = await runStretch(chans, src.sampleRate, ratio, deck.semitones, (v) => onProgress?.(`Syncing ${deck.id} · ${ev.stem}`, v), preserveFormants);
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
    this.applyLevelMatch(project, decks, events);
    return events;
  }

  /** Integrated loudness of one stem's source region (song seconds), cached per region. */
  private regionLoudness(deck: EngineDeck, stem: StemKey, t0: number, t1: number): number {
    const buf = deck.buffers[stem];
    if (!buf) return SILENCE_LUFS;
    const sr = buf.sampleRate;
    const s0 = Math.max(0, Math.floor(t0 * sr));
    const s1 = Math.min(buf.length, Math.ceil(Math.min(t1, t0 + MEASURE_MAX_SEC) * sr));
    if (s1 - s0 < sr * 0.4) return SILENCE_LUFS;
    const key = `${deck.id}:${stem}:${buf.length}:${s0}:${s1}`;
    const hit = this.loudness.get(key);
    if (hit !== undefined) return hit;
    const chans: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c).subarray(s0, s1));
    const lufs = integratedLufs(chans, sr);
    this.loudness.set(key, lufs);
    return lufs;
  }

  /**
   * Level matching: measure what each part actually sounds like at its source and trim it towards a
   * common loudness, so a quiet vocal stem and a loud full mix sit together without hand-balancing.
   * The foundation is measured once over everything it plays, so its own sections keep their dynamics.
   */
  private applyLevelMatch(project: Project, decks: EngineDecks, events: PlayEvent[]) {
    this.trims.clear();
    if (project.levelMatch === false) return;
    const trimFor = (lufs: number, target: number) => {
      if (lufs <= SILENCE_LUFS) return 1;
      const db = Math.max(-TRIM_LIMIT_DB, Math.min(TRIM_LIMIT_DB, target - lufs));
      return Math.pow(10, db / 20);
    };
    const f = project.foundation;
    if (f && decks[f.deckId]) {
      const deck = decks[f.deckId]!;
      const ratio = stretchRatio(deck, project.masterBpm);
      const fEvents = events.filter((e) => !e.clipId);
      if (fEvents.length) {
        const t0 = Math.min(...fEvents.map((e) => e.bufferOffsetSec)) / ratio;
        const t1 = Math.max(...fEvents.map((e) => e.bufferOffsetSec + e.durationSec)) / ratio;
        const trim = trimFor(this.regionLoudness(deck, f.stem, t0, t1), LEVEL_TARGET_LUFS);
        for (const e of fEvents) e.trim = trim;
        this.trims.set("foundation", trim);
      }
    }
    for (const ev of events) {
      if (!ev.clipId) continue;
      const deck = decks[ev.deckId];
      if (!deck) continue;
      const clip = project.clips.find((c) => c.id === ev.clipId);
      const ratio = stretchRatio(deck, project.masterBpm);
      const t0 = ev.bufferOffsetSec / ratio;
      const t1 = t0 + ev.durationSec / ratio;
      const layered = !!f && clip?.mode !== "swap";
      const target = LEVEL_TARGET_LUFS + (layered ? LAYER_OFFSET_DB[ev.stem] : 0);
      ev.trim = trimFor(this.regionLoudness(deck, ev.stem, t0, t1), target);
      this.trims.set(ev.clipId, ev.trim);
    }
  }

  /** Level-match trims from the last prepare(), in dB by clip id (and "foundation"). */
  trimsDb(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.trims) out[k] = Math.round(20 * Math.log10(v) * 10) / 10;
    return out;
  }

  /**
   * Schedules everything that sounds between timeline seconds `from` and `to`, starting at context time `at`.
   */
  private scheduleIteration(ctx: BaseAudioContext, dest: AudioNode, events: PlayEvent[], from: number, to: number, at: number, project: Project, options: TransportOptions): Scheduled {
    const nodes: AudioScheduledSourceNode[] = [];
    const disposables: AudioNode[] = [];
    const levels = new Map<string, GainNode[]>();
    const spb = 60 / project.masterBpm;
    let endCtx = at + (to - from);

    // Foundation bus: source -> low-pass -> high-pass -> automation level -> dest
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 1.2;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.Q.value = 1.2;
    const autoLevel = ctx.createGain();
    lp.connect(hp);
    hp.connect(autoLevel);
    autoLevel.connect(dest);
    disposables.push(lp, hp, autoLevel);
    {
      const secToCtx = (sec: number) => at + (sec - from);
      const beatAt = (sec: number) => sec / spb;
      const levelPts = project.automation.level;
      const filterPts = project.automation.filter;
      const l0 = automationValue(levelPts, beatAt(from), 1);
      autoLevel.gain.setValueAtTime(l0, at);
      const c0 = filterCutoffs(automationValue(filterPts, beatAt(from), 0));
      lp.frequency.setValueAtTime(c0.lp, at);
      hp.frequency.setValueAtTime(c0.hp, at);
      for (const p of levelPts) {
        const sec = p.beat * spb;
        if (sec > from && sec <= to) autoLevel.gain.linearRampToValueAtTime(p.value, secToCtx(sec));
      }
      for (const p of filterPts) {
        const sec = p.beat * spb;
        if (sec > from && sec <= to) {
          const c = filterCutoffs(p.value);
          lp.frequency.exponentialRampToValueAtTime(c.lp, secToCtx(sec));
          hp.frequency.exponentialRampToValueAtTime(c.hp, secToCtx(sec));
        }
      }
      // hold the end value so the ramp doesn't overshoot past the window
      const lEnd = automationValue(levelPts, beatAt(to), 1);
      autoLevel.gain.linearRampToValueAtTime(lEnd, secToCtx(to));
      const cEnd = filterCutoffs(automationValue(filterPts, beatAt(to), 0));
      lp.frequency.exponentialRampToValueAtTime(cEnd.lp, secToCtx(to));
      hp.frequency.exponentialRampToValueAtTime(cEnd.hp, secToCtx(to));
    }

    for (const ev of events) {
      const buf = this.cache.get(ev.key);
      if (!buf || buf instanceof Promise) continue;
      const evEnd = ev.startSec + ev.durationSec;
      if (evEnd <= from || ev.startSec >= to) continue;
      const skip = Math.max(0, from - ev.startSec);
      const when = at + Math.max(0, ev.startSec - from);
      const offset = ev.bufferOffsetSec + skip;
      const dur = Math.min(ev.durationSec - skip, to - Math.max(ev.startSec, from));
      if (dur <= 0.01 || offset >= buf.duration) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      // fade node (0..1 click-free envelope) -> level node (user gain, adjustable live)
      const g = ctx.createGain();
      const fi = Math.min(ev.fadeIn, dur / 2);
      const fo = Math.min(ev.fadeOut, dur / 2);
      const startLevel = skip > 0 && skip < ev.fadeIn ? skip / ev.fadeIn : skip > 0 ? 1 : 0;
      g.gain.setValueAtTime(startLevel, when);
      if (skip < ev.fadeIn) g.gain.linearRampToValueAtTime(1, when + Math.max(MIN_FADE, fi - skip));
      const tailStartsAt = when + dur - fo;
      const truncated = to < evEnd; // cut by the window end, not the clip's own end
      g.gain.setValueAtTime(1, Math.max(when, truncated ? when + dur - MIN_FADE : tailStartsAt));
      g.gain.linearRampToValueAtTime(0, when + dur);
      const level = ctx.createGain();
      level.gain.value = ev.gain * (ev.trim ?? 1);
      src.connect(g);
      g.connect(level);
      level.connect(ev.clipId ? dest : lp);
      src.start(when, offset, Math.min(dur, buf.duration - offset));
      nodes.push(src);
      disposables.push(g, level);
      const key = ev.clipId ?? "foundation";
      levels.set(key, [...(levels.get(key) ?? []), level]);
      endCtx = Math.max(endCtx, when + dur);
    }

    if (options.metronome) this.scheduleClicks(ctx, dest, from, to, at, spb, nodes, disposables);
    return { nodes, disposables, levels, endCtxTime: endCtx };
  }

  private scheduleClicks(ctx: BaseAudioContext, dest: AudioNode, from: number, to: number, at: number, spb: number, nodes: AudioScheduledSourceNode[], disposables: AudioNode[]) {
    const firstBeat = Math.ceil(from / spb - 1e-6);
    for (let b = firstBeat; b * spb < to; b++) {
      const t = at + (b * spb - from);
      this.click(ctx, dest, t, b % 4 === 0, nodes, disposables);
    }
  }

  private click(ctx: BaseAudioContext, dest: AudioNode, t: number, accent: boolean, nodes: AudioScheduledSourceNode[], disposables: AudioNode[]) {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = accent ? 1760 : 1175;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(accent ? 0.22 : 0.14, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + 0.06);
    nodes.push(osc);
    disposables.push(g);
  }

  async play(project: Project, decks: EngineDecks, from: number, options: TransportOptions, onProgress?: (label: string, v: number) => void): Promise<void> {
    this.stop();
    const ctx = this.ctx;
    if (ctx.state !== "running") await ctx.resume();
    this.ensureGraph();
    const events = await this.prepare(project, decks, onProgress);
    if (!this.master) return;
    const win = playWindow(project);
    this.win = win;
    this.looping = project.loop;
    const start = from >= win.start && from < win.end - 0.01 ? from : win.start;
    const spb = 60 / project.masterBpm;
    let at = ctx.currentTime + 0.08;
    const countIn: Scheduled = { nodes: [], disposables: [], levels: new Map(), endCtxTime: 0 };
    if (options.countIn) {
      for (let i = 0; i < 4; i++) this.click(ctx, this.master, at + i * spb, i === 0, countIn.nodes, countIn.disposables);
      at += 4 * spb;
      countIn.endCtxTime = at;
      this.scheduled.push(countIn);
    }
    this.current = { project, decks, events, options };
    this.startCtxTime = at;
    this.startOffset = start;
    this.playing = true;
    this.scheduled.push(this.scheduleIteration(ctx, this.master, events, start, win.end, at, project, options));
    this.nextIterStart = at + (win.end - start);
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  private tick() {
    if (!this.playing || !this.current) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.scheduled = this.scheduled.filter((s) => {
      if (s.endCtxTime + 0.2 < now) {
        s.nodes.forEach((n) => n.disconnect());
        s.disposables.forEach((g) => g.disconnect());
        return false;
      }
      return true;
    });
    if (this.looping) {
      if (now > this.nextIterStart - 0.7) {
        const { project, events, options } = this.current;
        this.scheduled.push(this.scheduleIteration(ctx, this.master!, events, this.win.start, this.win.end, this.nextIterStart, project, options));
        this.nextIterStart += this.win.end - this.win.start;
      }
    } else if (now >= this.nextIterStart) {
      this.stop();
      this.startOffset = this.win.start;
      this.onEnded?.();
    }
  }

  position(): number {
    if (!this.playing) return this.startOffset;
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    if (elapsed < 0) return this.startOffset; // count-in
    const len = this.win.end - this.win.start;
    const p = this.startOffset + elapsed;
    if (this.looping && len > 0) return this.win.start + (((p - this.win.start) % len) + len) % len;
    return Math.min(p, this.win.end);
  }

  /** Change the level of a playing clip (or "foundation") without rescheduling. */
  setLevel(id: string, gain: number) {
    if (this.current) for (const ev of this.current.events) if ((ev.clipId ?? "foundation") === id) ev.gain = gain;
    const now = this.ctx.currentTime;
    const trim = this.trims.get(id) ?? 1;
    for (const s of this.scheduled) for (const n of s.levels.get(id) ?? []) n.gain.setTargetAtTime(gain * trim, now, 0.015);
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
      for (const g of s.levels.values())
        for (const n of g) {
          try {
            n.gain.cancelScheduledValues(now);
            n.gain.setValueAtTime(n.gain.value, now);
            n.gain.linearRampToValueAtTime(0, now + 0.02);
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

  /** Offline render of [start, end) seconds of the arrangement; returns planar channels at 44.1 kHz. */
  async renderRange(project: Project, decks: EngineDecks, start: number, end: number, onProgress?: (label: string, v: number) => void): Promise<{ channels: Float32Array[]; sampleRate: number }> {
    const events = await this.prepare(project, decks, onProgress);
    const sr = 44100;
    const len = Math.max(1, Math.ceil((end - start) * sr) + Math.floor(0.05 * sr));
    const off = new OfflineAudioContext(2, len, sr);
    const master = off.createGain();
    master.gain.value = 0.9;
    const limiter = makeLimiter(off);
    master.connect(limiter);
    limiter.connect(off.destination);
    this.scheduleIteration(off, master, events, start, end, 0.02, project, { metronome: false, countIn: false });
    onProgress?.("Rendering", 0.5);
    const rendered = await off.startRendering();
    const channels = [0, 1].map((c) => rendered.getChannelData(c).slice(0, len));
    return { channels, sampleRate: sr };
  }
}

export function clipEndBeat(c: Clip): number {
  return c.startBeat + c.lengthBeats;
}
