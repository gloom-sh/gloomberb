import { afterEach, expect, test } from "bun:test";
import type { HiringPayload } from "../../../api-client/hiring";
import type { AppAttentionPayload } from "../../../api-client/app-attention";
import { setCloudApiFetchTransport } from "../../../api-client";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import realHiring from "./fixtures/hiring.json";
import realApps from "./fixtures/apps.json";
import { attentionCache, cachedAttention, fetchAppRank, fetchAttention, loadAttention, validateAttention } from "./client";
import { appsModel, attentionSeries, hiringModel, sortAttentionRows } from "./model";
import { attentionHeadless } from "./headless";
import realAppRank from "./fixtures/app-rank.json";

const fixture = () => structuredClone(realHiring) as HiringPayload;
afterEach(() => { attentionCache.reset(); setCloudApiFetchTransport(null); });

test("a sparse real capture preserves unknown changes and does not fabricate a trend", () => {
  const model = hiringModel(fixture());
  expect(model.chart.points).toHaveLength(1);
  expect(attentionSeries(model, "#ffffff")).toEqual([]);
  expect(model.sections.chart.rows[0]!.values.net).toBeNull();
  expect(model.sections.table.rows[0]!.values.title).toBe(fixture().evidence[0]!.title);
});

test("rejects malformed numerical evidence and a response for a different issuer", async () => {
  const invalid = fixture();
  invalid.latest!.remoteShare = 2;
  expect(() => validateAttention("hiring", invalid)).toThrow("unreadable");
  invalid.latest!.remoteShare = null;
  invalid.evidence[0]!.url = "javascript:alert(1)";
  expect(() => validateAttention("hiring", invalid)).toThrow("unreadable");
  setCloudApiFetchTransport(async () => Response.json(fixture()));
  await expect(fetchAttention("hiring", "NET")).rejects.toThrow("different company");
});

test("paid captures cannot be read from another account or free entitlement cache", async () => {
  attentionCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json(fixture()));
  await loadAttention("hiring", "ADYEN:AMS", "first:full", {});
  expect(cachedAttention("hiring", "ADYEN:AMS", "first:full", {})?.payload).toBeDefined();
  expect(cachedAttention("hiring", "ADYEN:AMS", "first:preview", {})).toBeNull();
  expect(cachedAttention("hiring", "ADYEN:AMS", "second:full", {})).toBeNull();
});

test("sort keeps missing observations last in either direction and never treats null as zero", () => {
  const rows = [{ id: "missing", values: { score: null } }, { id: "negative", values: { score: -1 } }, { id: "positive", values: { score: 2 } }];
  expect(sortAttentionRows(rows, "score", "asc").map((row) => row.id)).toEqual(["negative", "positive", "missing"]);
  expect(sortAttentionRows(rows, "score", "desc").map((row) => row.id)).toEqual(["positive", "negative", "missing"]);
});

test("real app captures preserve missing velocity, rating provenance and ordinal country identities", () => {
  const payload = structuredClone(realApps) as AppAttentionPayload;
  validateAttention("apps", payload);
  const model = appsModel(payload);
  expect(model.chart.points).toHaveLength(1);
  expect(attentionSeries(model, "#fff")).toEqual([]);
  expect(model.sections.table.rows.every((row) => row.values.change === null)).toBe(true);
  expect(new Set(model.sections.table.rows.map((row) => row.id)).size).toBe(model.sections.table.rows.length);
  expect(model.sections.evidence.rows[0]!.details!.find((entry) => entry.label === "Revision")?.value).toBe(payload.evidence[0]!.revisionId);
  payload.apps[0]!.rating = 8;
  expect(() => validateAttention("apps", payload)).toThrow("unreadable");
});

test("verified canonical issuer responses accept their echoed request while preserving identity", async () => {
  const payload = fixture();
  payload.requestedSymbol = "ADYEN:XAMS";
  setCloudApiFetchTransport(async () => Response.json(payload));
  expect((await fetchAttention("hiring", "ADYEN:XAMS") as HiringPayload).symbol).toBe("ADYEN:AMS");
  await expect(fetchAttention("hiring", "NET")).rejects.toThrow("different company");
});

test("history leaves an explicit break across an unobserved week", () => {
  const model = hiringModel(fixture());
  model.chart.points = [{ date: "2026-09-07", value: 1 }, { date: "2026-09-14", value: 2 }, { date: "2026-09-28", value: 4 }];
  const points = attentionSeries(model, "#fff")[0]!.points;
  expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
    ["2026-09-07", 1], ["2026-09-14", 2], ["2026-09-21", null], ["2026-09-28", 4],
  ]);
});

test("headless pages expose continuation and never claim a truncated report is complete", async () => {
  const payload = structuredClone(realApps) as AppAttentionPayload;
  payload.page = { offset: 0, limit: 100, total: 250, nextOffset: 100 };
  const api = { getCloudAppAttention: async () => payload };
  const report = await attentionHeadless("apps").load(createTestHeadlessArgs({ symbols: ["META"] }), createTestHeadlessContext({ apiClient: api as never }));
  expect(report.complete).toBe(false);
  expect(report.metadata?.nextOffset).toBe(100);
});

test("app rank history rejects a different country/chart and retains missing written-review counts", async () => {
  const focus = { store: "app-store" as const, appId: "6446901002", name: "Threads", country: "US", chart: "free" as const };
  setCloudApiFetchTransport(async () => Response.json(realAppRank));
  const payload = await fetchAppRank(focus, 90);
  expect(payload.rankHistory[0]!.rank).toBe(5);
  expect(payload.rankHistory[0]!.reviewCount).toBeNull();
  await expect(fetchAppRank({ ...focus, country: "DE" }, 90)).rejects.toThrow("unreadable app rank history");
});

test("individual-app headless forwards the exact cohort, window and continuation with provenance", async () => {
  const calls: unknown[][] = [];
  const payload = structuredClone(realAppRank);
  payload.page = { offset: 20, limit: 20, total: 80, nextOffset: 40 };
  const api = { getCloudAppRankHistory: async (...args: unknown[]) => { calls.push(args); return payload; } };
  const context = createTestHeadlessContext({ apiClient: api as never });
  const definition = attentionHeadless("apps");
  expect(definition.options?.find((option) => option.key === "appId")?.aliases).toContain("app-id");
  const report = await definition.load(createTestHeadlessArgs({ options: { appId: "6446901002", store: "app-store", country: "US", chart: "free", days: "365", limit: "20", offset: "20" } }), context);
  expect(calls).toEqual([["app-store", "6446901002", { country: "US", chart: "free", days: 365, offset: 20, limit: 20 }, context.signal]]);
  expect(report.complete).toBe(false);
  expect(report.sections[0]!.rows).toEqual(payload.rankHistory);
  expect(report.metadata?.nextOffset).toBe(40);
  expect(report.metadata?.provenance).toEqual(payload);
});
