import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { authorized, cloudEnabled } from "@/lib/server/access";

export const runtime = "nodejs";

/** Issues client-upload tokens so the browser sends audio straight to Blob (no function body limit). */
export async function POST(request: Request): Promise<Response> {
  if (!cloudEnabled()) return Response.json({ error: "Cloud library is not configured" }, { status: 501 });
  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let code: string | undefined;
        try {
          code = clientPayload ? (JSON.parse(clientPayload) as { code?: string }).code : undefined;
        } catch {
          code = undefined;
        }
        if (!authorized(code)) throw new Error("Invalid access code");
        if (!/^library\/[\w.-]{1,120}\/(song|stems\/(vocals|drums|bass|other))\.[a-z0-9]{1,5}$/i.test(pathname)) throw new Error("Unexpected upload path");
        return {
          allowedContentTypes: ["audio/*", "application/octet-stream"],
          maximumSizeInBytes: 80 * 1024 * 1024,
          addRandomSuffix: false,
          allowOverwrite: true,
          tokenPayload: JSON.stringify({}),
        };
      },
      onUploadCompleted: async () => {
        /* metadata is written by the client through PUT /api/library */
      },
    });
    return Response.json(json);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
