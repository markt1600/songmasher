import { put } from "@vercel/blob";
import { authorized, cloudEnabled, unauthorized } from "@/lib/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KEYS = ["vocals", "drums", "bass", "other"] as const;
type Key = (typeof KEYS)[number];

function allowedSource(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery") || url.hostname.endsWith(".replicate.com"));
  } catch {
    return false;
  }
}

/** Copies finished Demucs stems from Replicate into the song's library folder. */
export async function POST(request: Request): Promise<Response> {
  if (!cloudEnabled()) return Response.json({ error: "Cloud library is not configured" }, { status: 501 });
  if (!authorized(request.headers.get("x-access-code"))) return unauthorized();
  let body: { id?: string; urls?: Record<string, string> };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = body.id ?? "";
  if (!/^[\w.-]{1,120}$/.test(id)) return Response.json({ error: "Invalid song id" }, { status: 400 });
  const entries: [Key, string][] = [];
  for (const k of KEYS) {
    const u = body.urls?.[k];
    if (typeof u === "string" && allowedSource(u)) entries.push([k, u]);
  }
  if (entries.length === 0) return Response.json({ error: "No stem urls" }, { status: 400 });
  try {
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
    return Response.json({ stems });
  } catch (err) {
    return Response.json({ error: `Blob: ${(err as Error).message}` }, { status: 502 });
  }
}
