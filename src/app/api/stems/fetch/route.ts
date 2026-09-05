import { stemsAuthorized } from "@/lib/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams a finished stem file from Replicate's delivery CDN to the browser (avoids CORS issues). */
export async function GET(request: Request): Promise<Response> {
  if (!stemsAuthorized(request.headers.get("x-stems-code"))) return Response.json({ error: "Invalid access code" }, { status: 401 });
  const url = new URL(request.url).searchParams.get("url");
  if (!url) return Response.json({ error: "Missing url" }, { status: 400 });
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Response.json({ error: "Bad url" }, { status: 400 });
  }
  const host = target.hostname;
  if (target.protocol !== "https:" || !(host === "replicate.delivery" || host.endsWith(".replicate.delivery") || host.endsWith(".replicate.com"))) {
    return Response.json({ error: "Host not allowed" }, { status: 400 });
  }
  const upstream = await fetch(target.toString());
  if (!upstream.ok || !upstream.body) return Response.json({ error: `Upstream ${upstream.status}` }, { status: 502 });
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}
