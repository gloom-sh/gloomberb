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

async function run(command: string, args: string[], format: CliOutputFormat, financials = FINANCIALS): Promise<string[]> {
  const cli = createTestCliContext({ dataProvider: { getTickerFinancials: async () => financials } }, { format });
  await marketDataCliCommands.find((entry) => entry.name === command)!.execute([financials.quote?.symbol ?? "SBK.JO", ...args], cli.context);
  const [printed] = cli.printed;
  return serializeCliResult(printed!.result, { ...DEFAULT_CLI_OPTIONS, format }, printed!.options).split("\n");
}

/** What every exported row of SBK.JO's fundamentals ends with: the listing, and the source (they carry no observation date). */
const IDENTITY = "symbol_or_series,currency_or_unit,interval,source,as_of";
const FUNDAMENTALS_ROW = ",SBK.JO,,,Gloom Cloud,";

test("fundamentals --csv writes Metric,Value tables with each unit in its label, and the profile", async () => {
  const lines = await run("fundamentals", [], "csv");
  expect(lines.slice(0, 11)).toEqual([
    "# section: Fundamentals",
    `Metric,Value,${IDENTITY}`,
    ...[
      "Market Cap (ZAR),474045349888",
      "P/E (TTM),9.322304",
      "EPS (TTM) (ZAR),31.43",
      "Dividend Yield (forward) (%),6.14587987599",
      "Revenue (TTM) (ZAR),202080000000",
      "Profit Margin (%),28.868",
      "Shares Outstanding,1619308095",
    ].map((row) => `${row}${FUNDAMENTALS_ROW}`),
    "",
    "# section: Profile",
  ]);
  expect(lines).toContain("Description,\"A bank, \"\"pan-African\"\".");
  expect(lines.at(-6)).toBe("");
  expect(lines.at(-5)).toStartWith("# Source: ");
  expect(lines.at(-1)).toStartWith("# Retrieval time: ");
  expect(await run("fundamentals", ["--section", "profile"], "csv"))
    .toEqual(expect.arrayContaining([`Metric,Value,${IDENTITY}`, `Symbol,SBK.JO${FUNDAMENTALS_ROW}`, `Sector,Financial Services${FUNDAMENTALS_ROW}`]));
  expect(JSON.parse((await run("fundamentals", [], "ndjson"))[0]!)).toEqual({
    section: "Fundamentals", Metric: "Market Cap (ZAR)", Value: 474045349888,
    symbol_or_series: "SBK.JO", currency_or_unit: null, interval: null, source: "Gloom Cloud", as_of: null,
  });
});

test("valuation --csv is one clean table; financials --csv writes raw amounts under the displayed columns", async () => {
  const valuation = await run("valuation", [], "csv");
  // Measured at the quote's price, so dated by the quote, which it names first.
  expect(valuation.slice(0, 9)).toEqual([
    `Metric,Value,${IDENTITY}`,
    ...[
      "Last (ZAR),292.1",
      "Change (%),0.5",
      "Market Cap (ZAR),474045349888",
      "Shares Outstanding,1619308095",
      "P/E (TTM),9.322304",
      "EPS (TTM) (ZAR),31.43",
      "Dividend Yield (forward) (%),6.14587987599",
    ].map((row) => `${row}${FUNDAMENTALS_ROW}2026-10-09T13:57:00.000Z`),
    "",
  ]);
  const statements = await run("financials", [], "csv");
  expect([...statements.slice(0, 8), ...statements.slice(-2)]).toEqual([
    `Date,Revenue,Gross,Op Inc,Net Inc,EPS,Cur,${IDENTITY}`,
    "2024-12-31,189471000000,,,45818000000,26.179,ZAR,SBK.JO,ZAR,annual,Gloom Cloud,2025-12-31",
    "2025-12-31,202080000000,,,51215000000,29.876,ZAR,SBK.JO,ZAR,annual,Gloom Cloud,2025-12-31",
    "",
    "# Source: Gloom Cloud · Wed 31 Dec 2025 · not a live feed (financial statements)",
    "# Publisher: not published",
    "# Observation date: 2025-12-31",
    "# Publication time: not published",
    // The years served are the ones it says it has: this report holds two, from 2024, and the line takes the year from them.
    "# note: annual history from 2024; older years not served",
    "# note: earlier years, one metric at a time: gloomberb fn GF SBK.JO --period annual --periods 40",
  ]);
  expect(statements.at(-3)).toStartWith("# Retrieval time: ");
  // NDJSON writes the statement rows flat, each ending with the same five fields.
  expect((await run("financials", [], "ndjson"))[0]).toBe(
    "{\"date\":\"2024-12-31\",\"revenue\":189471000000,\"grossProfit\":null,\"operatingIncome\":null,\"netIncome\":45818000000,\"eps\":26.179,\"currency\":\"ZAR\","
      + "\"symbol_or_series\":\"SBK.JO\",\"currency_or_unit\":\"ZAR\",\"interval\":\"annual\",\"source\":\"Gloom Cloud\",\"as_of\":\"2025-12-31\"}",
  );
});

test("--section names the sections a report has, and is only for --csv and --ndjson", async () => {
  await expect(run("fundamentals", ["--section", "ratios"], "csv")).rejects.toThrow(
    "No section \"ratios\". Sections: Fundamentals, Profile, or a number from 1 to 2.",
  );
  await expect(run("valuation", ["--section", "1"], "json")).rejects.toThrow("--section picks one table of --csv or --ndjson output.");
});

test("fundamentals prints the float and the short interest of one dated settlement, as its JSON gives them", async () => {
  // GLO-760, GME as Gloom Cloud serves it after 2026-10-14: the float at the shares outstanding, the 30 September
  // settlement's shares short and days to cover. The text view used to leave these out, so scripts read the JSON alone.
  const gme: TickerFinancials = {
    quote: { symbol: "GME", name: "GameStop Corp.", price: 29.84, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2026-10-14T13:00:00Z") },
    fundamentals: {
      sharesOutstanding: 449_100_000, floatShares: 449_100_000, sharesShort: 42_673_721,
      shortPercentOfFloat: 42_673_721 / 449_100_000, shortRatio: 3.98, shortInterestDate: "2026-09-30",
    },
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
  };
  const text = (await run("fundamentals", [], "text", gme)).join("\n").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  expect(text).toContain("Shares Outstanding 449.1M\nFloat 449.1M\nShort Interest 42.67M (settled 2026-09-30)\nShort % of Float 9.50%\nDays to Cover 3.98\n");
  const json = JSON.parse((await run("fundamentals", [], "json", gme)).join("\n"));
  expect(json.data.fundamentals).toMatchObject({
    floatShares: 449_100_000, sharesShort: 42_673_721, shortRatio: 3.98, shortInterestDate: "2026-09-30",
  });
  expect(await run("fundamentals", [], "csv", gme)).toEqual(expect.arrayContaining([
    expect.stringMatching(/^Short Interest \(shares\),42673721,GME,/),
    expect.stringMatching(/^Short Interest Settlement,2026-09-30,GME,/),
    expect.stringMatching(/^Days to Cover,3.98,GME,/),
  ]));
})
