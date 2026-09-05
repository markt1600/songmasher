import { cloudEnabled, requiredCode } from "@/lib/server/access";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ai: !!process.env.ANTHROPIC_API_KEY,
    cloud: cloudEnabled(),
    stems: !!process.env.REPLICATE_API_TOKEN && cloudEnabled(),
    needCode: !!requiredCode(),
  });
}
