import { apiClient, setCloudApiFetchTransport } from "../../api-client";
import { setHttpFetchTransport } from "../../utils/http-transport";

export function browserCredentialedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
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
