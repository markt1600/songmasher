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
  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const s = useStore.getState();
      if (e.code === "Space") {
        e.preventDefault();
        if (s.playing) s.pause();
        else void s.play();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (s.selectedClipId) {
          e.preventDefault();
          s.removeClip(s.selectedClipId);
        }
      } else if (e.key === "d" && s.selectedClipId) {
        s.repeatClip(s.selectedClipId);
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
        <Library />
        <div className="grid lg:grid-cols-2 gap-4">
          <Deck id="A" />
          <Deck id="B" />
        </div>
        <Timeline />
        <Advisor />
        <footer className="text-[11px] text-muted text-center py-5 flex flex-wrap justify-center gap-x-4 gap-y-1">
          <span><kbd className="font-mono text-text-2">Space</kbd> play / pause</span>
          <span><kbd className="font-mono text-text-2">D</kbd> repeat selected clip</span>
          <span><kbd className="font-mono text-text-2">⌫</kbd> remove clip</span>
          <span><kbd className="font-mono text-text-2">⌥</kbd> drag for fine positioning</span>
          <span>Drag a selection onto the timeline · drag a library song onto a deck</span>
        </footer>
      </main>
      <Toast />
      <DragLayer />
    </div>
  );
}
