/** Optional shared secret protecting the cloud library and the paid stem-separation endpoints. */
export function requiredCode(): string | undefined {
  return process.env.ACCESS_CODE || process.env.STEMS_ACCESS_CODE || undefined;
}

export function authorized(code: string | null | undefined): boolean {
  const required = requiredCode();
  if (!required) return true;
  return !!code && code === required;
}

export function unauthorized(): Response {
  return Response.json({ error: "Invalid access code", code: "unauthorized" }, { status: 401 });
}

export const cloudEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;
