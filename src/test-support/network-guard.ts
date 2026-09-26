import { afterAll, beforeAll } from "bun:test";

/**
 * Blocks outbound fetch and WebSocket connections for the calling test file and fails the
 * file if anything tried to reach the network. `data:` URLs still resolve. Call it once at
 * the top level of a test file.
 */
export function blockExternalNetwork(): void {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  const attempts: string[] = [];

  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("data:")) return originalFetch(input, init);
      attempts.push(url);
      throw new Error(`External request blocked: ${url}`);
    }) as typeof fetch;
    globalThis.WebSocket = class {
      constructor(url: string | URL) {
        attempts.push(String(url));
        throw new Error(`External socket blocked: ${String(url)}`);
      }
    } as unknown as typeof WebSocket;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
    if (attempts.length > 0) {
      throw new Error(`Unexpected external network attempts: ${attempts.join(", ")}`);
    }
  });
}
