import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { stemsAuthorized } from "@/lib/server/access";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.REPLICATE_API_TOKEN) {
    return Response.json({ error: "AI stems are not configured on this deployment" }, { status: 501 });
  }
  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        let code: string | undefined;
        try {
          code = clientPayload ? (JSON.parse(clientPayload) as { code?: string }).code : undefined;
        } catch {
          code = undefined;
        }
        if (!stemsAuthorized(code)) throw new Error("Invalid access code");
        return {
          allowedContentTypes: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/flac", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/aac"],
          maximumSizeInBytes: 60 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({}),
        };
      },
      onUploadCompleted: async () => {
        /* nothing to persist; the client passes the blob URL to /api/stems */
      },
    });
    return Response.json(json);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
