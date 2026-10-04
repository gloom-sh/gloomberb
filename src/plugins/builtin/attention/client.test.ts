import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { AttentionPayload } from "../../../api-client/attention";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attentionCache, fetchAttention, loadAttention, validateAttention } from "./client";
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
