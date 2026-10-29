import { expect, test } from "bun:test";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { fetchProviderDividendData } from "../../plugins/builtin/dividend-yield/provider-client";
import { buildOverviewStats } from "../../plugins/builtin/ticker-detail/overview/model";
import { getColumnValue } from "../../portfolio/column-values";
import { createTestTicker } from "../../test-support/ticker";
import type { TickerFinancials } from "../../types/financials";
import { DEFAULT_CLI_OPTIONS, type CliOutputFormat } from "../options";
import { serializeCliResult } from "../result";
import { comparedSymbols, marketDataCliCommands } from "./market";

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
      "Market Cap (ZAR),472999894550",
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
    section: "Fundamentals", Metric: "Market Cap (ZAR)", Value: 472999894550,
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
      "Market Cap (ZAR),472999894550",
      "Shares Outstanding,1619308095",
      "P/E (TTM),9.322304",
      "EPS (TTM) (ZAR),31.43",
      "Dividend Yield (forward) (%),6.14587987599",
    ].map((row) => `${row}${FUNDAMENTALS_ROW}2026-10-09T13:57:00.000Z`),
    "",
  ]);
  const statements = await run("financials", [], "csv");
  expect([...statements.slice(0, 8), ...statements.slice(-1)]).toEqual([
    `Date,Revenue,Gross,Op Inc,Net Inc,EPS,Cur,${IDENTITY}`,
    "2024-12-31,189471000000,,,45818000000,26.179,ZAR,SBK.JO,ZAR,annual,Gloom Cloud,2025-12-31",
    "2025-12-31,202080000000,,,51215000000,29.876,ZAR,SBK.JO,ZAR,annual,Gloom Cloud,2025-12-31",
    "",
    "# Source: Gloom Cloud · Wed 31 Dec 2025 · not a live feed (financial statements)",
    "# Publisher: not published",
    "# Observation date: 2025-12-31",
    "# Publication time: not published",
    // The years served are the ones it says it has: this report holds two, from 2024, and the line takes the year from them.
    // GF's extended history holds the same two years, so the report points nowhere further.
    "# note: annual history from 2024; older years not available for this listing",
  ]);
  expect(statements.at(-2)).toStartWith("# Retrieval time: ");
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
  // GME as Gloom Cloud serves it: the share count of its 10-Q cover with the day it was counted, the source's
  // undated float held within it, the 30 September settlement's shares short and days to cover. The text view used to leave these
  // out, so scripts read the JSON alone; an undated 449.1M read as current when the 10-Q stated 504.5M.
  const gme: TickerFinancials = {
    quote: { symbol: "GME", name: "GameStop Corp.", price: 29.84, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2026-10-14T13:00:00Z") },
    fundamentals: {
      sharesOutstanding: 504_500_990, sharesOutstandingAsOf: "2026-09-03", floatShares: 461_240_030,
      sharesShort: 42_673_721, shortPercentOfFloat: 42_673_721 / 461_240_030, shortRatio: 3.98, shortInterestDate: "2026-09-30",
    },
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
  };
  const text = (await run("fundamentals", [], "text", gme)).join("\n").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  expect(text).toContain("Shares Outstanding 504.5M (as of 2026-09-03)\nFloat 461.24M\nShort Interest 42.67M (settled 2026-09-30)\nShort % of Float 9.25%\nDays to Cover 3.98\n");
  const json = JSON.parse((await run("fundamentals", [], "json", gme)).join("\n"));
  expect(json.data.fundamentals).toMatchObject({
    sharesOutstandingAsOf: "2026-09-03", floatShares: 461_240_030, sharesShort: 42_673_721, shortRatio: 3.98, shortInterestDate: "2026-09-30",
  });
  expect(await run("fundamentals", [], "csv", gme)).toEqual(expect.arrayContaining([
    expect.stringMatching(/^Shares Outstanding As Of,2026-09-03,GME,/),
    expect.stringMatching(/^Short Interest \(shares\),42673721,GME,/),
    expect.stringMatching(/^Short Interest Settlement,2026-09-30,GME,/),
    expect.stringMatching(/^Days to Cover,3.98,GME,/),
  ]));
})

test("a fund's trailing yield in fundamentals, the overview and DIV% is the one DVD measures from the same cash history and price", async () => {
  // Fundamentals and the overview's TTM Div Yld showed the trailing yield Gloom Cloud serves (HYD 4.62%) beside
  // DVD's 4.55%. Each now reads the history through trailingDividendYield (listingDividendYield). A quarterly payer whose latest ex-date came a week earlier in the year than
  // last year's: DVD counts four quarters, where a plain twelve-month window would count five.
  const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const actions = {
    symbol: "FUND", currency: "USD", coverage: { dividends: "available" as const },
    dividends: [2, 93, 184, 275, 360, 451, 542, 633, 724].map((daysAgo) => ({ exDate: day(daysAgo), amount: 0.25 })),
    splits: [], earnings: [],
  };
  const quote = { symbol: "FUND", name: "Fund", price: 50, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() - 60_000 };
  const fund: TickerFinancials = {
    quote, fundamentals: { dividendYield: 0.0462, dividendYieldBasis: "trailing" }, annualStatements: [], quarterlyStatements: [], priceHistory: [],
  };
  const dvd = await fetchProviderDividendData(createTestDataProvider({ getCorporateActions: async () => actions, getQuote: async () => quote }), "FUND", null);
  expect(dvd.metrics.trailingYield).toBe(0.02);

  const fundamentals = async (format: CliOutputFormat) => {
    const cli = createTestCliContext({ dataProvider: { getTickerFinancials: async () => fund, getCorporateActions: async () => actions } }, { format });
    await marketDataCliCommands.find((entry) => entry.name === "fundamentals")!.execute(["FUND"], cli.context);
    return serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format }, cli.printed[0]!.options);
  };
  expect(JSON.parse(await fundamentals("json")).data.fundamentals.dividendYield).toBe(dvd.metrics.trailingYield!);
  expect((await fundamentals("text")).replace(/\u001b\[[0-9;]*m/g, "")).toMatch(/Dividend Yield \(trailing\)\s+2\.00% \(last 12 months of distributions\)/);

  // The overview and DIV% show Gloom Cloud's until the history is read, never holding the figure back.
  const overview = (history: typeof actions | null) => buildOverviewStats({ quote, fundamentals: fund.fundamentals, quoteCurrency: "USD",
    baseCurrency: "USD", toBase: (value) => value, dividend: { pending: false, lapse: null, actions: history } })
    .find((stat) => stat.label === "TTM Div Yld")?.value;
  expect([overview(actions), overview(null)]).toEqual(["2.00%", "4.62%"]);
  const divColumn = (history: Map<string, typeof actions> | undefined) => getColumnValue({ id: "dividend_yield", label: "DIV%", width: 7, align: "right" },
    createTestTicker("FUND", "Fund"), fund, { baseCurrency: "USD", exchangeRates: new Map(), now: Date.now(), corporateActions: history }).text;
  expect([divColumn(new Map([["FUND", actions]])), divColumn(new Map())]).toEqual(["2.00%", "4.62%"]);
});

// `valuation NEE FSLR` said "Not a ticker: NEE FSLR", with no word of the function that compares them.
test("valuation given several symbols points at RV, which compares them; a company's name is still a name", async () => {
  const cli = createTestCliContext({ dataProvider: { getTickerFinancials: async () => FINANCIALS } });
  const valuation = marketDataCliCommands.find((entry) => entry.name === "valuation")!;
  for (const args of [["NEE", "FSLR"], ["NEE FSLR"], ["NEE,FSLR"]]) {
    await expect(valuation.execute(args, cli.context)).rejects.toThrow("valuation takes one symbol; got NEE FSLR.");
  }
  expect(comparedSymbols(["NEE,FSLR"])).toEqual(["NEE", "FSLR"]);
  expect(comparedSymbols(["Bank of America"])).toBeNull();
  expect(comparedSymbols(["BP:LSE"])).toBeNull();
});
