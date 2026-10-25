import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "./index";
import type { LiveScanWireDefinition } from "./live-scan";

afterEach(() => {
  setCloudApiFetchTransport(null);
});

test("a scan of a 1,000-symbol watchlist goes in a POST body, never in the request line", async () => {
  const symbols = Array.from({ length: 1_000 }, (_, index) => `S${String(index).padStart(4, "0")}.A`);
  const definition: LiveScanWireDefinition = {
    version: 1,
    universe: { kind: "symbols", symbols },
    conditions: [{ kind: "new_high", within: 5 }],
  };
  const asked: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  setCloudApiFetchTransport(((input: Request | string | URL, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(Response.json({ status: "closed", matches: [] }));
  }) as unknown as typeof fetch);
  await apiClient.getLiveScan(definition);
  expect(asked).toHaveLength(1);
  expect(asked[0]!.method).toBe("POST");
  expect(new URL(asked[0]!.url).pathname).toEndWith("/market/scanner/live");
  expect(asked[0]!.url.length).toBeLessThan(200);
  expect(asked[0]!.body).toEqual({ scan: definition });
});
