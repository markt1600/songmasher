import type { Metadata } from "next";
import Link from "next/link";
import { getPublicMix } from "@/lib/server/mixes";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const mix = await getPublicMix(id).catch(() => null);
  return { title: mix ? `${mix.name} · SongMasher` : "SongMasher", description: mix ? `A mashup of ${mix.songNames.join(" and ")}` : undefined };
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default async function SharedMixPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mix = await getPublicMix(id).catch(() => null);
  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="panel w-full max-w-[560px] p-6 flex flex-col gap-5">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-[9px] bg-gradient-to-b from-[#9d8cff] to-[#6f5cff]" />
          <div className="leading-none">
            <div className="font-semibold text-[15px]">SongMasher</div>
            <div className="text-[10.5px] text-muted mt-[3px]">Shared mashup</div>
          </div>
        </div>
        {mix ? (
          <>
            <div>
              <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{mix.name}</h1>
              <p className="text-text-2 text-[13px] mt-1">
                {mix.songNames.length ? mix.songNames.join(" × ") : "Two songs, one mashup"} · {fmt(mix.durationSec)} · {mix.format.toUpperCase()}
              </p>
            </div>
            <audio controls preload="metadata" src={mix.url} className="w-full" />
            <div className="flex flex-wrap gap-2">
              <a className="btn" href={mix.url} download>
                Download {mix.format.toUpperCase()}
              </a>
              <Link className="btn btn-ghost" href="/">
                Make your own
              </Link>
            </div>
          </>
        ) : (
          <div className="text-text-2 text-[14px]">
            This mashup isn&apos;t available. It may have been deleted, or the link is incomplete.
            <div className="mt-4">
              <Link className="btn" href="/">
                Open SongMasher
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
