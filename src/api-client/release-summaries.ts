import { CloudApiRequestTransport } from "./request";

// A public file needs no session credential. A separate transport, as the
// public wall summary has, still follows the installed desktop/web bridge.
const publicTransport = new CloudApiRequestTransport();

/**
 * The repository's CHANGELOG.md as Gloom Cloud serves it (GET
 * /public/releases/summaries): read there with the service's own GitHub
 * credentials and cached, so the Changelog does not spend the anonymous
 * GitHub limit of the address the app runs on. Null when the repository has
 * no such file. Throws when the service cannot say (a service without the
 * route, or GitHub down with nothing kept), so the caller asks GitHub itself.
 */
export async function getReleaseSummaries(signal?: AbortSignal): Promise<string | null> {
  const body = await publicTransport.request<unknown>("/public/releases/summaries", { signal });
  const markdown = typeof body === "object" && body !== null ? (body as { markdown?: unknown }).markdown : undefined;
  if (markdown === null) return null;
  if (typeof markdown !== "string") throw new Error("Gloom Cloud returned no release summaries");
  return markdown;
}
