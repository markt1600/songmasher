import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Deck = z.enum(["A", "B"]);
const StemEnum = z.enum(["full", "vocals", "instrumental", "drums", "melodic"]);
const TemplateEnum = z.enum(["classic", "vocal-first", "call-response", "extended"]);

const SongSchema = z.object({
  deck: Deck,
  name: z.string().max(200),
  bpm: z.number(),
  key: z.string(),
  camelot: z.string(),
  durationSec: z.number(),
  totalBars: z.number(),
  stems: z.array(z.string()),
  sections: z.array(z.object({ label: z.string(), startBar: z.number(), endBar: z.number() })).max(80).optional(),
  vocal: z
    .object({
      phrases: z.number(),
      firstPhraseBar: z.number().nullable(),
      loudestBars: z.array(z.number()).max(8),
    })
    .nullable()
    .optional(),
});

const CandidateSchema = z.object({
  id: z.string(),
  template: TemplateEnum,
  description: z.string(),
  score: z.number(),
  breakdown: z.object({ harmony: z.number(), phrases: z.number(), energy: z.number(), stretch: z.number() }),
  foundation: z.object({ deck: Deck, startBar: z.number(), stem: StemEnum }),
  vocalDeck: Deck,
  semitones: z.number(),
  masterBpm: z.number(),
  lengthBars: z.number(),
  clips: z.array(z.object({ label: z.string(), deck: Deck, srcBar: z.number(), lengthBars: z.number(), startBar: z.number(), stem: StemEnum, mode: z.enum(["layer", "swap"]), fit: z.number() })).max(12),
});

const ConstraintsSchema = z.object({
  foundation: Deck.nullable(),
  lengthBars: z.number().int().min(8).max(128).nullable(),
  vocalEntryBar: z.number().int().min(0).max(32).nullable(),
  hookBars: z.union([z.literal(4), z.literal(8), z.literal(16)]).nullable(),
  energy: z.enum(["higher", "lower"]).nullable(),
  maxShift: z.number().int().min(0).max(6).nullable(),
  template: TemplateEnum.nullable(),
});

const ResponseSchema = z.object({
  /** id of the chosen candidate, or null when the constraints should be applied and the best result taken */
  choice: z.string().nullable(),
  /** search constraints derived from the user's instruction (null when no change is wanted) */
  constraints: ConstraintsSchema.nullable(),
  summary: z.string(),
  tips: z.array(z.string()).max(5),
  clipLabels: z.array(z.string()).max(12),
  stemAdvice: z.array(z.object({ deck: Deck, variant: z.enum(["htdemucs", "htdemucs_ft", "htdemucs_6s"]), reason: z.string() })),
});

const HistorySchema = z.array(z.object({ instruction: z.string().max(2000), summary: z.string().max(4000) })).max(8);

const SYSTEM = `You are the producer's ear inside SongMasher, a two-song mashup tool. A deterministic planner has already
listened to both songs numerically: it knows the tempo, key, beat grid, song sections, where the singer actually
sings (phrases, from the isolated vocal stem when available), and it has scored candidate arrangements by
bar-by-bar harmonic fit between the vocal's notes and the foundation's chords, phrase completeness (no clip cuts
into the middle of a sung phrase), energy shape and tempo stretch. Your job is to choose and to interpret, never
to invent bar numbers.

You receive:
- songs: analysis summaries (sections are 0-based bar ranges, endBar exclusive; vocal.firstPhraseBar is where singing starts).
- candidates: the planner's top arrangements, best first, with a score (0..1) and a breakdown. Each candidate lists
  its clips (label, source bars, timeline bar, stem, layer/swap mode, harmonic fit). Templates:
  classic = beat alone, hook x2, breakdown, hook; vocal-first = vocal from bar 0; call-response = the two songs
  alternate in swap mode; extended = longer build.
- optionally an instruction from the user and the history of earlier instructions.

Respond with:
- choice: the id of the candidate you would build, judged musically (a slightly lower score with a better structure
  or a smaller pitch shift can be the right call; harmonic fit below ~0.5 is a real clash, avoid it). Null only when
  you set constraints that require a new search.
- constraints: when the user's instruction asks for something the candidates don't offer, express it as search
  constraints (e.g. "bring the vocal in earlier" -> vocalEntryBar 4 or template vocal-first; "make it longer" ->
  lengthBars; "less pitch shifting" -> maxShift 1; "more energy" -> energy higher, template classic with hookBars 8;
  "swap the roles" -> foundation set to the other deck). Otherwise null. Unchanged fields null.
- summary: 2-3 sentences a producer would say about the chosen plan: what sits under what, where the hook lands,
  why it works, and any caveat (e.g. one breakdown clip fits less well).
- tips: 2-4 concrete follow-ups in the tool (levels, a filter sweep before the hook, an extra repeat, running
  fine-tuned stems), specific to these songs.
- clipLabels: a short evocative label per clip of the chosen candidate, in order (same count as its clips), else [].
- stemAdvice: songs that still lack a "vocals" stem but are used for their vocal, with the Demucs variant to run
  ("htdemucs" default, "htdemucs_ft" when the vocal is the star, "htdemucs_6s" for guitar/piano). Empty otherwise.`;

export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server" }, { status: 501 });
  let songs: z.infer<typeof SongSchema>[];
  let candidates: z.infer<typeof CandidateSchema>[];
  let instruction: string | undefined;
  let history: z.infer<typeof HistorySchema> = [];
  try {
    const body = await request.json();
    songs = z.array(SongSchema).min(2).max(2).parse(body.songs);
    candidates = z.array(CandidateSchema).min(1).max(8).parse(body.candidates);
    instruction = typeof body.instruction === "string" ? body.instruction.slice(0, 2000) : undefined;
    if (body.history) history = HistorySchema.parse(body.history);
  } catch {
    return Response.json({ error: "Two analysed songs and at least one candidate are required" }, { status: 400 });
  }
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Songs:\n${JSON.stringify(songs)}\n\nCandidates (best first):\n${JSON.stringify(candidates)}`,
    },
  ];
  for (const h of history) {
    messages.push({ role: "user", content: `Instruction: ${h.instruction}` });
    messages.push({ role: "assistant", content: h.summary });
  }
  if (instruction) messages.push({ role: "user", content: `Instruction: ${instruction}\n\nThe candidates above were searched with the previous constraints. If they already satisfy this, choose one; otherwise return new constraints.` });
  else messages.push({ role: "user", content: "Choose the candidate to build and explain it." });
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 6000,
      system: SYSTEM,
      output_config: { format: zodOutputFormat(ResponseSchema), effort: "high" },
      messages,
    });
    if (response.stop_reason === "refusal") return Response.json({ error: "The advisor declined this request" }, { status: 422 });
    const out = response.parsed_output;
    if (!out) return Response.json({ error: "The advisor returned an unreadable answer" }, { status: 502 });
    return Response.json({ result: out });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return Response.json({ error: "Invalid ANTHROPIC_API_KEY" }, { status: 500 });
    if (err instanceof Anthropic.RateLimitError) return Response.json({ error: "Rate limited by the Claude API, try again shortly" }, { status: 429 });
    if (err instanceof Anthropic.APIError) return Response.json({ error: `Claude API error ${err.status}: ${err.message}` }, { status: 502 });
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
