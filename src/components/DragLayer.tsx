"use client";
import { useEffect } from "react";
import { useDnd } from "@/lib/dnd";
import { DECK_COLORS } from "@/lib/types";
import { Icon } from "./ui";

/** The ghost that follows the pointer during a drag. */
export default function DragLayer() {
  const payload = useDnd((s) => s.payload);
  const x = useDnd((s) => s.x);
  const y = useDnd((s) => s.y);
  const hover = useDnd((s) => s.hover);

  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useDnd.getState().end(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payload]);

  if (!payload) return null;
  const color = payload.kind === "selection" ? DECK_COLORS[payload.deckId].main : "var(--accent)";
  const title = payload.kind === "selection" ? `${payload.deckId} · ${payload.name}` : payload.name;
  const sub = payload.kind === "selection" ? `bars ${payload.srcBar + 1}–${payload.srcBar + payload.lengthBeats / 4} · ${payload.stem}` : "drop on a deck";
  return (
    <div className="fixed inset-0 z-[100] pointer-events-none select-none">
      <div
        className="absolute rounded-[9px] border px-2.5 py-1.5 text-[11px] shadow-[0_12px_32px_rgba(0,0,0,0.55)] backdrop-blur-md"
        style={{
          left: x + 14,
          top: y + 10,
          background: `linear-gradient(180deg, ${payload.kind === "selection" ? color + "e6" : "rgba(124,108,255,0.9)"}, ${payload.kind === "selection" ? color + "99" : "rgba(124,108,255,0.6)"})`,
          borderColor: "rgba(255,255,255,0.5)",
          color: payload.kind === "selection" ? "#000" : "#fff",
          minWidth: 150,
          maxWidth: 260,
          transform: hover ? "scale(1)" : "scale(0.96)",
          opacity: hover ? 1 : 0.85,
          transition: "transform 0.12s, opacity 0.12s",
        }}
      >
        <div className="font-semibold truncate flex items-center gap-1.5">
          <Icon name={payload.kind === "selection" ? "scissors" : "music"} size={11} /> {title}
        </div>
        <div className="opacity-75 font-mono tabular-nums text-[10px] truncate">{hover?.info.label ?? sub}</div>
      </div>
    </div>
  );
}
