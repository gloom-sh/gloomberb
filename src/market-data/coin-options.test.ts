import { expect, test } from "bun:test";
import { optionRows, optionsBasisFootnote } from "../cli/commands/options-chain";
import { calculateOptionGreeks, solveChainVolatilities } from "../plugins/builtin/options/analytics";
import { daysToExpiryFrom } from "../plugins/builtin/shared/volatility/pricing";
import { dvolSection } from "../plugins/builtin/vol-surface/headless";
import { dvolStats } from "../plugins/builtin/vol-surface/pane";
import { expiryLabel } from "../plugins/builtin/vol-surface/tables";
import { dvolCurrency, type DvolPayload } from "../plugins/builtin/volatility/dvol";
import { VOLATILITY_SERIES } from "../plugins/builtin/volatility/series";
import { lookupGlossary, reportGlossary } from "../cli/glossary";
import { createTestCliContext } from "../test-support/cli-context";
import { marketDataCliCommands } from "../cli/commands/market";
import type { OptionContract, OptionsChain } from "../types/financials";
import { isSettlementStamp } from "../utils/option-expiry";
import { coinOptionsSymbol, isCoinWithoutOptions, listedCoinOptions } from "./options-alternatives";

// 30 Oct 2026 08:00 UTC, when Deribit's BTC options of that date settle.
const SETTLES = Date.UTC(2026, 9, 30, 8) / 1000;
const NOW = Date.UTC(2026, 9, 22, 22, 42);

function marked(strike: number, side: "call" | "put", iv: number, delta: number): OptionContract {
  return {
    contractSymbol: `BTC-30OCT26-${strike}-${side === "call" ? "C" : "P"}`, strike, currency: "USD", lastPrice: 3_841.22, change: 0,
    percentChange: 0, volume: 0, openInterest: 482, bid: 3_759, ask: 3_963, impliedVolatility: iv, inTheMoney: false,
    expiration: SETTLES, lastTradeDate: 0,
    mark: { price: 3_841.22, iv, delta, gamma: 0.000067, vega: 32.53, theta: -80.31, forward: 81_380 },
    coin: { currency: "BTC", bid: 0.046, ask: 0.0485, mark: 0.0472, last: 0.0472 },
  };
}
const chain: OptionsChain = {
  underlyingSymbol: "BTC-USD", expirationDates: [SETTLES], calls: [marked(78_000, "call", 0.365, 0.8)],
  puts: [marked(78_000, "put", 0.365, -0.2)], feed: "deribit", rate: 0, venue: "Deribit", asOf: new Date(NOW).toISOString(),
};

test("only BTC-USD and ETH-USD have coin options; a bare BTC is the coin in the options functions, and SOL-USD has none", () => {
  expect(["BTC-USD", "btc-usd", "BTC-USD:CCC", "ETH-USD", "SOL-USD", "BTC", "IBIT", "EUR-USD"].map(listedCoinOptions))
    .toEqual(["BTC-USD", "BTC-USD", "BTC-USD", "ETH-USD", null, null, null, null]);
  expect(["SOL-USD", "DOGE-USD:CCC", "BTC-USD", "BTC", "SPY", "EUR-USD"].map(isCoinWithoutOptions))
    .toEqual([true, true, false, false, false, false]);
  expect(["BTC", "eth", "BTC:ARCA", "SPY"].map(coinOptionsSymbol)).toEqual(["BTC-USD", "ETH-USD", "BTC:ARCA", "SPY"]);
});

test("a Deribit expiry runs to its 08:00 UTC settlement, a US one to its date's 16:00 ET close", () => {
  expect(isSettlementStamp(SETTLES)).toBe(true);
  expect(isSettlementStamp(Date.UTC(2026, 9, 30) / 1000)).toBe(false);
  expect(isSettlementStamp(Date.UTC(2026, 8, 25, 23) / 1000)).toBe(false);
  expect(daysToExpiryFrom(SETTLES, NOW)).toBeCloseTo((SETTLES * 1000 - NOW) / 86_400_000, 10);
  // The date's midnight stamp still runs to 20:00 UTC, the close in New York in October.
  expect(daysToExpiryFrom(Date.UTC(2026, 9, 30) / 1000, NOW)).toBeCloseTo((Date.UTC(2026, 9, 30, 20) - NOW) / 86_400_000, 10);
  expect(expiryLabel(SETTLES)).toBe("2026-10-30 08:00 UTC");
  expect(expiryLabel(Date.UTC(2026, 9, 30) / 1000)).toBe("2026-10-30");
});

test("a marked contract keeps the venue's IV and greeks, with its coin premiums beside the dollar ones", () => {
  const volatilities = solveChainVolatilities(chain, undefined, undefined, NOW);
  expect(volatilities.byStrike.get(78_000)).toBe(0.365);
  expect(calculateOptionGreeks(chain.puts[0], "put", undefined, undefined, volatilities)).toEqual({
    price: 3_841.22, delta: -0.2, gamma: 0.000067, thetaPerDay: -80.31, vegaPerPoint: 32.53, rhoPerPoint: 0,
  });
  const [call] = optionRows(chain);
  expect(call).toMatchObject({ coinCurrency: "BTC", coinBid: 0.046, coinMark: 0.0472, mark: 3_841.22, forward: 81_380,
    expiresAt: "2026-10-30T08:00:00.000Z" });
  expect(optionsBasisFootnote({ spot: null, openInterest: null } as never, chain)).toStartWith(
    "Deribit marks: IV and greeks at each expiry's forward, rate 0%; $ is the BTC price at the forward · expiries settle 08:00 UTC · OI live,");
});

test("options on a coin without them names BTC and ETH options and IBIT, not the routing error", async () => {
  const cli = createTestCliContext({ dataProvider: {
    getOptionsChain: async (symbol: string) => { throw new Error(`No options provider available for ${symbol}`); },
    getQuote: async () => { throw new Error("offline"); },
  } });
  let failure: { message: string; details?: string } | null = null;
  cli.context.fail = ((message: string, details?: string): never => {
    failure = { message, details };
    throw new Error(message);
  }) as typeof cli.context.fail;
  await expect(marketDataCliCommands.find((command) => command.name === "options")!.execute(["SOL-USD"], cli.context))
    .rejects.toThrow("Options are not available for SOL-USD.");
  expect(failure!.details).toBe("Listed crypto options cover BTC and ETH: gloomberb options BTC-USD, gloomberb options ETH-USD."
    + " Bitcoin-linked US listings have their own: gloomberb options IBIT.");
  expect(`${failure!.message} ${failure!.details}`).not.toMatch(/provider|OSA/i);
});

const dvol: DvolPayload = {
  version: 1, currency: "BTC", delayed: false, venue: "Deribit", latest: { value: 38.28, at: "2026-10-22T22:51:00.000Z" },
  observations: [{ date: "2025-10-21", value: 50 }, { date: "2026-10-21", value: 37.1 }, { date: "2026-10-22", value: 38.28 }],
};

test("DVOL is a chartable series for BTC and ETH, and OVDV states it with its change on the day", () => {
  expect(VOLATILITY_SERIES.filter((series) => series.id.startsWith("volatility:dvol")).map((series) => [series.id, series.name])).toEqual([
    ["volatility:dvol-btc", "Bitcoin volatility index (DVOL)"], ["volatility:dvol-eth", "Ether volatility index (DVOL)"],
  ]);
  expect(["BTC-USD", "ETH-USD:CCC", "BTC", "BTC:ARCA", "SOL-USD"].map(dvolCurrency)).toEqual(["BTC", "ETH", null, null, null]);
  const section = dvolSection(dvol, null);
  expect(section.title).toBe("DVOL · BTC · Deribit");
  const entry = (key: string) => section.entries!.find((row) => row.key === key);
  expect(entry("dvol")?.value).toBe(38.28);
  expect(entry("dvolChange")?.value).toBe(1.18);
  // 2025-10-21 is more than a year back, outside the range.
  expect(entry("dvolRange")?.value).toEqual({ low: 37.1, high: 38.28 });
  expect(entry("series")?.formatted).toBe("gloomberb fn G CAP:volatility:dvol-btc");
  expect(dvolStats(dvol, 0.3647).map((stat) => [stat.label, stat.value, stat.detail])).toEqual([
    ["DVOL", "38.28", "22:51 UTC"], ["DVOL 1D", "+1.18", "vol pts"], ["30D ATM", "36.47", "-1.81 vs DVOL"],
  ]);
});

test("the glossary explains max pain, Payout $, RR, BF and DVOL from what OPX and OVDV print", () => {
  expect(lookupGlossary("max pain").exact.map((entry) => entry.term)).toEqual(["Max pain"]);
  expect(lookupGlossary("risk reversal").exact.map((entry) => entry.term)).toEqual(["Risk reversal"]);
  expect(lookupGlossary("BF").exact.map((entry) => entry.term)).toEqual(["Butterfly"]);
  expect(reportGlossary("OPX", "Max pain  Vs spot\nStrike  Payout $").map((entry) => entry.term)).toEqual(["Max pain", "Payout $"]);
  expect(reportGlossary("OVDV", "DVOL 38.14\nRR call-put (pts)  BF wings-ATM (pts)").map((entry) => entry.term))
    .toEqual(["Risk reversal", "Butterfly", "DVOL"]);
});
