"use client";
/** Lightweight pointer-based drag and drop shared by the waveforms, library cards, decks and the timeline. */
import { create } from "zustand";
import type { DeckId, StemKey } from "./types";

export type DragPayload =
  | { kind: "selection"; deckId: DeckId; srcBar: number; lengthBeats: number; stem: StemKey; name: string }
  | { kind: "song"; id: string; name: string };

export interface DropInfo {
  /** timeline: lane 0 = foundation, 1..n = clip lanes */
  lane?: number;
  /** timeline: snapped start beat */
  beat?: number;
  /** deck target */
  deckId?: DeckId;
  label?: string;
}

interface Zone {
  el: HTMLElement;
  accepts: DragPayload["kind"][];
  resolve: (x: number, y: number, payload: DragPayload, altKey: boolean) => DropInfo | null;
  onDrop: (payload: DragPayload, info: DropInfo) => void;
}

interface DndState {
  payload: DragPayload | null;
  x: number;
  y: number;
  hover: { zone: string; info: DropInfo } | null;
  zones: Map<string, Zone>;
  start: (payload: DragPayload, x: number, y: number) => void;
  move: (x: number, y: number, altKey: boolean) => void;
  end: (drop: boolean) => void;
  register: (id: string, zone: Zone) => () => void;
}

export const useDnd = create<DndState>((set, get) => ({
  payload: null,
  x: 0,
  y: 0,
  hover: null,
  zones: new Map(),
  start: (payload, x, y) => set({ payload, x, y, hover: null }),
  move: (x, y, altKey) => {
    const { payload, zones } = get();
    if (!payload) return;
    let hover: DndState["hover"] = null;
    for (const [id, z] of zones) {
      if (!z.accepts.includes(payload.kind)) continue;
      const r = z.el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const info = z.resolve(x, y, payload, altKey);
      if (info) {
        hover = { zone: id, info };
        break;
      }
    }
    set({ x, y, hover });
  },
  end: (drop) => {
    const { payload, hover, zones } = get();
    if (drop && payload && hover) zones.get(hover.zone)?.onDrop(payload, hover.info);
    set({ payload: null, hover: null });
  },
  register: (id, zone) => {
    get().zones.set(id, zone);
    return () => {
      get().zones.delete(id);
    };
  },
}));

/**
 * Attach to a pointerdown: starts a drag once the pointer moves more than a few pixels.
 * `onClick` runs instead when the pointer is released without moving.
 */
export function beginDragOnMove(e: React.PointerEvent, payload: DragPayload, onClick?: () => void) {
  const startX = e.clientX;
  const startY = e.clientY;
  const target = e.currentTarget as HTMLElement;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      dragging = true;
      useDnd.getState().start(payload, ev.clientX, ev.clientY);
      document.body.style.cursor = "grabbing";
    }
    useDnd.getState().move(ev.clientX, ev.clientY, ev.altKey);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    document.body.style.cursor = "";
    if (dragging) useDnd.getState().end(true);
    else onClick?.();
  };
  const cancel = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    document.body.style.cursor = "";
    if (dragging) useDnd.getState().end(false);
  };
  try {
    target.releasePointerCapture?.(e.pointerId);
  } catch {
    /* ignore */
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}
