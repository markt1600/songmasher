import { authorized, unauthorized } from "@/lib/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function allowed(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  const h = u.hostname;
  return h === "replicate.delivery" || h.endsWith(".replicate.delivery") || h.endsWith(".replicate.com") || h.endsWith(".vercel-storage.com");
}

/** Streams an audio file from Replicate or Vercel Blob to the browser (same-origin, so no CORS surprises). */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("x-access-code"))) return unauthorized();
  const url = new URL(request.url).searchParams.get("url");
  if (!url) return Response.json({ error: "Missing url" }, { status: 400 });
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Response.json({ error: "Bad url" }, { status: 400 });
  }
  if (!allowed(target)) return Response.json({ error: "Host not allowed" }, { status: 400 });
  const upstream = await fetch(target.toString());
  if (!upstream.ok || !upstream.body) return Response.json({ error: `Upstream ${upstream.status}` }, { status: 502 });
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}
