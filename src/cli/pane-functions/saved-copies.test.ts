import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { DoeBoardPayload } from "../../api-client/doe";
import { AppPersistence } from "../../data/app-persistence";
import { collectSavedCopies } from "../../data/saved-copies";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
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
  const cli = createTestCliContext({ config, persistence, store: new TickerRepository(persistence.tickers), dataProvider: createTestDataProvider() });
  (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
  const error = await collectSavedCopies(() => runPaneFunction(args, cli.context)).then(() => null, (failure: unknown) => failure);
  const printed = cli.printed[0];
  return { error, text: printed ? serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, color: false }, printed.options) : "" };
}

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
