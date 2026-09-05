import { list } from "@vercel/blob";
import { cloudEnabled } from "./access";

export interface PublicMix {
  id: string;
  name: string;
  createdAt: number;
  durationSec: number;
  format: "wav" | "mp3";
  songNames: string[];
  url: string;
}

/** Reads a shared mix's metadata by id. Ids are 96-bit random, so knowing one is the capability. */
export async function getPublicMix(id: string): Promise<PublicMix | null> {
  if (!cloudEnabled() || !/^[a-f0-9]{16,64}$/.test(id)) return null;
  const page = await list({ prefix: `mixes/${id}/meta-`, limit: 50 });
  const metas = page.blobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
  if (metas.length === 0) return null;
  const res = await fetch(metas[0].url, { cache: "no-store" });
  if (!res.ok) return null;
  const m = (await res.json()) as Partial<PublicMix>;
  if (!m.url) return null;
  return { id, name: m.name ?? "Mashup", createdAt: m.createdAt ?? 0, durationSec: m.durationSec ?? 0, format: m.format ?? "mp3", songNames: m.songNames ?? [], url: m.url };
}
