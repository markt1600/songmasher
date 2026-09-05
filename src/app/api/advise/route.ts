import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SongSchema = z.object({
  deck: z.enum(["A", "B"]),
  name: z.string().max(200),
  bpm: z.number(),
  key: z.string(),
  camelot: z.string(),
  durationSec: z.number(),
  totalBars: z.number(),
  barEnergy: z.array(z.number()).max(600),
  barOnset: z.array(z.number()).max(600),
  barVocal: z.array(z.number()).max(600),
  stems: z.array(z.string()),
});

const PlanSchema = z.object({
  summary: z.string(),
  foundation: z.object({
    deck: z.enum(["A", "B"]),
    startBar: z.number().int().min(0),
    reason: z.string(),
  }),
  masterBpm: z.number(),
  pitchShift: z
    .object({
      deck: z.enum(["A", "B"]),
      semitones: z.number().int().min(-12).max(12),
      reason: z.string(),
    })
    .nullable(),
  arrangement: z.array(
    z.object({
      deck: z.enum(["A", "B"]),
      srcBar: z.number().int().min(0),
      lengthBars: z.number().int().min(1).max(64),
      startBar: z.number().int().min(0),
      lane: z.number().int().min(1).max(3),
      label: z.string(),
      stem: z.enum(["full", "vocals", "instrumental", "drums", "melodic"]),
    }),
  ),
  tips: z.array(z.string()).max(6),
});

const SYSTEM = `You are a mashup producer's assistant inside SongMasher, a browser mashup tool.
You receive an automatic analysis of two songs: tempo, key (with Camelot code), and three per-bar curves
(0..1, index = bar number starting at 0): barEnergy (loudness), barOnset (rhythmic/percussive strength),
barVocal (mid-band centre energy, a rough proxy for vocals or lead melody).

The tool works like this:
- One song is the "foundation": it plays continuously from a chosen start bar, tempo-matched to the master BPM.
- Clips from either song (a source bar range, usually 4/8/16 bars) are placed on the timeline in bars, on 3 lanes,
  and are time-stretched to the master BPM. Clips can use a stem: "full", or if the song's stems list includes them,
  "vocals", "instrumental", "drums", "melodic".
- Pitch shift is per song, in semitones, to make keys compatible (same or adjacent Camelot number, or relative major/minor).

Produce a concrete, musically sensible plan:
- Pick the foundation (usually the song with stronger, steadier barOnset) and a start bar where its groove is established
  (skip quiet intros; prefer phrase boundaries that are multiples of 4 or 8 bars from the first loud section).
- Master BPM: keep the foundation's BPM unless the other song needs more than ~8% stretch; then meet in the middle.
  If the tempos are roughly a 2:1 ratio, treat them as the same feel and keep one BPM.
- Pitch shift only if the keys clash; choose the smallest shift (|semitones| <= 3 preferred) that makes them compatible.
- Arrangement: 8-32 bars total, on timeline bars that are multiples of 4. Use the other song's high-barVocal
  sections as hooks (repeat them), quieter vocal passages as a breakdown, and leave the foundation alone for the first 4-8 bars
  so the beat establishes itself. Use lane 1 for the main hook clips, lanes 2/3 for layered extras. Prefer the "vocals" stem
  for hook clips when it is available, otherwise "full". Source bar ranges must stay inside each song's totalBars.
- Keep the summary to 2-3 sentences and the tips practical (e.g. where to add a filter, when to drop the foundation gain).`;

export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server" }, { status: 501 });
  let songs: z.infer<typeof SongSchema>[];
  try {
    const body = await request.json();
    songs = z.array(SongSchema).min(2).max(2).parse(body.songs);
  } catch {
    return Response.json({ error: "Two analysed songs are required" }, { status: 400 });
  }
  const client = new Anthropic();
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { format: zodOutputFormat(PlanSchema), effort: "medium" },
      messages: [
        {
          role: "user",
          content: `Here are the two analysed songs as JSON. Design the mashup plan.\n\n${JSON.stringify(songs)}`,
        },
      ],
    });
    if (response.stop_reason === "refusal") return Response.json({ error: "The advisor declined this request" }, { status: 422 });
    const plan = response.parsed_output;
    if (!plan) return Response.json({ error: "The advisor returned an unreadable plan" }, { status: 502 });
    return Response.json({ plan });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return Response.json({ error: "Invalid ANTHROPIC_API_KEY" }, { status: 500 });
    if (err instanceof Anthropic.RateLimitError) return Response.json({ error: "Rate limited by the Claude API, try again shortly" }, { status: 429 });
    if (err instanceof Anthropic.APIError) return Response.json({ error: `Claude API error ${err.status}: ${err.message}` }, { status: 502 });
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
