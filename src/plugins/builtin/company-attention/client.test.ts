import { afterEach, expect, test } from "bun:test";
import type { HiringCompanyMoves, HiringCompanySignals, HiringMovesBoard, HiringPayload } from "../../../api-client/hiring";
import { ApiRequestError } from "../../../api-client/errors";
import type { AppAttentionPayload, AppRankPayload } from "../../../api-client/app-attention";
import { setCloudApiFetchTransport } from "../../../api-client";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import realHiring from "./fixtures/hiring.json";
import realApps from "./fixtures/apps.json";
import { attentionCache, cachedAttention, fetchAppRank, fetchAttention, loadAttention, validateAttention } from "./client";
import { appsModel, attentionSeries, hiringModel, sortAttentionRows } from "./model";
import { attentionHeadless } from "./headless";
import { companyMovesModel, moveFacts, movesBoardModel, movesPreviewNote } from "./moves-model";
import realAppRank from "./fixtures/app-rank.json";
import realMoves from "./fixtures/hiring-moves.json";
import realMovesBoard from "./fixtures/hiring-moves-board.json";
import realExpansion from "./fixtures/hiring-expansion-board.json";
import realAnomalies from "./fixtures/hiring-anomalies-board.json";

const fixture = () => structuredClone(realHiring) as HiringPayload;
/** A company HIRE has no moves for yet. */
/** A company the signals job has not read yet. */
const noSignals = async (symbol: string): Promise<HiringCompanySignals> => ({ generatedAt: "2026-10-19T08:00:00.000Z", proRequired: true, preview: false, symbol, name: null, week: null, watchedSince: null, held: null, skipped: [], signals: [], history: [], locked: { signals: 0, history: 0, expansion: 0, anomalies: 0 } });
const noMoves = async (symbol?: string): Promise<HiringCompanyMoves> => ({ generatedAt: "2026-10-19T08:00:00.000Z", proRequired: true, preview: false, symbol: symbol ?? "", name: null, latest: null, week: null, weeks: [], history: [],
  evidence: { added: [], closed: [] }, evidenceTotals: { added: 0, closed: 0 }, locked: { history: 0, added: 0, closed: 0 } });
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
  // A detail reads in words: no revision, confidence, dash, raw timestamp or bare address.
  const evidence = model.sections.evidence.rows[0]!;
  expect(evidence.details!.map((entry) => entry.label)).not.toContain("Revision");
  expect(evidence.details!.every((entry) => entry.value !== "--" && !/\d{4}-\d{2}-\d{2}T|^https?:/.test(entry.value))).toBe(true);
  expect(evidence.links?.every((link) => /^https?:/.test(link.url))).toBe(true);
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
  expect(text("Peers", "remote", 2)).toBe("16% of 401 known");
  expect(text("Peers", "remote", 0)).toBe("100% of 185 known");
  expect(hiringModel(payload).figures.find((figure) => figure.label === "Remote")).toMatchObject({ value: "100%", detail: "of 5 known" });
});

test("a hiring report heads each view by what its rows are, and the board has only its table, as the pane's tabs do", async () => {
  const company = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["ADYEN:AMS"] }), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => fixture(), getCloudHiringMoves: noMoves, getCloudHiringCompanySignals: noSignals } as never }));
  expect(company.sections.map((section) => section.title)).toEqual(["Open roles", "Hiring trend", "Role family", "Peers", "Posting evidence", "Hiring moves", "Move drivers", "Postings first seen", "Expansion", "Anomalies"]);
  const board = { generatedAt: "2026-10-15T00:00:00.000Z", proRequired: true, preview: false, total: 0, locked: 0, companies: [] };
  const market = await attentionHeadless("hiring").load(createTestHeadlessArgs(), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => board, getCloudHiringMoves: async () => realMovesBoard,
    getCloudHiringSignals: async (group: string) => group === "expansion" ? realExpansion : realAnomalies } as never }));
  expect(market.sections.map((section) => section.title)).toEqual(["Companies hiring", "Hiring moves", "Expansion", "Anomalies"]);
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
  const hire = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["ADYEN:AMS"] }), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring, getCloudHiringMoves: noMoves, getCloudHiringCompanySignals: noSignals } as never }));
  expect(hire.errors).toEqual([`Free shows ${hiring.evidence.length} of ${hiring.evidence.length + 57} open roles. Gloom Pro adds the other 57 roles, 5 weeks of history and 17 more peers, with history from 19 Sep 2026.`]);
  expect(hire.notes).toEqual(["The latest capture has incomplete or unknown coverage."]);
  expect(hire.sections.find((section) => section.title === "Hiring trend")).toMatchObject({ empty: "Weekly history is part of Gloom Pro." });

  // A preview that holds nothing back (a company with no captures) has nothing to unlock.
  hiring.locked = { history: 0, evidence: 0, peers: 0, signals: 0, mix: 0 };
  expect((await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["ADYEN:AMS"] }), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring, getCloudHiringMoves: noMoves, getCloudHiringCompanySignals: noSignals } as never }))).errors).toBeUndefined();

  const apps = structuredClone(realApps) as AppAttentionPayload;
  apps.access = "preview";
  apps.locked = { ...apps.locked, apps: 9, history: 9 };
  apps.summary.firstObservedAt = "2026-10-04";
  const report = await attentionHeadless("apps").load(createTestHeadlessArgs({ symbols: [apps.symbol!] }), createTestHeadlessContext({ apiClient: { getCloudAppAttention: async () => apps } as never }));
  expect(report.errors).toEqual([`Free shows ${apps.apps.length} of ${apps.apps.length + 9} app ranks and the latest day of history. Gloom Pro adds the other 9 ranks and 9 earlier days of history, with history from 4 Oct 2026.`]);
  expect(report.notes).toEqual(apps.coverage.limitations);
});

test("HIRE's moves report each move with why, a company's weeks with why a week is not measured, and a server without moves keeps the rest", async () => {
  const hiring = { ...fixture(), symbol: "RIVN" };
  const company = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["RIVN"] }),
    createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring, getCloudHiringMoves: async () => structuredClone(realMoves) as HiringCompanyMoves, getCloudHiringCompanySignals: noSignals } as never }));
  const weeks = company.sections.find((section) => section.title === "Hiring moves")!;
  const weekRows = weeks.rows!;
  expect(weekRows[0]).toMatchObject({ week: "2026-10-12", newRoles: 311, signal: "Accelerating" });
  expect(weekRows.at(-1)).toMatchObject({ week: "2026-09-14", excluded: "First read" });
  expect(weeks.columns!.find((column) => column.key === "pace")?.format?.(weekRows[0]!.pace, weekRows[0]!)).toBe("3.4x");
  expect(company.notes).toContain(realMoves.latest.why);
  expect(company.sections.find((section) => section.title === "Move drivers")!.rows![0]).toMatchObject({ label: "Operations", newRoles: 222 });

  const board = { generatedAt: "2026-10-15T00:00:00.000Z", proRequired: true, preview: false, total: 0, locked: 0, companies: [] };
  const free = { ...structuredClone(realMovesBoard), preview: true, moves: realMovesBoard.moves.slice(0, 3), locked: realMovesBoard.total - 3 } as HiringMovesBoard;
  const market = await attentionHeadless("hiring").load(createTestHeadlessArgs(), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => board, getCloudHiringMoves: async () => free, getCloudHiringSignals: async (group: string) => group === "expansion" ? realExpansion : realAnomalies } as never }));
  expect(market.sections.find((section) => section.title === "Hiring moves")!.rows!.map((row) => [row.symbol, typeof row.why])).toEqual([["RIVN", "string"], ["GNRC", "string"], ["BBIO", "string"]]);
  expect(market.errors).toEqual(["Free shows 3 of 18 moves. Gloom Pro adds the other 15."]);

  const missing = await attentionHeadless("hiring").load(createTestHeadlessArgs(), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => board,
    getCloudHiringMoves: async () => { throw new ApiRequestError("Not found", 404); }, getCloudHiringSignals: async () => { throw new ApiRequestError("Not found", 404); } } as never }));
  expect(missing.sections.map((section) => section.title)).toEqual(["Companies hiring"]);
  expect(missing.notes).toEqual(["Hiring moves are not available yet.", "Hiring signals are not available yet."]);
});

test("a flagged move is listed with what to check and never reads as alerted; a free read off the free board keeps the week, not the move", async () => {
  const board = movesBoardModel(structuredClone(realMovesBoard) as HiringMovesBoard, "moves").sections.board!;
  // CBRL's seasonal roles came in one day: on the board, after the unflagged moves.
  const cbrl = board.rows.find((row) => row.symbol === "CBRL")!;
  expect(cbrl.values.check).toBe("One-day batch");
  expect(board.rows.findIndex((row) => row.values.check)).toBe(board.rows.length - 2);
  expect(moveFacts(cbrl.move!)).toEqual(expect.arrayContaining([{ label: "Check", value: "1,318 of the 1,329 came on 2026-10-13" }, { label: "Alert", value: "Held: flagged for a second look" }]));
  const unflagged = movesBoardModel({ ...structuredClone(realMovesBoard), moves: realMovesBoard.moves.slice(0, 3) } as HiringMovesBoard, "moves").sections.board!;
  expect(unflagged.columns.some((column) => column.id === "check")).toBe(false);

  const { latest: _latest, ...rivn } = structuredClone(realMoves) as HiringCompanyMoves;
  const free: HiringCompanyMoves = { ...rivn, latest: null, preview: true, weeks: [], history: [], locked: { history: 5, added: 17, closed: 17, move: 1 } };
  const model = companyMovesModel(free);
  expect(model.figures.map((figure) => [figure.label, figure.value])).toEqual([["New roles", "311"], ["Closed", "191"], ["Open", "979"], ["Move", "Pro"]]);
  expect(model.sections.drivers!.empty).toBe("This company's move is in Pro.");
  expect(movesPreviewNote(free)).toBe("Free shows the latest week and three postings each way. Gloom Pro adds its move, 5 weeks of history and 34 more postings.");
});
