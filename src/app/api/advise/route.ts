import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Window = z.object({ bar: z.number(), score: z.number() });
const SongSchema = z.object({
  deck: z.enum(["A", "B"]),
  name: z.string().max(200),
  bpm: z.number(),
  key: z.string(),
  camelot: z.string(),
  durationSec: z.number(),
  totalBars: z.number(),
  stems: z.array(z.string()),
  phrases: z.array(z.object({ bar: z.number(), energy: z.number(), beat: z.number(), vocal: z.number() })).max(400),
  sections: z.array(z.object({ label: z.string(), startBar: z.number(), endBar: z.number() })).max(80).optional(),
  hooks: z.array(Window).max(5),
  quietVocals: z.array(Window).max(5),
  instrumentalGrooves: z.array(Window).max(5),
});

const StemEnum = z.enum(["full", "vocals", "instrumental", "drums", "melodic"]);

const PlanSchema = z.object({
  summary: z.string(),
  foundation: z.object({
    deck: z.enum(["A", "B"]),
    startBar: z.number().int().min(0),
    stem: StemEnum,
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
      stem: StemEnum,
      mode: z.enum(["layer", "swap"]),
    }),
  ),
  tips: z.array(z.string()).max(6),
});

const SYSTEM = `You are the arrangement brain inside SongMasher, a two-song mashup tool. You get an automatic
analysis of two songs and must return one concrete arrangement that a producer would actually build.

## How the tool plays things
- The FOUNDATION is one song playing continuously from a chosen source bar, tempo-matched to the master BPM.
  It carries the groove for the whole mashup. It can use a stem: "full" (whole mix) or, when that song lists
  it under "stems", "instrumental" (no vocals), "drums", or "melodic" (bass + music, no drums).
- CLIPS are bar ranges of either song placed on a bar timeline (three lanes). Each clip has a stem and a mode:
  - mode "layer": plays ON TOP of the foundation. Only for stems with no drums: "vocals" or "melodic".
  - mode "swap": the foundation is MUTED while the clip plays; the clip's own mix takes over. Use this for
    "full", "instrumental" or "drums" clips, i.e. whenever the clip brings its own beat.
- Bar numbers are 0-based in both the source songs and the timeline. Timeline positions must be multiples of 4.

## The analysis you receive (per song)
- bpm, key with Camelot code, totalBars, and which stems exist.
- phrases: one row per 4-bar phrase with energy (loudness), beat (percussive strength) and vocal (lead
  vocal / melody presence), all 0..1.
- sections: the detected song structure (Intro / Verse / Chorus / Bridge / Break / Outro) as 0-based bar ranges
  (endBar exclusive). Choruses are the natural hooks; verses and breaks make good breakdowns; intros make
  poor foundations. Use these ranges directly when they exist.
- hooks: best 8-bar windows for a vocal hook (loud + vocal). quietVocals: sparse vocal passages.
  instrumentalGrooves: 8-bar windows with a strong beat and little vocal. Prefer these precomputed windows;
  they are aligned to phrase boundaries.

## Hard rules (the app enforces them, so a plan that breaks them gets edited)
1. Exactly one beat at a time. Never layer a clip that contains drums over the foundation.
2. Never two lead vocals at once. Layered vocal clips must not overlap each other, and while one plays the
   foundation must be "instrumental" (if that song has stems) or sit in one of its instrumentalGrooves.
3. Source ranges stay inside totalBars. Lengths are 4, 8 or 16 bars. Timeline starts are multiples of 4.

## What good looks like
- Foundation: the song with the steadier, stronger beat. Start it at an instrumentalGroove, never in an intro
  that is quiet. If both songs have stems, prefer foundation stem "instrumental" and the other song's "vocals".
- Structure, typically 24-40 bars:
  a. 4-8 bars of foundation alone to establish the groove.
  b. The other song's hook as a layered "vocals" clip, 8 bars, then repeated once (two clips back to back).
  c. A contrast section: either a "swap" clip of the other song's full mix (8 bars, its own beat takes over),
     or a quietVocals passage layered over the foundation.
  d. Return of the hook, then 4-8 bars of foundation alone to end.
- Without stems: you cannot layer safely, so build a call-and-response using "swap" clips (8-bar sections
  alternating between the two songs), and say in tips that running AI stems would unlock true layering.
- Tempo: keep the foundation's BPM if the other song is within ~8%; otherwise pick a value between them.
  If the tempos are near a 2:1 ratio, treat them as the same feel and keep the foundation's BPM.
- Pitch: shift the non-foundation song only when the keys clash, by the smallest amount (prefer within +-3).
- Labels are short ("Hook", "Hook again", "Breakdown", "Drop", "Outro"). Summary: 2-3 plain sentences.
  Tips: 2-4 practical, specific pointers (e.g. "lower the foundation level to 0.8 under the hook").`;

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
      output_config: { format: zodOutputFormat(PlanSchema), effort: "high" },
      messages: [
        {
          role: "user",
          content: `Design the mashup for these two songs. Follow the hard rules exactly and use the precomputed windows.\n\n${JSON.stringify(songs)}`,
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
