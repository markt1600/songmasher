"use client";
import { useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { formatBytes, type LibrarySong } from "@/lib/library";
import { DECK_COLORS, type DeckId } from "@/lib/types";
import { Icon } from "./ui";
import { beginDragOnMove } from "@/lib/dnd";

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Library() {
  const library = useStore((s) => s.library);
  const decks = useStore((s) => s.decks);
  const busy = useStore((s) => s.libraryBusy);
  const storage = useStore((s) => s.storage);
  const config = useStore((s) => s.config);
  const syncing = useStore((s) => s.syncing);
  const cloudBytes = useStore((s) => s.cloudBytes);
  const cloudError = useStore((s) => s.cloudError);
  const { importFiles, loadFromLibrary, deleteFromLibrary, changeAccessCode, refreshLibrary } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const loadedOn = (id: string): DeckId | null => {
    if (decks.A.songId === id && decks.A.status !== "empty") return "A";
    if (decks.B.songId === id && decks.B.status !== "empty") return "B";
    return null;
  };

  const count = library.length;
  const where = config.cloud ? "synced to your cloud library" : "saved in this browser";
  const size = config.cloud ? cloudBytes : storage?.usage ?? 0;
  const status = count === 0 ? (config.cloud ? "Songs you add are saved to your cloud library and follow you to any device" : "Songs you add are saved in this browser, stems included") : `${count} song${count === 1 ? "" : "s"} ${where}${size ? ` · ${formatBytes(size)}` : ""}`;

  return (
    <section
      className="panel px-4 py-3 flex flex-col gap-3 transition-[border-color,box-shadow] duration-150"
      style={drag ? { borderColor: "var(--accent)", boxShadow: "0 0 0 3px rgba(124,108,255,0.25)" } : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|oga|aiff?)$/i.test(f.name));
        if (files.length) void importFiles(files);
      }}
    >
      <input ref={fileRef} type="file" multiple accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.aiff,.aif" className="hidden" onChange={(e) => e.target.files && void importFiles(Array.from(e.target.files))} />

      <div className="flex items-center gap-2.5 min-h-[30px]">
        <div className="h-7 w-7 rounded-[8px] grid place-items-center bg-white/[0.08] border border-white/[0.08]">
          <Icon name="music" size={13} />
        </div>
        <div className="font-semibold text-[14px] tracking-[-0.01em]">Library</div>
        <span className="text-[11.5px] text-muted truncate">{status}</span>
        {config.cloud && (
          <span className="chip" title="Songs, corrections and stems are stored in Vercel Blob and load on any device">
            <Icon name="cloud" size={10} /> Cloud
          </span>
        )}
        <div className="flex-1" />
        {(busy || syncing) && (
          <span className="text-[11.5px] text-text-2 pulse flex items-center gap-2 mr-1 truncate max-w-[320px]">
            <span className="h-3 w-3 rounded-full border-2 border-white/20 border-t-white animate-spin shrink-0" />
            {busy ? `${busy.name} · ${busy.label}` : syncing}
          </span>
        )}
        {cloudError && !busy && !syncing && (
          <button className="text-[11.5px] text-[#ff6b61] mr-1 truncate max-w-[360px] hover:underline" onClick={() => void refreshLibrary()} title={`${cloudError}. Click to retry.`}>
            Cloud: {cloudError}
          </button>
        )}
        {config.needCode && (
          <button className="btn btn-sm btn-ghost" onClick={changeAccessCode} title="Change the access code used for the cloud library and AI stems">
            <Icon name="key" size={12} />
          </button>
        )}
        <button className="btn btn-sm btn-primary" onClick={() => fileRef.current?.click()} title="Add an MP3, WAV, M4A, FLAC or OGG file. It is analysed once and kept in your library.">
          <Icon name="plus" size={12} /> Add song
        </button>
      </div>

      {library.length === 0 ? (
        <button
          className="h-[68px] rounded-[10px] border border-dashed border-white/[0.14] hover:border-white/[0.3] hover:bg-white/[0.03] bg-black/20 text-[12.5px] text-muted transition-colors"
          onClick={() => fileRef.current?.click()}
        >
          <span className="text-text font-medium">Drop songs here</span> or click Add song. Each one is analysed once and reloads instantly next time.
        </button>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarGutter: "stable" }}>
          {library.map((song) => (
            <SongCard
              key={song.id}
              song={song}
              cloud={config.cloud}
              loadedOn={loadedOn(song.id)}
              confirming={confirmId === song.id}
              onLoad={(deck) => void loadFromLibrary(deck, song.id)}
              onDelete={() => {
                if (confirmId === song.id) {
                  setConfirmId(null);
                  void deleteFromLibrary(song.id);
                } else {
                  setConfirmId(song.id);
                  window.setTimeout(() => setConfirmId((c) => (c === song.id ? null : c)), 3500);
                }
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SongCard({ song, cloud, loadedOn, confirming, onLoad, onDelete }: { song: LibrarySong; cloud: boolean; loadedOn: DeckId | null; confirming: boolean; onLoad: (deck: DeckId) => void; onDelete: () => void }) {
  const ring = loadedOn ? DECK_COLORS[loadedOn].main : undefined;
  const synced = !!song.fileUrl;
  return (
    <div
      className="relative shrink-0 w-[268px] rounded-[12px] inset p-3 flex flex-col gap-2 transition-[border-color,box-shadow] duration-150 fade-in cursor-grab active:cursor-grabbing"
      style={ring ? { borderColor: `${ring}88`, boxShadow: `0 0 0 1px ${ring}33` } : undefined}
      title="Drag onto a deck to load it"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        beginDragOnMove(e, { kind: "song", id: song.id, name: song.name });
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold truncate tracking-[-0.01em]" title={song.name}>
            {song.name}
          </div>
          <div className="text-[11px] text-muted mt-0.5 font-mono tabular-nums truncate whitespace-nowrap">
            {song.bpm.toFixed(1)} BPM · {song.keyName} {song.camelot} · {fmtDuration(song.duration)}
          </div>
        </div>
        {loadedOn && (
          <span className="text-[10px] font-bold h-5 w-5 rounded-[6px] grid place-items-center text-black shrink-0" style={{ background: ring }}>
            {loadedOn}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {song.stemSource === "ai" && song.aiStems.length > 0 ? (
          <span className="chip" style={{ color: "var(--accent-2)", borderColor: "rgba(124,108,255,0.4)" }} title="Demucs stems are saved with this song">
            <Icon name="sparkles" size={10} /> AI stems
          </span>
        ) : song.stemSource === "quick" ? (
          <span className="chip">Quick stems</span>
        ) : (
          <span className="chip">{formatBytes(song.size)}</span>
        )}
        {cloud && (
          <span className="text-muted" title={synced ? "Stored in your cloud library" : "Uploading to your cloud library"} style={{ opacity: synced ? 0.8 : 0.35 }}>
            <Icon name="cloud" size={12} />
          </span>
        )}
        <div className="flex-1" />
        <button className="btn btn-xs" onClick={() => onLoad("A")} title="Load into deck A" style={{ color: "var(--a)" }}>
          A
        </button>
        <button className="btn btn-xs" onClick={() => onLoad("B")} title="Load into deck B" style={{ color: "var(--b)" }}>
          B
        </button>
        <button className={`btn btn-xs btn-ghost ${confirming ? "!text-[#ff6b61] !bg-[#ff453a]/15" : "text-muted hover:!text-[#ff6b61]"}`} onClick={onDelete} title={confirming ? "Click again to delete this song and its stems everywhere" : "Delete from library"}>
          {confirming ? "Delete?" : <Icon name="trash" size={11} />}
        </button>
      </div>
    </div>
  );
}
