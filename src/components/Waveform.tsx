"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { timeToBar, barToTime, type SongAnalysis } from "@/lib/audio/analysis";
import type { SectionLabel } from "@/lib/audio/sections";
import { deckSourceTime, engine, useStore } from "@/lib/store";
import { DECK_COLORS, type DeckId } from "@/lib/types";
import { beginDragOnMove } from "@/lib/dnd";
import { Icon } from "./ui";

interface Props {
  deckId: DeckId;
  analysis: SongAnalysis;
  height?: number;
}

const RULER = 18;
const SECTIONS_H = 16;
const TOP = RULER + SECTIONS_H;

export const SECTION_COLORS: Record<SectionLabel, string> = {
  Intro: "#8e8e99",
  Verse: "#4fd1ff",
  Chorus: "#ff5fa8",
  Bridge: "#ffd60a",
  Break: "#30d158",
  Outro: "#8e8e99",
};

/** Bar position shown as "9" or "9.3" (bar.beat) when fractional. */
export function fmtBar(bar: number): string {
  const whole = Math.floor(bar + 1e-6);
  const beat = Math.round((bar - whole) * 4);
  return beat === 0 ? `${whole + 1}` : `${whole + 1}.${beat + 1}`;
}

export default function Waveform({ deckId, analysis, height = 176 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const selection = useStore((s) => s.decks[deckId].selection);
  const setSelection = useStore((s) => s.setSelection);
  const deckName = useStore((s) => s.decks[deckId].name);
  const activeStem = useStore((s) => s.decks[deckId].activeStem);
  const buffer = useStore((s) => s.decks[deckId].buffers.full);
  const foundation = useStore((s) => s.project.foundation);
  const [width, setWidth] = useState(600);
  // View window keyed by the song it belongs to, so a new song always starts fitted.
  const [viewState, setViewState] = useState<{ dur: number; start: number; end: number }>({ dur: analysis.duration, start: 0, end: analysis.duration });
  const view = useMemo(() => (viewState.dur === analysis.duration ? { start: viewState.start, end: viewState.end } : { start: 0, end: analysis.duration }), [viewState, analysis.duration]);
  const setView = useCallback((v: { start: number; end: number }) => setViewState({ dur: analysis.duration, ...v }), [analysis.duration]);
  const dragRef = useRef<{ anchorBar: number; moved: boolean } | null>(null);
  const [hoverBar, setHoverBar] = useState<number | null>(null);
  const color = DECK_COLORS[deckId];
  const zoomed = view.end - view.start < analysis.duration - 1e-3;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const span = view.end - view.start;
  const pxPerSec = width / span;
  const xOf = useCallback((t: number) => (t - view.start) * pxPerSec, [view.start, pxPerSec]);
  const tOf = useCallback((x: number) => view.start + x / pxPerSec, [view.start, pxPerSec]);
  const beatPx = analysis.beatInterval * pxPerSec;
  const snap = beatPx >= 14 ? 0.25 : 1; // beats when zoomed in enough, else bars

  const xToBar = useCallback(
    (x: number) => {
      const bar = timeToBar(analysis, tOf(x));
      return Math.max(0, Math.min(analysis.totalBars - snap, Math.floor(bar / snap) * snap));
    },
    [analysis, tOf, snap],
  );

  // Visible waveform columns: overview arrays when zoomed out, real samples when zoomed in.
  const columns = useMemo(() => {
    const cols = Math.max(1, Math.floor(width));
    const peaks = new Float32Array(cols);
    const rms = new Float32Array(cols);
    const n = analysis.peaks.length;
    const bucketsPerSec = n / analysis.duration;
    const secPerCol = span / cols;
    if (!zoomed || !buffer || secPerCol * bucketsPerSec >= 1) {
      for (let c = 0; c < cols; c++) {
        const t0 = view.start + c * secPerCol;
        const i0 = Math.floor(t0 * bucketsPerSec);
        const i1 = Math.max(i0 + 1, Math.floor((t0 + secPerCol) * bucketsPerSec));
        let m = 0;
        let r = 0;
        let k = 0;
        for (let i = i0; i < i1 && i < n; i++) {
          if (analysis.peaks[i] > m) m = analysis.peaks[i];
          r += analysis.rms[i];
          k++;
        }
        peaks[c] = m;
        rms[c] = k ? r / k : 0;
      }
      return { peaks, rms };
    }
    const sr = buffer.sampleRate;
    const chs = buffer.numberOfChannels;
    const data = Array.from({ length: chs }, (_, ch) => buffer.getChannelData(ch));
    for (let c = 0; c < cols; c++) {
      const s0 = Math.max(0, Math.floor((view.start + c * secPerCol) * sr));
      const s1 = Math.min(buffer.length, Math.max(s0 + 1, Math.floor((view.start + (c + 1) * secPerCol) * sr)));
      let m = 0;
      let sq = 0;
      for (let ch = 0; ch < chs; ch++) {
        const d = data[ch];
        for (let i = s0; i < s1; i++) {
          const v = d[i];
          const av = v < 0 ? -v : v;
          if (av > m) m = av;
          sq += v * v;
        }
      }
      peaks[c] = m;
      rms[c] = Math.sqrt(sq / ((s1 - s0) * chs));
    }
    return { peaks, rms };
  }, [analysis, buffer, view.start, span, width, zoomed]);

  // Draw static layers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const h = height - TOP;
    const mid = TOP + h / 2;
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, 0, width, TOP);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, TOP - 0.5, width, 0.5);

    // Bar energy heat background
    const barLen = analysis.beatInterval * 4;
    const firstVisibleBar = Math.max(0, Math.floor(timeToBar(analysis, view.start)));
    const lastVisibleBar = Math.min(analysis.totalBars, Math.ceil(timeToBar(analysis, view.end)) + 1);
    for (let b = firstVisibleBar; b < lastVisibleBar; b++) {
      const x0 = xOf(barToTime(analysis, b));
      const w = barLen * pxPerSec;
      const e = analysis.barEnergy[b];
      const v = analysis.barVocal[b];
      ctx.fillStyle = `rgba(255,255,255,${0.012 + e * 0.045})`;
      ctx.fillRect(x0, TOP, w, h);
      if (v > 0.55) {
        ctx.fillStyle = `rgba(255,255,255,${(v - 0.55) * 0.1})`;
        ctx.fillRect(x0, mid - 1.5, w, 3);
      }
    }

    // Waveform
    const amp = h / 2 - 4;
    const grad = ctx.createLinearGradient(0, TOP, 0, height);
    grad.addColorStop(0, color.main);
    grad.addColorStop(0.5, "#ffffff");
    grad.addColorStop(1, color.main);
    const drawEnvelope = (arr: Float32Array, scale: number) => {
      const cols = arr.length;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let c = 0; c < cols; c++) ctx.lineTo((c / cols) * width, mid - Math.min(amp, arr[c] * amp * scale));
      for (let c = cols - 1; c >= 0; c--) ctx.lineTo((c / cols) * width, mid + Math.min(amp, arr[c] * amp * scale));
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = color.soft;
    drawEnvelope(columns.peaks, 1);
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.9;
    drawEnvelope(columns.rms, 1.5);
    ctx.globalAlpha = 1;

    // Sections band
    for (const sec of analysis.sections ?? []) {
      const x0 = xOf(barToTime(analysis, sec.startBar));
      const x1 = xOf(barToTime(analysis, sec.endBar));
      if (x1 < 0 || x0 > width) continue;
      const c = SECTION_COLORS[sec.label];
      ctx.fillStyle = `${c}33`;
      ctx.fillRect(x0, RULER, x1 - x0, SECTIONS_H);
      ctx.fillStyle = `${c}aa`;
      ctx.fillRect(x0, RULER + SECTIONS_H - 2, x1 - x0, 2);
      if (x1 - x0 > 40) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText(sec.label.toUpperCase(), Math.max(x0, 0) + 4, RULER + 11);
      }
    }

    // Beat grid + ruler labels
    const firstBeat = Math.max(0, Math.floor((view.start - analysis.firstDownbeat) / analysis.beatInterval));
    const lastBeat = Math.floor((view.end - analysis.firstDownbeat) / analysis.beatInterval) + 1;
    const labelEvery = barLen * pxPerSec > 34 ? 1 : barLen * pxPerSec > 18 ? 2 : 4;
    for (let k = firstBeat; k <= lastBeat; k++) {
      const x = xOf(analysis.firstDownbeat + k * analysis.beatInterval);
      const bar = k % 4 === 0;
      if (!bar && beatPx < 6) continue;
      const phrase = bar && (k / 4) % 4 === 0;
      ctx.strokeStyle = phrase ? "rgba(255,255,255,0.32)" : bar ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, bar ? TOP : mid - h * 0.15);
      ctx.lineTo(Math.round(x) + 0.5, bar ? height : mid + h * 0.15);
      ctx.stroke();
      if (bar) {
        const barIdx = k / 4;
        if (barIdx % labelEvery === 0) {
          ctx.fillStyle = phrase ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.4)";
          ctx.font = `${phrase ? 600 : 500} 9.5px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.fillText(String(barIdx + 1), x + 3, 12);
        }
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(Math.round(x), RULER - 4, 1, 4);
      } else if (beatPx >= 14) {
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fillRect(Math.round(x), RULER - 2, 1, 2);
      }
    }
  }, [analysis, width, height, color, columns, view, xOf, pxPerSec, beatPx]);

  // Playhead animation
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = playheadRef.current;
      if (el) {
        const t = deckSourceTime(deckId, engine.position());
        const st = useStore.getState();
        const active = t !== null && (st.playing || st.previewDeck === deckId);
        if (t !== null) {
          el.style.transform = `translateX(${xOf(t)}px)`;
          el.style.opacity = active ? "1" : "0.35";
        } else el.style.opacity = "0";
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [deckId, xOf]);

  const zoomAround = (factor: number, x: number) => {
    const t = tOf(x);
    const newSpan = Math.max(analysis.beatInterval * 4, Math.min(analysis.duration, span / factor));
    const frac = (t - view.start) / span;
    let start = t - frac * newSpan;
    start = Math.max(0, Math.min(analysis.duration - newSpan, start));
    setView({ start, end: start + newSpan });
  };
  const pan = (dx: number) => {
    const dt = dx / pxPerSec;
    let start = view.start + dt;
    start = Math.max(0, Math.min(analysis.duration - span, start));
    setView({ start, end: start + span });
  };

  // Wheel: ⌘/ctrl zooms around the cursor, horizontal or shift-wheel pans. Registered natively so we
  // can call preventDefault (React's onWheel is passive).
  const wheelState = useRef({ zoomAround, pan, zoomed });
  useEffect(() => {
    wheelState.current = { zoomAround, pan, zoomed };
  });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const { zoomAround, pan, zoomed } = wheelState.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        zoomAround(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - rect.left);
      } else if (zoomed && (Math.abs(e.deltaX) > 0 || e.shiftKey)) {
        e.preventDefault();
        pan(e.deltaX || e.deltaY);
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Section band: click selects the whole section
    if (y >= RULER && y < TOP) {
      const bar = timeToBar(analysis, tOf(x));
      const sec = (analysis.sections ?? []).find((s) => bar >= s.startBar && bar < s.endBar);
      if (sec) setSelection(deckId, { startBar: sec.startBar, lengthBeats: (sec.endBar - sec.startBar) * 4 });
      return;
    }
    const bar = xToBar(x);
    if (selection && bar >= selection.startBar && bar < selection.startBar + selection.lengthBeats / 4) {
      beginDragOnMove(e, { kind: "selection", deckId, srcBar: selection.startBar, lengthBeats: selection.lengthBeats, stem: activeStem, name: deckName });
      return;
    }
    dragRef.current = { anchorBar: bar, moved: false };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setSelection(deckId, { startBar: bar, lengthBeats: snap * 4 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const bar = xToBar(e.clientX - rect.left);
    setHoverBar(bar);
    const d = dragRef.current;
    if (!d) return;
    d.moved = true;
    const start = Math.min(d.anchorBar, bar);
    const end = Math.max(d.anchorBar, bar);
    setSelection(deckId, { startBar: start, lengthBeats: Math.round((end - start + snap) * 4) });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved) {
      // single click: a 4-bar phrase when zoomed out, one bar when zoomed in
      const bars = snap === 1 ? 4 : 1;
      const start = snap === 1 ? d.anchorBar : Math.floor(d.anchorBar);
      const len = Math.min(bars, analysis.totalBars - start);
      setSelection(deckId, { startBar: start, lengthBeats: len * 4 });
    }
  };

  const selLeft = selection ? xOf(barToTime(analysis, selection.startBar)) : 0;
  const selWidth = selection ? selection.lengthBeats * analysis.beatInterval * pxPerSec : 0;
  const isFoundation = foundation?.deckId === deckId;
  const fLeft = isFoundation ? xOf(barToTime(analysis, foundation!.startBar)) : 0;
  const selBars = selection ? selection.lengthBeats / 4 : 0;
  const selLabel = selection
    ? `${selBars % 1 === 0 ? `Bars ${fmtBar(selection.startBar)}–${fmtBar(selection.startBar + selBars - 1)}` : `From ${fmtBar(selection.startBar)}`} · ${selBars % 1 === 0 ? `${selBars} bar${selBars === 1 ? "" : "s"}` : `${selection.lengthBeats} beats`}`
    : "";

  return (
    <div className="relative">
      <div
        ref={wrapRef}
        className="relative w-full select-none rounded-[10px] overflow-hidden inset"
        style={{ height, touchAction: "none", cursor: hoverBar !== null && selection && hoverBar >= selection.startBar && hoverBar < selection.startBar + selection.lengthBeats / 4 ? "grab" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverBar(null)}
      >
        <canvas ref={canvasRef} style={{ width, height }} className="absolute inset-0" />
        {isFoundation && fLeft >= 0 && fLeft <= width && (
          <div className="absolute bottom-0 pointer-events-none border-l border-dashed" style={{ left: fLeft, top: TOP, borderColor: color.main }}>
            <span className="absolute top-1 left-1 text-[9.5px] font-semibold px-1.5 py-[1px] rounded-[4px] whitespace-nowrap" style={{ background: color.main, color: "#000" }}>
              Foundation start
            </span>
          </div>
        )}
        {selection && (
          <div
            className="absolute bottom-0 pointer-events-none"
            style={{
              left: selLeft,
              top: TOP,
              width: selWidth,
              background: `linear-gradient(180deg, ${color.main}2e, ${color.main}14)`,
              borderLeft: `1.5px solid ${color.main}`,
              borderRight: `1.5px solid ${color.main}`,
            }}
          >
            <span className="absolute bottom-1.5 left-1.5 text-[10px] font-medium tabular-nums px-1.5 py-[2px] rounded-[5px] bg-black/75 text-white whitespace-nowrap border border-white/10">
              {selLabel}
              <span className="opacity-60"> · drag to timeline</span>
            </span>
          </div>
        )}
        {hoverBar !== null && !selection && <div className="absolute bottom-0 pointer-events-none bg-white/[0.05]" style={{ top: TOP, left: xOf(barToTime(analysis, hoverBar)), width: snap * analysis.beatInterval * 4 * pxPerSec }} />}
        <div ref={playheadRef} className="absolute top-0 bottom-0 w-px bg-white pointer-events-none playhead-glow will-change-transform" style={{ left: 0, opacity: 0 }} />
      </div>
      {/* Zoom controls */}
      <div className="absolute top-[1px] right-1 flex items-center gap-0.5 opacity-80 hover:opacity-100 rounded-md bg-[#101015]/85 px-0.5">
        <button className="btn btn-xs btn-ghost" onClick={() => zoomAround(0.6, width / 2)} disabled={!zoomed} title="Zoom out">
          <Icon name="zoom-out" size={12} />
        </button>
        <button className="btn btn-xs btn-ghost" onClick={() => zoomAround(1.8, selection ? xOf(barToTime(analysis, selection.startBar + selection.lengthBeats / 8)) : width / 2)} title="Zoom in (or ⌘-scroll). Shift-scroll pans.">
          <Icon name="zoom-in" size={12} />
        </button>
        {zoomed && (
          <button className="btn btn-xs btn-ghost" onClick={() => setView({ start: 0, end: analysis.duration })} title="Show the whole song">
            Fit
          </button>
        )}
      </div>
      {zoomed && (
        <div className="absolute bottom-1 right-2 h-1 rounded-full bg-white/10 pointer-events-none" style={{ width: 80 }}>
          <div className="absolute h-full rounded-full bg-white/50" style={{ left: `${(view.start / analysis.duration) * 100}%`, width: `${(span / analysis.duration) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
