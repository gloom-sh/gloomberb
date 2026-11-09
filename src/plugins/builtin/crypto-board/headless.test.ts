import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { headlessReportTables, type LoadedHeadlessPaneModel, renderHeadlessPaneText, reportCoverage } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness, paneStatusLine } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";
import type { HeadlessPaneContext } from "../../../types/headless";
import { cryptoBoardHeadless } from "./headless";
import { buildCryptoRows, CRYPTO_BOARD_FRESHNESS, cryptoRowObservations } from "./model";
import { CRYPTO_FIXTURE_NOW, cryptoFixture, defiTvlFixture, stablecoinSupplyFixture } from "./test-fixture";

const ARGS = { rawArgument: "", argument: null, symbols: [], options: { list: "stablecoin" } };

beforeEach(() => setSystemTime(new Date(CRYPTO_FIXTURE_NOW)));
afterEach(() => setSystemTime());

function load(getCloudStablecoinSupply: () => Promise<unknown>) {
  const apiClient = { getCloudCryptoMarkets: async () => cryptoFixture(), getCloudStablecoinSupply };
  return cryptoBoardHeadless.load(ARGS, { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext);
}

test("the stablecoin list states the total, adds each coin's supply, and exports the daily series", async () => {
  const result = await load(async () => stablecoinSupplyFixture());
  const freshness = deriveHeadlessFreshness(cryptoBoardHeadless, result, CRYPTO_FIXTURE_NOW);
  const text = renderHeadlessPaneText(cryptoBoardHeadless, result, ARGS, "CRYP", freshness);
  expect(text).toContain("Total supply 300.00B · 7D -1.50B (-0.50%) · 30D +1.80B (+0.60%) · as of 2026-09-23");
  expect(text).toMatch(/Supply\s+Supply 7D %\s+Supply 7D\s+Supply 30D %\s+Supply 30D\s+Share/);
  expect(text).toMatch(/USDT .* 180\.00B\s+-0\.33%\s+-600\.00M\s+\+0\.11%\s+\+200\.00M\s+60\.00%/);

  const csv = renderReportCsv(headlessReportTables(cryptoBoardHeadless, result, ARGS, "CRYP", freshness, { complete: true, unavailableSymbols: [] }), freshness);
  // The text says the change is since 00:00 UTC; the export keeps the header scripts read it by.
  expect(text).toMatch(/Chg % UTC\s+7D %/);
  expect(csv.split("\n").find((line) => line.startsWith('"#"'))).toContain(",Chg %,7D %,");
  const series = csv.slice(csv.indexOf("# section: Stablecoin supply")).split("\n");
  expect(series[1]).toBe("Date,Total,USDT,USDC,Other,symbol_or_series,currency_or_unit,interval,source,as_of,retrieved_at");
  expect(series[2]).toStartWith("2026-09-19,296000000000,178000000000,,118000000000,,USD,1d,");
  expect(series[4]).toStartWith("2026-09-21,,,71000000000,,,USD,1d,");
});

test("a supply outage is a note: the prices stay a complete report, with the market cap and no blank supply", async () => {
  const result = await load(async () => {
    throw new ApiRequestError("Unavailable", 503);
  });
  expect(result.rows[0]).toMatchObject({ code: "USDT", price: 0.9998, supply: null, supplyShare: null });
  expect(result.errors).toEqual([]);
  expect(result.notes).toEqual(["Stablecoin supply is temporarily unavailable; the prices are complete without it."]);
  expect(reportCoverage({ definition: cryptoBoardHeadless, args: ARGS, result } as LoadedHeadlessPaneModel).complete).toBe(true);
  expect(result.metadata).not.toHaveProperty("notices");
  expect("exportTables" in result).toBe(false);
  const freshness = deriveHeadlessFreshness(cryptoBoardHeadless, result, CRYPTO_FIXTURE_NOW);
  const text = renderHeadlessPaneText(cryptoBoardHeadless, result, ARGS, "CRYP", freshness);
  expect(text).toMatch(/Vol 24h USD  Market cap USD\n/);
  expect(text).not.toMatch(/Supply\s/);
});

test("the DeFi list states the total and its source, ranks protocols or chains, and exports the other list and the daily total", async () => {
  const defi = async (by: "protocol" | "chain") => {
    const args = { rawArgument: "", argument: null, symbols: [], options: { list: "defi", by } };
    const apiClient = { getCloudDefiTvl: async () => defiTvlFixture() };
    const result = await cryptoBoardHeadless.load(args, { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext);
    const freshness = deriveHeadlessFreshness(cryptoBoardHeadless, result, CRYPTO_FIXTURE_NOW);
    return { result, freshness, text: renderHeadlessPaneText(cryptoBoardHeadless, result, args, "CRYP", freshness), args };
  };

  const protocols = await defi("protocol");
  expect(protocols.text).toContain("Total DeFi TVL 92.40B · 7D +2.01B (+2.22%) · 30D -1.06B (-1.13%) · as of 2026-09-23 · DefiLlama, daily since 2026-09-19");
  expect(protocols.text).toMatch(/1\s+Aave\s+Lending\s+17\.88B\s+-0\.40%\s+-580\.00M\s+-3\.14%\s+—\s+—\s+18/);
  expect(protocols.result.notes).toEqual(["Protocols as of 2026-09-22 16:17 UTC, the source's latest; their versions are counted together."]);
  // A server before fees and revenue has no columns for them.
  expect(protocols.text).not.toContain("Fees");
  // Daily figures from a publisher, dated by their day: never a live feed.
  expect(protocols.freshness).toMatchObject({ status: "not-a-feed", publisher: "DefiLlama", asOf: "2026-09-23" });
  // A day's close is aged from the day's end: 23 Sep's is current until 36 hours after it, noon on the 25th.
  const at = (time: string) => deriveHeadlessFreshness(cryptoBoardHeadless, protocols.result, Date.parse(time)).status;
  expect(at("2026-09-25T11:00:00Z")).toBe("not-a-feed");
  expect(at("2026-09-25T13:00:00Z")).toBe("stale");

  const chains = await defi("chain");
  expect(chains.text).toMatch(/Chain\s+Token\s+TVL USD\s+7D\s+7D %\s+30D\s+30D %\s+Share/);
  expect(chains.text).toMatch(/1\s+Ethereum\s+ETH\s+55\.40B .* 59\.96%/);
  expect(chains.result.notes).toBeUndefined();

  const csv = renderReportCsv(headlessReportTables(cryptoBoardHeadless, chains.result, chains.args, "CRYP", chains.freshness, { complete: true, unavailableSymbols: [] }), chains.freshness);
  expect(csv).toContain("# section: DeFi TVL by protocol");
  // Every row names its unit (the export's own header stays "TVL"); before, currency_or_unit was empty.
  const header = csv.split("\n").find((line) => line.startsWith('"#"'))!.split(",");
  const ethereum = csv.split("\n").find((line) => line.startsWith("1,Ethereum,"))!.split(",");
  expect(ethereum[header.indexOf("currency_or_unit")]).toBe("USD");
  const history = csv.slice(csv.indexOf("# section: Total DeFi TVL")).split("\n");
  expect(history[1]).toStartWith("Date,TVL,");
  expect(history.slice(2, 5).map((line) => line.split(",").slice(0, 2).join(","))).toEqual(["2026-09-19,90000000000", "2026-09-20,91000000000", "2026-09-21,"]);
});

test("a protocol list read at the day's close has one date, and its fees and revenue in USD beside TVL", async () => {
  // Wed 4 Nov 2026: the note said "as of 2026-11-04 00:00 UTC" under a source line dated Tue 3 Nov.
  const board = {
    ...defiTvlFixture(),
    asOf: "2026-11-03", fetchedAt: "2026-11-04T00:00:13.311Z", protocolsAsOf: "2026-11-04T00:00:13.311Z", incomeAsOf: "2026-11-04T00:00:13.311Z",
  };
  board.protocols[0] = { ...board.protocols[0]!, fees24h: 1_350_000, fees7d: 9.26e6, fees30d: 37.06e6, revenue24h: 135_200, revenue7d: 926_000, revenue30d: null };
  const args = { rawArgument: "", argument: null, symbols: [], options: { list: "defi" } };
  const apiClient = { getCloudDefiTvl: async () => board };
  const result = await cryptoBoardHeadless.load(args, { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext);
  expect(result.notes).toEqual(["Protocols are read at the day's close; their versions are counted together."]);
  expect(result.rows[0]).toMatchObject({ name: "Aave", unit: "USD", fees24h: 1_350_000, fees30d: 37.06e6, revenue30d: null });
  expect(result.rows[1]).toMatchObject({ name: "Lido", fees24h: null, revenue24h: null });
  const freshness = deriveHeadlessFreshness(cryptoBoardHeadless, result, CRYPTO_FIXTURE_NOW);
  const csv = renderReportCsv(headlessReportTables(cryptoBoardHeadless, result, args, "CRYP", freshness, { complete: true, unavailableSymbols: [] }), freshness);
  const header = csv.split("\n").find((line) => line.startsWith('"#"'))!.split(",");
  const aave = csv.split("\n").find((line) => line.startsWith("1,Aave,"))!.split(",");
  expect([header.indexOf("Fees 24h") >= 0, aave[header.indexOf("Fees 30D")], aave[header.indexOf("Revenue 30D")], aave[header.indexOf("currency_or_unit")]])
    .toEqual([true, "37060000", "", "USD"]);
});

test("the coin report dates the board as the pane footer does: its time and age, with no feed label", async () => {
  const args = { ...ARGS, options: { list: "coin" } };
  const apiClient = { getCloudCryptoMarkets: async () => cryptoFixture() };
  const result = await cryptoBoardHeadless.load(args, { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext);
  const report = paneStatusLine(deriveHeadlessFreshness(cryptoBoardHeadless, result, CRYPTO_FIXTURE_NOW));
  const rows = buildCryptoRows(cryptoFixture().assets, "coin", new Map(), CRYPTO_FIXTURE_NOW);
  const pane = paneStatusLine(deriveHeadlessFreshness({ shape: "rows" }, { rows: cryptoRowObservations(rows), freshness: CRYPTO_BOARD_FRESHNESS }, CRYPTO_FIXTURE_NOW));
  expect(report).toBe("11:59 UTC · oldest 1 min");
  expect(pane).toBe(report);
});

/**
 * The worst coin was row 17 of 24 in market-cap order, and Bond USD0 at 0.9762 read as a 238bp depeg.
 * `--sort offpeg` puts the furthest off first, either side of par; a bond token has no par to be off, so it is last.
 */
test("--sort offpeg lists the stablecoins furthest off their peg first, a bond token by its kind, and the shot opens on that order", async () => {
  const board = cryptoFixture();
  const usdt = board.assets.find((asset) => asset.code === "USDT")!;
  const coin = (code: string, price: number, rank: number, peg = usdt.peg!) => ({
    ...usdt, symbol: `${code}-USD`, code, name: code, price, rank, marketCap: usdt.marketCap! / (rank + 1), peg,
  });
  board.assets.push(
    coin("BUSD0", 0.9762, 2, { currency: "USD", accrues: true, kind: "bond", price: null, asOf: null }),
    coin("USDE", 1.0021, 3),
    coin("FDUSD", 0.9955, 4),
  );
  const apiClient = { getCloudCryptoMarkets: async () => board, getCloudStablecoinSupply: async () => stablecoinSupplyFixture() };
  const ctx = { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext;
  const args = { ...ARGS, options: { list: "stablecoin", sort: "offpeg" } };
  const result = await cryptoBoardHeadless.load(args, ctx);
  expect(result.rows.map((row) => [row.code, row.offPegBp ?? null, row.pegText])).toEqual([
    ["FDUSD", -45, "USD"], ["USDE", 21, "USD"], ["USDT", -2, "USD"], ["BUSD0", null, "USD bond"],
  ]);
  expect(result.metadata).toMatchObject({ sort: "offpeg" });
  const byCap = await cryptoBoardHeadless.load(ARGS, ctx);
  expect(byCap.rows.map((row) => row.code)).toEqual(["USDT", "BUSD0", "USDE", "FDUSD"]);
  // The pane opens on the order asked for, which it reads back as its header's sort.
  expect(cryptoBoardHeadless.shotState!(args as never, null as never, new Set(["list", "sort"])))
    .toEqual({ pluginState: { "market-overview": { sort: { columnId: "offPegBp", direction: "desc" } } } });
  await expect(cryptoBoardHeadless.load({ ...ARGS, options: { sort: "offpeg" } }, ctx)).rejects.toThrow("add --list stablecoin");
});

test("a word after CRYP opens that list as --list does, an unknown one names the lists, and --limit keeps the first rows", async () => {
  const apiClient = {
    getCloudCryptoMarkets: async () => cryptoFixture(),
    getCloudStablecoinSupply: async () => stablecoinSupplyFixture(),
    getCloudDefiTvl: async () => defiTvlFixture(),
  };
  const ctx = { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext;
  const run = (argument: string | null, options: Record<string, unknown> = {}) =>
    cryptoBoardHeadless.load({ rawArgument: argument ?? "", argument, symbols: [], options: { list: "coin", ...options } }, ctx);
  expect((await run("tvl")).metadata).toMatchObject({ list: "defi", by: "protocol" });
  expect((await run("stablecoins")).metadata).toMatchObject({ list: "stablecoin" });
  expect((cryptoBoardHeadless.describe as (args: unknown) => string)({ rawArgument: "tvl", argument: "tvl", symbols: [], options: { list: "coin", by: "chain" } }))
    .toBe("Crypto | DeFi TVL by chain");
  // The shot opens the pane on the list named.
  expect(cryptoBoardHeadless.shotState!({ rawArgument: "stablecoin", argument: "stablecoin", symbols: [], options: {} } as never, null as never, new Set()))
    .toEqual({ pluginState: { "market-overview": { activeTab: "stablecoin" } } });
  await expect(run("foo")).rejects.toThrow('No list "foo". CRYP lists: coin, stablecoin, defi (or tvl).');
  const coins = await run(null);
  const limited = await run(null, { limit: 2 });
  expect(limited.rows.map((row) => row.code)).toEqual(coins.rows.slice(0, 2).map((row) => row.code));
  expect((await run("defi", { limit: 1 })).rows).toHaveLength(1);
});

test("a supply a day older than the prices beside it is headed with its day", async () => {
  const supplyHeader = async (supplyAsOf: string) => {
    const apiClient = { getCloudCryptoMarkets: async () => cryptoFixture(), getCloudStablecoinSupply: async () => ({ ...stablecoinSupplyFixture(), asOf: supplyAsOf }) };
    const result = await cryptoBoardHeadless.load(ARGS, { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext);
    const column = result.columns!.find((entry) => entry.key === "supply")!;
    return column.textHeader ?? column.header;
  };
  expect(await supplyHeader("2026-09-22")).toBe("Supply 09-22");
  expect(await supplyHeader("2026-09-23")).toBe("Supply");
});
