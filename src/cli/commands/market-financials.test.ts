import { expect, test } from "bun:test";
import { createTestCliContext } from "../../test-support/cli-context";
import type { TickerFinancials } from "../../types/financials";
import { DEFAULT_CLI_OPTIONS, type CliOutputFormat } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";

const FINANCIALS: TickerFinancials = {
  quote: {
    symbol: "SBK.JO", name: "Standard Bank Group Limited", price: 292.1, currency: "ZAR", change: 1.46, changePercent: 0.5,
    marketCap: 474_045_349_888, lastUpdated: Date.parse("2026-10-09T13:57:00Z"),
  },
  fundamentals: {
    trailingPE: 9.322304, eps: 31.43, dividendYield: 0.0614587987599, dividendYieldBasis: "forward",
    revenue: 202_080_000_000, financialCurrency: "ZAR", profitMargin: 0.28868, sharesOutstanding: 1_619_308_095,
  },
  profile: { sector: "Financial Services", industry: "Banks - Regional", description: "A bank, \"pan-African\".\nSecond line." },
  annualStatements: [
    { date: "2024-12-31", totalRevenue: 189_471_000_000, netIncome: 45_818_000_000, eps: 26.179, currency: "ZAR" },
    { date: "2025-12-31", totalRevenue: 202_080_000_000, netIncome: 51_215_000_000, eps: 29.876, currency: "ZAR" },
  ],
  quarterlyStatements: [],
  priceHistory: [],
};

async function run(command: string, args: string[], format: CliOutputFormat): Promise<string[]> {
  const cli = createTestCliContext({ dataProvider: { getTickerFinancials: async () => FINANCIALS } }, { format });
  await marketDataCliCommands.find((entry) => entry.name === command)!.execute(["SBK.JO", ...args], cli.context);
  const [printed] = cli.printed;
  return serializeCliResult(printed!.result, { ...DEFAULT_CLI_OPTIONS, format }, printed!.options).split("\n");
}

test("fundamentals --csv writes Metric,Value tables with each unit in its label, and the profile", async () => {
  const lines = await run("fundamentals", [], "csv");
  expect(lines.slice(0, 11)).toEqual([
    "# section: Fundamentals",
    "Metric,Value",
    "Market Cap (ZAR),474045349888",
    "P/E (TTM),9.322304",
    "EPS (TTM) (ZAR),31.43",
    "Dividend Yield (forward) (%),6.14587987599",
    "Revenue (TTM) (ZAR),202080000000",
    "Profit Margin (%),28.868",
    "Shares Outstanding,1619308095",
    "",
    "# section: Profile",
  ]);
  expect(lines).toContain("Description,\"A bank, \"\"pan-African\"\".");
  expect(lines.at(-1)).toStartWith("# Source: ");
  expect(lines.at(-2)).toBe("");
  expect(await run("fundamentals", ["--section", "profile"], "csv")).toEqual(expect.arrayContaining(["Metric,Value", "Symbol,SBK.JO", "Sector,Financial Services"]));
  expect((await run("fundamentals", [], "ndjson"))[0]).toBe("{\"section\":\"Fundamentals\",\"Metric\":\"Market Cap (ZAR)\",\"Value\":474045349888}");
});

test("valuation --csv is one clean table; financials --csv writes raw amounts under the displayed columns", async () => {
  const valuation = await run("valuation", [], "csv");
  expect(valuation.slice(0, 6)).toEqual([
    "Metric,Value",
    "Market Cap (ZAR),474045349888",
    "P/E (TTM),9.322304",
    "EPS (TTM) (ZAR),31.43",
    "Dividend Yield (forward) (%),6.14587987599",
    "",
  ]);
  expect(await run("financials", [], "csv")).toEqual([
    "Date,Revenue,Gross,Op Inc,Net Inc,EPS,Cur",
    "2024-12-31,189471000000,,,45818000000,26.179,ZAR",
    "2025-12-31,202080000000,,,51215000000,29.876,ZAR",
    "",
    "# Source: Gloom Cloud | As of 2025-12-31 | Not a live feed (financial statements)",
  ]);
  // NDJSON already wrote the statement rows flat, so it is unchanged.
  expect((await run("financials", [], "ndjson"))[0]).toBe(
    "{\"date\":\"2024-12-31\",\"revenue\":189471000000,\"grossProfit\":null,\"operatingIncome\":null,\"netIncome\":45818000000,\"eps\":26.179,\"currency\":\"ZAR\"}",
  );
});

test("--section names the sections a report has, and is only for --csv and --ndjson", async () => {
  await expect(run("fundamentals", ["--section", "ratios"], "csv")).rejects.toThrow(
    "No section \"ratios\". Sections: Fundamentals, Profile, or a number from 1 to 2.",
  );
  await expect(run("valuation", ["--section", "1"], "json")).rejects.toThrow("--section picks one table of --csv or --ndjson output.");
});
