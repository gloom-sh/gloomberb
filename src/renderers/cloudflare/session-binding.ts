import { NO_SESSION_COOKIE, SESSION_COOKIE_NAMES } from "../../api-client/session-cookie";

export async function sessionCookieBinding(request: Request): Promise<string> {
  const cookies = request.headers.get("cookie")?.split(";").map((part) => part.trim()).filter((part) => (
    SESSION_COOKIE_NAMES.some((name) => part.startsWith(`${name}=`) && part.length > name.length + 1)
  ));
  if (!cookies?.length) return NO_SESSION_COOKIE;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`gloom-display-session-v1\n${cookies.join(";")}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
