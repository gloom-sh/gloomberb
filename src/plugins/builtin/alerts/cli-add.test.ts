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
import { alertsCliCommand } from "./cli";
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
    AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" }),
  };
  return createTestDataProvider({
    search: async (query: string) => {
      if (query.toUpperCase() === "AAPL") return [{ providerId: "test", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "EQUITY", currency: "USD" }];
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
  const stored = readAlertStores(await loadConfig(dataDir)).alerts;
  return { stored, error, printed: cli.printed[0] };
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
