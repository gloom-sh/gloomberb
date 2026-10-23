import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, saveConfig } from "../../../data/config/store";
import { createTestCliContext } from "../../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { currencyPairSpelling } from "../../../utils/currency-pair";
import { alertsCliCommand, parseAlertAddArgs } from "./cli";
import { farTargetMessage } from "./quotes";
import { readAlertStores } from "./storage";

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const pair: Quote = createTestQuote({
  symbol: "USDMXN=X", name: "USD/MXN", currency: "MXN", price: 18.42, listingExchangeName: "CCY", exchangeName: "CCY", instrumentType: "CURRENCY",
});

/**
 * Gloom Cloud for a few symbols: the pair is quoted under its own listing only (USDMXN as typed is no
 * ticker, as the service answers it), USD_NGN is a miss search lists the pair for, and AAPL is a US stock.
 */
function cloud() {
  const quotes: Record<string, Quote> = {
    "USDMXN=X": pair,
    "USDNGN=X": { ...pair, symbol: "USDNGN=X", name: "USD/NGN", currency: "NGN", price: 1322 },
    // After hours: the alert is checked on the regular-session price, which the far-target check measures against.
    AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", price: 250, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ",
      marketState: "POST", postMarketPrice: 300 }),
    // The bare coin ticker is the Grayscale fund, as the data service answers it.
    BTC: createTestQuote({ symbol: "BTC", name: "Grayscale Bitcoin Mini Trust ETF", price: 37.35, listingExchangeName: "ARCA", exchangeName: "ARCA", instrumentType: "ETF" }),
  };
  return createTestDataProvider({
    search: async (query: string) => {
      if (query.toUpperCase() === "AAPL") return [{ providerId: "test", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "EQUITY", currency: "USD" }];
      if (query.toUpperCase() === "BTC") return [{ providerId: "test", symbol: "BTC", name: "Grayscale Bitcoin Mini Trust ETF", exchange: "ARCA", type: "ETF", currency: "USD" }];
      const found = currencyPairSpelling(query.replace("_", "/").toUpperCase(), "CCY");
      const quote = found ? quotes[found.symbol] : undefined;
      return quote ? [{ providerId: "test", symbol: quote.symbol, name: quote.name!, exchange: "CCY", type: "CURRENCY", currency: quote.currency }] : [];
    },
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => (
      quotes[target.symbol] ? { target, quote: quotes[target.symbol]! } : { target, quote: null, error: `Not a ticker: ${target.symbol}.` }
    )),
  });
}

async function addAlert(args: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-alerts-add-"));
  dataDirs.push(dataDir);
  const config = createDefaultConfig(dataDir);
  await saveConfig(config);
  const cli = createTestCliContext({ config, dataProvider: cloud() });
  let error: string | null = null;
  try {
    await alertsCliCommand.execute(["add", ...args], cli.context);
  } catch (thrown) {
    error = (thrown as Error).message;
  }
  const saved = await loadConfig(dataDir);
  const stores = readAlertStores(saved);
  return { stored: stores.alerts, events: stores.events.rules, pluginState: saved.pluginConfig.alerts ?? {}, error, printed: cli.printed[0] };
}

test("a price alert is kept for the listing quote prints, so one pair is one target however it is typed", async () => {
  const spellings = await Promise.all(["USDMXN", "USD/MXN", "usdmxn=x", "MXN=X"].map((typed) => addAlert([typed, "above", "18.8"])));
  for (const { stored, error } of spellings) {
    expect(error).toBeNull();
    expect(stored.map((alert) => [alert.symbol, alert.exchange, alert.targetPrice])).toEqual([["USDMXN=X", undefined, 18.8]]);
  }
});

test("a symbol nothing quotes is refused and nothing is stored, with the nearest listing named when there is one", async () => {
  const unknown = await addAlert(["ZZZQQ9", "above", "1"]);
  expect(unknown.error).toContain("Not a ticker: ZZZQQ9.");
  expect(unknown.stored).toEqual([]);
  expect(unknown.printed).toBeUndefined();

  const near = await addAlert(["USD_NGN", "above", "1500"]);
  expect(near.error).toBe("Not a ticker: USD_NGN. Did you mean USDNGN=X (USD/NGN)?");
  expect(near.stored).toEqual([]);

  // One slip from a US ticker the user is likely to mean, which search lists no typo for.
  const typo = await addAlert(["AAPLL", "above", "100"]);
  expect(typo.error).toContain("Did you mean AAPL");
  expect(typo.stored).toEqual([]);
});

test("a price alert says what delivers it, and the app is the one thing that always does", async () => {
  const { printed, stored } = await addAlert(["AAPL", "above", "250"]);
  expect(stored).toHaveLength(1);
  const text = printed!.options!.text!(printed!.result.data);
  expect(text).toContain("AAPL above 250 (the app alerts while it is running;");
  // Signed in, Cloud emails or pushes it only once the app has been closed for a while: never promised to everyone.
  expect(text).toContain("sign in with Cloud sync for email or phone alerts when it is closed");
});

test("a bare coin ticker on its fund gets quote's note, and a target ten times its price is refused with it", async () => {
  const far = await addAlert(["btc", "above", "85000"]);
  expect(far.error).toBe("A target of 85,000 is more than 10 times BTC's last price of 37.35. BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD.");
  expect(far.stored).toEqual([]);
  // Measured against the price the alert is checked on (250), not the after-hours print, and the same for crosses.
  expect((await addAlert(["AAPL", "below", "24.99"])).error).toBe("A target of 24.99 is under 1/10 of AAPL's last price of 250. Check the price and the symbol.");
  expect((await addAlert(["AAPL", "crosses", "2500.01"])).error).toMatch(/^A target of 2,500.01 is more than 10 times AAPL's last price of 250\./);
  expect((await addAlert(["AAPL", "crosses", "2500"])).error).toBeNull();

  const near = await addAlert(["btc", "above", "40"]);
  expect(near.stored.map((alert) => [alert.symbol, alert.targetPrice])).toEqual([["BTC", 40]]);
  expect(near.printed!.result.warnings).toContain("BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD.");
});

test("alerts add reads the dialog's news, flow and IV forms", () => {
  expect(parseAlertAddArgs(["IBIT", "iv", "above", "50"], undefined)).toEqual({ kind: "iv_level", symbol: "IBIT", metric: "atm", direction: "above", level: 50 });
  expect(parseAlertAddArgs(["SPY", "RR", "below", "-6"], undefined)).toEqual({ kind: "iv_level", symbol: "SPY", metric: "rr", direction: "below", level: -6 });
  // A level takes its unit, joined or apart, and only the one its measure is in.
  expect(parseAlertAddArgs(["IBIT", "iv", "above", "50%"], undefined)).toMatchObject({ metric: "atm", level: 50 });
  expect(parseAlertAddArgs(["IBIT", "iv", "above", "50", "%"], undefined)).toMatchObject({ metric: "atm", level: 50 });
  expect(parseAlertAddArgs(["SPY", "rr", "below", "-5.5", "pts"], undefined)).toMatchObject({ metric: "rr", level: -5.5 });
  expect(parseAlertAddArgs(["SPY", "rr", "below", "-5.5pts"], undefined)).toMatchObject({ metric: "rr", level: -5.5 });
  expect(() => parseAlertAddArgs(["SPY", "rr", "below", "-5%"], undefined)).toThrow("A risk reversal is in vol points, not %");
  expect(() => parseAlertAddArgs(["IBIT", "iv", "above", "50", "pts"], undefined)).toThrow("An ATM IV level is in %, not vol points");
  expect(parseAlertAddArgs(["AAPL271217C00300000", "iv", "spike", "5", "pts"], undefined)).toMatchObject({ kind: "iv_spike", points: 5 });
  expect(parseAlertAddArgs(["AAPL271217C00300000", "iv", "spike", "5"], undefined)).toEqual({ kind: "iv_spike", contract: "AAPL271217C00300000", points: 5 });
  expect(parseAlertAddArgs(["AAPL", "news", "share", "buyback"], undefined)).toEqual({ kind: "news", symbol: "AAPL", keyword: "share buyback" });
  expect(parseAlertAddArgs(["news", "rate", "cut"], undefined)).toEqual({ kind: "news", symbol: null, keyword: "rate cut" });
  expect(parseAlertAddArgs(["NVDA", "flow", "5m", "calls", "sweeps"], undefined)).toEqual({ kind: "flow", symbol: "NVDA", premium: 5_000_000, side: "calls", print: "sweep" });
  expect(parseAlertAddArgs(["flow"], undefined)).toEqual({ kind: "flow", symbol: null, premium: 1_000_000, side: "any", print: "any" });
  // A symbol that spells a form word is still a price alert.
  expect(parseAlertAddArgs(["NEWS", "above", "10"], undefined)).toMatchObject({ kind: "price", symbol: "NEWS", price: 10 });

  expect(() => parseAlertAddArgs(["IBIT", "iv", "50"], undefined)).toThrow("An iv alert takes above or below and a level");
  expect(() => parseAlertAddArgs(["IBIT", "iv", "above", "900"], undefined)).toThrow("1 to 500");
  expect(() => parseAlertAddArgs(["AAPL271217C00300000", "iv", "above", "5"], undefined)).toThrow("iv spike 5");
  expect(() => parseAlertAddArgs(["NVDA", "flow", "10k"], undefined)).toThrow("$50,000");
  expect(() => parseAlertAddArgs(["AAPL", "news", "buyback"], "3")).toThrow("--days is for earnings");
});

test("an IV level from the shell is the rule the dialog saves, on the listing quote reads, in the list released versions never read", async () => {
  const { events, error, printed, pluginState } = await addAlert(["aapl", "iv", "above", "35%"]);
  expect(error).toBeNull();
  expect(events).toHaveLength(1);
  expect(Object.keys(pluginState)).toEqual(["ivLevelAlerts"]);
  expect(events[0]).toMatchObject({ kind: "iv_level", target: "rule", status: "active" });
  expect(JSON.parse(events[0]!.value)).toEqual({ version: 1, symbol: "AAPL", exchange: "US", metric: "atm", direction: "above", threshold: 35 });
  expect(printed!.options!.text!(printed!.result.data)).toContain("IV level AAPL · 30d ATM IV above 35% (the app checks it every 15 minutes while it is running");
});

test("the far-target refusal is exactly past ten times either way, and writes prices as typed, never in exponent form", () => {
  expect(farTargetMessage("XYZ", 100, 10, null)).toBeNull();
  expect(farTargetMessage("XYZ", 1, 10, null)).toBeNull();
  expect(farTargetMessage("XYZ", 0.999, 10, null)).toBe("A target of 0.999 is under 1/10 of XYZ's last price of 10. Check the price and the symbol.");
  expect(farTargetMessage("XYZ", 1, 0.0000001234, null)).toBe("A target of 1 is more than 10 times XYZ's last price of 0.0000001234. Check the price and the symbol.");
  expect(farTargetMessage("XYZ", 0.00000001, 1, null)).toBe("A target of 0.00000001 is under 1/10 of XYZ's last price of 1. Check the price and the symbol.");
  // No price to measure against: nothing is refused.
  expect(farTargetMessage("XYZ", 85_000, 0, null)).toBeNull();
});
