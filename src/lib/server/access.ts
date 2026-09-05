/** Optional shared secret protecting the paid stem-separation endpoints. */
export function stemsAuthorized(code: string | null | undefined): boolean {
  const required = process.env.STEMS_ACCESS_CODE;
  if (!required) return true;
  return !!code && code === required;
}
