"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { barToTime } from "@/lib/audio/analysis";
import { engine, useStore } from "@/lib/store";
import { CLIP_LANES, DECK_COLORS, STEM_LABELS, type Clip, type DeckId, type StemKey } from "@/lib/types";
import { Icon, Stepper } from "./ui";

const LANE_H = 62;
const RULER_H = 26;
const HEADER_W = 150;

export default function Timeline() {
  const project = useStore((s) => s.project);
  const decks = useStore((s) => s.decks);
  const zoom = useStore((s) => s.zoom);
  const selectedClipId = useStore((s) => s.selectedClipId);
  const previewDeck = useStore((s) => s.previewDeck);
  const { setZoom, selectClip, updateClip, removeClip, repeatClip, setLengthBars, seek, clearClips, setFoundation, clearFoundation } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const totalBeats = project.lengthBars * 4;
  const width = totalBeats * zoom;
  const spb = 60 / project.masterBpm;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = playheadRef.current;
      if (el) {
        const st = useStore.getState();
        const beat = engine.position() / spb;
        el.style.transform = `translateX(${beat * zoom}px)`;
        el.style.opacity = st.previewDeck ? "0.25" : "1";
        // auto-scroll
        const sc = scrollRef.current;
        if (sc && st.playing && !st.previewDeck) {
          const x = beat * zoom + HEADER_W;
          if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 120);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [spb, zoom]);

  const selected = project.clips.find((c) => c.id === selectedClipId) ?? null;
  const foundationDeck = project.foundation ? decks[project.foundation.deckId] : null;
  const hasAnything = !!project.foundation || project.clips.length > 0;

  const rulerMarks = useMemo(() => {
    const marks: { beat: number; label?: string; strong: boolean }[] = [];
    const every = zoom < 8 ? 4 : zoom < 16 ? 2 : 1; // bars between labels
    for (let bar = 0; bar <= project.lengthBars; bar++) {
      marks.push({ beat: bar * 4, label: bar % every === 0 ? String(bar + 1) : undefined, strong: bar % 4 === 0 });
    }
    return marks;
  }, [project.lengthBars, zoom]);

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 h-[52px] border-b border-white/[0.07]">
        <div className="font-semibold text-[14px] tracking-[-0.01em] mr-1">Timeline</div>
        <span className="chip">
          <b>{project.masterBpm.toFixed(1)}</b> BPM
        </span>
        <Stepper value={project.lengthBars} min={1} max={256} step={4} onChange={setLengthBars} format={(v) => `${v}`} suffix="bars" title="Arrangement length" />
        <div className="flex-1" />
        {selected && (
          <div className="flex items-center gap-1.5 rounded-[9px] border border-white/[0.08] bg-white/[0.05] px-2 h-[32px] fade-in">
            <span className="label mr-1">Clip</span>
            <select className="sel" value={selected.stem} onChange={(e) => updateClip(selected.id, { stem: e.target.value as StemKey })} title="Stem">
              {(Object.keys(decks[selected.deckId].buffers) as StemKey[]).map((k) => (
                <option key={k} value={k}>
                  {STEM_LABELS[k]}
                </option>
              ))}
            </select>
            <input type="range" min={0} max={1.5} step={0.01} value={selected.gain} onChange={(e) => updateClip(selected.id, { gain: parseFloat(e.target.value) })} className="w-20" title="Clip level" />
            <button className="btn btn-sm" onClick={() => repeatClip(selected.id)} title="Repeat this clip right after itself (D)">
              <Icon name="repeat" size={12} /> Repeat
            </button>
            <button className="btn btn-sm" onClick={() => updateClip(selected.id, { lane: Math.max(1, selected.lane - 1) })} disabled={selected.lane <= 1} title="Move up a lane">
              ↑
            </button>
            <button className="btn btn-sm" onClick={() => updateClip(selected.id, { lane: Math.min(CLIP_LANES, selected.lane + 1) })} disabled={selected.lane >= CLIP_LANES} title="Move down a lane">
              ↓
            </button>
            <button className="btn btn-sm text-pink-300" onClick={() => removeClip(selected.id)} title="Delete clip (Del)">
              <Icon name="trash" size={12} />
            </button>
          </div>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => setZoom(zoom / 1.3)} title="Zoom out">
          <Icon name="zoom-out" size={14} />
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setZoom(zoom * 1.3)} title="Zoom in">
          <Icon name="zoom-in" size={14} />
        </button>
        <button className="btn btn-sm btn-ghost" onClick={clearClips} disabled={project.clips.length === 0} title="Remove all clips">
          Clear
        </button>
      </div>

      <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden relative" style={{ scrollbarGutter: "stable" }}>
        <div className="relative" style={{ width: width + HEADER_W + 40, height: RULER_H + LANE_H * (1 + CLIP_LANES) }}>
          {/* Lane headers */}
          <div className="absolute left-0 top-0 bottom-0 z-10 bg-[#101015]/95 backdrop-blur border-r border-white/[0.08]" style={{ width: HEADER_W }}>
            <div style={{ height: RULER_H }} />
            <div className="px-3 flex flex-col justify-center gap-1 border-b border-white/[0.06]" style={{ height: LANE_H }}>
              <div className="label flex items-center gap-1">
                <Icon name="anchor" size={10} /> Foundation
              </div>
              {foundationDeck ? (
                <div className="text-[12px] truncate font-medium" style={{ color: DECK_COLORS[foundationDeck.id].main }} title={foundationDeck.name}>
                  {foundationDeck.id} · {foundationDeck.name}
                </div>
              ) : (
                <div className="text-[12px] text-muted">None yet</div>
              )}
            </div>
            {Array.from({ length: CLIP_LANES }).map((_, i) => (
              <div key={i} className="px-3 flex items-center border-b border-white/[0.06]" style={{ height: LANE_H }}>
                <div className="label">Clips {i + 1}</div>
              </div>
            ))}
          </div>

          {/* Ruler */}
          <div
            className="absolute top-0 right-0 cursor-pointer"
            style={{ left: HEADER_W, height: RULER_H }}
            onPointerDown={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const beat = Math.max(0, Math.floor((e.clientX - rect.left) / zoom));
              seek(beat * spb);
            }}
          >
            {rulerMarks.map((m) => (
              <div key={m.beat} className="absolute top-0 bottom-0 border-l" style={{ left: m.beat * zoom, borderColor: m.strong ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.12)" }}>
                {m.label && <span className="absolute top-[6px] left-1.5 text-[10.5px] font-mono tabular-nums text-muted">{m.label}</span>}
              </div>
            ))}
          </div>

          {/* Grid background */}
          <div className="absolute right-0 bottom-0" style={{ left: HEADER_W, top: RULER_H }}>
            {rulerMarks.map((m) => (
              <div key={m.beat} className="absolute top-0 bottom-0 border-l pointer-events-none" style={{ left: m.beat * zoom, borderColor: m.strong ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)" }} />
            ))}
            {Array.from({ length: 1 + CLIP_LANES }).map((_, i) => (
              <div key={i} className="absolute left-0 right-0 border-b border-white/6" style={{ top: i * LANE_H, height: LANE_H, background: i === 0 ? "rgba(255,255,255,0.015)" : undefined }} />
            ))}
            {/* end marker */}
            <div className="absolute top-0 bottom-0 border-l-2 border-dashed border-white/20" style={{ left: totalBeats * zoom }} />

            {/* Foundation block */}
            {project.foundation && foundationDeck?.analysis && (
              <FoundationBlock deckId={project.foundation.deckId} startBar={project.foundation.startBar} zoom={zoom} widthBeats={totalBeats} masterBpm={project.masterBpm} onRemove={clearFoundation} onStartBar={(b) => setFoundation(project.foundation!.deckId, { startBar: b })} />
            )}

            {/* Clips */}
            {project.clips.map((c) => (
              <ClipView key={c.id} clip={c} zoom={zoom} selected={c.id === selectedClipId} onSelect={() => selectClip(c.id)} onChange={(p) => updateClip(c.id, p)} onRepeat={() => repeatClip(c.id)} />
            ))}

            {!hasAnything && (
              <div className="absolute inset-0 flex items-center justify-center text-[13px] text-muted pointer-events-none">
                Load a song, then drag across its waveform and choose “Add to timeline”.
              </div>
            )}
          </div>

          {/* Playhead */}
          <div ref={playheadRef} className="absolute top-0 bottom-0 w-px bg-white playhead-glow pointer-events-none z-20 will-change-transform" style={{ left: HEADER_W, opacity: previewDeck ? 0.25 : 1 }}>
            <div className="absolute -left-[5px] top-[6px] w-0 h-0 border-l-[5.5px] border-r-[5.5px] border-t-[8px] border-l-transparent border-r-transparent border-t-white" />
          </div>
        </div>
      </div>
    </section>
  );
}

function MiniWave({ deckId, srcBar, lengthBeats, width, height }: { deckId: DeckId; srcBar: number; lengthBeats: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const analysis = useStore((s) => s.decks[deckId].analysis);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !analysis) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const t0 = barToTime(analysis, srcBar);
    const t1 = t0 + lengthBeats * analysis.beatInterval;
    const n = analysis.peaks.length;
    const i0 = Math.max(0, Math.floor((t0 / analysis.duration) * n));
    const i1 = Math.min(n, Math.ceil((t1 / analysis.duration) * n));
    const mid = height / 2;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    const cols = Math.max(1, Math.floor(width / 2));
    for (let c = 0; c < cols; c++) {
      const j0 = i0 + Math.floor(((i1 - i0) * c) / cols);
      const j1 = Math.max(j0 + 1, i0 + Math.floor(((i1 - i0) * (c + 1)) / cols));
      let m = 0;
      for (let j = j0; j < j1 && j < n; j++) if (analysis.peaks[j] > m) m = analysis.peaks[j];
      const h = m * (mid - 2);
      ctx.rect(c * 2, mid - h, 1.4, h * 2);
    }
    ctx.fill();
  }, [analysis, srcBar, lengthBeats, width, height]);
  return <canvas ref={ref} style={{ width, height }} className="absolute inset-x-0 bottom-0 pointer-events-none opacity-70" />;
}

function FoundationBlock({ deckId, startBar, zoom, widthBeats, masterBpm, onRemove, onStartBar }: { deckId: DeckId; startBar: number; zoom: number; widthBeats: number; masterBpm: number; onRemove: () => void; onStartBar: (b: number) => void }) {
  const deck = useStore((s) => s.decks[deckId]);
  const a = deck.analysis!;
  const color = DECK_COLORS[deckId];
  const ratio = a.bpm / masterBpm;
  const availableBeats = Math.max(0, ((a.duration - barToTime(a, startBar)) * ratio) / (60 / masterBpm));
  const beats = Math.min(widthBeats, availableBeats);
  const w = beats * zoom;
  return (
    <div
      className="clip cursor-default"
      style={{ left: 0, width: w, top: 5, height: LANE_H - 10, background: `linear-gradient(180deg, ${color.main}55, ${color.main}22)`, borderColor: `${color.main}99` }}
      title={`${deck.name} from bar ${startBar + 1}`}
    >
      <MiniWave deckId={deckId} srcBar={startBar} lengthBeats={beats} width={w} height={LANE_H - 30} />
      <div className="absolute top-1.5 left-2.5 right-2 flex items-center gap-2 text-[11px]">
        <span className="font-bold" style={{ color: color.main }}>
          {deckId}
        </span>
        <span className="truncate font-medium">{deck.name}</span>
        <span className="text-text-2 font-mono tabular-nums">from bar {startBar + 1}</span>
        <span className="flex-1" />
        <button className="text-muted hover:text-text" onClick={() => onStartBar(Math.max(0, startBar - 4))} title="Start 4 bars earlier">
          <Icon name="chev-left" size={12} />
        </button>
        <button className="text-muted hover:text-text" onClick={() => onStartBar(Math.min(a.totalBars - 1, startBar + 4))} title="Start 4 bars later">
          <Icon name="chev-right" size={12} />
        </button>
        <button className="text-muted hover:text-text" onClick={onRemove} title="Remove foundation">
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  );
}

function ClipView({ clip, zoom, selected, onSelect, onChange, onRepeat }: { clip: Clip; zoom: number; selected: boolean; onSelect: () => void; onChange: (p: Partial<Clip>) => void; onRepeat: () => void }) {
  const deck = useStore((s) => s.decks[clip.deckId]);
  const color = DECK_COLORS[clip.deckId];
  const [drag, setDrag] = useState<{ mode: "move" | "resize"; startX: number; startY: number; origBeat: number; origLen: number; origLane: number } | null>(null);
  const [live, setLive] = useState<{ startBeat: number; lengthBeats: number; lane: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent, mode: "move" | "resize") => {
    e.stopPropagation();
    onSelect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ mode, startX: e.clientX, startY: e.clientY, origBeat: clip.startBeat, origLen: clip.lengthBeats, origLane: clip.lane });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dBeats = (e.clientX - drag.startX) / zoom;
    const snap = e.altKey ? 0.25 : 1;
    if (drag.mode === "move") {
      const lane = Math.max(1, Math.min(CLIP_LANES, drag.origLane + Math.round((e.clientY - drag.startY) / LANE_H)));
      setLive({ startBeat: Math.max(0, Math.round((drag.origBeat + dBeats) / snap) * snap), lengthBeats: drag.origLen, lane });
    } else {
      setLive({ startBeat: drag.origBeat, lengthBeats: Math.max(1, Math.round((drag.origLen + dBeats) / snap) * snap), lane: drag.origLane });
    }
  };
  const onPointerUp = () => {
    if (drag && live) onChange(live);
    setDrag(null);
    setLive(null);
  };

  const startBeat = live?.startBeat ?? clip.startBeat;
  const lengthBeats = live?.lengthBeats ?? clip.lengthBeats;
  const lane = live?.lane ?? clip.lane;
  const w = lengthBeats * zoom;
  return (
    <div
      className="clip"
      data-selected={selected}
      style={{
        left: startBeat * zoom,
        width: w,
        top: lane * LANE_H + 5,
        bottom: "auto",
        height: LANE_H - 10,
        background: `linear-gradient(180deg, ${color.main}e6, ${color.main}99)`,
        borderColor: selected ? "white" : color.main,
        opacity: clip.gain === 0 ? 0.4 : 1,
      }}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onRepeat}
      title={`${deck.name} · bars ${clip.srcBar + 1}–${clip.srcBar + Math.ceil(clip.lengthBeats / 4)} · ${STEM_LABELS[clip.stem]}\nDrag to move · drag right edge to resize · double-click to repeat`}
    >
      <MiniWave deckId={clip.deckId} srcBar={clip.srcBar} lengthBeats={lengthBeats} width={w} height={LANE_H - 22} />
      <div className="absolute top-1 left-2 right-3 text-[0.66rem] flex items-center gap-1.5 text-black/85 font-medium">
        <span className="font-bold">{clip.deckId}</span>
        <span className="truncate">{deck.name}</span>
        <span className="font-mono tabular-nums opacity-70 shrink-0 text-[10px]">
          bar {clip.srcBar + 1} · {STEM_LABELS[clip.stem]}
        </span>
      </div>
      <div className="handle" onPointerDown={(e) => onPointerDown(e, "resize")} />
    </div>
  );
}
