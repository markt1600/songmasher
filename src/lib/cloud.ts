"use client";
/** Client for the cloud library (Vercel Blob behind /api/library). */
import { upload } from "@vercel/blob/client";
import type { SongAnalysis } from "./audio/analysis";
import type { LibrarySong } from "./library";

export class AccessCodeError extends Error {
  constructor() {
    super("Access code required");
  }
}

type Wire = Omit<LibrarySong, "analysis"> & { analysis: Record<string, unknown> };

const F32_KEYS: (keyof SongAnalysis)[] = ["peaks", "rms", "barEnergy", "barOnset", "barVocal"];

export function serializeSong(song: LibrarySong): Wire {
  const a: Record<string, unknown> = { ...song.analysis };
  for (const k of F32_KEYS) {
    const arr = song.analysis[k] as Float32Array;
    a[k] = Array.from(arr).map((v) => Math.round(v * 10000) / 10000);
  }
  return { ...song, analysis: a };
}

export function deserializeSong(w: Wire): LibrarySong {
  const a = { ...w.analysis } as Record<string, unknown>;
  for (const k of F32_KEYS) a[k] = Float32Array.from((a[k] as number[]) ?? []);
  return { ...w, analysis: a as unknown as SongAnalysis, cloud: true };
}

function headers(code: string): HeadersInit {
  return { "content-type": "application/json", "x-access-code": code };
}

async function check(res: Response): Promise<Response> {
  if (res.status === 401) throw new AccessCodeError();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res;
}

export async function cloudList(code: string): Promise<{ songs: LibrarySong[]; bytes: number }> {
  const res = await check(await fetch("/api/library", { headers: headers(code), cache: "no-store" }));
  const j = (await res.json()) as { songs: Wire[]; bytes: number };
  return { songs: j.songs.map(deserializeSong), bytes: j.bytes };
}

export async function cloudPutMeta(song: LibrarySong, code: string): Promise<void> {
  await check(await fetch("/api/library", { method: "PUT", headers: headers(code), body: JSON.stringify(serializeSong(song)) }));
}

export async function cloudDelete(id: string, code: string): Promise<void> {
  await check(await fetch(`/api/library?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: headers(code) }));
}

export async function cloudUploadSong(id: string, file: Blob, fileName: string, code: string): Promise<string> {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1] ?? "mp3").toLowerCase();
  try {
    const res = await upload(`library/${id}/song.${ext}`, file, {
      access: "public",
      handleUploadUrl: "/api/library/upload",
      clientPayload: JSON.stringify({ code }),
      contentType: file.type || "audio/mpeg",
    });
    return res.url;
  } catch (err) {
    if (/access code/i.test((err as Error).message)) throw new AccessCodeError();
    throw err;
  }
}

export async function cloudUploadStem(id: string, stem: string, file: Blob, code: string): Promise<string> {
  try {
    const res = await upload(`library/${id}/stems/${stem}.mp3`, file, {
      access: "public",
      handleUploadUrl: "/api/library/upload",
      clientPayload: JSON.stringify({ code }),
      contentType: "audio/mpeg",
    });
    return res.url;
  } catch (err) {
    if (/access code/i.test((err as Error).message)) throw new AccessCodeError();
    throw err;
  }
}

export async function cloudSaveStems(id: string, urls: Record<string, string>, code: string): Promise<Record<string, string>> {
  const res = await check(await fetch("/api/library/stems", { method: "POST", headers: headers(code), body: JSON.stringify({ id, urls }) }));
  return ((await res.json()) as { stems: Record<string, string> }).stems;
}

export async function cloudFetch(url: string, code: string): Promise<ArrayBuffer> {
  const res = await check(await fetch(`/api/stems/fetch?url=${encodeURIComponent(url)}`, { headers: { "x-access-code": code } }));
  return res.arrayBuffer();
}
