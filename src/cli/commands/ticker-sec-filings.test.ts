import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { SecFilingItem } from "../../types/data-provider";
import type { MarketContext } from "../types";
import { createTestDataProvider } from "../../test-support/data-provider";
import { buildTickerReport, ticker } from "./ticker";
import { createCoreCliCommands } from "../index";
import { checkCliCommandOptions } from "../command-options";
import { createTestCliContext } from "../../test-support/cli-context";

const config = createDefaultConfig("/tmp/gloom-ticker-sec-unused");

// JPM as the service lists it: note supplements in runs, the results 8-K behind them.
const filing = (form: string, index: number, extra: Partial<SecFilingItem> = {}): SecFilingItem => ({
  form, accessionNumber: `0000019617-26-${String(index).padStart(6, "0")}`, filingDate: new Date("2026-10-13"), cik: "19617",
  filingUrl: `https://www.sec.gov/${index}`, ...extra,
});
const issuer = [
  ...Array.from({ length: 30 }, (_, index) => filing(index % 3 ? "424B2" : "FWP", index)),
  filing("8-K", 100, { items: "2.02,9.01", primaryDocDescription: "8-K" }),
  filing("8-K", 101, { items: "7.01,9.01" }),
  ...Array.from({ length: 4 }, (_, index) => filing("4", 200 + index)),
  filing("10-Q", 300),
];

async function report(all = false) {
  let data: any;
  const requested: number[] = [];
  await ticker("JPM", {
    allFilings: all,
    initMarketData: async () => ({
      config, dataDir: "/tmp/gloom-ticker-sec-unused",
      store: { loadTicker: async () => null }, persistence: { close: () => {} },
      dataProvider: {
        ...createTestDataProvider({ getTickerFinancials: async () => ({ annualStatements: [{ date: "2025-12-31", totalRevenue: 1 }], quarterlyStatements: [], priceHistory: [] }) }),
        getNews: async () => [],
        getSecFilings: async (_symbol: string, count = 0) => { requested.push(count); return issuer.slice(0, count); },
      },
    }) as unknown as MarketContext,
    fail: (message) => { throw new Error(message); },
    printResult: (result) => { data = result.data; },
  });
  return { data, requested };
}

test("ticker's recent SEC filings leave the pricing supplements out, say how many, and name each 8-K's items", async () => {
  const { data, requested } = await report();
  expect(requested).toEqual([200]);
  const text = (await buildTickerReport({ symbol: "JPM", tickerFile: null, config, toBase: async (value) => value,
    financials: { annualStatements: [], quarterlyStatements: [], priceHistory: [] },
    recentSecFilings: issuer.slice(30, 35), hiddenPricingSupplements: 30 })).replace(/\u001b\[[0-9;]*m/g, "");
  const section = text.slice(text.indexOf("Recent SEC Filings"));
  expect(section).toContain("Form 8-K");
  expect(section).toContain("Items 2.02 Results of operations");
  expect(section).toContain("Items 7.01 Regulation FD disclosure");
  expect(section).not.toContain("424B2");
  expect(section).toContain("30 pricing supplements hidden, --all to show");
  expect(data.recentSecFilings.map((row: { form: string }) => row.form)).toEqual(["8-K", "8-K", "4", "4", "4"]);
  // Codes in items, as fn SEC and filings give them; the words the text shows beside them.
  expect(data.recentSecFilings[0]).toMatchObject({ items: "2.02,9.01", itemsLabel: "2.02 Results of operations" });
  expect(data.recentSecFilingsHidden).toEqual({ pricingSupplements: 30 });

  const all = await report(true);
  expect(all.data.recentSecFilings.map((row: { form: string }) => row.form)).toEqual(["FWP", "424B2", "424B2", "FWP", "424B2"]);
  expect(all.data.recentSecFilingsHidden).toEqual({ pricingSupplements: 0 });
});

test("ticker --all, as the CLI reads it, keeps the supplements", async () => {
  const command = createCoreCliCommands(() => [], () => null, () => []).find((entry) => entry.name === "ticker")!;
  // The dispatcher's option check takes --all.
  expect(() => checkCliCommandOptions(command, ["JPM", "--all"])).not.toThrow();
  const run = async (args: string[]) => {
    const requested: number[] = [];
    const cli = createTestCliContext({
      config, dataDir: "/tmp/gloom-ticker-sec-unused",
      dataProvider: {
        ...createTestDataProvider({ getTickerFinancials: async () => ({ annualStatements: [{ date: "2025-12-31", totalRevenue: 1 }], quarterlyStatements: [], priceHistory: [] }) }),
        getNews: async () => [],
        getSecFilings: async (_symbol: string, count = 0) => { requested.push(count); return issuer.slice(0, count); },
      },
    }, { format: "json" });
    await command.execute(args, cli.context);
    return { requested, data: cli.printed[0]!.result.data };
  };
  const all = await run(["JPM", "--all"]);
  expect(all.requested).toEqual([5]);
  expect(all.data.recentSecFilings.map((row: { form: string }) => row.form)).toEqual(["FWP", "424B2", "424B2", "FWP", "424B2"]);
  expect((await run(["JPM"])).requested).toEqual([200]);
});
