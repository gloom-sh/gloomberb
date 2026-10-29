import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { DoeBoardPayload } from "../../api-client/doe";
import { ApiRequestError } from "../../api-client/errors";
import type { MoneyMarketRow, MoneyMarketsPayload } from "../../api-client/money-markets";
import { AppPersistence } from "../../data/app-persistence";
import { collectSavedCopies } from "../../data/saved-copies";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
import { standaloneSeriesCatalog, standaloneSeriesInvoker } from "../../series/standalone";
import { createTestCliContext } from "../../test-support/cli-context";
import { captureConsole } from "../../test-support/console";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import { DataServiceUnreachableError } from "../../utils/network-failure";
import { setHttpFetchTransport } from "../../utils/http-transport";
import { printCliError } from "../errors";
import { createCommandPluginPersistence } from "../saved-copy-persistence";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { runPaneFunction } from ".";

/**
 * Offline, `fn DOE` and `fn ECST` failed with the bare unreachable error
 * although an earlier run had read the same data: a command's plugin caches
 * kept nothing past the run. They now save what a run reads where the app
 * keeps it, answer a failed refresh from that copy with when it was saved,
 * and fail as every other command does when there is none.
 */

const config = createDefaultConfig("/tmp/gloom-fn-saved-copies");
const unreachable = () => new DataServiceUnreachableError(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }));
const spies: Array<{ mockRestore(): void }> = [];
const profiles: AppPersistence[] = [];
afterEach(() => {
  setHttpFetchTransport(null);
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const profile of profiles.splice(0)) profile.close();
  process.exitCode = 0;
});

/** One profile's database across runs: each run closes what it opened, so it stays open until the test ends. */
function profile(): AppPersistence {
  const persistence = new AppPersistence(":memory:");
  profiles.push(persistence);
  return new Proxy(persistence, { get: (target, key) => key === "close" ? () => {} : Reflect.get(target, key) });
}

/** `gloom fn <args>` against a profile, as the command line runs it: its text, or what it failed with. */
async function fn(args: string[], persistence: AppPersistence) {
  const plugins = getLoadablePlugins();
  // The catalog series `fn G` charts, as the command line reads them where no plugin runtime runs.
  const cli = createTestCliContext({ config, persistence, store: new TickerRepository(persistence.tickers), dataProvider: createTestDataProvider(),
    seriesCapabilities: standaloneSeriesInvoker(plugins, "/tmp/gloom-fn-saved-copies"), findCatalogSeries: standaloneSeriesCatalog(plugins) });
  (cli.context as { plugins?: unknown }).plugins = plugins;
  const error = await collectSavedCopies(() => runPaneFunction(args, cli.context)).then(() => null, (failure: unknown) => failure);
  const printed = cli.printed[0];
  return { error, text: printed ? serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, color: false }, printed.options) : "" };
}

const MONEY_MARKETS_ROW = {
  id: "net-liquidity", label: "Net liquidity", seriesId: "WALCL", sourceSeriesIds: ["WALCL"], sourceUrl: null,
  group: "liquidity", unit: "usd-billions", frequency: "weekly", value: 5_808, asOf: "2026-09-16", previousValue: 5_790,
  previousAsOf: "2026-09-09", change: 18, changeUnit: "usd-billions",
  percentile: { value: 50, rank: 2, sampleCount: 4, windowStart: "2025-09-16", windowEnd: "2026-09-16", min: 5_700, max: 5_900, mean: 5_800 },
  history: [{ date: "2026-09-09", value: 5_790 }, { date: "2026-09-16", value: 5_808 }], status: "available",
  fetchedAt: "2026-09-17T10:00:00Z", unavailableReason: null, notes: [],
} satisfies MoneyMarketRow;
const MONEY_MARKETS: MoneyMarketsPayload = {
  generatedAt: "2026-09-17T10:00:00Z", status: "available", rows: [], netLiquidity: MONEY_MARKETS_ROW,
  billsCurve: { asOf: "2026-09-16", status: "available", basis: "discount",
    points: [{ tenor: "4W", maturityYears: 28 / 365, seriesId: "DTB4WK", value: 4.1 }], comparisons: [],
    slope: { valueBps: null, asOf: null, percentile: MONEY_MARKETS_ROW.percentile, history: [] } },
};

const BOARD: DoeBoardPayload = {
  source: "EIA", generatedAt: "2026-10-22T15:00:00.000Z", status: "available", gaps: [],
  reports: [{ id: "gas", weekEnding: "2026-10-16", releasedAt: "2026-10-22T14:30:00.000Z", releaseHoliday: null,
    nextWeekEnding: "2026-10-23", nextReleaseAt: "2026-10-29T14:30:00.000Z", nextReleaseHoliday: null }],
  series: [{
    id: "gas-lower-48", key: "NW2_EPG0_SWO_R48_BCF", report: "gas", tab: "gas", label: "Lower 48", unit: "bcf",
    weekEnding: "2026-10-16", value: 3_644, previousWeekEnding: "2026-10-09", weekChange: 77,
    yearAgo: null, fiveYear: null, read: null, seasonal: null,
  }],
};

test("fn DOE answers a failed refresh from the board an earlier run read, and fails with the hint when none did", async () => {
  const board = spyOn(apiClient, "getCloudDoeBoard").mockResolvedValue(BOARD);
  spies.push(board);
  const saved = profile();
  expect((await fn(["DOE", "--tab", "gas"], saved)).text).toContain("not a live feed");

  board.mockRejectedValue(unreachable());
  const offline = await fn(["DOE", "--tab", "gas"], saved);
  expect(offline.error).toBeNull();
  expect(offline.text).toMatch(/Lower 48 +Bcf +3,644 +\+77/);
  expect(offline.text).toMatch(/· couldn't refresh; saved copy from \d\d:\d\d UTC/);

  // A profile that never read it has nothing to show: the error every command gives, with what to check.
  const { error } = await fn(["DOE", "--tab", "gas"], profile());
  const printed = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, color: false }));
  expect(printed.stderr).toMatch(/^error: Gloom couldn't reach its data service\nCheck the internet connection/);
  const json = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  expect(JSON.parse(json.stderr).error).toMatchObject({ code: "service_unreachable", retryable: true });
});

test("fn ECST answers a failed refresh from the statistic an earlier run read, saying so once rather than as an error", async () => {
  const observations = [{ date: "2026-09-01", value: 159_044 }, { date: "2026-08-01", value: 159_015 }, { date: "2026-07-01", value: 158_882 }];
  const series = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async () => ({ observations, info: null }));
  spies.push(series);
  const saved = profile();
  expect((await fn(["ECST", "payrolls m/m"], saved)).text).toContain("Payrolls m/m");

  series.mockRejectedValue(unreachable());
  const offline = await fn(["ECST", "payrolls m/m"], saved);
  expect(offline.text).toMatch(/Payrolls m\/m +\+29k +\+133k/);
  expect(offline.text).toMatch(/· couldn't refresh; saved copy from \d\d:\d\d UTC/);
  expect(offline.text).not.toContain("Errors:");
});

// Offline, 13F listed each saved copy it answered from as an error ("refresh failed: ... Retained data
// retrieved ...") and MOST called its saved list stale: neither said what every other command says.
test("fn 13F and fn MOST answer a failed refresh from what an earlier run read, saying so in the one closing line", async () => {
  const offline = { now: false };
  const sec13f = spyOn(apiClient, "getCloudSec13F").mockImplementation(async (path: string) => {
    if (offline.now) throw unreachable();
    return path === "/funds" ? [{ cik: "1067983", name: "Berkshire Hathaway Inc" }] : [];
  });
  const movers = spyOn(apiClient, "getMarketMovers").mockImplementation(async () => {
    if (offline.now) throw unreachable();
    return { status: "success", stale: false, data: { quotes: [{ symbol: "STLA", name: "Stellantis N.V.", price: 4.68, change: 0.54, changePercent: 12.92, volume: 94_550_000, avgVolume: 32_600_000 }] } } as never;
  });
  spies.push(sec13f, movers);
  // The public 13F source the app falls back to is out of reach too.
  setHttpFetchTransport(async () => { throw unreachable(); });
  const saved = profile();
  const thirteenF = ["13F", "Berkshire Hathaway"];
  expect((await fn(thirteenF, saved)).text).toContain("Berkshire Hathaway Inc");
  expect((await fn(["MOST"], saved)).text).toContain("Stellantis");

  offline.now = true;
  for (const [args, shown] of [[thirteenF, "Berkshire Hathaway Inc"], [["MOST"], "Stellantis"]] as const) {
    const answer = await fn([...args], saved);
    expect(answer.error).toBeNull();
    expect(answer.text).toContain(shown);
    expect(answer.text).toMatch(/· couldn't refresh; saved copy from \d\d:\d\d UTC/);
    expect(answer.text).not.toMatch(/Errors:|Retained data|refresh failed|stale/);
  }
});

const MOVERS = { status: "success", stale: false, data: { quotes: [{ symbol: "STLA", name: "Stellantis N.V.", price: 4.68, change: 0.54,
  changePercent: 12.92, volume: 94_550_000, avgVolume: 32_600_000 }] } } as never;

// A 200 reply saying its source did not answer this time was refused like a broken reply, so the copy an
// earlier run saved never answered it.
test("a board or list whose source did not answer this time is answered by the saved copy, with its note", async () => {
  const board = spyOn(apiClient, "getCloudDoeBoard").mockResolvedValue(BOARD);
  const movers = spyOn(apiClient, "getMarketMovers").mockResolvedValue(MOVERS);
  spies.push(board, movers);
  const saved = profile();
  await fn(["DOE", "--tab", "gas"], saved);
  await fn(["MOST"], saved);

  board.mockResolvedValue({ ...BOARD, status: "unavailable", series: [] });
  movers.mockResolvedValue({ status: "retryable_error", reasonCode: "UPSTREAM_TIMEOUT", data: null } as never);
  for (const [args, shown] of [[["DOE", "--tab", "gas"], /Lower 48 +Bcf +3,644/], [["MOST"], /Stellantis/]] as const) {
    const answer = await fn([...args], saved);
    expect(answer.error).toBeNull();
    expect(answer.text).toMatch(shown);
    expect(answer.text).toMatch(/· couldn't refresh; saved copy from \d\d:\d\d UTC/);
  }
});

// Only a permanent reason stays the error over a saved copy: a route not served yet, an unsupported list, sign-in.
test("a reply with a permanent reason is the error whatever copy an earlier run saved", async () => {
  const board = spyOn(apiClient, "getCloudDoeBoard").mockResolvedValue(BOARD);
  const movers = spyOn(apiClient, "getMarketMovers").mockResolvedValue(MOVERS);
  spies.push(board, movers);
  const saved = profile();
  await fn(["DOE", "--tab", "gas"], saved);
  await fn(["MOST"], saved);

  for (const [refusal, said] of [[new ApiRequestError("Not found", 404), "Oil and gas inventories are not available yet."],
    [new ApiRequestError("Sign in to continue", 401), "Sign in to continue"]] as const) {
    board.mockRejectedValue(refusal);
    const answer = await fn(["DOE", "--tab", "gas"], saved);
    expect((answer.error as Error | null)?.message).toBe(said);
    expect(answer.text).not.toContain("saved copy");
  }
  movers.mockResolvedValue({ status: "unsupported", reasonCode: "UNSUPPORTED_LIST", data: null } as never);
  const unsupported = await fn(["MOST"], saved);
  expect(`${unsupported.text}${(unsupported.error as Error | null)?.message ?? ""}`).toContain("Invalid market movers response");
  expect(unsupported.text).not.toContain("saved copy");
});

// Offline, AUCT listed the failed refresh under "Errors:" above the closing line that already named its saved copy.
test("fn AUCT answers a failed refresh from the board an earlier run read, saying so only in the closing line", async () => {
  const offline = { now: false };
  const auctionDate = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  setHttpFetchTransport(async () => {
    if (offline.now) throw unreachable();
    return Response.json({ data: [{ cusip: "91282CNH3", security_type: "Note", security_term: "10-Year", auction_date: auctionDate,
      high_yield: "4.6830", bid_to_cover_ratio: "2.530000", offering_amt: "42000000000" }], meta: { "total-pages": 1 } });
  });
  const saved = profile();
  expect((await fn(["AUCT"], saved)).text).toContain("10-Year");

  offline.now = true;
  const answer = await fn(["AUCT"], saved);
  expect(answer.error).toBeNull();
  expect(answer.text).toContain("10-Year");
  expect(answer.text).toMatch(/· couldn't refresh; saved copy from \d\d:\d\d UTC/);
  expect(answer.text).not.toContain("Errors:");
});

// Both said "saved copy from" over a refusal: VIX over a FRED series Gloom Cloud no longer serves or a
// refused session, G over a board route the server stopped serving ("not available yet" before).
test("fn VIX and fn G end with the saved-copy line after an outage, and say a refusal instead of covering it", async () => {
  let failure: unknown = null;
  const history = (id: string) => [17, 18, 19].map((value, day) => ({ date: `2026-09-${16 + day}`, value: id === "VIXCLS" ? value : value + 3 }));
  const fred = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (id: string) => {
    if (failure) throw failure;
    return { info: null, observations: history(id) };
  });
  const markets = spyOn(apiClient, "getCloudMoneyMarkets").mockImplementation(async () => {
    if (failure) throw failure;
    return MONEY_MARKETS;
  });
  spies.push(fred, markets);
  const saved = profile();
  const chart = ["G", "CAP:money-markets:net-liquidity"];
  expect((await fn(["VIX"], saved)).text).toContain("3M / 30D");
  expect((await fn(chart, saved)).text).toContain("Net liquidity");

  failure = unreachable();
  for (const args of [["VIX"], chart]) {
    const answer = await fn(args, saved);
    expect(answer.error).toBeNull();
    expect(answer.text).toMatch(/· couldn't refresh; saved copy from \d\d:\d\d UTC/);
    // The test provider has no Cboe closes; what VIX lists for them is not the outage.
    expect(answer.text).not.toMatch(/Unable to connect|couldn't reach|Refresh failed|refresh failed|VIXCLS:|VXVCLS:/);
  }

  for (const refusal of [new ApiRequestError("Series not found", 404), new ApiRequestError("Sign in to continue", 401)]) {
    failure = refusal;
    const vix = await fn(["VIX"], saved);
    expect(`${vix.text}${vix.error ?? ""}`).toContain(refusal.message);
    expect(vix.text).not.toContain("saved copy");
  }
  failure = new ApiRequestError("Not found", 404);
  const stopped = await fn(chart, saved);
  expect(`${stopped.text}${stopped.error ?? ""}`).toContain("Money markets are not available yet.");
  expect(stopped.text).not.toContain("saved copy");
});

test("a plugin that keeps a command's persistence past the command never reaches the store the command closed", () => {
  const store = new AppPersistence(":memory:");
  const kept = createCommandPluginPersistence(store.resources, "plugin:test");
  const policy = { cachePolicy: { staleMs: 60_000, expireMs: 120_000 } };
  kept.setResource("board", "gas", { value: 1 }, policy);
  expect(kept.getResource("board", "other", { allowExpired: true })).toBeNull();
  // Released with the catalog, then the store closes: later reads and writes stay in memory.
  kept.release();
  store.close();
  expect(() => kept.setResource("board", "oil", { value: 2 }, policy)).not.toThrow();
  expect(kept.getResource("board", "oil", { allowExpired: true })?.value).toEqual({ value: 2 });
  // Not released, a closed store costs the saved copy, never the caller.
  const unreleased = createCommandPluginPersistence(store.resources, "plugin:test");
  expect(() => unreleased.setResource("board", "gas", { value: 3 }, policy)).not.toThrow();
  expect(unreleased.getResource("board", "coal", { allowExpired: true })).toBeNull();
});
