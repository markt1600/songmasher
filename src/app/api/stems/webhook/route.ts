import Replicate from "replicate";
import { cloudEnabled } from "@/lib/server/access";
import { copyStemsToLibrary, recordStemsInMeta, SONG_ID_RE, STEM_KEYS, webhookTokenValid } from "@/lib/server/stems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Replicate calls this when a separation finishes, so the stems land in the library even if the browser
 * that started the job has long since closed. The prediction is re-read from Replicate rather than
 * trusted from the request body, and it must have been run on this song's own audio.
 */
export async function POST(request: Request): Promise<Response> {
  if (!cloudEnabled()) return Response.json({ error: "Cloud library is not configured" }, { status: 501 });
  const url = new URL(request.url);
  const songId = url.searchParams.get("song") ?? "";
  if (!SONG_ID_RE.test(songId) || !webhookTokenValid(songId, url.searchParams.get("t"))) return Response.json({ error: "Forbidden" }, { status: 403 });
  let predictionId = "";
  try {
    const body = (await request.json()) as { id?: unknown };
    if (typeof body.id === "string" && /^[A-Za-z0-9_-]+$/.test(body.id)) predictionId = body.id;
  } catch {
    /* fall through */
  }
  if (!predictionId) return Response.json({ error: "Missing prediction id" }, { status: 400 });
  const auth = process.env.REPLICATE_API_TOKEN;
  if (!auth) return Response.json({ error: "REPLICATE_API_TOKEN is not set" }, { status: 501 });
  try {
    const p = await new Replicate({ auth }).predictions.get(predictionId);
    if (p.status !== "succeeded") return Response.json({ ok: true, status: p.status });
    const audio = (p.input as { audio?: unknown } | undefined)?.audio;
    if (typeof audio !== "string" || !audio.includes(`/library/${songId}/`)) return Response.json({ error: "Prediction does not belong to this song" }, { status: 400 });
    const raw = (p.output ?? {}) as Record<string, unknown>;
    const urls: Record<string, string> = {};
    for (const k of STEM_KEYS) if (typeof raw[k] === "string") urls[k] = raw[k] as string;
    const stems = await copyStemsToLibrary(songId, urls);
    const recorded = await recordStemsInMeta(songId, stems);
    return Response.json({ ok: true, stems: Object.keys(stems), recorded });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
