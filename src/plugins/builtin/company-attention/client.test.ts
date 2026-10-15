import { afterEach, expect, test } from "bun:test";
import type { HiringPayload } from "../../../api-client/hiring";
import type { AppAttentionPayload, AppRankPayload } from "../../../api-client/app-attention";
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

test("the report prints shares as the pane does, and a remote share with the roles it is measured on", async () => {
  const payload = fixture();
  payload.latest = { ...payload.latest!, remoteShare: 1, remoteKnown: 5 };
  const api = { getCloudHiring: async () => payload };
  const report = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["ADYEN:AMS"] }), createTestHeadlessContext({ apiClient: api as never }));
  const text = (title: string, key: string, index = 0) => {
    const section = report.sections.find((entry) => entry.title === title)!;
    const column = section.columns!.find((entry) => entry.key === key)!;
    const row = section.rows![index]!;
    return (column.textFormat ?? column.format)!(row[key], row);
  };
  // 0.30454545... of the roles, and NET's 16.2% of 401 roles with a stated work mode.
  expect(text("Role family", "share")).toBe("30.5");
  expect(text("peers", "remote", 2)).toBe("16% of 401 known");
  expect(text("peers", "remote", 0)).toBe("100% of 185 known");
  expect(hiringModel(payload).figures.find((figure) => figure.label === "Remote")).toMatchObject({ value: "100%", detail: "of 5 known" });
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
  const payload = structuredClone(realAppRank) as AppRankPayload;
  payload.page = { offset: 20, limit: 20, total: 80, nextOffset: 40 };
  const api = { getCloudAppRankHistory: async (...args: unknown[]) => { calls.push(args); return payload; } };
  const context = createTestHeadlessContext({ apiClient: api as never });
  const definition = attentionHeadless("apps");
  expect(definition.options?.find((option) => option.key === "appId")?.aliases).toContain("app-id");
  const report = await definition.load(createTestHeadlessArgs({ options: { appId: "6446901002", store: "app-store", country: "us", chart: "free", days: "365", limit: "20", offset: "20" } }), context);
  expect(calls).toEqual([["app-store", "6446901002", { country: "US", chart: "free", days: 365, offset: 20, limit: 20 }, context.signal]]);
  expect(report.complete).toBe(false);
  expect(report.sections[0]!.rows).toEqual(payload.rankHistory);
  expect(report.metadata?.nextOffset).toBe(40);
  expect(report.metadata?.provenance).toEqual(payload);
});

test("individual Play app history defaults to its unranked global source", async () => {
  const calls: unknown[][] = [];
  const payload: AppRankPayload = { ...structuredClone(realAppRank) as AppRankPayload, store: "google-play", appId: "com.instagram.barcelona", rankHistory: [] };
  const context = createTestHeadlessContext({ apiClient: { getCloudAppRankHistory: async (...args: unknown[]) => { calls.push(args); return payload; } } as never });
  await attentionHeadless("apps").load(createTestHeadlessArgs({ options: { appId: "com.instagram.barcelona", store: "google-play" } }), context);
  expect(calls).toEqual([["google-play", "com.instagram.barcelona", { country: "GLOBAL", chart: "unranked", days: 90, offset: 0, limit: 100 }, context.signal]]);
});

test("a free HIRE and APPS preview say what free shows, what Pro adds and where history starts, and keep caveats out of the errors", async () => {
  const hiring = fixture();
  hiring.preview = true;
  hiring.locked = { history: 5, evidence: 57, peers: 17, signals: 0, mix: 21 };
  hiring.coverage.firstObservedAt = "2026-09-19T00:00:00.000Z";
  hiring.latest = { ...hiring.latest!, completeness: "partial" };
  const hire = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["ADYEN:AMS"] }), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring } as never }));
  expect(hire.errors).toEqual([`Free shows ${hiring.evidence.length} of ${hiring.evidence.length + 57} open roles. Gloom Pro adds the other 57 roles, 5 weeks of history and 17 more peers, with history from 19 Sep 2026.`]);
  expect(hire.notes).toEqual(["The latest capture has incomplete or unknown coverage."]);
  expect(hire.sections.find((section) => section.title === "chart")).toMatchObject({ empty: "Weekly history is part of Gloom Pro." });

  // A preview that holds nothing back (a company with no captures) has nothing to unlock.
  hiring.locked = { history: 0, evidence: 0, peers: 0, signals: 0, mix: 0 };
  expect((await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["ADYEN:AMS"] }), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring } as never }))).errors).toBeUndefined();

  const apps = structuredClone(realApps) as AppAttentionPayload;
  apps.access = "preview";
  apps.locked = { ...apps.locked, apps: 9, history: 9 };
  apps.summary.firstObservedAt = "2026-10-04";
  const report = await attentionHeadless("apps").load(createTestHeadlessArgs({ symbols: [apps.symbol!] }), createTestHeadlessContext({ apiClient: { getCloudAppAttention: async () => apps } as never }));
  expect(report.errors).toEqual([`Free shows ${apps.apps.length} of ${apps.apps.length + 9} app ranks and the latest day of history. Gloom Pro adds the other 9 ranks and 9 earlier days of history, with history from 4 Oct 2026.`]);
  expect(report.notes).toEqual(apps.coverage.limitations);
});
