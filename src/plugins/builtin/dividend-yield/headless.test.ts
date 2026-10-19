import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import type { DividendData } from "./client";
import { createDividendYieldHeadless } from "./headless";
import { headlessReportTables, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";
import { serializeCliResult } from "../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../cli/options";

const fixture: DividendData = {
  price: 200,
  metrics: {
    trailingYield: 0.005,
    forwardYield: 0.0052,
    trailingRate: 1,
    forwardRate: 1.04,
    forwardRateAsOf: "2026-08-10",
    payoutRatio: 0.14,
    growth1Y: 0.04,
    growth3Y: 0.03,
    paymentFrequency: "quarterly",
    lastExDividendDate: new Date("2026-08-10T00:00:00.000Z"),
    nextExDividendDate: null,
    nextPayDate: new Date("2026-08-17T00:00:00.000Z"),
  },
  payments: [
    {
      exDate: new Date("2026-08-10T00:00:00.000Z"),
      recordDate: null,
      paymentDate: null,
      declarationDate: null,
      amount: 0.26,
      currency: "USD",
      type: "cash",
    },
    {
      exDate: new Date("2026-05-11T00:00:00.000Z"),
      recordDate: null,
      paymentDate: null,
      declarationDate: null,
      amount: 0.24,
      currency: "USD",
      type: "special",
    },
  ],
};

function args(options: Record<string, string | number | boolean>): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AAPL",
    argument: "AAPL",
    symbols: ["AAPL"],
    options,
  };
}

const context = {} as HeadlessPaneContext;

describe("dividend yield headless", () => {
  test("maps metrics and payment rows", async () => {
    const definition = createDividendYieldHeadless({
      loadData: async () => fixture,
    });

    const result = await definition.load(args({ type: "all", limit: 40 }), context);

    expect(result.sections[0]).toMatchObject({
      title: "Dividend metrics",
      entries: expect.arrayContaining([
        { label: "Trailing yield", value: 0.005, formatted: "0.50% (last 12 months of distributions)" },
        { label: "Frequency", value: "quarterly" },
      ]),
    });
    expect(result.sections[1]).toMatchObject({
      title: "Dividend history",
      rows: [
        expect.objectContaining({ exDate: "2026-08-10", amount: 0.26, type: "cash" }),
        expect.objectContaining({ exDate: "2026-05-11", amount: 0.24, type: "special" }),
      ],
    });
  });

  test("applies type and limit options", async () => {
    const definition = createDividendYieldHeadless({ loadData: async () => fixture });

    const result = await definition.load(args({ type: "cash", limit: 1 }), context);
    const history = result.sections[1];

    expect(history).toMatchObject({
      rows: [expect.objectContaining({ type: "cash" })],
    });
    expect(result.metadata).toMatchObject({ totalPayments: 1, returnedPayments: 1 });
  });
});


test("cash growth and payout text use percentages while JSON and CSV keep fractional values, to the sixth decimal", async () => {
  for (const [source, growth, formatted] of [[-0.152317880794702, -0.152318, "-15.23%"], [0.11248149975332988, 0.112481, "+11.25%"], [0, 0, "0.00%"], [null, null, "—"]] as const) {
    const data = { ...fixture, metrics: { ...fixture.metrics, payoutRatio: source, growth1Y: source, growth3Y: source } };
    const definition = createDividendYieldHeadless({ loadData: async () => data });
    const request = args({ type: "all", limit: 40 });
    const result = await definition.load(request, context);
    const text = renderHeadlessPaneText(definition, result, request, "DVD");
    const section = result.sections[0]!;
    const entries = section.entries ?? [];
    expect(entries.filter((entry) => entry.label === "1Y Cash Growth" || entry.label === "3Y Cash CAGR")).toEqual([
      { label: "1Y Cash Growth", value: growth, formatted },
      { label: "3Y Cash CAGR", value: growth, formatted },
    ]);
    expect(text).toContain("1Y Cash Growth");
    expect(text).toContain("3Y Cash CAGR");
    expect(text).toContain(formatted);
    // Controlled provider ratio contract; these finite values are not asserted to be live ETF payouts.
    expect(entries.find((entry) => entry.label === "Earnings Payout")).toEqual({ label: "Earnings Payout", value: growth, formatted: formatted.replace(/^\+/, "") });
    const serialized = serializeHeadlessPaneResult(definition, result);
    const json = JSON.parse(serializeCliResult({ data: serialized }, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
    const raw = json.data.sections[0].entries.filter((entry: { label: string }) => ["Earnings Payout", "1Y Cash Growth", "3Y Cash CAGR"].includes(entry.label));
    expect(raw.map((entry: { value: unknown }) => entry.value)).toEqual([growth, growth, growth]);
    // fn CSV retains nested sections as JSON cells; display strings cannot replace numeric values.
    const csv = serializeCliResult({ data: serialized }, { ...DEFAULT_CLI_OPTIONS, format: "csv" });
    expect(csv).toContain(`""label"":""1Y Cash Growth"",""value"":${JSON.stringify(growth)},""formatted"":""${formatted}""`);
    expect(csv).toContain(`""label"":""Earnings Payout"",""value"":${JSON.stringify(growth)}`);
    expect(data.metrics.growth1Y).toBe(source);
  }
});

test("several symbols are one table ranked by trailing yield; a read without its history or summary is marked incomplete, never a non-payer", async () => {
  const withYield = (trailingYield: number | null, extra: Partial<DividendData> = {}): DividendData => ({ ...fixture, ...extra,
    metrics: { ...fixture.metrics, trailingYield, payoutRatio: null, nextPayDate: null,
      ...trailingYield == null ? { forwardYield: null, growth1Y: null, growth3Y: null } : {} } });
  const data: Record<string, DividendData> = {
    // A rand payer beside dollar payers: yields are ratios, so they rank together.
    "SBK.JO": withYield(0.0578, { currency: "ZAR", priceAsOf: "2026-01-16T15:00:00.000Z", declared: [{ exDate: "2030-03-10", amount: 9.5, payDate: "2030-04-01" }] }),
    KO: withYield(0.0223539, { currency: "USD", priceAsOf: "2026-01-16T21:00:00.000Z" }),
    // Rounds to KO's 2.2354% but yields more, so it ranks above KO though typed after it.
    PEP: withYield(0.0223541, { currency: "USD" }),
    NEW: withYield(null, { currency: "USD" }),
    HALF: withYield(null, { currency: "USD", historyError: "Incomplete cash history; totals unavailable." }),
    NOSUM: withYield(0.031, { currency: "USD", summaryError: "Dividend summary unavailable." }),
  };
  const definition = createDividendYieldHeadless({
    loadData: async (symbol) => {
      if (!data[symbol]) throw new Error(`No dividend data found for ${symbol}`);
      return data[symbol]!;
    },
  });
  const symbols = ["NEW", "KO", "GONE", "HALF", "SBK.JO", "NOSUM", "PEP"];
  const request = { rawArgument: symbols.join(" "), argument: symbols, symbols, options: { type: "all", limit: 40 } };
  const result = await definition.load(request, context);
  expect(result.sections).toHaveLength(1);
  const rows = result.sections[0]!.rows!;
  expect(rows.map((row) => row.symbol)).toEqual(["SBK.JO", "NOSUM", "PEP", "KO", "NEW", "HALF", "GONE"]);
  expect(rows[0]).toMatchObject({ trailingYield: 0.0578, payDate: "2030-04-01", payoutRatio: null, note: null });
  expect(result).toMatchObject({ complete: false, unavailableSymbols: ["GONE", "HALF", "NOSUM"] });
  const text = renderHeadlessPaneText(definition, result, request, "DVD");
  const line = (symbol: string) => text.split("\n").find((entry) => entry.startsWith(`${symbol} `))!;
  expect(line("SBK.JO")).toContain("5.78%");
  // A non-payer and a ticker with no history both have no yield; only the second says why.
  expect(line("NEW")).not.toMatch(/\d\.\d\d%|no cash history/);
  expect(line("HALF")).toContain("no cash history");
  expect(line("NOSUM")).toMatch(/3\.10%.*no summary/);
  expect(line("GONE")).toContain("not read");

  // Every exported row names its ticker, the percent its figures are in and the time of the price its yields are over,
  // and the closing lines date the report by the newest of those prices.
  const freshness = deriveHeadlessFreshness(definition, result);
  const csv = renderReportCsv(headlessReportTables(definition, result, request, "DVD", freshness, { complete: false, unavailableSymbols: [] }), freshness)
    .split("\n");
  expect(csv.find((entry) => entry.startsWith("KO,"))).toMatch(/^KO,2\.2354,0\.52,.*,KO,pct,,Gloom Cloud,2026-01-16T21:00:00\.000Z$/);
  expect(csv.find((entry) => entry.startsWith("SBK.JO,"))).toMatch(/,SBK\.JO,pct,,Gloom Cloud,2026-01-16T15:00:00\.000Z$/);
  expect(csv.find((entry) => entry.startsWith("GONE,"))).toMatch(/,GONE,pct,,Gloom Cloud,$/);
  expect(csv).toContain("# Observation date: 2026-01-16T21:00:00.000Z");

  // Options that pick one ticker's history rows are refused for a ranking, before anything is read.
  await expect(definition.load({ ...request, options: { type: "special", limit: 40 } }, context)).rejects.toThrow("--type filters one ticker's payment history");
  await expect(definition.load({ ...request, options: { type: "all", limit: 5 } }, context)).rejects.toThrow("--limit filters");
});
