import Replicate from "replicate";
import { authorized, cloudEnabled, unauthorized } from "@/lib/server/access";
import { SONG_ID_RE, webhookToken } from "@/lib/server/stems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STEM_KEYS = ["vocals", "drums", "bass", "other", "guitar", "piano"] as const;
/** Demucs variants: standard, fine-tuned (slower, cleaner), 6-stem (adds guitar + piano) */
const VARIANTS = ["htdemucs", "htdemucs_ft", "htdemucs_6s"] as const;
type Variant = (typeof VARIANTS)[number];

function client(): Replicate | null {
  const auth = process.env.REPLICATE_API_TOKEN;
  if (!auth) return null;
  return new Replicate({ auth });
}

let cachedVersion: { model: string; id: string; at: number } | null = null;

/**
 * Community models on Replicate must be run by version id. Unless DEMUCS_VERSION pins one,
 * look up the model's latest version (cached for an hour).
 */
async function resolveVersion(replicate: Replicate): Promise<string> {
  if (process.env.DEMUCS_VERSION) return process.env.DEMUCS_VERSION;
  const model = process.env.DEMUCS_MODEL ?? "ryan5453/demucs";
  if (cachedVersion && cachedVersion.model === model && Date.now() - cachedVersion.at < 3600_000) return cachedVersion.id;
  const [owner, name] = model.split("/");
  if (!owner || !name) throw new Error(`DEMUCS_MODEL must look like owner/name, got "${model}"`);
  const info = await replicate.models.get(owner, name);
  const id = info.latest_version?.id;
  if (!id) throw new Error(`Model ${model} has no published version`);
  cachedVersion = { model, id, at: Date.now() };
  return id;
}

/** Start a Demucs separation for an already-uploaded audio URL. */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("x-access-code"))) return unauthorized();
  const replicate = client();
  if (!replicate) return Response.json({ error: "REPLICATE_API_TOKEN is not set" }, { status: 501 });
  let audioUrl: string;
  let songId = "";
  let variant = process.env.DEMUCS_MODEL_VARIANT ?? "htdemucs";
  try {
    const body = (await request.json()) as { audioUrl?: string; variant?: string; songId?: string };
    audioUrl = String(body.audioUrl ?? "");
    const u = new URL(audioUrl);
    if (u.protocol !== "https:") throw new Error("bad protocol");
    if (body.variant && VARIANTS.includes(body.variant as Variant)) variant = body.variant;
    if (typeof body.songId === "string" && SONG_ID_RE.test(body.songId)) songId = body.songId;
  } catch {
    return Response.json({ error: "audioUrl must be an https URL" }, { status: 400 });
  }
  const input = {
    audio: audioUrl,
    model: variant,
    stem: "none",
    output_format: "mp3",
    mp3_bitrate: 320,
  };
  // When the deployment is reachable from the internet, have Replicate call back on completion so the
  // stems are saved even if the browser that started the job is gone (fine-tuned runs take a while).
  const origin = new URL(request.url).origin;
  const token = songId ? webhookToken(songId) : null;
  const webhook = songId && token && cloudEnabled() && /^https:\/\//.test(origin) && !/localhost|127\.0\.0\.1/.test(origin) ? `${origin}/api/stems/webhook?song=${encodeURIComponent(songId)}&t=${token}` : undefined;
  try {
    const version = await resolveVersion(replicate);
    const prediction = await replicate.predictions.create({ version, input, ...(webhook ? { webhook, webhook_events_filter: ["completed"] } : {}) });
    return Response.json({ id: prediction.id, status: prediction.status, webhook: !!webhook });
  } catch (err) {
    return Response.json({ error: `Replicate: ${(err as Error).message}` }, { status: 502 });
  }
}

/** Poll a separation job. */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("x-access-code"))) return unauthorized();
  const replicate = client();
  if (!replicate) return Response.json({ error: "REPLICATE_API_TOKEN is not set" }, { status: 501 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return Response.json({ error: "Missing id" }, { status: 400 });
  try {
    const p = await replicate.predictions.get(id);
    const output: Record<string, string> = {};
    const raw = p.output as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const k of STEM_KEYS) {
        const v = (raw as Record<string, unknown>)[k];
        if (typeof v === "string" && v.startsWith("http")) output[k] = v;
      }
    }
    const logs = typeof p.logs === "string" ? p.logs.trim().split("\n").pop()?.slice(0, 80) : undefined;
    return Response.json({ status: p.status, output, error: p.error ? String(p.error) : undefined, logs });
  } catch (err) {
    return Response.json({ error: `Replicate: ${(err as Error).message}` }, { status: 502 });
  }
}
