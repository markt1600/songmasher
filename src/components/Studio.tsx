"use client";
import { useEffect } from "react";
import { useStore } from "@/lib/store";
import Header from "./Header";
import Deck from "./Deck";
import Timeline from "./Timeline";
import Advisor from "./Advisor";
import Library from "./Library";
import Toast from "./Toast";
import DragLayer from "./DragLayer";

export default function Studio() {
  const loadConfig = useStore((s) => s.loadConfig);
  const decks = useStore((s) => s.decks);
  const restorable = useStore((s) => s.restorable);
  const restoreSession = useStore((s) => s.restoreSession);
  const dismissRestore = useStore((s) => s.dismissRestore);
  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void s.saveProject();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
      } else if (mod && e.key.toLowerCase() === "c") {
        if (s.selectedClipIds.length) {
          e.preventDefault();
          s.copySelected();
        }
      } else if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        s.paste();
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        s.selectAll();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        s.repeatSelected();
      } else if (e.code === "Space") {
        e.preventDefault();
        if (s.playing) s.pause();
        else void s.play();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (s.selectedClipIds.length) {
          e.preventDefault();
          s.removeSelected();
        }
      } else if (e.key === "d" && s.selectedClipIds.length) {
        s.repeatSelected();
      } else if (e.key === "m") {
        s.addCue();
      } else if (e.key === "l") {
        if (s.project.loopRegion) s.setLoopRegion(null);
        else s.loopSelected();
      } else if (e.key === "Escape") {
        s.selectClip(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const empty = decks.A.status === "empty" && decks.B.status === "empty";

  return (
    <div className="flex-1 flex flex-col">
      <Header />
      <main className="max-w-[1500px] w-full mx-auto p-4 flex flex-col gap-4">
        {empty && (
          <div className="text-center pt-10 pb-3 fade-in">
            <h1 className="text-[34px] md:text-[40px] font-semibold tracking-[-0.03em] leading-tight bg-gradient-to-r from-[#9ee8ff] via-[#c9bfff] to-[#ffb0d4] bg-clip-text text-transparent">
              Two songs in. One mashup out.
            </h1>
            <p className="text-text-2 mt-3 text-[14px] max-w-[560px] mx-auto leading-relaxed">
              Add songs to your library, load one on each deck, and SongMasher finds the tempo, beat grid and key. Pick a foundation,
              slice hooks from the other song and lay them on a beat-locked timeline. Everything runs in your browser.
            </p>
          </div>
        )}
        {restorable && empty && (
          <div className="rounded-[12px] border border-[#7c6cff]/40 bg-[#7c6cff]/10 px-4 py-2.5 flex flex-wrap items-center gap-3 fade-in">
            <span className="text-[13px]">
              Pick up where you left off? <span className="text-text-2">{restorable.currentProject?.name ?? Object.values(restorable.songNames).filter(Boolean).join(" × ")}</span>
              <span className="text-muted"> · {new Date(restorable.at).toLocaleString()}</span>
            </span>
            <div className="flex-1" />
            <button className="btn btn-sm btn-primary" onClick={() => void restoreSession()}>
              Restore
            </button>
            <button className="btn btn-sm btn-ghost" onClick={dismissRestore}>
              Dismiss
            </button>
          </div>
        )}
        <Library />
        <div className="grid lg:grid-cols-2 gap-4">
          <Deck id="A" />
          <Deck id="B" />
        </div>
        <Timeline />
        <Advisor />
        <footer className="text-[11px] text-muted text-center py-5 flex flex-wrap justify-center gap-x-4 gap-y-1">
          <span><kbd className="font-mono text-text-2">Space</kbd> play / pause</span>
          <span><kbd className="font-mono text-text-2">⇧click</kbd> multi-select</span>
          <span><kbd className="font-mono text-text-2">⌘C ⌘V</kbd> copy / paste at playhead</span>
          <span><kbd className="font-mono text-text-2">⌘Z</kbd> undo</span>
          <span><kbd className="font-mono text-text-2">D</kbd> repeat</span>
          <span><kbd className="font-mono text-text-2">⌫</kbd> delete</span>
          <span><kbd className="font-mono text-text-2">M</kbd> cue</span>
          <span><kbd className="font-mono text-text-2">L</kbd> loop selection</span>
          <span><kbd className="font-mono text-text-2">⌥</kbd> drag for fine positioning</span>
        </footer>
      </main>
      <Toast />
      <DragLayer />
    </div>
  );
}
