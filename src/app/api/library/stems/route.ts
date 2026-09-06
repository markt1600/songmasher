import { authorized, cloudEnabled, unauthorized } from "@/lib/server/access";
import { copyStemsToLibrary, recordStemsInMeta, SONG_ID_RE } from "@/lib/server/stems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Copies finished Demucs stems from Replicate into the song's library folder and records them on the song. */
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
  if (!SONG_ID_RE.test(id)) return Response.json({ error: "Invalid song id" }, { status: 400 });
  try {
    const stems = await copyStemsToLibrary(id, body.urls ?? {});
    // Best effort: the client writes its own record next, but noting the stems here means even a client
    // that dies right now leaves the cloud record complete.
    await recordStemsInMeta(id, stems).catch(() => false);
    return Response.json({ stems });
  } catch (err) {
    const msg = (err as Error).message;
    return Response.json({ error: msg === "No stem urls" ? msg : `Blob: ${msg}` }, { status: msg === "No stem urls" ? 400 : 502 });
  }
}
