"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { barToTime } from "@/lib/audio/analysis";
import { engine, useStore } from "@/lib/store";
import { CLIP_LANES, DECK_COLORS, STEM_LABELS, type AutomationPoint, type Clip, type DeckId, type StemKey } from "@/lib/types";
import { automationValue, foundationIntervals } from "@/lib/engine/engine";
import { useDnd } from "@/lib/dnd";
import { Icon, Stepper } from "./ui";

const LANE_H = 62;
const AUTO_H = 56;
const RULER_H = 30;
const HEADER_W = 150;
const FADE_STEPS = [0, 0.25, 0.5, 1, 2, 4];

/** Vertical position of a lane: 0 = foundation, then the automation row, then clip lanes 1..n */
function laneTop(lane: number): number {
  return lane === 0 ? 0 : LANE_H + AUTO_H + (lane - 1) * LANE_H;
}
function laneAt(y: number): number | "auto" | null {
  if (y < 0) return null;
  if (y < LANE_H) return 0;
  if (y < LANE_H + AUTO_H) return "auto";
  const l = 1 + Math.floor((y - LANE_H - AUTO_H) / LANE_H);
  return l <= CLIP_LANES ? l : null;
}
const LANES_HEIGHT = LANE_H + AUTO_H + CLIP_LANES * LANE_H;

export default function Timeline() {
  const project = useStore((s) => s.project);
  const decks = useStore((s) => s.decks);
  const zoom = useStore((s) => s.zoom);
  const selectedClipIds = useStore((s) => s.selectedClipIds);
  const previewDeck = useStore((s) => s.previewDeck);
  const { setZoom, selectClip, updateClip, removeSelected, repeatSelected, setLengthBars, seek, clearClips, setFoundation, clearFoundation, addClip, moveClips, nudgeClip, autoAlignClip, setLoopRegion, addCue, updateCue, removeCue, loopSelected } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const register = useDnd((s) => s.register);
  const dropHover = useDnd((s) => (s.hover?.zone === "timeline" ? s.hover.info : null));
  const dragPayload = useDnd((s) => s.payload);
  const [autoParam, setAutoParam] = useState<"level" | "filter">("level");
  const totalBeats = project.lengthBars * 4;
  const width = totalBeats * zoom;
  const spb = 60 / project.masterBpm;

  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    return register("timeline", {
      el,
      accepts: ["selection"],
      resolve: (x, y, payload, altKey) => {
        if (payload.kind !== "selection") return null;
        const r = el.getBoundingClientRect();
        const lane = laneAt(y - r.top);
        if (lane === null || lane === "auto") return null;
        const rawBeat = Math.max(0, (x - r.left) / zoom - payload.lengthBeats / 2);
        const snap = altKey ? 1 : 4;
        const beat = Math.round(rawBeat / snap) * snap;
        const bars = payload.lengthBeats / 4;
        return lane === 0
          ? { lane, beat: 0, label: `Foundation from bar ${payload.srcBar + 1}` }
          : { lane, beat, label: `Lane ${lane} · bar ${Math.floor(beat / 4) + 1} · ${bars} bar${bars === 1 ? "" : "s"}` };
      },
      onDrop: (payload, info) => {
        if (payload.kind !== "selection" || info.lane === undefined) return;
        if (info.lane === 0) {
          setFoundation(payload.deckId, { startBar: payload.srcBar, stem: payload.stem });
          return;
        }
        const bringsDrums = payload.stem === "full" || payload.stem === "instrumental" || payload.stem === "drums";
        addClip(payload.deckId, payload.srcBar, payload.lengthBeats, {
          lane: info.lane,
          startBeat: info.beat ?? 0,
          stem: payload.stem,
          mode: bringsDrums && useStore.getState().project.foundation ? "swap" : "layer",
        });
      },
    });
  }, [register, zoom, setFoundation, addClip]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const z = useStore.getState().zoom;
        useStore.getState().setZoom(z * (e.deltaY < 0 ? 1.12 : 0.89));
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  useEffect(() => {
    const playheadRef = scrollRef.current?.querySelector<HTMLDivElement>("[data-playhead]");
    let raf = 0;
    const tick = () => {
      const el = playheadRef;
      if (el) {
        const st = useStore.getState();
        const beat = engine.position() / spb;
        el.style.transform = `translateX(${beat * zoom}px)`;
        el.style.opacity = st.previewDeck ? "0.25" : "1";
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

  const selected = project.clips.filter((c) => selectedClipIds.includes(c.id));
  const one = selected.length === 1 ? selected[0] : null;
  const foundationDeck = project.foundation ? decks[project.foundation.deckId] : null;
  const hasAnything = !!project.foundation || project.clips.length > 0;

  const rulerMarks = useMemo(() => {
    const marks: { beat: number; label?: string; strong: boolean }[] = [];
    const every = zoom < 8 ? 4 : zoom < 16 ? 2 : 1;
    for (let bar = 0; bar <= project.lengthBars; bar++) marks.push({ beat: bar * 4, label: bar % every === 0 ? String(bar + 1) : undefined, strong: bar % 4 === 0 });
    return marks;
  }, [project.lengthBars, zoom]);

  // Ruler interaction: click seeks, drag sets the loop region.
  const rulerDrag = useRef<{ startBeat: number; moved: boolean } | null>(null);
  const [rulerPreview, setRulerPreview] = useState<[number, number] | null>(null);
  const beatFromRuler = (e: React.PointerEvent, snap = 4) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.max(0, Math.min(totalBeats, Math.round((e.clientX - rect.left) / zoom / snap) * snap));
  };

  const region = project.loopRegion;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 min-h-[52px] py-2 border-b border-white/[0.07]">
        <div className="font-semibold text-[14px] tracking-[-0.01em] mr-1">Timeline</div>
        <span className="chip">
          <b>{project.masterBpm.toFixed(1)}</b> BPM
        </span>
        <Stepper value={project.lengthBars} min={1} max={256} step={4} onChange={setLengthBars} format={(v) => `${v}`} suffix="bars" title="Arrangement length" />
        <button className={`btn btn-sm ${region ? "text-warn border-warn/50" : ""}`} onClick={() => (region ? setLoopRegion(null) : loopSelected())} title={region ? "Clear the loop region (play the whole arrangement)" : "Loop only the selected clips (L). Or drag across the ruler."}>
          <Icon name="loop" size={11} /> {region ? `Loop bars ${Math.floor(region.startBeat / 4) + 1}–${Math.ceil(region.endBeat / 4)}` : "Loop region"}
        </button>
        <button className="btn btn-sm" onClick={() => addCue()} title="Add a cue marker at the playhead (M)">
          <Icon name="flag" size={11} /> Cue
        </button>
        <div className="flex-1" />
        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-[9px] border border-white/[0.08] bg-white/[0.05] px-2 py-1 fade-in">
            <span className="label mr-1">{selected.length === 1 ? "Clip" : `${selected.length} clips`}</span>
            {one && (
              <>
                <select className="sel" value={one.stem} onChange={(e) => updateClip(one.id, { stem: e.target.value as StemKey })} title="Stem">
                  {(Object.keys(decks[one.deckId].buffers) as StemKey[]).map((k) => (
                    <option key={k} value={k}>
                      {STEM_LABELS[k]}
                    </option>
                  ))}
                </select>
                <input type="range" min={0} max={1.5} step={0.01} value={one.gain} onChange={(e) => updateClip(one.id, { gain: parseFloat(e.target.value) })} className="w-16" title="Clip level" />
                <button className={`btn btn-sm ${one.mode === "swap" ? "text-warn border-warn/50" : ""}`} onClick={() => updateClip(one.id, { mode: one.mode === "swap" ? "layer" : "swap" })} title={one.mode === "swap" ? "Swap: the foundation is muted while this clip plays. Click to layer it instead." : "Layer: plays over the foundation. Click to swap the foundation out while this plays."}>
                  {one.mode === "swap" ? "Swaps beat" : "Layers"}
                </button>
                <FadeControl label="In" value={one.fadeIn ?? 0} onChange={(v) => updateClip(one.id, { fadeIn: v })} />
                <FadeControl label="Out" value={one.fadeOut ?? 0} onChange={(v) => updateClip(one.id, { fadeOut: v })} />
                <div className="inline-flex items-center gap-0.5" title="Nudge the clip's start inside the source, in milliseconds, to land its first hit on the beat">
                  <button className="btn btn-xs" onClick={() => nudgeClip(one.id, -5)}>
                    −5
                  </button>
                  <span className="font-mono tabular-nums text-[11px] min-w-[46px] text-center">{one.offsetMs ?? 0} ms</span>
                  <button className="btn btn-xs" onClick={() => nudgeClip(one.id, 5)}>
                    +5
                  </button>
                  <button className="btn btn-xs" onClick={() => void autoAlignClip(one.id)} title="Detect the first hit in this clip and move it onto the beat">
                    Align
                  </button>
                </div>
              </>
            )}
            <button className="btn btn-sm" onClick={repeatSelected} title="Repeat right after (D)">
              <Icon name="repeat" size={12} /> Repeat
            </button>
            <button className="btn btn-sm" onClick={() => moveClips(selectedClipIds, 0, -1)} title="Move up a lane">
              ↑
            </button>
            <button className="btn btn-sm" onClick={() => moveClips(selectedClipIds, 0, 1)} title="Move down a lane">
              ↓
            </button>
            <button className="btn btn-sm text-[#ff6b61]" onClick={removeSelected} title="Delete (⌫)">
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

      <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden relative" style={{ scrollbarGutter: "stable", WebkitOverflowScrolling: "touch" }}>
        <div className="relative" style={{ width: width + HEADER_W + 40, height: RULER_H + LANES_HEIGHT }} onPointerDown={(e) => e.target === e.currentTarget && selectClip(null)}>
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
            <div className="px-3 flex flex-col justify-center gap-1 border-b border-white/[0.06]" style={{ height: AUTO_H }}>
              <div className="label">Automation</div>
              <div className="seg self-start">
                <button data-active={autoParam === "level"} onClick={() => setAutoParam("level")} style={{ height: 20, fontSize: 11, padding: "0 7px" }} title="Foundation level over time">
                  Level
                </button>
                <button data-active={autoParam === "filter"} onClick={() => setAutoParam("filter")} style={{ height: 20, fontSize: 11, padding: "0 7px" }} title="Foundation filter sweep: below the centre is a low-pass, above is a high-pass">
                  Filter
                </button>
              </div>
            </div>
            {Array.from({ length: CLIP_LANES }).map((_, i) => (
              <div key={i} className="px-3 flex items-center border-b border-white/[0.06]" style={{ height: LANE_H }}>
                <div className="label">Clips {i + 1}</div>
              </div>
            ))}
          </div>

          {/* Ruler: click to seek, drag for loop region, cues on top */}
          <div
            className="absolute top-0 right-0 cursor-pointer select-none"
            style={{ left: HEADER_W, height: RULER_H, touchAction: "none" }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("[data-cue]")) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              rulerDrag.current = { startBeat: beatFromRuler(e), moved: false };
            }}
            onPointerMove={(e) => {
              const d = rulerDrag.current;
              if (!d) return;
              const b = beatFromRuler(e);
              if (b !== d.startBeat) d.moved = true;
              if (d.moved) setRulerPreview([Math.min(d.startBeat, b), Math.max(d.startBeat, b)]);
            }}
            onPointerUp={(e) => {
              const d = rulerDrag.current;
              rulerDrag.current = null;
              setRulerPreview(null);
              if (!d) return;
              const b = beatFromRuler(e);
              if (d.moved && Math.abs(b - d.startBeat) >= 4) setLoopRegion({ startBeat: Math.min(d.startBeat, b), endBeat: Math.max(d.startBeat, b) });
              else seek(beatFromRuler(e, 1) * spb);
            }}
          >
            {rulerMarks.map((m) => (
              <div key={m.beat} className="absolute top-0 bottom-0 border-l" style={{ left: m.beat * zoom, borderColor: m.strong ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.12)" }}>
                {m.label && <span className="absolute bottom-[3px] left-1.5 text-[10.5px] font-mono tabular-nums text-muted">{m.label}</span>}
              </div>
            ))}
            {(rulerPreview || region) && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: (rulerPreview ? rulerPreview[0] : region!.startBeat) * zoom,
                  width: ((rulerPreview ? rulerPreview[1] : region!.endBeat) - (rulerPreview ? rulerPreview[0] : region!.startBeat)) * zoom,
                  background: "rgba(255,214,10,0.18)",
                  borderLeft: "2px solid var(--warn)",
                  borderRight: "2px solid var(--warn)",
                }}
              />
            )}
            {project.cues.map((c) => (
              <div
                key={c.id}
                data-cue
                className="absolute top-0 h-[16px] pl-1 pr-1.5 rounded-br-[6px] text-[10px] font-medium text-black bg-[#9d8cff] hover:bg-[#c9bfff] whitespace-nowrap cursor-pointer z-[2]"
                style={{ left: c.beat * zoom }}
                title={`${c.label} · click to jump · double-click to rename · ⌥-click to delete`}
                onClick={(e) => {
                  if (e.altKey) removeCue(c.id);
                  else seek(c.beat * spb);
                }}
                onDoubleClick={() => {
                  const name = window.prompt("Cue name", c.label);
                  if (name !== null) updateCue(c.id, { label: name.trim() || c.label });
                }}
              >
                {c.label}
              </div>
            ))}
          </div>

          {/* Lanes */}
          <div ref={lanesRef} className="absolute right-0 bottom-0" style={{ left: HEADER_W, top: RULER_H }}>
            {rulerMarks.map((m) => (
              <div key={m.beat} className="absolute top-0 bottom-0 border-l pointer-events-none" style={{ left: m.beat * zoom, borderColor: m.strong ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)" }} />
            ))}
            <div className="absolute left-0 right-0 border-b border-white/6 pointer-events-none" style={{ top: 0, height: LANE_H, background: "rgba(255,255,255,0.015)" }} />
            <div className="absolute left-0 right-0 border-b border-white/6" style={{ top: LANE_H, height: AUTO_H }}>
              <AutomationLane param={autoParam} points={project.automation[autoParam]} zoom={zoom} totalBeats={totalBeats} />
            </div>
            {Array.from({ length: CLIP_LANES }).map((_, i) => (
              <div key={i} className="absolute left-0 right-0 border-b border-white/6 pointer-events-none" style={{ top: laneTop(i + 1), height: LANE_H }} />
            ))}
            {region && <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: region.startBeat * zoom, width: (region.endBeat - region.startBeat) * zoom, background: "rgba(255,214,10,0.04)", borderLeft: "1px dashed rgba(255,214,10,0.4)", borderRight: "1px dashed rgba(255,214,10,0.4)" }} />}
            <div className="absolute top-0 bottom-0 border-l-2 border-dashed border-white/20" style={{ left: totalBeats * zoom }} />
            {project.cues.map((c) => (
              <div key={c.id} className="absolute top-0 bottom-0 border-l border-[#9d8cff]/50 pointer-events-none" style={{ left: c.beat * zoom }} />
            ))}

            {project.foundation && foundationDeck?.analysis && (
              <FoundationBlock deckId={project.foundation.deckId} startBar={project.foundation.startBar} zoom={zoom} widthBeats={totalBeats} masterBpm={project.masterBpm} clips={project.clips} onRemove={clearFoundation} onStartBar={(b) => setFoundation(project.foundation!.deckId, { startBar: b })} />
            )}

            {project.clips.map((c) => (
              <ClipView key={c.id} clip={c} zoom={zoom} selected={selectedClipIds.includes(c.id)} selectedIds={selectedClipIds} onSelect={(add) => selectClip(c.id, { add })} onMove={(db, dl) => moveClips(selectedClipIds.includes(c.id) ? selectedClipIds : [c.id], db, dl)} onResize={(len) => updateClip(c.id, { lengthBeats: len })} onRepeat={repeatSelected} />
            ))}

            {dropHover && dragPayload?.kind === "selection" && dropHover.lane !== undefined && (
              <div
                className="absolute rounded-[8px] border-2 border-dashed pointer-events-none z-[3]"
                style={{
                  left: dropHover.lane === 0 ? 0 : (dropHover.beat ?? 0) * zoom,
                  width: dropHover.lane === 0 ? Math.max(totalBeats * zoom, 40) : dragPayload.lengthBeats * zoom,
                  top: laneTop(dropHover.lane) + 5,
                  height: LANE_H - 10,
                  borderColor: DECK_COLORS[dragPayload.deckId].main,
                  background: `${DECK_COLORS[dragPayload.deckId].main}33`,
                }}
              />
            )}
            {dragPayload?.kind === "selection" &&
              [0, ...Array.from({ length: CLIP_LANES }, (_, i) => i + 1)].map((lane) => (
                <div key={`hint-${lane}`} className="absolute left-0 right-0 pointer-events-none" style={{ top: laneTop(lane), height: LANE_H, background: dropHover?.lane === lane ? "rgba(255,255,255,0.04)" : "transparent", outline: "1px dashed rgba(255,255,255,0.12)", outlineOffset: -3 }} />
              ))}
            {!hasAnything && !dragPayload && (
              <div className="absolute inset-x-0 flex items-center justify-center text-[13px] text-muted pointer-events-none" style={{ top: laneTop(1), height: LANE_H * CLIP_LANES }}>
                Select bars on a waveform, then drag them here or press “Add to timeline”.
              </div>
            )}
          </div>

          <div data-playhead className="absolute top-0 bottom-0 w-px bg-white playhead-glow pointer-events-none z-20 will-change-transform" style={{ left: HEADER_W, opacity: previewDeck ? 0.25 : 1 }}>
            <div className="absolute -left-[5px] w-0 h-0 border-l-[5.5px] border-r-[5.5px] border-t-[8px] border-l-transparent border-r-transparent border-t-white" style={{ top: RULER_H - 9 }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function FadeControl({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const idx = Math.max(0, FADE_STEPS.findIndex((v) => v >= value));
  const fmt = (v: number) => (v === 0 ? "0" : v < 1 ? `${v}` : `${v}`);
  return (
    <div className="inline-flex items-center gap-0.5" title={`Fade ${label.toLowerCase()} length in beats`}>
      <span className="text-[10px] text-muted mr-0.5">Fade {label}</span>
      <button className="btn btn-xs" onClick={() => onChange(FADE_STEPS[Math.max(0, idx - 1)])} disabled={idx === 0}>
        −
      </button>
      <span className="font-mono tabular-nums text-[11px] min-w-[26px] text-center">{fmt(FADE_STEPS[idx])}</span>
      <button className="btn btn-xs" onClick={() => onChange(FADE_STEPS[Math.min(FADE_STEPS.length - 1, idx + 1)])} disabled={idx === FADE_STEPS.length - 1}>
        +
      </button>
    </div>
  );
}

function AutomationLane({ param, points, zoom, totalBeats }: { param: "level" | "filter"; points: AutomationPoint[]; zoom: number; totalBeats: number }) {
  const setAutomation = useStore((s) => s.setAutomation);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ index: number } | null>(null);
  const [live, setLive] = useState<AutomationPoint[] | null>(null);
  const pts = live ?? points;
  const range = param === "level" ? { min: 0, max: 1.5, def: 1 } : { min: -1, max: 1, def: 0 };
  const toY = (v: number) => AUTO_H - 6 - ((v - range.min) / (range.max - range.min)) * (AUTO_H - 12);
  const fromY = (y: number) => Math.max(range.min, Math.min(range.max, range.min + ((AUTO_H - 6 - y) / (AUTO_H - 12)) * (range.max - range.min)));
  const posOf = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const beat = Math.max(0, Math.min(totalBeats, Math.round(((e.clientX - r.left) / zoom) * 4) / 4));
    const value = fromY(e.clientY - r.top);
    return { beat, value: Math.round(value * 100) / 100 };
  };
  const path = useMemo(() => {
    const w = totalBeats * zoom;
    const samples: string[] = [];
    const steps = Math.max(2, Math.floor(w / 6));
    for (let i = 0; i <= steps; i++) {
      const beat = (i / steps) * totalBeats;
      samples.push(`${i === 0 ? "M" : "L"}${(beat * zoom).toFixed(1)},${toY(automationValue(pts, beat, range.def)).toFixed(1)}`);
    }
    return samples.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, zoom, totalBeats, param]);
  const color = param === "level" ? "#9d8cff" : "#4fd1ff";
  return (
    <div
      ref={ref}
      className="absolute inset-0"
      style={{ touchAction: "none" }}
      title={param === "level" ? "Foundation level. Double-click to add a point, drag to move, ⌥-click to delete." : "Foundation filter. Centre = off, below = low-pass (darker), above = high-pass (thinner). Double-click adds a point."}
      onDoubleClick={(e) => {
        const p = posOf(e);
        setAutomation(param, [...points, p]);
      }}
      onPointerDown={(e) => {
        const target = (e.target as HTMLElement).dataset.idx;
        if (target === undefined) return;
        const index = Number(target);
        if (e.altKey) {
          setAutomation(param, points.filter((_, i) => i !== index));
          return;
        }
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDrag({ index });
        setLive(points);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = posOf(e);
        setLive((pts) => (pts ? pts.map((q, i) => (i === drag.index ? p : q)) : pts));
      }}
      onPointerUp={() => {
        if (drag && live) setAutomation(param, live);
        setDrag(null);
        setLive(null);
      }}
    >
      <svg className="absolute inset-0 pointer-events-none" width={totalBeats * zoom} height={AUTO_H}>
        <line x1={0} x2={totalBeats * zoom} y1={toY(range.def)} y2={toY(range.def)} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 4" />
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} opacity={0.9} />
      </svg>
      {pts.map((p, i) => (
        <div
          key={i}
          data-idx={i}
          className="absolute h-3 w-3 -ml-1.5 -mt-1.5 rounded-full border-2 bg-[#101015] cursor-ns-resize hover:scale-125 transition-transform"
          style={{ left: p.beat * zoom, top: toY(p.value), borderColor: color }}
          title={`${param === "level" ? `Level ${p.value.toFixed(2)}` : p.value < 0 ? `Low-pass ${Math.round((1 + p.value) * 100)}%` : p.value > 0 ? `High-pass ${Math.round(p.value * 100)}%` : "Filter off"} @ bar ${Math.floor(p.beat / 4) + 1}`}
        />
      ))}
    </div>
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

function FoundationBlock({ deckId, startBar, zoom, widthBeats, masterBpm, clips, onRemove, onStartBar }: { deckId: DeckId; startBar: number; zoom: number; widthBeats: number; masterBpm: number; clips: Clip[]; onRemove: () => void; onStartBar: (b: number) => void }) {
  const deck = useStore((s) => s.decks[deckId]);
  const a = deck.analysis!;
  const color = DECK_COLORS[deckId];
  const ratio = a.bpm / masterBpm;
  const availableBeats = Math.max(0, ((a.duration - barToTime(a, startBar)) * ratio) / (60 / masterBpm));
  const beats = Math.min(widthBeats, availableBeats);
  const w = beats * zoom;
  const audible = foundationIntervals(clips, beats);
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const [a0, b0] of audible) {
    if (a0 > cursor) gaps.push([cursor, a0]);
    cursor = b0;
  }
  if (cursor < beats) gaps.push([cursor, beats]);
  return (
    <div className="clip cursor-default" style={{ left: 0, width: w, top: 5, height: LANE_H - 10, background: `linear-gradient(180deg, ${color.main}55, ${color.main}22)`, borderColor: `${color.main}99` }} title={`${deck.name} from bar ${startBar + 1}`}>
      <MiniWave deckId={deckId} srcBar={startBar} lengthBeats={beats} width={w} height={LANE_H - 30} />
      {gaps.map(([a0, b0]) => (
        <div key={a0} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: a0 * zoom, width: (b0 - a0) * zoom, background: "repeating-linear-gradient(135deg, rgba(0,0,0,0.55) 0 6px, rgba(0,0,0,0.35) 6px 12px)" }} title="Muted: a clip swaps the beat here" />
      ))}
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

function ClipView({ clip, zoom, selected, selectedIds, onSelect, onMove, onResize, onRepeat }: { clip: Clip; zoom: number; selected: boolean; selectedIds: string[]; onSelect: (add: boolean) => void; onMove: (deltaBeats: number, deltaLane: number) => void; onResize: (len: number) => void; onRepeat: () => void }) {
  const deck = useStore((s) => s.decks[clip.deckId]);
  const color = DECK_COLORS[clip.deckId];
  const [drag, setDrag] = useState<{ mode: "move" | "resize"; startX: number; startY: number; origLen: number } | null>(null);
  const [live, setLive] = useState<{ dBeats: number; dLane: number; len: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent, mode: "move" | "resize") => {
    e.stopPropagation();
    if (!selected || e.shiftKey || e.metaKey || e.ctrlKey) onSelect(e.shiftKey || e.metaKey || e.ctrlKey);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ mode, startX: e.clientX, startY: e.clientY, origLen: clip.lengthBeats });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dBeatsRaw = (e.clientX - drag.startX) / zoom;
    const snap = e.altKey ? 0.25 : 1;
    if (drag.mode === "move") {
      const dLane = Math.round((e.clientY - drag.startY) / LANE_H);
      setLive({ dBeats: Math.round(dBeatsRaw / snap) * snap, dLane, len: drag.origLen });
    } else {
      setLive({ dBeats: 0, dLane: 0, len: Math.max(1, Math.round((drag.origLen + dBeatsRaw) / snap) * snap) });
    }
  };
  const onPointerUp = () => {
    if (drag && live) {
      if (drag.mode === "move") onMove(live.dBeats, live.dLane);
      else if (live.len !== clip.lengthBeats) onResize(live.len);
    }
    setDrag(null);
    setLive(null);
  };

  const startBeat = Math.max(0, clip.startBeat + (live?.dBeats ?? 0));
  const lengthBeats = live?.len ?? clip.lengthBeats;
  const lane = Math.max(1, Math.min(CLIP_LANES, clip.lane + (live?.dLane ?? 0)));
  const w = lengthBeats * zoom;
  const fadeInW = (clip.fadeIn ?? 0) * zoom;
  const fadeOutW = (clip.fadeOut ?? 0) * zoom;
  void selectedIds;
  return (
    <div
      className="clip"
      data-selected={selected}
      style={{
        left: startBeat * zoom,
        width: w,
        top: laneTop(lane) + 5,
        height: LANE_H - 10,
        background: `linear-gradient(180deg, ${color.main}e6, ${color.main}99)`,
        borderColor: selected ? "white" : color.main,
        borderStyle: clip.mode === "swap" ? "dashed" : "solid",
        opacity: clip.gain === 0 ? 0.4 : 1,
      }}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onRepeat}
      title={`${deck.name} · bars ${clip.srcBar + 1}–${clip.srcBar + Math.ceil(clip.lengthBeats / 4)} · ${STEM_LABELS[clip.stem]}\nDrag to move · shift-click to multi-select · right edge resizes · double-click repeats`}
    >
      <MiniWave deckId={clip.deckId} srcBar={clip.srcBar} lengthBeats={lengthBeats} width={w} height={LANE_H - 30} />
      {fadeInW > 0 && <div className="absolute top-0 bottom-0 left-0 pointer-events-none" style={{ width: fadeInW, background: "linear-gradient(90deg, rgba(0,0,0,0.55), transparent)" }} />}
      {fadeOutW > 0 && <div className="absolute top-0 bottom-0 right-0 pointer-events-none" style={{ width: fadeOutW, background: "linear-gradient(270deg, rgba(0,0,0,0.55), transparent)" }} />}
      <div className="absolute top-1.5 left-2.5 right-3 text-[11px] flex items-center gap-1.5 text-black/85 font-medium">
        <span className="font-bold">{clip.deckId}</span>
        <span className="truncate">{deck.name}</span>
        <span className="font-mono tabular-nums opacity-70 shrink-0 text-[10px]">
          bar {clip.srcBar + 1} · {STEM_LABELS[clip.stem]}
          {clip.mode === "swap" ? " · swap" : ""}
          {clip.offsetMs ? ` · ${clip.offsetMs > 0 ? "+" : ""}${clip.offsetMs}ms` : ""}
        </span>
      </div>
      <div className="handle" onPointerDown={(e) => onPointerDown(e, "resize")} />
    </div>
  );
}
