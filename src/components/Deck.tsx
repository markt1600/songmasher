"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDnd } from "@/lib/dnd";
import { useStore } from "@/lib/store";
import { DECK_COLORS, DEMUCS_VARIANTS, STEM_LABELS, type DeckId, type StemKey } from "@/lib/types";
import { shiftedKey } from "@/lib/audio/music";
import Waveform from "./Waveform";
import { Icon, Segmented, Stepper } from "./ui";

const STEM_ORDER: StemKey[] = ["full", "instrumental", "vocals", "drums", "melodic"];

export default function Deck({ id }: { id: DeckId }) {
  const deck = useStore((s) => s.decks[id]);
  const project = useStore((s) => s.project);
  const config = useStore((s) => s.config);
  const playing = useStore((s) => s.playing);
  const previewDeck = useStore((s) => s.previewDeck);
  const {
    loadFile,
    clearDeck,
    setFoundation,
    clearFoundation,
    setDeckStem,
    setDeckPitch,
    addClip,
    previewSelection,
    pause,
    nudgeDownbeat,
    nudgeGridMs,
    scaleTempo,
    setDeckBpm,
    separateQuick,
    separateAI,
    loadFromLibrary,
  } = useStore();
  const [drag, setDrag] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const register = useDnd((s) => s.register);
  const dndHover = useDnd((s) => (s.hover?.zone === `deck-${id}` ? s.hover.info : null));
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    return register(`deck-${id}`, {
      el,
      accepts: ["song"],
      resolve: (_x, _y, payload) => (payload.kind === "song" ? { deckId: id, label: `Load on deck ${id}` } : null),
      onDrop: (payload) => {
        if (payload.kind === "song") void loadFromLibrary(id, payload.id);
      },
    });
  }, [id, register, loadFromLibrary]);
  const [showGrid, setShowGrid] = useState(false);
  const [aiMenu, setAiMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const color = DECK_COLORS[id];
  const isFoundation = project.foundation?.deckId === id;

  const onFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (f) void loadFile(id, f);
    },
    [id, loadFile],
  );

  const a = deck.analysis;
  const effectiveKey = a ? shiftedKey(a.key, deck.semitones) : null;
  const stems = STEM_ORDER.filter((k) => !!deck.buffers[k]);
  const isPreviewing = previewDeck === id && playing;
  const selBars = deck.selection ? deck.selection.lengthBeats / 4 : 0;

  return (
    <section
      ref={sectionRef}
      className="panel p-4 flex flex-col gap-3 relative overflow-hidden transition-[border-color,box-shadow] duration-150"
      style={drag || dndHover ? { borderColor: color.main, boxShadow: `0 0 0 3px ${color.main}33` } : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      <div className="absolute -top-28 -right-28 h-64 w-64 rounded-full blur-3xl opacity-[0.16] pointer-events-none" style={{ background: color.main }} />
      <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac" className="hidden" onChange={(e) => onFiles(e.target.files)} />

      {/* Title row */}
      <div className="flex items-center gap-3 min-h-[36px]">
        <div className="h-8 w-8 rounded-[9px] grid place-items-center font-bold text-black text-[15px] shrink-0" style={{ background: `linear-gradient(180deg, ${color.main}, ${color.main}cc)`, boxShadow: `0 1px 0 rgba(255,255,255,0.35) inset, 0 4px 12px ${color.main}44` }}>
          {id}
        </div>
        <div className="min-w-0 flex-1">
          {deck.status === "empty" ? (
            <div className="text-[14px] font-medium text-text-2">
              Deck {id} <span className="text-muted font-normal">· empty</span>
            </div>
          ) : (
            <div className="font-semibold truncate text-[14px] tracking-[-0.01em]" title={deck.name}>
              {deck.name}
            </div>
          )}
          {a && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              <span className="chip" title={`Tempo confidence ${(a.bpmConfidence * 100).toFixed(0)}%`}>
                <b>{a.bpm.toFixed(1)}</b> BPM
              </span>
              <span className="chip" title={`Detected key · confidence ${(a.key.confidence * 100).toFixed(0)}%`}>
                <b>{effectiveKey!.name}</b> {effectiveKey!.camelot}
                {deck.semitones !== 0 && (
                  <span className="text-warn">
                    {deck.semitones > 0 ? "+" : ""}
                    {deck.semitones}
                  </span>
                )}
              </span>
              <span className="chip">
                <b>{a.totalBars}</b> bars
              </span>
              {deck.stemSource !== "none" && (
                <span className="chip" style={{ color: color.main, borderColor: `${color.main}55` }}>
                  {deck.stemSource === "ai" ? "AI stems" : "Quick stems"}
                </span>
              )}
              {isFoundation && (
                <span className="chip" style={{ borderColor: `${color.main}66`, color: color.main, background: `${color.main}14` }}>
                  <Icon name="anchor" size={10} /> Foundation
                </span>
              )}
            </div>
          )}
        </div>
        {deck.status !== "empty" && (
          <div className="flex items-center gap-0.5 self-start">
            <button className="btn btn-sm btn-ghost btn-icon" style={{ width: 26 }} onClick={() => fileRef.current?.click()} title="Replace song">
              <Icon name="upload" size={13} />
            </button>
            <button className="btn btn-sm btn-ghost btn-icon" style={{ width: 26 }} onClick={() => clearDeck(id)} title="Clear deck">
              <Icon name="x" size={13} />
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      {deck.status === "empty" || deck.status === "error" ? (
        <button
          className="h-[168px] rounded-[10px] border border-dashed border-white/[0.14] hover:border-white/[0.3] hover:bg-white/[0.03] bg-black/20 flex flex-col items-center justify-center gap-2.5 text-muted transition-colors"
          onClick={() => fileRef.current?.click()}
        >
          <div className="h-11 w-11 rounded-full grid place-items-center" style={{ background: `${color.main}1f`, color: color.main }}>
            <Icon name="upload" size={18} />
          </div>
          <div className="text-[13px]">
            <span className="text-text font-medium">Drop a song here</span> <span className="text-muted">or click to browse</span>
          </div>
          <div className="text-[11px] text-muted/80">MP3, WAV, M4A, FLAC, OGG · or press A / B on a song in the library</div>
          {deck.status === "error" && <div className="text-[12px] text-[#ff6b61] mt-1">{deck.error}</div>}
        </button>
      ) : deck.status !== "ready" || !a ? (
        <div className="h-[168px] rounded-[10px] inset flex flex-col items-center justify-center gap-3">
          <div className="w-1/2 h-1 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(3, deck.progress * 100)}%`, background: color.main }} />
          </div>
          <div className="text-[12px] text-text-2 pulse">{deck.progressLabel || "Working"}…</div>
        </div>
      ) : (
        <>
          <Waveform deckId={id} analysis={a} />

          {/* Selection + role actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-sm" disabled={!deck.selection} onClick={() => (isPreviewing ? pause() : void previewSelection(id))} title="Loop the selected bars at the master tempo">
              <Icon name={isPreviewing ? "stop" : "play"} size={11} /> {isPreviewing ? "Stop" : "Audition"}
            </button>
            <button className="btn btn-sm btn-primary" disabled={!deck.selection} onClick={() => deck.selection && addClip(id, deck.selection.startBar, deck.selection.lengthBeats)} title="Add the selected bars to the timeline as a clip">
              <Icon name="scissors" size={11} /> Add to timeline
            </button>
            <span className="text-[11.5px] text-muted ml-1">{deck.selection ? `${selBars} bar${selBars === 1 ? "" : "s"} selected` : "Drag across the waveform to select bars"}</span>
            <div className="flex-1" />
            {isFoundation ? (
              <button className="btn btn-sm" onClick={clearFoundation} title="Stop using this song as the continuous beat">
                <Icon name="anchor" size={11} /> Release foundation
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => setFoundation(id, deck.selection ? { startBar: deck.selection.startBar } : undefined)} title="Use this song as the continuous beat under the mashup">
                <Icon name="anchor" size={11} /> Use as foundation
              </button>
            )}
          </div>

          {/* Controls */}
          <div className="flex flex-wrap gap-x-5 gap-y-3 pt-3 border-t border-white/[0.07]">
            <div className="flex flex-col gap-1.5">
              <span className="label">Stem</span>
              <Segmented value={deck.activeStem} onChange={(v) => setDeckStem(id, v)} options={stems.map((k) => ({ value: k, label: STEM_LABELS[k] }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="label">Separate</span>
              <div className="flex items-center gap-1.5 h-[28px]">
                {deck.stemBusy ? (
                  <span className="text-[12px] text-text-2 pulse flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full border-2 border-white/20 border-t-white animate-spin" />
                    {deck.stemProgress}…
                  </span>
                ) : (
                  <>
                    <button className="btn btn-sm" onClick={() => void separateQuick(id)} title="Instant vocal / instrumental split using centre-channel cancellation. Runs locally in a second.">
                      <Icon name="wand" size={11} /> Quick
                    </button>
                    <div className="relative">
                      <button
                        className="btn btn-sm"
                        disabled={!config.stems}
                        onClick={() => setAiMenu((v) => !v)}
                        title={config.stems ? "Separate vocals, drums, bass and music with Demucs in the cloud (about 1–3 minutes)" : "Set REPLICATE_API_TOKEN and BLOB_READ_WRITE_TOKEN on the server to enable AI stems"}
                      >
                        <Icon name="sparkles" size={11} /> AI <Icon name="chev-down" size={10} />
                      </button>
                      {aiMenu && (
                        <div className="absolute left-0 top-[30px] z-30 w-[260px] rounded-[12px] border border-white/10 bg-[#16161d]/98 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.6)] p-1.5 flex flex-col fade-in" onPointerLeave={() => setAiMenu(false)}>
                          {DEMUCS_VARIANTS.map((v) => (
                            <button
                              key={v.id}
                              className="btn btn-ghost justify-start h-auto py-1.5 text-left"
                              onClick={() => {
                                setAiMenu(false);
                                void separateAI(id, v.id);
                              }}
                            >
                              <div>
                                <div className="text-[12.5px]">{v.label}</div>
                                <div className="text-[10.5px] text-muted font-normal">{v.hint}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="label">Pitch</span>
              <Stepper value={deck.semitones} min={-12} max={12} onChange={(v) => setDeckPitch(id, v)} format={(v) => (v > 0 ? `+${v}` : String(v))} suffix="st" title="Transpose this song in semitones (tempo is unaffected)" />
            </div>
            {isFoundation && (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="label">Starts at</span>
                  <Stepper value={project.foundation!.startBar + 1} min={1} max={a.totalBars} onChange={(v) => setFoundation(id, { startBar: v - 1 })} format={(v) => `bar ${v}`} title="Which bar of this song plays at the start of the mashup" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="label">Foundation stem</span>
                  <select className="sel h-[30px]" value={project.foundation!.stem} onChange={(e) => setFoundation(id, { stem: e.target.value as StemKey })}>
                    {stems.map((k) => (
                      <option key={k} value={k}>
                        {STEM_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5 min-w-[120px]">
                  <span className="label">Level</span>
                  <input type="range" min={0} max={1.5} step={0.01} value={project.foundation!.gain} onChange={(e) => setFoundation(id, { gain: parseFloat(e.target.value) })} className="mt-[11px]" />
                </div>
              </>
            )}
            <div className="flex flex-col gap-1.5 ml-auto">
              <span className="label">Grid</span>
              <button className={`btn btn-sm ${showGrid ? "text-accent-2" : ""}`} onClick={() => setShowGrid((v) => !v)} title="Adjust the detected tempo or downbeat">
                {showGrid ? "Done" : "Adjust"}
              </button>
            </div>
          </div>

          {showGrid && (
            <div className="flex flex-wrap items-center gap-2 text-[12px] rounded-[10px] inset p-2.5 fade-in">
              <span className="label mr-1">Tempo</span>
              <button className="btn btn-sm" onClick={() => scaleTempo(id, 0.5)} title="Halve the detected tempo">
                ÷2
              </button>
              <button className="btn btn-sm" onClick={() => scaleTempo(id, 2)} title="Double the detected tempo">
                ×2
              </button>
              <input
                className="num"
                style={{ height: 26, width: 70, fontSize: 12 }}
                defaultValue={a.bpm.toFixed(2)}
                key={a.bpm}
                onBlur={(e) => setDeckBpm(id, parseFloat(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                aria-label="Deck tempo"
              />
              <span className="label ml-3 mr-1">Downbeat</span>
              <button className="btn btn-sm" onClick={() => nudgeDownbeat(id, -1)} title="Move bar 1 one beat earlier">
                <Icon name="chev-left" size={11} /> 1 beat
              </button>
              <button className="btn btn-sm" onClick={() => nudgeDownbeat(id, 1)} title="Move bar 1 one beat later">
                1 beat <Icon name="chev-right" size={11} />
              </button>
              <button className="btn btn-sm" onClick={() => nudgeGridMs(id, -10)} title="Shift the whole grid 10 ms earlier">
                −10 ms
              </button>
              <button className="btn btn-sm" onClick={() => nudgeGridMs(id, 10)} title="Shift the whole grid 10 ms later">
                +10 ms
              </button>
              <span className="text-muted ml-auto font-mono tabular-nums text-[11px]">offset {(a.firstDownbeat * 1000).toFixed(0)} ms</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
