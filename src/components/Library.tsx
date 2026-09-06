"use client";
import { useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { formatBytes, type LibraryMix, type LibraryProject, type LibrarySong } from "@/lib/library";
import { DECK_COLORS, type DeckId } from "@/lib/types";
import { Icon } from "./ui";
import { beginDragOnMove } from "@/lib/dnd";

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type SongSort = "recent" | "name" | "bpm";
/** Songs shown before "Show all": about two rows on a wide screen. */
const SONG_LIMIT = 12;
function readPref(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(`songmasher:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(`songmasher:${key}`, value);
  } catch {
    /* private mode */
  }
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
  const { importFiles, loadFromLibrary, deleteFromLibrary, changeAccessCode, refreshLibrary, openProject, renameProject, deleteProject, deleteMix, shareLink, playMix, showToast } = useStore();
  const projects = useStore((s) => s.projects);
  const mixes = useStore((s) => s.mixes);
  const currentProject = useStore((s) => s.currentProject);
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The studio renders client-only, so view preferences can be read straight from localStorage.
  const [sort, setSort] = useState<SongSort>(() => {
    const v = readPref("songSort", "recent");
    return v === "name" || v === "bpm" ? v : "recent";
  });
  const [showAll, setShowAll] = useState(() => readPref("songShowAll", "0") === "1");

  const songs = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? library.filter((x) => x.name.toLowerCase().includes(q) || x.keyName.toLowerCase().includes(q) || x.camelot.toLowerCase() === q) : [...library];
    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    else if (sort === "bpm") list.sort((a, b) => a.bpm - b.bpm);
    else list.sort((a, b) => b.addedAt - a.addedAt);
    return list;
  }, [library, query, sort]);
  const capped = !showAll && !query.trim() && songs.length > SONG_LIMIT;
  const visible = capped ? songs.slice(0, SONG_LIMIT) : songs;

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
        {library.length > 6 && (
          <>
            <div className="relative hidden sm:block">
              <input
                className="h-[28px] w-[170px] rounded-[8px] border border-white/[0.12] bg-black/30 pl-2.5 pr-6 text-[12px] outline-none focus:border-[#7c6cff] placeholder:text-muted/70"
                placeholder="Filter songs…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter songs"
              />
              {query && (
                <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-text" onClick={() => setQuery("")} title="Clear filter">
                  <Icon name="x" size={10} />
                </button>
              )}
            </div>
            <div className="seg hidden md:inline-flex" title="Sort songs">
              {(["recent", "name", "bpm"] as SongSort[]).map((k) => (
                <button
                  key={k}
                  data-active={sort === k}
                  style={{ height: 22, fontSize: 11.5, padding: "0 8px" }}
                  onClick={() => {
                    setSort(k);
                    writePref("songSort", k);
                  }}
                >
                  {k === "recent" ? "Recent" : k === "name" ? "Name" : "BPM"}
                </button>
              ))}
            </div>
          </>
        )}
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
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(196px, 1fr))" }}>
          {visible.map((song) => (
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
          {visible.length === 0 && <div className="text-[12px] text-muted py-3 col-span-full">No songs match “{query}”.</div>}
        </div>
      )}
      {(capped || (showAll && songs.length > SONG_LIMIT)) && (
        <button
          className="self-center text-[11.5px] text-text-2 hover:text-text -mt-1"
          onClick={() => {
            setShowAll(!showAll);
            writePref("songShowAll", showAll ? "0" : "1");
          }}
        >
          {capped ? `Show all ${songs.length} songs` : "Show fewer"}
        </button>
      )}

      {projects.length > 0 && (
        <div className="flex flex-col gap-2 pt-1 border-t border-white/[0.06]">
          <div className="flex items-center gap-2 mt-1">
            <Icon name="folder" size={12} />
            <span className="label">Mashups</span>
            <span className="text-[11px] text-muted">{projects.length}</span>
          </div>
          <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1">
            {projects.map((p) => (
              <ProjectCard key={p.id} p={p} active={currentProject?.id === p.id} onOpen={() => void openProject(p.id)} onRename={() => void renameProject(p.id)} onDelete={() => void deleteProject(p.id)} />
            ))}
          </div>
        </div>
      )}

      {mixes.length > 0 && (
        <div className="flex flex-col gap-2 pt-1 border-t border-white/[0.06]">
          <div className="flex items-center gap-2 mt-1">
            <Icon name="download" size={12} />
            <span className="label">Rendered mixes</span>
            <span className="text-[11px] text-muted">{mixes.length}</span>
          </div>
          <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1">
            {mixes.map((m) => (
              <MixCard
                key={m.id}
                m={m}
                link={shareLink(m.id)}
                onPlay={() => playMix(m.id)}
                onShare={async () => {
                  const l = shareLink(m.id);
                  if (!l) return;
                  try {
                    await navigator.clipboard.writeText(l);
                    showToast("Share link copied");
                  } catch {
                    window.prompt("Share link", l);
                  }
                }}
                onDelete={() => void deleteMix(m.id)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectCard({ p, active, onOpen, onRename, onDelete }: { p: LibraryProject; active: boolean; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const songs = (["A", "B"] as const).map((d) => p.songNames[d]).filter(Boolean);
  return (
    <div className="relative shrink-0 w-[250px] rounded-[12px] inset p-3 flex flex-col gap-2 fade-in" style={active ? { borderColor: "rgba(124,108,255,0.6)", boxShadow: "0 0 0 1px rgba(124,108,255,0.25)" } : undefined}>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold truncate tracking-[-0.01em]" title={p.name}>
          {p.name}
        </div>
        <div className="text-[11px] text-muted mt-0.5 truncate">{songs.join(" × ") || "No songs"}</div>
        <div className="text-[10.5px] text-muted/80 mt-0.5 font-mono tabular-nums">
          {p.project.clips.length} clip{p.project.clips.length === 1 ? "" : "s"} · {p.project.lengthBars} bars · {new Date(p.updatedAt).toLocaleDateString()}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button className="btn btn-xs btn-primary" onClick={onOpen}>
          Open
        </button>
        <button className="btn btn-xs" onClick={onRename} title="Rename">
          Rename
        </button>
        <div className="flex-1" />
        <button
          className={`btn btn-xs btn-ghost ${confirm ? "!text-[#ff6b61] !bg-[#ff453a]/15" : "text-muted hover:!text-[#ff6b61]"}`}
          onClick={() => {
            if (confirm) onDelete();
            else {
              setConfirm(true);
              window.setTimeout(() => setConfirm(false), 3500);
            }
          }}
          title={confirm ? "Click again to delete" : "Delete mashup"}
        >
          {confirm ? "Delete?" : <Icon name="trash" size={11} />}
        </button>
      </div>
    </div>
  );
}

function MixCard({ m, link, onPlay, onShare, onDelete }: { m: LibraryMix; link: string | null; onPlay: () => Promise<string | null>; onShare: () => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  return (
    <div className="relative shrink-0 w-[290px] rounded-[12px] inset p-3 flex flex-col gap-2 fade-in">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold truncate tracking-[-0.01em]" title={m.name}>
          {m.name}
        </div>
        <div className="text-[11px] text-muted mt-0.5 font-mono tabular-nums truncate">
          {fmtDuration(m.durationSec)} · {m.format.toUpperCase()} · {formatBytes(m.size)} · {new Date(m.createdAt).toLocaleDateString()}
        </div>
      </div>
      {src ? (
        <audio controls autoPlay src={src} className="w-full h-8" />
      ) : (
        <div className="flex items-center gap-1.5">
          <button className="btn btn-xs" onClick={async () => setSrc(await onPlay())}>
            <Icon name="play" size={10} /> Play
          </button>
          {link ? (
            <button className="btn btn-xs" onClick={onShare} title={link}>
              <Icon name="share" size={10} /> Share
            </button>
          ) : (
            <span className="text-[10.5px] text-muted" title="Turn on the cloud library (Vercel Blob) to share mixes by link">local only</span>
          )}
          <div className="flex-1" />
          <button
            className={`btn btn-xs btn-ghost ${confirm ? "!text-[#ff6b61] !bg-[#ff453a]/15" : "text-muted hover:!text-[#ff6b61]"}`}
            onClick={() => {
              if (confirm) onDelete();
              else {
                setConfirm(true);
                window.setTimeout(() => setConfirm(false), 3500);
              }
            }}
            title={confirm ? "Click again to delete" : "Delete mix"}
          >
            {confirm ? "Delete?" : <Icon name="trash" size={11} />}
          </button>
        </div>
      )}
    </div>
  );
}

function SongCard({ song, cloud, loadedOn, confirming, onLoad, onDelete }: { song: LibrarySong; cloud: boolean; loadedOn: DeckId | null; confirming: boolean; onLoad: (deck: DeckId) => void; onDelete: () => void }) {
  const ring = loadedOn ? DECK_COLORS[loadedOn].main : undefined;
  const synced = !!song.fileUrl;
  const ai = song.stemSource === "ai" && song.aiStems.length > 0;
  return (
    <div
      className="relative min-w-0 rounded-[10px] inset px-2.5 py-2 flex flex-col gap-1.5 transition-[border-color,box-shadow] duration-150 fade-in cursor-grab active:cursor-grabbing"
      style={ring ? { borderColor: `${ring}88`, boxShadow: `0 0 0 1px ${ring}33` } : undefined}
      title={`${song.name}\nDrag onto a deck to load it`}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        beginDragOnMove(e, { kind: "song", id: song.id, name: song.name });
      }}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {loadedOn && (
          <span className="text-[9.5px] font-bold h-4 w-4 rounded-[5px] grid place-items-center text-black shrink-0" style={{ background: ring }}>
            {loadedOn}
          </span>
        )}
        <div className="text-[12.5px] font-semibold truncate tracking-[-0.01em] flex-1 min-w-0">{song.name}</div>
        {ai && (
          <span className="shrink-0" style={{ color: "var(--accent-2)" }} title="Demucs stems are saved with this song">
            <Icon name="sparkles" size={10} />
          </span>
        )}
        {cloud && (
          <span className="text-muted shrink-0" title={synced ? "Stored in your cloud library" : "Uploading to your cloud library"} style={{ opacity: synced ? 0.7 : 0.3 }}>
            <Icon name="cloud" size={11} />
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 min-w-0">
        <div className="text-[10.5px] text-muted font-mono tabular-nums truncate whitespace-nowrap flex-1 min-w-0" title={`${song.bpm.toFixed(1)} BPM · ${song.keyName} ${song.camelot} · ${fmtDuration(song.duration)} · ${ai ? "AI stems" : song.stemSource === "quick" ? "quick stems" : formatBytes(song.size)}`}>
          {song.bpm.toFixed(1)} <span className="opacity-70">BPM</span> · {song.keyName} {song.camelot} · {fmtDuration(song.duration)}
        </div>
        <button className="btn btn-xs !h-[20px] !px-1.5 !text-[10.5px]" onClick={() => onLoad("A")} title="Load into deck A" style={{ color: "var(--a)" }}>
          A
        </button>
        <button className="btn btn-xs !h-[20px] !px-1.5 !text-[10.5px]" onClick={() => onLoad("B")} title="Load into deck B" style={{ color: "var(--b)" }}>
          B
        </button>
        <button className={`btn btn-xs btn-ghost !h-[20px] !px-1 ${confirming ? "!text-[#ff6b61] !bg-[#ff453a]/15 !px-1.5 !text-[10.5px]" : "text-muted hover:!text-[#ff6b61]"}`} onClick={onDelete} title={confirming ? "Click again to delete this song and its stems everywhere" : "Delete from library"}>
          {confirming ? "Delete?" : <Icon name="trash" size={10} />}
        </button>
      </div>
    </div>
  );
}
