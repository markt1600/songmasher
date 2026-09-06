"use client";
/**
 * Song library persisted in IndexedDB. Stores the original file, the analysis (including
 * any grid corrections), the per-song pitch preference and the raw Demucs stems, so a song
 * can be reloaded instantly without re-analysing or re-separating it.
 */
import type { SongAnalysis } from "./audio/analysis";
import type { VocalProfile } from "./audio/vocal";
import type { DeckId, Project, StemKey, StemSource } from "./types";

export const AI_STEM_KEYS = ["vocals", "drums", "bass", "other"] as const;
export type AiStemKey = (typeof AI_STEM_KEYS)[number];

export interface LibrarySong {
  id: string; // sha-256 of the file bytes
  name: string;
  fileName: string;
  mimeType: string;
  size: number;
  addedAt: number;
  lastUsedAt: number;
  duration: number;
  bpm: number;
  keyName: string;
  camelot: string;
  analysis: SongAnalysis;
  semitones: number;
  stemSource: StemSource;
  /** which AI stems exist (stored locally under files `${id}:${stem}` and/or in the cloud) */
  aiStems: AiStemKey[];
  /** last metadata change; newest wins when merging local and cloud copies */
  updatedAt?: number;
  /** cloud copy of the original file */
  fileUrl?: string;
  /** cloud copies of the AI stems */
  stemUrls?: Partial<Record<AiStemKey, string>>;
  /** true when this record came from (or is synced to) the cloud library */
  cloud?: boolean;
  /** derived from the Demucs vocal stem: phrases, per-bar vocal energy, melody chroma */
  vocal?: VocalProfile | null;
}

interface StoredFile {
  id: string; // `${songId}:full` or `${songId}:${stem}`
  blob: Blob;
}

export interface LibraryProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  songs: Partial<Record<DeckId, string>>;
  songNames: Partial<Record<DeckId, string>>;
  deckSettings: Partial<Record<DeckId, { semitones: number; activeStem: StemKey }>>;
  project: Project;
  cloud?: boolean;
}

export interface LibraryMix {
  id: string;
  name: string;
  createdAt: number;
  durationSec: number;
  format: "wav" | "mp3";
  size: number;
  songNames: string[];
  /** cloud copy (public URL); required for sharing */
  url?: string;
  cloud?: boolean;
}

const DB_NAME = "songmasher";
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("mixes")) db.createObjectStore("mixes", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open library"));
  });
}

type StoreName = "songs" | "files" | "projects" | "mixes";

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("Library operation failed"));
        t.oncomplete = () => db.close();
      }),
  );
}

export async function hashFile(data: ArrayBuffer, fallback: File): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return `${fallback.name}-${fallback.size}-${fallback.lastModified}`;
  }
}

export async function listSongs(): Promise<LibrarySong[]> {
  try {
    const all = await tx<LibrarySong[]>("songs", "readonly", (s) => s.getAll());
    return all.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

export async function getSong(id: string): Promise<LibrarySong | undefined> {
  try {
    return await tx<LibrarySong | undefined>("songs", "readonly", (s) => s.get(id));
  } catch {
    return undefined;
  }
}

export async function putSong(song: LibrarySong): Promise<void> {
  await tx("songs", "readwrite", (s) => s.put(song));
}

export async function updateSong(id: string, patch: Partial<LibrarySong>): Promise<LibrarySong | undefined> {
  const existing = await getSong(id);
  if (!existing) return undefined;
  const next = { ...existing, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
  await putSong(next);
  return next;
}

export async function hasFile(id: string): Promise<boolean> {
  try {
    const key = await tx<IDBValidKey | undefined>("files", "readonly", (s) => s.getKey(id));
    return key !== undefined;
  } catch {
    return false;
  }
}

export async function putFile(id: string, blob: Blob): Promise<void> {
  await tx("files", "readwrite", (s) => s.put({ id, blob } satisfies StoredFile));
}

export async function getFile(id: string): Promise<Blob | undefined> {
  try {
    const rec = await tx<StoredFile | undefined>("files", "readonly", (s) => s.get(id));
    return rec?.blob;
  } catch {
    return undefined;
  }
}

export async function deleteSong(id: string): Promise<void> {
  const song = await getSong(id);
  await tx("songs", "readwrite", (s) => s.delete(id));
  const ids = [`${id}:full`, ...(song?.aiStems ?? []).map((k) => `${id}:${k}`)];
  for (const fid of ids) await tx("files", "readwrite", (s) => s.delete(fid));
}

/** Ask the browser not to evict the library under storage pressure. Best effort. */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    /* ignore */
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return null;
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---- Projects ---------------------------------------------------------------
export async function listProjects(): Promise<LibraryProject[]> {
  try {
    const all = await tx<LibraryProject[]>("projects", "readonly", (s) => s.getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}
export async function getProject(id: string): Promise<LibraryProject | undefined> {
  try {
    return await tx<LibraryProject | undefined>("projects", "readonly", (s) => s.get(id));
  } catch {
    return undefined;
  }
}
export async function putProject(p: LibraryProject): Promise<void> {
  await tx("projects", "readwrite", (s) => s.put(p));
}
export async function deleteProject(id: string): Promise<void> {
  await tx("projects", "readwrite", (s) => s.delete(id));
}

// ---- Mixes ------------------------------------------------------------------
export async function listMixes(): Promise<LibraryMix[]> {
  try {
    const all = await tx<LibraryMix[]>("mixes", "readonly", (s) => s.getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}
export async function getMix(id: string): Promise<LibraryMix | undefined> {
  try {
    return await tx<LibraryMix | undefined>("mixes", "readonly", (s) => s.get(id));
  } catch {
    return undefined;
  }
}
export async function putMix(m: LibraryMix): Promise<void> {
  await tx("mixes", "readwrite", (s) => s.put(m));
}
export async function deleteMix(id: string): Promise<void> {
  await tx("mixes", "readwrite", (s) => s.delete(id));
  await tx("files", "readwrite", (s) => s.delete(`mix:${id}`));
}

export function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Reconcile a song's local and cloud records. The newer record wins for ordinary fields, but stems are
 * a union: a separation done on one device (or saved before a crash) must never be forgotten because
 * the other side's record was written later without knowing about it.
 */
export function mergeSongRecords(local: LibrarySong, remote: LibrarySong): { next: LibrarySong; localNewer: boolean; remoteNewer: boolean } {
  const remoteNewer = (remote.updatedAt ?? 0) > (local.updatedAt ?? 0);
  const localNewer = (local.updatedAt ?? 0) > (remote.updatedAt ?? 0);
  const base: LibrarySong = remoteNewer ? { ...local, ...remote } : { ...remote, ...local };
  const stemUrls = { ...(remote.stemUrls ?? {}), ...(local.stemUrls ?? {}) };
  const aiStems = Array.from(new Set([...(remote.aiStems ?? []), ...(local.aiStems ?? [])])) as AiStemKey[];
  const hasAi = aiStems.length > 0 || Object.keys(stemUrls).length > 0;
  const next: LibrarySong = {
    ...base,
    cloud: true,
    fileUrl: local.fileUrl ?? remote.fileUrl,
    stemUrls,
    aiStems: hasAi ? (aiStems.length ? aiStems : (Object.keys(stemUrls) as AiStemKey[])) : base.aiStems ?? [],
    stemSource: hasAi ? "ai" : base.stemSource,
    vocal: base.vocal ?? local.vocal ?? remote.vocal ?? null,
  };
  return { next, localNewer, remoteNewer };
}
