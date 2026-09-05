"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { timeToBar, barToTime, type SongAnalysis } from "@/lib/audio/analysis";
import { deckSourceTime, engine, useStore } from "@/lib/store";
import { DECK_COLORS, type DeckId } from "@/lib/types";
import { beginDragOnMove } from "@/lib/dnd";

interface Props {
  deckId: DeckId;
  analysis: SongAnalysis;
  height?: number;
}

const RULER = 18;

export default function Waveform({ deckId, analysis, height = 168 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const selection = useStore((s) => s.decks[deckId].selection);
  const setSelection = useStore((s) => s.setSelection);
  const deckName = useStore((s) => s.decks[deckId].name);
  const activeStem = useStore((s) => s.decks[deckId].activeStem);
  const foundation = useStore((s) => s.project.foundation);
  const [width, setWidth] = useState(600);
  const dragRef = useRef<{ anchorBar: number; moved: boolean } | null>(null);
  const [hoverBar, setHoverBar] = useState<number | null>(null);
  const color = DECK_COLORS[deckId];

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const xToBar = useCallback(
    (x: number) => {
      const t = (x / width) * analysis.duration;
      return Math.floor(timeToBar(analysis, t));
    },
    [width, analysis],
  );

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
    const { peaks, rms, duration } = analysis;
    const top = RULER;
    const h = height - RULER;
    const mid = top + h / 2;
    const pxPerSec = width / duration;
    // ruler band
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, 0, width, RULER);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, RULER - 0.5, width, 0.5);

    // Bar energy heat background
    const barLen = analysis.beatInterval * 4;
    for (let b = 0; b < analysis.totalBars; b++) {
      const x0 = barToTime(analysis, b) * pxPerSec;
      const w = barLen * pxPerSec;
      const e = analysis.barEnergy[b];
      const v = analysis.barVocal[b];
      ctx.fillStyle = `rgba(255,255,255,${0.012 + e * 0.045})`;
      ctx.fillRect(x0, top, w, h);
      if (v > 0.55) {
        ctx.fillStyle = `rgba(255,255,255,${(v - 0.55) * 0.1})`;
        ctx.fillRect(x0, mid - 1.5, w, 3);
      }
    }

    // Waveform
    const n = peaks.length;
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, color.main);
    grad.addColorStop(0.5, "#ffffff");
    grad.addColorStop(1, color.main);
    const amp = h / 2 - 4;
    const drawEnvelope = (arr: Float32Array, scale: number) => {
      // smooth, symmetric envelope drawn as one closed path (crisper than per-bucket rects)
      const cols = Math.min(n, Math.floor(width));
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let c = 0; c <= cols; c++) {
        const i0 = Math.floor((c / cols) * n);
        const i1 = Math.max(i0 + 1, Math.floor(((c + 1) / cols) * n));
        let m = 0;
        for (let i = i0; i < i1 && i < n; i++) if (arr[i] > m) m = arr[i];
        ctx.lineTo((c / cols) * width, mid - Math.min(amp, m * amp * scale));
      }
      for (let c = cols; c >= 0; c--) {
        const i0 = Math.floor((c / cols) * n);
        const i1 = Math.max(i0 + 1, Math.floor(((c + 1) / cols) * n));
        let m = 0;
        for (let i = i0; i < i1 && i < n; i++) if (arr[i] > m) m = arr[i];
        ctx.lineTo((c / cols) * width, mid + Math.min(amp, m * amp * scale));
      }
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = color.soft;
    drawEnvelope(peaks, 1);
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.9;
    drawEnvelope(rms, 1.5);
    ctx.globalAlpha = 1;

    // Beat grid
    const totalBeats = Math.floor((duration - analysis.firstDownbeat) / analysis.beatInterval);
    const beatPx = analysis.beatInterval * pxPerSec;
    for (let k = 0; k <= totalBeats; k++) {
      const x = (analysis.firstDownbeat + k * analysis.beatInterval) * pxPerSec;
      const bar = k % 4 === 0;
      if (!bar && beatPx < 6) continue;
      const phrase = bar && (k / 4) % 4 === 0;
      ctx.strokeStyle = phrase ? "rgba(255,255,255,0.32)" : bar ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, bar ? top : mid - h * 0.15);
      ctx.lineTo(Math.round(x) + 0.5, bar ? height : mid + h * 0.15);
      ctx.stroke();
      if (bar) {
        const barIdx = k / 4;
        const labelEvery = barLen * pxPerSec > 34 ? 1 : barLen * pxPerSec > 18 ? 2 : 4;
        if (barIdx % labelEvery === 0) {
          ctx.fillStyle = phrase ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.4)";
          ctx.font = `${phrase ? 600 : 500} 9.5px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.fillText(String(barIdx + 1), x + 3, 12);
        }
        // tick in ruler
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(Math.round(x), RULER - 4, 1, 4);
      }
    }
  }, [analysis, width, height, color]);

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
          el.style.transform = `translateX(${(t / analysis.duration) * width}px)`;
          el.style.opacity = active ? "1" : "0.35";
        } else el.style.opacity = "0";
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [deckId, analysis.duration, width]);

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const bar = Math.max(0, Math.min(analysis.totalBars - 1, xToBar(e.clientX - rect.left)));
    if (selection && bar >= selection.startBar && bar < selection.startBar + selection.lengthBeats / 4) {
      // Inside the current selection: drag it to the timeline (a plain click keeps the selection).
      beginDragOnMove(e, { kind: "selection", deckId, srcBar: selection.startBar, lengthBeats: selection.lengthBeats, stem: activeStem, name: deckName });
      return;
    }
    dragRef.current = { anchorBar: bar, moved: false };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setSelection(deckId, { startBar: bar, lengthBeats: 4 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const bar = Math.max(0, Math.min(analysis.totalBars - 1, xToBar(e.clientX - rect.left)));
    setHoverBar(bar);
    const d = dragRef.current;
    if (!d) return;
    d.moved = true;
    const start = Math.min(d.anchorBar, bar);
    const end = Math.max(d.anchorBar, bar);
    setSelection(deckId, { startBar: start, lengthBeats: (end - start + 1) * 4 });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved) {
      // single click: select a 4-bar phrase starting at the clicked bar
      const len = Math.min(4, analysis.totalBars - d.anchorBar);
      setSelection(deckId, { startBar: d.anchorBar, lengthBeats: len * 4 });
    }
  };

  const pxPerSec = width / analysis.duration;
  const selLeft = selection ? barToTime(analysis, selection.startBar) * pxPerSec : 0;
  const selWidth = selection ? selection.lengthBeats * analysis.beatInterval * pxPerSec : 0;
  const isFoundation = foundation?.deckId === deckId;
  const fLeft = isFoundation ? barToTime(analysis, foundation!.startBar) * pxPerSec : 0;

  return (
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
      {isFoundation && (
        <div className="absolute bottom-0 pointer-events-none border-l border-dashed" style={{ left: fLeft, top: RULER, borderColor: color.main }}>
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
            top: RULER,
            width: selWidth,
            background: `linear-gradient(180deg, ${color.main}2e, ${color.main}14)`,
            borderLeft: `1.5px solid ${color.main}`,
            borderRight: `1.5px solid ${color.main}`,
          }}
        >
          <span className="absolute bottom-1.5 left-1.5 text-[10px] font-medium tabular-nums px-1.5 py-[2px] rounded-[5px] bg-black/75 text-white whitespace-nowrap border border-white/10">
            Bars {selection.startBar + 1}–{selection.startBar + selection.lengthBeats / 4} · {selection.lengthBeats / 4} bar{selection.lengthBeats > 4 ? "s" : ""}
            <span className="opacity-60"> · drag to timeline</span>
          </span>
        </div>
      )}
      {hoverBar !== null && !selection && (
        <div className="absolute bottom-0 pointer-events-none bg-white/[0.05]" style={{ top: RULER, left: barToTime(analysis, hoverBar) * pxPerSec, width: analysis.beatInterval * 4 * pxPerSec }} />
      )}
      <div ref={playheadRef} className="absolute top-0 bottom-0 w-px bg-white pointer-events-none playhead-glow will-change-transform" style={{ left: 0, opacity: 0 }} />
    </div>
  );
}
