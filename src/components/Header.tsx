"use client";
import { useEffect, useRef, useState } from "react";
import { engine, useStore } from "@/lib/store";
import { Icon, formatTime } from "./ui";
import Spectrum from "./Spectrum";

export default function Header() {
  const project = useStore((s) => s.project);
  const playing = useStore((s) => s.playing);
  const previewDeck = useStore((s) => s.previewDeck);
  const busy = useStore((s) => s.busy);
  const decks = useStore((s) => s.decks);
  const { play, pause, stop, toggleLoop, setMasterBpm, adoptDeckTempo, exportMix } = useStore();
  const anyReady = decks.A.status === "ready" || decks.B.status === "ready";
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = engine.position();
      if (timeRef.current) timeRef.current.textContent = formatTime(p);
      if (barRef.current) {
        const beat = p / (60 / project.masterBpm);
        barRef.current.textContent = `${Math.floor(beat / 4) + 1}.${(Math.floor(beat) % 4) + 1}`;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [project.masterBpm]);

  const commitBpm = () => {
    if (bpmDraft !== null) {
      const v = parseFloat(bpmDraft);
      if (!isNaN(v)) setMasterBpm(v);
      setBpmDraft(null);
    }
  };

  return (
    <header className="sticky top-0 z-30 backdrop-blur-2xl bg-[#0b0b0f]/75 border-b border-white/[0.07]">
      <div className="max-w-[1500px] mx-auto px-4 h-[56px] flex items-center gap-3">
        <div className="flex items-center gap-2.5 min-w-[150px]">
          <div className="h-8 w-8 rounded-[9px] bg-gradient-to-b from-[#9d8cff] to-[#6f5cff] grid place-items-center shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_4px_12px_rgba(111,92,255,0.35)]">
            <Icon name="music" size={16} />
          </div>
          <div className="leading-none">
            <div className="font-semibold tracking-[-0.01em] text-[15px]">SongMasher</div>
            <div className="text-[10.5px] text-muted mt-[3px]">Mashup studio</div>
          </div>
        </div>

        <div className="hidden md:block ml-2 opacity-90">
          <Spectrum width={200} height={28} />
        </div>

        <div className="flex-1" />

        {/* Tempo */}
        <div className="flex items-center gap-2 pr-3 mr-1 border-r border-white/[0.08]">
          <div className="flex flex-col items-end leading-none gap-[3px]">
            <span className="label">Master</span>
            <span className="text-[10.5px] text-muted">BPM</span>
          </div>
          <input
            className="num"
            value={bpmDraft ?? project.masterBpm.toFixed(1)}
            onChange={(e) => setBpmDraft(e.target.value)}
            onFocus={(e) => {
              setBpmDraft(project.masterBpm.toFixed(1));
              e.target.select();
            }}
            onBlur={commitBpm}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            aria-label="Master tempo"
          />
          <div className="toolbar-group">
            {(["A", "B"] as const).map((id) => (
              <button key={id} disabled={decks[id].status !== "ready"} onClick={() => adoptDeckTempo(id)} title={`Use deck ${id}'s tempo as master`} data-active={decks[id].analysis ? Math.abs(decks[id].analysis!.bpm - project.masterBpm) < 0.05 : false}>
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: id === "A" ? "var(--a)" : "var(--b)", opacity: decks[id].status === "ready" ? 1 : 0.3 }} />
                <span className="font-mono text-[11.5px] tabular-nums">{decks[id].analysis ? decks[id].analysis!.bpm.toFixed(1) : "—"}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Transport */}
        <div className="toolbar-group">
          <button onClick={stop} disabled={!anyReady} title="Stop and return to start">
            <Icon name="stop" size={12} />
          </button>
          <button
            onClick={() => (playing ? pause() : void play())}
            disabled={!anyReady || !!busy}
            title={playing ? "Pause (space)" : "Play (space)"}
            data-active={playing}
            style={{ minWidth: 44 }}
          >
            {busy ? <span className="h-3.5 w-3.5 rounded-full border-2 border-white/25 border-t-white animate-spin" /> : <Icon name={playing ? "pause" : "play"} size={14} />}
          </button>
          <button onClick={toggleLoop} data-active={project.loop} title="Loop the arrangement">
            <Icon name="loop" size={13} />
          </button>
        </div>
        <div className="font-mono text-[13px] tabular-nums leading-none text-right min-w-[64px] ml-1">
          <span ref={timeRef}>0:00.0</span>
          <div className="text-[10.5px] text-muted mt-[3px]">
            bar <span ref={barRef}>1.1</span>
            {previewDeck && <span className="ml-1 text-warn">· audition {previewDeck}</span>}
          </div>
        </div>

        <button className="btn ml-2" onClick={() => void exportMix()} disabled={!anyReady || !!busy} title="Render the arrangement to a WAV file">
          <Icon name="download" size={13} /> <span className="hidden sm:inline">Export</span>
        </button>
      </div>
      <div className="h-[2px] w-full relative overflow-hidden">
        {busy && <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#4fd1ff] via-[#9d8cff] to-[#ff5fa8] transition-[width] duration-200" style={{ width: `${Math.max(4, busy.value * 100)}%` }} />}
      </div>
      {busy && (
        <div className="absolute right-4 top-[62px] text-[11px] text-text-2 font-mono tabular-nums bg-[#16161d]/95 px-2.5 py-1 rounded-md border border-white/10 shadow-lg fade-in">
          {busy.label} · {Math.round(busy.value * 100)}%
        </div>
      )}
    </header>
  );
}
