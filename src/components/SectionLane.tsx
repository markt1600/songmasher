"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { barToTime, type SongAnalysis } from "@/lib/audio/analysis";
import { hookRange, SECTION_LABELS, type Section, type SectionLabel } from "@/lib/audio/sections";
import { beginDragOnMove } from "@/lib/dnd";
import { useStore } from "@/lib/store";
import type { DeckId, StemKey } from "@/lib/types";
import { Icon } from "./ui";

export const SECTION_COLORS: Record<SectionLabel, string> = {
  Intro: "#8e8e99",
  Verse: "#4fd1ff",
  "Pre-chorus": "#c9bfff",
  Chorus: "#ff5fa8",
  Bridge: "#ffd60a",
  Break: "#30d158",
  Outro: "#8e8e99",
};

interface Props {
  deckId: DeckId;
  analysis: SongAnalysis;
  deckName: string;
  stem: StemKey;
  xOf: (t: number) => number;
  tOf: (x: number) => number;
  width: number;
  top: number;
  height: number;
}

/**
 * Editable song-structure lane above the waveform. Click selects the section's bars, dragging a
 * block carries it to the timeline, the edges move boundaries, double-click relabels, and the
 * context menu splits or merges.
 */
export default function SectionLane({ deckId, analysis, deckName, stem, xOf, tOf, width, top, height }: Props) {
  const setSelection = useStore((s) => s.setSelection);
  const setSections = useStore((s) => s.setSections);
  const resetSections = useStore((s) => s.resetSections);
  const vocal = useStore((s) => s.decks[deckId].vocal);
  const selection = useStore((s) => s.decks[deckId].selection);
  const sections = analysis.sections ?? [];
  const [menu, setMenu] = useState<{ x: number; y: number; index: number; bar: number } | null>(null);
  const [labelFor, setLabelFor] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ index: number; edge: "start" | "end"; live: Section[] } | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hook = hookRange(sections, analysis.barEnergy, vocal ? vocal.barVocal : analysis.barVocal);

  useEffect(() => {
    if (!menu && labelFor === null) return;
    const close = (e: PointerEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setMenu(null);
      setLabelFor(null);
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
  }, [menu, labelFor]);

  const barAtX = (clientX: number) => {
    const rect = laneRef.current!.getBoundingClientRect();
    const t = tOf(clientX - rect.left);
    return Math.max(0, Math.min(analysis.totalBars, Math.round((t - analysis.firstDownbeat) / (analysis.beatInterval * 4))));
  };

  const list = drag?.live ?? sections;
  const commit = (next: Section[]) => setSections(deckId, next);

  const startEdge = (e: React.PointerEvent, index: number, edge: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ index, edge, live: sections.map((s) => ({ ...s })) });
  };
  const moveEdge = (e: React.PointerEvent) => {
    if (!drag) return;
    const bar = barAtX(e.clientX);
    const live = drag.live.map((s) => ({ ...s }));
    const s = live[drag.index];
    if (drag.edge === "start") {
      const prev = live[drag.index - 1];
      const min = prev ? prev.startBar + 1 : 0;
      s.startBar = Math.max(min, Math.min(s.endBar - 1, bar));
      if (prev) prev.endBar = s.startBar;
    } else {
      const next = live[drag.index + 1];
      const max = next ? next.endBar - 1 : analysis.totalBars;
      s.endBar = Math.min(max, Math.max(s.startBar + 1, bar));
      if (next) next.startBar = s.endBar;
    }
    setDrag({ ...drag, live });
  };
  const endEdge = () => {
    if (drag) commit(drag.live);
    setDrag(null);
  };

  const split = (index: number, bar: number) => {
    const s = sections[index];
    if (bar <= s.startBar || bar >= s.endBar) return;
    const next = [...sections];
    next.splice(index, 1, { ...s, endBar: bar }, { ...s, startBar: bar, cluster: Math.max(...sections.map((x) => x.cluster)) + 1 });
    commit(next);
  };
  const merge = (index: number, withNext: boolean) => {
    const j = withNext ? index + 1 : index - 1;
    if (j < 0 || j >= sections.length) return;
    const a = sections[Math.min(index, j)];
    const b = sections[Math.max(index, j)];
    const next = [...sections];
    next.splice(Math.min(index, j), 2, { ...a, endBar: b.endBar });
    commit(next);
  };
  const relabel = (index: number, label: SectionLabel) => {
    commit(sections.map((s, i) => (i === index ? { ...s, label } : s)));
  };

  return (
    <div ref={laneRef} className="absolute left-0 right-0 select-none" style={{ top, height, touchAction: "none" }} onPointerMove={moveEdge} onPointerUp={endEdge} onPointerCancel={endEdge}>
      {list.map((sec, i) => {
        const x0 = xOf(barToTime(analysis, sec.startBar));
        const x1 = xOf(barToTime(analysis, sec.endBar));
        if (x1 < -4 || x0 > width + 4) return null;
        const c = SECTION_COLORS[sec.label] ?? "#8e8e99";
        const w = Math.max(2, x1 - x0);
        const isHook = hook && hook.startBar >= sec.startBar && hook.endBar <= sec.endBar;
        const selected = selection && selection.startBar === sec.startBar && selection.lengthBeats === (sec.endBar - sec.startBar) * 4;
        return (
          <div
            key={`${sec.startBar}-${i}`}
            className="absolute top-[2px] bottom-[2px] rounded-[4px] overflow-hidden cursor-grab active:cursor-grabbing group"
            style={{ left: x0, width: w, background: `${c}${selected ? "66" : "33"}`, boxShadow: `inset 0 -2px 0 ${c}`, outline: selected ? `1px solid ${c}` : undefined }}
            title={`${sec.label} · bars ${sec.startBar + 1}–${sec.endBar}${isHook ? " · hook" : ""}\nClick: select · drag: to timeline · edges: move boundary · double-click: relabel · right-click: split / merge`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const sel = { startBar: sec.startBar, lengthBeats: (sec.endBar - sec.startBar) * 4 };
              beginDragOnMove(e, { kind: "selection", deckId, srcBar: sec.startBar, lengthBeats: sel.lengthBeats, stem, name: `${deckName} · ${sec.label}` }, () => setSelection(deckId, sel));
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setLabelFor(i);
              setMenu({ x: e.clientX, y: e.clientY, index: i, bar: barAtX(e.clientX) });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setLabelFor(null);
              setMenu({ x: e.clientX, y: e.clientY, index: i, bar: barAtX(e.clientX) });
            }}
          >
            <div className="absolute inset-y-0 left-0 flex items-center gap-1 pl-1.5 pr-1 whitespace-nowrap text-[9.5px] font-semibold tracking-[0.04em] text-white/90 uppercase">
              {w > 44 && <span>{sec.label}</span>}
              {isHook && w > 24 && (
                <span className="inline-flex items-center gap-0.5 normal-case tracking-normal text-[9px] px-1 rounded-[3px] bg-black/50" style={{ color: c }} title="Detected hook: the strongest 8 bars of the chorus">
                  <Icon name="sparkles" size={8} /> hook
                </span>
              )}
            </div>
            {/* resize handles */}
            {i > 0 && <div className="absolute inset-y-0 left-0 w-[6px] cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/40" onPointerDown={(e) => startEdge(e, i, "start")} />}
            <div className="absolute inset-y-0 right-0 w-[6px] cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/40" onPointerDown={(e) => startEdge(e, i, "end")} />
          </div>
        );
      })}
      {sections.length === 0 && <div className="absolute inset-0 flex items-center px-2 text-[10px] text-muted">Detecting sections…</div>}

      {menu &&
        createPortal(
        <div ref={menuRef} className="fixed z-50 rounded-[10px] border border-white/10 bg-[#16161d]/98 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.6)] p-1.5 flex flex-col min-w-[180px] fade-in" style={{ left: menu.x + 4, top: menu.y + 4 }} onPointerDown={(e) => e.stopPropagation()}>
          {labelFor !== null ? (
            <>
              <div className="label px-2 pt-1 pb-1.5">Label</div>
              {SECTION_LABELS.map((l) => (
                <button key={l} className="btn btn-ghost justify-start gap-2" onClick={() => { relabel(menu.index, l); setMenu(null); setLabelFor(null); }}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: SECTION_COLORS[l] }} />
                  {l}
                  {sections[menu.index]?.label === l && <Icon name="check" size={11} />}
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="text-[11px] text-muted px-2 pt-1 pb-1.5">
                {sections[menu.index]?.label} · bars {sections[menu.index]?.startBar + 1}–{sections[menu.index]?.endBar}
              </div>
              <button className="btn btn-ghost justify-start" onClick={() => setLabelFor(menu.index)}>
                Relabel…
              </button>
              <button className="btn btn-ghost justify-start" disabled={menu.bar <= sections[menu.index]?.startBar || menu.bar >= sections[menu.index]?.endBar} onClick={() => { split(menu.index, menu.bar); setMenu(null); }}>
                Split at bar {menu.bar + 1}
              </button>
              <button className="btn btn-ghost justify-start" disabled={menu.index === 0} onClick={() => { merge(menu.index, false); setMenu(null); }}>
                Merge with previous
              </button>
              <button className="btn btn-ghost justify-start" disabled={menu.index >= sections.length - 1} onClick={() => { merge(menu.index, true); setMenu(null); }}>
                Merge with next
              </button>
              <div className="border-t border-white/[0.08] my-1" />
              <button className="btn btn-ghost justify-start text-muted" onClick={() => { resetSections(deckId); setMenu(null); }}>
                Re-detect all sections
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
