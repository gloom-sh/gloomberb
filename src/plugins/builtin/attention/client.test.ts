import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { AttentionPayload } from "../../../api-client/attention";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attentionCache, fetchAttention, loadAttention, validateAttention } from "./client";
import { attentionHeadless } from "./headless";
import { attentionFixture, attentionPreview } from "./test-fixture";
afterEach(() => { setCloudApiFetchTransport(null); attentionCache.reset(); });
test("rejects malformed observations and preview history leaks at the read boundary", () => {
  const good = attentionFixture();
  expect(validateAttention(good)).toBe(good);
  expect(validateAttention(attentionPreview()).rows).toHaveLength(3);
  const cases = [
    { ...good, entitlement: "preview" },
    { ...attentionPreview(), rows: [{ ...good.rows[0]!, history: good.rows[0]!.history }] },
    { ...good, rows: [{ ...good.rows[0]!, researchUnits: -5 }] },
    { ...good, rows: [{ ...good.rows[0]!, zScore: Infinity }] },
    { ...good, rows: [{ ...good.rows[0]!, news: [{ title: "unsafe", url: "javascript:alert(1)", publishedAt: good.generatedAt }] }] },
    { ...good, rows: [{ ...good.rows[0]!, history: [good.rows[0]!.history[0]!, good.rows[0]!.history[0]!] }] },
  ];
  for (const data of cases) expect(() => validateAttention(data as AttentionPayload)).toThrow("invalid attention");
});
test("rejects responses for a previous window or different listing", async () => {
  const client = { getCloudAttention: async () => attentionFixture() };
  await expect(fetchAttention("today", undefined, client)).rejects.toThrow("different selection");
  await expect(fetchAttention("now", "6758:JPX", client)).rejects.toThrow("different selection");
});
test("separates cached accounts and entitlements and discards denied stale data", async () => {
  attentionCache.attach(new MemoryPluginPersistence());
  let calls = 0;
  setCloudApiFetchTransport(async () => { calls++; return Response.json(calls === 1 ? attentionFixture() : attentionPreview()); });
  await loadAttention("now", "account1:pro");
  await loadAttention("now", "account2:preview");
  expect(calls).toBe(2);
  setCloudApiFetchTransport(async () => { throw new ApiRequestError("Forbidden", 403); });
  await expect(loadAttention("now", "account1:pro", undefined, true)).rejects.toThrow("Forbidden");
});

test("never stores a full response under preview entitlement during an account refresh race", async () => {
  attentionCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json(attentionFixture()));
  await expect(loadAttention("now", "account:preview")).rejects.toThrow("access changed");
  setCloudApiFetchTransport(async () => Response.json(attentionPreview()));
  expect((await loadAttention("now", "account:preview", undefined, true)).payload.entitlement).toBe("preview");
});
test("accepts a bare ticker only when the server resolves that ticker to a unique listing", async () => {
  const data = attentionFixture();
  data.rows = [{ ...data.rows[1]!, symbol: "NVDA:NASDAQ" }];
  expect((await fetchAttention("now", "NVDA", { getCloudAttention: async () => data })).rows[0]?.symbol).toBe("NVDA:NASDAQ");
  await expect(fetchAttention("now", "NVDA:JPX", { getCloudAttention: async () => data })).rejects.toThrow("different selection");
});

test("listing suffixes remain tied to their exact exchange", async () => {
  const data = attentionFixture();
  data.rows = [{ ...data.rows[0]!, ticker: "VOD", symbol: "VOD:LSE", exchange: "LSE" }];
  expect((await fetchAttention("now", "VOD.L", { getCloudAttention: async () => data })).rows[0]?.symbol).toBe("VOD:LSE");
  await expect(fetchAttention("now", "VOD.L:NASDAQ", { getCloudAttention: async () => data })).rejects.toThrow("different selection");
});

test("a ticker outside the free preview lists the preview's rows with the lock line, and a board still collecting says so instead of No data", async () => {
  // The server picks the preview's three rows before it looks the ticker up: one outside them comes back with none.
  const api = { getCloudAttention: async (_window: string, symbol?: string) => symbol ? { ...attentionPreview(), rows: [], sectors: [], countries: [] } : attentionPreview() };
  const load = (client: unknown, argument: string | null) => attentionHeadless.load(
    createTestHeadlessArgs({ argument, rawArgument: argument ?? "" }), createTestHeadlessContext({ apiClient: client as never }));

  const outside = await load(api, "DUOL");
  expect(outside.sections[0]!.rows).toHaveLength(3);
  expect(outside.errors).toEqual(["Free shows the top 3 of 6 tickers, not DUOL: the preview can't filter by ticker. Gloom Pro adds the other 3 tickers and hourly history for any ticker."]);
  expect((await load(api, null)).errors?.[0]).toStartWith("Free shows the top 3 of 6 tickers, for the latest hour.");

  const collecting = { getCloudAttention: async () => ({ ...attentionPreview(), status: "collecting" as const, rows: [], sectors: [], countries: [], counts: { rows: 0, sectors: 0, countries: 0 } }) };
  expect(await load(collecting, "DUOL")).toMatchObject({ sections: [{ rows: [], empty: "Waiting for privacy-qualified research activity." }] });
  expect((await load(collecting, "DUOL")).errors).toBeUndefined();
});
