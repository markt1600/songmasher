import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { authorized, unauthorized } from "@/lib/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FileSchema = z.object({
  id: z.string().max(200),
  name: z.string().max(200),
  durationSec: z.number().optional(),
  bpm: z.number().optional(),
  key: z.string().max(40).optional(),
});

const ResultSchema = z.object({
  songs: z.array(
    z.object({
      id: z.string(),
      /** the song's proper title (never a track number or file cruft), or null if it cannot be told */
      title: z.string().max(200).nullable(),
      /** the performing artist, only when you actually know this song; null otherwise */
      artist: z.string().max(200).nullable(),
      /** 0..1: how sure you are this is the real song and artist */
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const SYSTEM = `You identify songs from their file names for a music library. For each file name, give the song's proper title and,
only when you genuinely recognise the song, its performing artist. Strip track numbers, disc prefixes, bracketed
tags like (Official Video) or [Remastered], featuring notes and file cruft from the title; keep the artist's usual
name. Many names are not in English (Vietnamese, Thai, Hindi, Korean, Chinese): keep their proper script and
diacritics. When a name is "Artist - Title", split it. When a name could be several songs, choose the best known
one that fits the duration and tempo given, and lower the confidence. Never invent an artist for a song you do
not know: return null with low confidence instead.`;

/** Title/artist guesses for untagged library files, from Claude's knowledge of the songs. */
export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server" }, { status: 501 });
  if (!authorized(request.headers.get("x-access-code"))) return unauthorized();
  let files: z.infer<typeof FileSchema>[];
  try {
    files = z.array(FileSchema).min(1).max(40).parse((await request.json()).files);
  } catch {
    return Response.json({ error: "files[] required" }, { status: 400 });
  }
  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { format: zodOutputFormat(ResultSchema) },
      messages: [{ role: "user", content: `Files:\n${JSON.stringify(files)}` }],
    });
    const parsed = response.parsed_output;
    if (!parsed) return Response.json({ error: "No result" }, { status: 502 });
    return Response.json({ songs: parsed.songs });
  } catch (err) {
    return Response.json({ error: `Claude: ${(err as Error).message}` }, { status: 502 });
  }
}
