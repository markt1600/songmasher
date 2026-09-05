import Replicate from "replicate";
import { stemsAuthorized } from "@/lib/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STEM_KEYS = ["vocals", "drums", "bass", "other", "guitar", "piano"] as const;

function client(): Replicate | null {
  const auth = process.env.REPLICATE_API_TOKEN;
  if (!auth) return null;
  return new Replicate({ auth });
}

/** Start a Demucs separation for an already-uploaded audio URL. */
export async function POST(request: Request): Promise<Response> {
  if (!stemsAuthorized(request.headers.get("x-stems-code"))) return Response.json({ error: "Invalid access code" }, { status: 401 });
  const replicate = client();
  if (!replicate) return Response.json({ error: "REPLICATE_API_TOKEN is not set" }, { status: 501 });
  let audioUrl: string;
  try {
    const body = (await request.json()) as { audioUrl?: string };
    audioUrl = String(body.audioUrl ?? "");
    const u = new URL(audioUrl);
    if (u.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    return Response.json({ error: "audioUrl must be an https URL" }, { status: 400 });
  }
  const input = {
    audio: audioUrl,
    model: process.env.DEMUCS_MODEL_VARIANT ?? "htdemucs",
    stem: "none",
    output_format: "mp3",
    mp3_bitrate: 320,
  };
  try {
    const version = process.env.DEMUCS_VERSION;
    const prediction = version
      ? await replicate.predictions.create({ version, input })
      : await replicate.predictions.create({ model: process.env.DEMUCS_MODEL ?? "ryan5453/demucs", input });
    return Response.json({ id: prediction.id, status: prediction.status });
  } catch (err) {
    return Response.json({ error: `Replicate: ${(err as Error).message}` }, { status: 502 });
  }
}

/** Poll a separation job. */
export async function GET(request: Request): Promise<Response> {
  if (!stemsAuthorized(request.headers.get("x-stems-code"))) return Response.json({ error: "Invalid access code" }, { status: 401 });
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
