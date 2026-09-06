"use client";
import { useEffect, useRef, useState } from "react";
import { engine, useStore, type ExportOptions } from "@/lib/store";
import { Icon, formatTime } from "./ui";
import Spectrum from "./Spectrum";

export default function Header() {
  const project = useStore((s) => s.project);
  const playing = useStore((s) => s.playing);
  const previewDeck = useStore((s) => s.previewDeck);
  const soloClipId = useStore((s) => s.soloClipId);
  const busy = useStore((s) => s.busy);
  const decks = useStore((s) => s.decks);
  const { play, pause, stop, toggleLoop, setMasterBpm, adoptDeckTempo, exportMix, toggleMetronome, toggleCountIn, undo, redo, saveProject, saveProjectAs, newProject } = useStore();
  const currentProject = useStore((s) => s.currentProject);
  const dirty = useStore((s) => s.dirty);
  const config = useStore((s) => s.config);
  const [projectMenu, setProjectMenu] = useState(false);
  const transport = useStore((s) => s.transport);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportOpts, setExportOpts] = useState<ExportOptions>({ format: "mp3", range: "all", normalize: true, save: true });
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
      <div className="max-w-[1500px] mx-auto px-4 min-h-[56px] flex items-center gap-3 flex-wrap md:flex-nowrap py-1.5 md:py-0">
        <div className="flex items-center gap-2.5 min-w-[150px]">
          <div className="h-8 w-8 rounded-[9px] bg-gradient-to-b from-[#9d8cff] to-[#6f5cff] grid place-items-center shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_4px_12px_rgba(111,92,255,0.35)]">
            <Icon name="music" size={16} />
          </div>
          <div className="leading-none">
            <div className="font-semibold tracking-[-0.01em] text-[15px]">SongMasher</div>
            <div className="text-[10.5px] text-muted mt-[3px]">Mashup studio</div>
          </div>
        </div>

        <div className="hidden lg:block ml-2 opacity-90">
          <Spectrum width={160} height={28} />
        </div>

        {/* Project */}
        <div className="relative ml-2 min-w-0">
          <button className="btn btn-ghost max-w-[240px] gap-1.5" onClick={() => setProjectMenu((v) => !v)} title="Mashup project" disabled={!anyReady}>
            <span className={`h-[7px] w-[7px] rounded-full shrink-0 ${dirty ? "bg-[#ffd60a]" : "bg-[#30d158]"}`} style={{ opacity: anyReady ? 1 : 0.3 }} />
            <span className="truncate text-[12.5px]">{currentProject?.name ?? "Untitled mashup"}</span>
            <Icon name="chev-down" size={11} />
          </button>
          {projectMenu && (
            <div className="absolute left-0 top-[38px] z-40 w-[220px] rounded-[12px] border border-white/10 bg-[#16161d]/98 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.6)] p-1.5 flex flex-col fade-in" onPointerLeave={() => setProjectMenu(false)}>
              <button className="btn btn-ghost justify-start" onClick={() => { setProjectMenu(false); void saveProject(); }}>
                <Icon name="save" size={13} /> Save {currentProject ? "" : "mashup…"} <span className="ml-auto text-muted font-mono text-[10px]">⌘S</span>
              </button>
              <button className="btn btn-ghost justify-start" onClick={() => { setProjectMenu(false); void saveProjectAs(); }}>
                <Icon name="folder" size={13} /> Save a copy as…
              </button>
              <button className="btn btn-ghost justify-start" onClick={() => { setProjectMenu(false); newProject(); }}>
                <Icon name="plus" size={13} /> New mashup (keep songs)
              </button>
              <div className="text-[10.5px] text-muted px-2 pt-1.5 pb-1">Saved mashups are listed in the Library{config.cloud ? " and synced to the cloud" : ""}.</div>
            </div>
          )}
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
          <button onClick={toggleMetronome} data-active={transport.metronome} title="Metronome click">
            <Icon name="metronome" size={13} />
          </button>
          <button onClick={toggleCountIn} data-active={transport.countIn} title="One bar count-in before playback" className="font-mono text-[10.5px]">
            1234
          </button>
        </div>
        <div className="toolbar-group">
          <button onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
            <Icon name="undo" size={13} />
          </button>
          <button onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
            <Icon name="redo" size={13} />
          </button>
        </div>
        <div className="font-mono text-[13px] tabular-nums leading-none text-right min-w-[64px] ml-1">
          <span ref={timeRef}>0:00.0</span>
          <div className="text-[10.5px] text-muted mt-[3px]">
            bar <span ref={barRef}>1.1</span>
            {previewDeck && <span className="ml-1 text-warn">· audition {previewDeck}</span>}
            {soloClipId && <span className="ml-1 text-warn">· clip solo</span>}
          </div>
        </div>

        <div className="relative ml-2">
          <button className="btn" onClick={() => setExportOpen((v) => !v)} disabled={!anyReady || !!busy} title="Render the arrangement to a file">
            <Icon name="download" size={13} /> <span className="hidden sm:inline">Export</span> <Icon name="chev-down" size={11} />
          </button>
          {exportOpen && (
            <div className="absolute right-0 top-[38px] z-40 w-[260px] rounded-[12px] border border-white/10 bg-[#16161d]/98 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.6)] p-3 flex flex-col gap-3 fade-in" onPointerLeave={() => setExportOpen(false)}>
              <div className="flex items-center justify-between">
                <span className="label">Format</span>
                <div className="seg">
                  <button data-active={exportOpts.format === "wav"} onClick={() => setExportOpts({ ...exportOpts, format: "wav" })}>
                    WAV
                  </button>
                  <button data-active={exportOpts.format === "mp3"} onClick={() => setExportOpts({ ...exportOpts, format: "mp3" })}>
                    MP3
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="label">Range</span>
                <div className="seg">
                  <button data-active={exportOpts.range === "all"} onClick={() => setExportOpts({ ...exportOpts, range: "all" })}>
                    Whole
                  </button>
                  <button data-active={exportOpts.range === "loop"} disabled={!project.loopRegion} onClick={() => setExportOpts({ ...exportOpts, range: "loop" })} title={project.loopRegion ? "Only the loop region" : "Set a loop region on the timeline ruler first"}>
                    Loop region
                  </button>
                </div>
              </div>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="label">Normalise to −14 LUFS</span>
                <input type="checkbox" checked={exportOpts.normalize} onChange={(e) => setExportOpts({ ...exportOpts, normalize: e.target.checked })} className="accent-[#7c6cff]" />
              </label>
              <label className="flex items-center justify-between cursor-pointer" title={config.cloud ? "Keeps the render in your library and creates a share link" : "Keeps the render in this browser's library"}>
                <span className="label">Save to library{config.cloud ? " + share link" : ""}</span>
                <input type="checkbox" checked={!!exportOpts.save} onChange={(e) => setExportOpts({ ...exportOpts, save: e.target.checked })} className="accent-[#7c6cff]" />
              </label>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setExportOpen(false);
                  void exportMix(exportOpts);
                }}
              >
                <Icon name="download" size={13} /> Export {exportOpts.format.toUpperCase()}
              </button>
            </div>
          )}
        </div>
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
