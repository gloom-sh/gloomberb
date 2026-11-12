import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useMemo, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import * as activity from "../../../api-client/research-activity";
import type { CloudSocialOutliersParams, SocialMentionsPayload, SocialOutlierRow, SocialOutliersPayload } from "../../../api-client/social-mentions";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestHeadlessContext } from "../../../test-support/headless";
import type { DataProvider } from "../../../types/data-provider";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { findPaneInstance } from "../../../types/config";
import { socialMentionsHeadless } from "./headless";
import { socialOutliersCache } from "./outliers-client";
import { buildSocialOutlierColumns, socialOutlierMinOptions, socialOutliersQueryFrom } from "./outliers-model";
import { SocialMentionsPane } from "./pane";

const tui = createOpenTuiTestHarness();
const PANE_ID = "buzz:outliers:test";

// Invented companies.
function outlier(symbol: string, name: string | null, mentions: number, baseline: number, extra: Partial<SocialOutlierRow> = {}): SocialOutlierRow {
  return {
    symbol, name, day: "2026-11-05", mentions, closed: true, countedAt: "2026-11-06T00:20:00.000Z", baseline,
    ratio: mentions / baseline, stance: .42, stancePosts: 18, marketCap: 4_200_000_000,
    price: { changePct: 3.25, asOf: "2026-11-05T21:00:00.000Z" }, ...extra,
  };
}
const ROWS = [
  outlier("NWBI", "Northwind Biologics Inc", 1_826, 200),
  outlier("CTSO", "Contoso Energy Corp", 840, 160, { stance: -.31, price: { changePct: -2.1, asOf: "2026-11-05T21:00:00.000Z" } }),
  outlier("FBKM", "Fabrikam Bancorp", 96, 40, { stance: null, stancePosts: 0, price: null, marketCap: null }),
];
function answer(params: CloudSocialOutliersParams, rows = ROWS): SocialOutliersPayload {
  const today = params.window === "today";
  return {
    window: params.window ?? "day", asOf: "2026-11-06T16:30:00.000Z", freshFrom: "2026-11-03",
    filters: { minPosts: params.minPosts ?? 0, cap: params.cap ?? null }, coverage: { tracked: 4_968, counted: 131 },
    rows: today ? rows.map((row) => ({ ...row, day: "2026-11-06", closed: false, countedAt: "2026-11-06T16:05:00.000Z" })) : rows,
  };
}
/** The ticker a row opens: its own daily posts, as BUZZ on a ticker reads them. */
function mentions(symbol: string): SocialMentionsPayload {
  const days = ["2026-11-03", "2026-11-04", "2026-11-05"].map((day, index) => ({ day, mentions: [150, 170, 840][index]!, closed: true }));
  return {
    symbol, range: "1y", asOf: "2026-11-06T16:30:00.000Z",
    x: { days, historyFrom: "2026-11-03", completeThrough: "2026-11-05", baseline: 160, refreshedAt: "2026-11-06T00:20:00.000Z" },
    stance: [], topPosts: [], pending: [], warnings: [],
  };
}

let state: AppState | null = null;
let seed: Record<string, unknown> = {};
/** The data provider the pane names its tickers through; none leaves the screener's stored names. */
let marketData: Partial<DataProvider> | null = null;
function Harness({ width, height }: { width: number; height: number }) {
  const config = createTestPaneConfig(join(tmpdir(), "gloom-social-outliers-test"), { instanceId: PANE_ID, paneId: "social-mentions", title: "Social Mentions" });
  const [current, dispatch] = useReducer(appReducer, config, (initialConfig) => {
    const initial = createInitialState(initialConfig);
    initial.focusedPaneId = PANE_ID;
    initial.paneState[PANE_ID] = { pluginState: { "social-mentions": seed } };
    return initial;
  });
  state = current;
  const runtime = useMemo(() => createStatefulTestPluginRuntime({ getMarketData: () => marketData as DataProvider | null }), []);
  return <TestPaneFrame state={current} dispatch={dispatch} paneId={PANE_ID} pluginId="social-mentions" runtime={runtime} width={width} height={height} footerKeys>
    {(body) => <SocialMentionsPane focused {...body} />}
  </TestPaneFrame>;
}
const pane = () => findPaneInstance(state!.config.layout, PANE_ID)!;

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Bun.sleep(2); await tui.setup().renderOnce(); });
}
const asked: CloudSocialOutliersParams[] = [];
const opened: string[] = [];
async function mount(load: (params: CloudSocialOutliersParams) => Promise<SocialOutliersPayload>, width = 120, height = 20) {
  asked.length = 0;
  opened.length = 0;
  spyOn(apiClient, "getCloudSocialOutliers").mockImplementation(async (params = {}) => {
    asked.push(params);
    return load(params);
  });
  spyOn(apiClient, "getCloudSocialMentions").mockImplementation(async (symbol: string) => {
    opened.push(symbol);
    return mentions(symbol);
  });
  spyOn(apiClient, "getCloudSocialMentionPosts").mockImplementation(async (symbol: string, day: string) => ({
    symbol, day, posts: [{ id: "1971000000000000009", day, author: "contoso_watch", text: `Spike day post about $${symbol}`,
      postedAt: `${day}T15:00:00.000Z`, views: 4_901, likes: 88, reposts: 12, replies: 4, url: "https://x.com/contoso_watch/status/1971000000000000009", stance: .7 }],
  }));
  spyOn(activity, "exposeWallTeaser").mockImplementation(async () => null);
  spyOn(activity, "recordWallViewed").mockImplementation(() => {});
  await act(async () => { await tui.render(<Harness width={width} height={height} />, { width, height }); });
  await settle();
}

afterEach(() => {
  mock.restore();
  socialOutliersCache.reset();
  seed = {};
  marketData = null;
});

test("BUZZ alone ranks the outliers; Enter opens the ticker's BUZZ here and Esc comes back to the same row", async () => {
  await mount(async (params) => answer(params));
  let frame = tui.frame();
  expect(asked).toEqual([{ window: "day", minPosts: 25, limit: 100 }]);
  expect(frame).toMatch(/Window\s+Latest day\s+Today/);
  expect(frame).toMatch(/TICKER\s+COMPANY\s+DATE\s+POSTS\s+30D MEDIAN\s+VS MEDIAN ▼\s+STANCE\s+PRICE %/);
  expect(frame).toMatch(/NWBI\s+Northwind Biologics Inc\s+2026-11-05\s+1,826\s+200\s+9\.1x\s+\+0\.42\s+\+3\.25%/);
  expect(frame).toMatch(/CTSO\s+Contoso Energy Corp\s+2026-11-05\s+840\s+160\s+5\.3x\s+-0\.31\s+-2\.10%/);
  // No stance scored and no price: dashes, never zeros.
  expect(frame).toMatch(/FBKM\s+Fabrikam Bancorp\s+2026-11-05\s+96\s+40\s+2\.4x\s+--\s+--/);

  await tui.emitKeypress({ name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  frame = tui.frame();
  // BUZZ on the ticker, in the ranking's stack, named once.
  expect(frame).toContain("\u2190 Back CTSO \u00b7 Contoso Energy Corp");
  expect(opened).toEqual(["CTSO"]);
  expect(frame).toContain("30D median");
  expect(frame).not.toContain("Northwind Biologics");
  // The pane stays the ranking: no ticker, no new title.
  expect(pane().binding?.kind ?? "none").toBe("none");
  expect(pane().title).toBe("Social Mentions");

  // A day opens in the ticker's own stack: Esc closes it before the ticker.
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  frame = tui.frame();
  expect(frame).toContain("Spike day post about $CTSO");
  expect(frame.match(/\u2190 Back/g)?.length).toBe(2);
  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, trackPropagation: true, afterCommit: true });
  await settle();
  frame = tui.frame();
  expect(frame.match(/\u2190 Back/g)?.length).toBe(1);
  expect(frame).toContain("\u2190 Back CTSO");

  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, trackPropagation: true, afterCommit: true });
  await settle();
  frame = tui.frame();
  expect(frame).toContain("Northwind Biologics");
  expect(frame).not.toContain("\u2190 Back");
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  expect(tui.frame()).toContain("\u2190 Back CTSO");
  expect(state!.paneState[PANE_ID]?.pluginState?.["social-mentions"]).toMatchObject({
    "social-mentions:outliers:open": "CTSO", "social-mentions:outliers:selected": "CTSO",
  });
});

test("Today reads today's counts, dated by when they were read; the filters narrow the request", async () => {
  await mount(async (params) => answer(params));
  await tui.clickFrameText("Today");
  await settle();
  expect(asked.at(-1)).toEqual({ window: "today", minPosts: 25, limit: 100 });
  const frame = tui.frame();
  expect(frame).toMatch(/TICKER\s+COMPANY\s+AS OF\s+POSTS/);
  expect(frame).toMatch(/NWBI\s+Northwind Biologics Inc\s+16:05 UTC\s+1,826/);
  expect(frame).not.toContain("2026-11-05");

  seed = { "social-mentions:outliers:minPosts": 500, "social-mentions:outliers:cap": "small", "social-mentions:outliers:window": "today" };
  socialOutliersCache.reset();
  await mount(async (params) => answer(params, []));
  expect(asked).toEqual([{ window: "today", minPosts: 500, cap: "small", limit: 100 }]);
  expect(tui.frame()).toContain("No ticker counted today matches these filters.");
});

test("an empty ranking, a load, a failure and a refused session each say so in the body", async () => {
  seed = { "social-mentions:outliers:minPosts": 0 };
  await mount(async (params) => answer(params, []));
  expect(asked).toEqual([{ window: "day", limit: 100 }]);
  expect(tui.frame()).toContain("No ticker has been counted since 3 Nov 2026.");
  // The query bar stays, so another window is one click away.
  expect(tui.frame()).toContain("Today");

  socialOutliersCache.reset();
  let resolve: (payload: SocialOutliersPayload) => void = () => {};
  await mount((params) => new Promise((done) => { resolve = (payload) => done(payload ?? answer(params)); }));
  expect(tui.frame()).toMatch(/Loading social outliers/i);
  expect(tui.frame()).toContain("Latest day");
  await act(async () => { resolve(answer({ window: "day" })); });
  await settle();
  expect(tui.frame()).toContain("Northwind Biologics");

  socialOutliersCache.reset();
  await mount(async () => { throw new Error("Upstream timed out."); });
  expect(tui.frame()).toContain("Upstream timed out.");
  expect(tui.frame()).toContain("Retry");

  socialOutliersCache.reset();
  await mount(async () => { throw new ApiRequestError("Sign in required", 401); });
  const wall = tui.frame();
  expect(wall).toMatch(/[Ss]ign in/);
  expect(wall).toContain("view social outliers");
  expect(wall).not.toContain("Sign in required");
  expect(wall).not.toContain("Latest day");
});

/** A search row as the service lists a listing. */
function listing(symbol: string, exchange: string, name: string, extra: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult {
  return { providerId: "gloomberb-cloud", symbol, exchange, name, type: "Common Stock", ...extra };
}

test("tickers are named as ticker search names them, in one batched search: capitals, blanks and foreign lines settled", async () => {
  const batches: string[][] = [];
  const singles: string[] = [];
  marketData = {
    searchBatch: async (queries) => {
      batches.push([...queries]);
      return new Map([
        // The TSX line carries the symbol for a name; the US line is the cashtag's listing.
        ["NWBI", [listing("NWBI", "TSX", "NWBI"), listing("NWBI", "NASDAQ", "Northwind Biologics, Inc.")]],
        ["CTSO", [listing("CTSO", "NYSE", "Contoso Energy Corporation")]],
        ["FBKM", [listing("FBKM", "NASDAQ", "Fabrikam Semiconductor ETF", { type: "ETF" })]],
      ]);
    },
    search: async (query) => { singles.push(query); return []; },
  };
  await mount(async (params) => answer(params, [
    outlier("NWBI", "NORTHWIND BIOLOGICS INC", 1_826, 200),
    outlier("CTSO", "CONTOSO ENERGY CORP", 840, 160),
    outlier("FBKM", null, 96, 40),
  ]));
  const frame = tui.frame();
  expect(frame).toMatch(/NWBI\s+Northwind Biologics, Inc\.\s+2026-11-05/);
  expect(frame).toMatch(/CTSO\s+Contoso Energy Corporation\s+2026-11-05/);
  expect(frame).toMatch(/FBKM\s+Fabrikam Semiconductor ETF\s+2026-11-05/);
  expect(frame).not.toMatch(/NORTHWIND|CONTOSO|FBKM\s+--/);
  // One request for the whole ranking, never one a row.
  expect(batches).toEqual([["NWBI", "CTSO", "FBKM"]]);
  expect(singles).toEqual([]);

  // The opened ticker's title says the same name.
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  expect(tui.frame()).toContain("\u2190 Back NWBI \u00b7 Northwind Biologics, Inc.");
});

test("a name search cannot give keeps the stored one, and a failed or missing batch never costs the ranking", async () => {
  marketData = { searchBatch: async () => new Map([["CTSO", [listing("CTSO", "NYSE", "Contoso Energy Corporation")]]]) };
  await mount(async (params) => answer(params, [outlier("NWBI", "NORTHWIND BIOLOGICS INC", 1_826, 200), outlier("CTSO", "CONTOSO ENERGY CORP", 840, 160)]));
  expect(tui.frame()).toMatch(/NWBI\s+NORTHWIND BIOLOGICS INC/);
  expect(tui.frame()).toMatch(/CTSO\s+Contoso Energy Corporation/);

  for (const searchBatch of [async () => { throw new Error("Search is down."); }, async () => null, undefined]) {
    socialOutliersCache.reset();
    marketData = { searchBatch } as Partial<DataProvider>;
    await mount(async (params) => answer(params, [outlier("NWBI", "NORTHWIND BIOLOGICS INC", 1_826, 200)]));
    expect(tui.frame()).toMatch(/NWBI\s+NORTHWIND BIOLOGICS INC/);
    expect(tui.frame()).not.toContain("unavailable");
  }
});

test("a narrow pane gives up the median, then the company, then the stance", () => {
  const ids = (width: number) => buildSocialOutlierColumns(width, ROWS, "day").map((column) => column.id);
  expect(ids(120)).toEqual(["ticker", "company", "day", "mentions", "baseline", "ratio", "stance", "price"]);
  expect(ids(80)).toEqual(["ticker", "company", "day", "mentions", "ratio", "stance", "price"]);
  expect(ids(60)).toEqual(["ticker", "day", "mentions", "ratio", "stance", "price"]);
  expect(ids(44)).toEqual(["ticker", "day", "mentions", "ratio", "price"]);
  expect(buildSocialOutlierColumns(120, ROWS, "today").map((column) => column.id)).toContain("countedAt");
});

test("a stored query is read part by part; a minimum the CLI set joins the menu", () => {
  expect(socialOutliersQueryFrom({})).toEqual({ window: "day", minPosts: 25, cap: null });
  expect(socialOutliersQueryFrom({ window: "today", minPosts: "50", cap: "mid" })).toEqual({ window: "today", minPosts: 50, cap: "mid" });
  expect(socialOutliersQueryFrom({ window: "week", minPosts: -3, cap: "mega" })).toEqual({ window: "day", minPosts: 25, cap: null });
  expect(socialOutliersQueryFrom({ minPosts: 2.5 }).minPosts).toBe(25);
  expect(socialOutlierMinOptions(50).map((option) => option.label)).toEqual(["Any", "25+", "50+", "100+", "500+", "1,000+"]);
  expect(socialOutlierMinOptions(100)).toHaveLength(5);
});

test("fn BUZZ alone reads the same query, one row per ticker dated by its own day", async () => {
  const asked: CloudSocialOutliersParams[] = [];
  const apiClient = { getCloudSocialOutliers: async (params: CloudSocialOutliersParams) => {
    asked.push(params);
    return answer(params, params.cap ? [] : ROWS);
  } } as never;
  const load = (options: Record<string, string | number>) => socialMentionsHeadless.load(
    { rawArgument: "", argument: "", symbols: [], options: { range: "1y", limit: 20, ...options } },
    createTestHeadlessContext({ apiClient }),
  );
  const report = await load({ window: "day", minPosts: 25 });
  const section = report.sections[0]!;
  expect("columns" in section && section.columns?.map((column) => column.header))
    .toEqual(["Ticker", "Company", "Date", "Posts", "30D median", "Vs median", "Stance", "Price %"]);
  expect("rows" in section && section.rows?.[2]).toEqual({
    symbol: "FBKM", company: "Fabrikam Bancorp", day: "2026-11-05", countedAt: "2026-11-06T00:20:00.000Z", posts: 96, median: 40,
    ratio: 2.4, stance: null, stancePosts: 0, pricePct: null, priceAsOf: null, marketCap: null,
  });
  // The report names each ticker through the context's batched search too.
  const named = await socialMentionsHeadless.load(
    { rawArgument: "", argument: "", symbols: [], options: { range: "1y", limit: 20, window: "day", minPosts: 25 } },
    createTestHeadlessContext({ apiClient, refresh: true, marketData: { searchBatch: async () => new Map([["FBKM", [listing("FBKM", "NASDAQ", "Fabrikam Bancorp, Inc.")]]]) } as never }),
  );
  expect("rows" in named.sections[0]! && named.sections[0].rows?.map((row) => row.company)).toEqual(["Northwind Biologics Inc", "Contoso Energy Corp", "Fabrikam Bancorp, Inc."]);
  const empty = await load({ window: "today", minPosts: 100, cap: "small" });
  expect("empty" in empty.sections[0]! && empty.sections[0].empty).toBe("No ticker counted today matches these filters.");
  expect(asked).toEqual([{ window: "day", minPosts: 25, limit: 20 }, { window: "day", minPosts: 25, limit: 20 }, { window: "today", minPosts: 100, cap: "small", limit: 20 }]);
});
