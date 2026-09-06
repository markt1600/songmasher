/**
 * Server-side stem bookkeeping shared by the client-driven save route and the Replicate webhook:
 * copying finished stems into the song's library folder and folding them into its metadata.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { del, list, put } from "@vercel/blob";

export const STEM_KEYS = ["vocals", "drums", "bass", "other"] as const;
export type StemKey = (typeof STEM_KEYS)[number];
export const SONG_ID_RE = /^[\w.-]{1,120}$/;

export function allowedStemSource(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery") || url.hostname.endsWith(".replicate.com"));
  } catch {
    return false;
  }
}

/** Copies finished Demucs stems from Replicate into `library/<id>/stems/`; returns their library URLs. */
export async function copyStemsToLibrary(id: string, urls: Record<string, string>): Promise<Record<string, string>> {
  const entries: [StemKey, string][] = [];
  for (const k of STEM_KEYS) {
    const u = urls[k];
    if (typeof u === "string" && allowedStemSource(u)) entries.push([k, u]);
  }
  if (entries.length === 0) throw new Error("No stem urls");
  const stems: Record<string, string> = {};
  await Promise.all(
    entries.map(async ([k, url]) => {
      const ext = /\.(wav|flac|mp3)(\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? "mp3";
      const src = await fetch(url);
      if (!src.ok || !src.body) throw new Error(`Could not fetch ${k} from Replicate (${src.status})`);
      const res = await put(`library/${id}/stems/${k}.${ext}`, src.body, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: src.headers.get("content-type") ?? "audio/mpeg",
      });
      stems[k] = res.url;
    }),
  );
  return stems;
}

interface MetaRow {
  url: string;
  pathname: string;
}

function metaStamp(pathname: string): number {
  const m = /\/meta-(\d+)\.json$/.exec(pathname);
  return m ? Number(m[1]) : 0;
}

async function listMetas(id: string): Promise<MetaRow[]> {
  const rows: MetaRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `library/${id}/meta-`, cursor, limit: 1000 });
    rows.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return rows.sort((a, b) => metaStamp(b.pathname) - metaStamp(a.pathname));
}

/** The song's newest cloud record, or null when the song is not in the cloud library. */
export async function readSongMeta(id: string): Promise<Record<string, unknown> | null> {
  const metas = await listMetas(id);
  if (metas.length === 0) return null;
  const res = await fetch(metas[0].url, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

/** Writes a new immutable record file and prunes the older ones. */
export async function writeSongMeta(id: string, meta: Record<string, unknown>): Promise<void> {
  const stamp = Date.now();
  await put(`library/${id}/meta-${stamp}.json`, JSON.stringify(meta), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  const old = (await listMetas(id)).filter((f) => metaStamp(f.pathname) < stamp);
  if (old.length) await del(old.map((f) => f.url));
}

/** Folds finished stems into the song's cloud record so any device picks them up on its next refresh. */
export async function recordStemsInMeta(id: string, stems: Record<string, string>): Promise<boolean> {
  const meta = await readSongMeta(id);
  if (!meta) return false;
  const prev = (meta.stemUrls as Record<string, string> | undefined) ?? {};
  const stemUrls = { ...prev, ...stems };
  const next = {
    ...meta,
    stemUrls,
    aiStems: Object.keys(stemUrls),
    stemSource: "ai",
    pendingStems: undefined,
    cloud: true,
    updatedAt: Date.now(),
  };
  await writeSongMeta(id, next);
  return true;
}

/** A per-song token so only Replicate's callback for that song can write its stems. */
export function webhookToken(songId: string): string | null {
  const secret = process.env.STEMS_WEBHOOK_SECRET || process.env.ACCESS_CODE || process.env.STEMS_ACCESS_CODE || process.env.REPLICATE_API_TOKEN;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`stems:${songId}`).digest("hex");
}

export function webhookTokenValid(songId: string, token: string | null): boolean {
  const expected = webhookToken(songId);
  if (!expected || !token || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
