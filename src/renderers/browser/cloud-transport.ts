import { apiClient, setCloudApiFetchTransport } from "../../api-client";
import { setHttpFetchTransport } from "../../utils/http-transport";

const SESSION_COOKIE_NAMES = ["__Secure-gloomberb.session_token", "gloomberb.session_token"] as const;

function plantBrowserSessionCookies(cookieHeader: string): void {
  if (typeof document === "undefined") return;
  const secure = typeof location !== "undefined" && location.protocol === "https:";
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!(SESSION_COOKIE_NAMES as readonly string[]).includes(name) || !value) continue;
    const useSecure = secure || name.startsWith("__Secure-");
    document.cookie = `${name}=${value}; Path=/; SameSite=Lax${useSecure ? "; Secure" : ""}`;
  }
}

export function browserCredentialedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookieHeader = headers.get("Cookie");
  if (cookieHeader) plantBrowserSessionCookies(cookieHeader);
  // These are controlled by the browser. Desktop transports may set them, but
  // carrying them into fetch would either fail or misrepresent the web origin.
  headers.delete("Cookie");
  headers.delete("Origin");
  return fetch(url, { ...init, headers, credentials: "include" });
}

export function installBrowserFetchTransports(): void {
  apiClient.setCookieSessionMode(true);
  setCloudApiFetchTransport(browserCredentialedFetch);
  setHttpFetchTransport((url, init) => fetch(url, init));
}

export async function restoreBrowserCloudSession(budgetMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    await Promise.race([apiClient.getSession().catch(() => null), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
