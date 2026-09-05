import { del, list, put } from "@vercel/blob";
import { authorized, cloudEnabled, unauthorized } from "@/lib/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ID_RE = /^[\w.-]{1,120}$/;
const KINDS = ["library", "projects", "mixes"] as const;
type Kind = (typeof KINDS)[number];
function kindOf(request: Request): Kind {
  const k = new URL(request.url).searchParams.get("kind") ?? "library";
  return (KINDS as readonly string[]).includes(k) ? (k as Kind) : "library";
}

interface BlobRow {
  url: string;
  pathname: string;
  size: number;
}

async function listAll(prefix: string): Promise<BlobRow[]> {
  const rows: BlobRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    rows.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return rows;
}

function metaStamp(pathname: string): number {
  const m = /\/meta-(\d+)\.json$/.exec(pathname);
  return m ? Number(m[1]) : 0;
}

/** List every song in the cloud library (newest metadata per song). */
export async function GET(request: Request): Promise<Response> {
  if (!cloudEnabled()) return Response.json({ error: "Cloud library is not configured" }, { status: 501 });
  if (!authorized(request.headers.get("x-access-code"))) return unauthorized();
  const kind = kindOf(request);
  try {
    const rows = await listAll(`${kind}/`);
    const bySong = new Map<string, BlobRow[]>();
    for (const r of rows) {
      const id = r.pathname.split("/")[1];
      if (!id) continue;
      bySong.set(id, [...(bySong.get(id) ?? []), r]);
    }
    const songs: unknown[] = [];
    let bytes = 0;
    await Promise.all(
      Array.from(bySong.values()).map(async (files) => {
        const metas = files.filter((f) => /\/meta-\d+\.json$/.test(f.pathname)).sort((a, b) => metaStamp(b.pathname) - metaStamp(a.pathname));
        if (metas.length === 0) return;
        for (const f of files) bytes += f.size;
        try {
          const res = await fetch(metas[0].url, { cache: "no-store" });
          if (res.ok) songs.push(await res.json());
        } catch {
          /* skip unreadable */
        }
      }),
    );
    return Response.json({ songs, bytes });
  } catch (err) {
    return Response.json({ error: `Blob: ${(err as Error).message}` }, { status: 502 });
  }
}

/** Write a song's metadata as a new immutable file (older ones are pruned), so CDN caching never serves stale data. */
export async function PUT(request: Request): Promise<Response> {
  if (!cloudEnabled()) return Response.json({ error: "Cloud library is not configured" }, { status: 501 });
  if (!authorized(request.headers.get("x-access-code"))) return unauthorized();
  let song: { id?: unknown };
  try {
    song = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof song.id === "string" ? song.id : "";
  if (!ID_RE.test(id)) return Response.json({ error: "Invalid song id" }, { status: 400 });
  const kind = kindOf(request);
  try {
    const stamp = Date.now();
    await put(`${kind}/${id}/meta-${stamp}.json`, JSON.stringify(song), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      cacheControlMaxAge: 60,
    });
    const old = (await listAll(`${kind}/${id}/meta-`)).filter((f) => metaStamp(f.pathname) < stamp);
    if (old.length) await del(old.map((f) => f.url));
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: `Blob: ${(err as Error).message}` }, { status: 502 });
  }
}

/** Delete a song and everything stored with it. */
export async function DELETE(request: Request): Promise<Response> {
  if (!cloudEnabled()) return Response.json({ error: "Cloud library is not configured" }, { status: 501 });
  if (!authorized(request.headers.get("x-access-code"))) return unauthorized();
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!ID_RE.test(id)) return Response.json({ error: "Invalid song id" }, { status: 400 });
  const kind = kindOf(request);
  try {
    const rows = await listAll(`${kind}/${id}/`);
    if (rows.length) await del(rows.map((r) => r.url));
    return Response.json({ ok: true, deleted: rows.length });
  } catch (err) {
    return Response.json({ error: `Blob: ${(err as Error).message}` }, { status: 502 });
  }
}
