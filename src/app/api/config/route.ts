export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ai: !!process.env.ANTHROPIC_API_KEY,
    stems: !!process.env.REPLICATE_API_TOKEN && !!process.env.BLOB_READ_WRITE_TOKEN,
    stemsNeedCode: !!process.env.STEMS_ACCESS_CODE,
  });
}
