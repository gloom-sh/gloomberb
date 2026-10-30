import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import type { DividendData } from "./client";
import type { FundBondFacts } from "../../../api-client/fund-facts";
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

  test("a payout over a loss and a yield over a gap in the history say so, in the text, the entries and the ranking", async () => {
    const loss: DividendData = { ...fixture, currency: "USD", priceAsOf: "2026-10-16T20:00:00.000Z",
      metrics: { ...fixture.metrics, payoutRatio: null, payoutNotMeaningful: true, trailingYield: 0.3574,
        trailingPayments: { counted: 9, expected: 12, cadence: "monthly" } } };
    const definition = createDividendYieldHeadless({ loadData: async () => loss });
    const result = await definition.load(args({ type: "all", limit: 40 }), context);
    expect(result.sections[0]).toMatchObject({ entries: expect.arrayContaining([
      { label: "Earnings Payout", value: null, formatted: "N/M" },
      { label: "Trailing yield", value: 0.3574, formatted: "35.74% (last 12 months of distributions; counts 9 of 12 monthly payments)" },
    ]) });
    expect(result.metadata).toMatchObject({ trailingPayments: { counted: 9, expected: 12, cadence: "monthly" } });
    const request: HeadlessPaneLoadArgs = { rawArgument: "ECC, KO", argument: "ECC, KO", symbols: ["ECC", "KO"], options: {} };
    const ranked = createDividendYieldHeadless({ loadData: async (symbol) => symbol === "ECC" ? loss : { ...fixture, currency: "USD" } });
    const text = renderHeadlessPaneText(ranked, await ranked.load(request, context), request, "DVD");
    expect(text).toMatch(/\nECC +35\.74% .* N\/M .*counts 9 of 12 monthly payments/);
    expect(text).toMatch(/\nKO +0\.50% .* 14\.00% /);
    // A count is not an incomplete read: its own field and column, and Note stays empty for a whole read.
    const rows = (await ranked.load(request, context)).sections[0]!.rows!;
    expect(rows.find((row) => row.symbol === "ECC")).toMatchObject({ note: null, yieldBasis: "counts 9 of 12 monthly payments", payoutRatio: null, payoutNotMeaningful: true });
    expect(text).not.toContain("Note");
    const csv = renderReportCsv(headlessReportTables(ranked, await ranked.load(request, context), request, "DVD", deriveHeadlessFreshness(ranked, await ranked.load(request, context)), { complete: true, unavailableSymbols: [] }));
    expect(csv).toContain("Yield basis");
    expect(csv).toMatch(/\nECC,35\.74,[^\n]*,n\/m,[^\n]*,counts 9 of 12 monthly payments/);
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
  // The date column is the next distribution's pay date, beside the last ex-date that has passed.
  expect(text.split("\n").find((entry) => entry.startsWith("Ticker"))).toMatch(/Last ex +Next pay/);

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

describe("a bond fund's yields", () => {
  const ISHARES = { source: "iShares", url: "https://www.ishares.com/us/products/239766/ishares-national-muni-bond-etf" };
  const MUB: FundBondFacts = {
    kind: "municipal", state: null,
    secYield: { value: 4.0418, asOf: "2026-10-15", ...ISHARES },
    yieldToWorst: { value: 4.16, asOf: "2026-10-15", ...ISHARES },
    duration: { value: 7.12591, asOf: "2026-10-15", measure: "effective", ...ISHARES },
  };
  const mubData: DividendData = { ...fixture, price: 102.35,
    metrics: { ...fixture.metrics, trailingYield: 0.0334, forwardYield: 0.0327, forwardRateAsOf: "2026-10-01" } };
  const treasury = [{ tenor: "5Y", years: 5, yield: 4.76, asOf: "2026-10-16" }, { tenor: "7Y", years: 7, yield: 4.98, asOf: "2026-10-16" }];
  const mubArgs: HeadlessPaneLoadArgs = { rawArgument: "MUB", argument: "MUB", symbols: ["MUB"], options: {} };
  const withOptions = (options: Record<string, string>): HeadlessPaneLoadArgs => ({ ...mubArgs, options });
  const report = async (definition: ReturnType<typeof createDividendYieldHeadless>, request: HeadlessPaneLoadArgs = mubArgs) =>
    renderHeadlessPaneText(definition, await definition.load(request, context), request, "DVD");

  test("are distribution yields, not its SEC yield, which follows them dated with its yield to worst and duration", async () => {
    const definition = createDividendYieldHeadless({ loadData: async () => mubData, loadBond: async () => MUB });
    const text = await report(definition);
    expect(text).toContain("Trailing distribution yield (not SEC yield)  3.34% (last 12 months of distributions)");
    expect(text).toContain("Forward distribution yield (not SEC yield)   3.27% (latest distribution annualized, as of 2026-10-01)");
    expect(text).toContain("30-day SEC yield                             4.04% (as of 2026-10-15)");
    expect(text).toContain("Yield to worst                               4.16% (as of 2026-10-15)");
    expect(text).toContain("Effective duration                           7.13 yrs (as of 2026-10-15)");
    expect(text).not.toContain("Tax-equivalent yield");

    // A stock, or a fund with no bond facts, reads as before.
    const stock = await report(createDividendYieldHeadless({ loadData: async () => mubData, loadBond: async () => null }));
    expect(stock).toMatch(/\nTrailing yield +3\.34% \(last 12 months of distributions\)\nForward yield +3\.27% /);
    expect(stock).not.toMatch(/SEC yield|distribution yield/);
  });

  test("--tax-rate adds the tax-equivalent yield and muni/Treasury ratio, which JSON keeps with the formula", async () => {
    const definition = createDividendYieldHeadless({ loadData: async () => mubData, loadBond: async () => MUB, loadTreasury: async () => treasury });
    const request = withOptions({ "tax-rate": "40.8" });
    const result = await definition.load(request, context);
    const text = renderHeadlessPaneText(definition, result, request, "DVD");
    expect(text).toContain([
      "Tax-equivalent yield",
      "Tax rate              40.8% (federal; no state rate given)",
      "Tax-equivalent yield  6.83% (30-day SEC yield 4.04% as of 2026-10-15 / (1 - 40.8%))",
      "Muni/Treasury ratio   81.2% (SEC yield 4.04% / 7Y Treasury 4.98% on 2026-10-16, the tenor nearest its 7.13-year duration)",
    ].join("\n"));
    expect(result.metadata).toMatchObject({
      bondFund: { kind: "municipal", class: "Municipal, national" },
      taxEquivalent: { federalRate: 40.8, combinedRate: 40.8, muniTreasuryRatio: { tenor: "7Y", treasuryYield: 4.98 } },
    });
    expect((result.metadata as { taxEquivalent: { taxEquivalentYield: number } }).taxEquivalent.taxEquivalentYield).toBeCloseTo(6.8274, 4);
  });

  test("--tax-rate refuses a ranking of several tickers and a state rate without its state", async () => {
    const definition = createDividendYieldHeadless({ loadData: async () => mubData, loadBond: async () => MUB, loadTreasury: async () => treasury });
    await expect(definition.load({ rawArgument: "MUB, TFI", argument: "MUB, TFI", symbols: ["MUB", "TFI"], options: { "tax-rate": "40.8" } }, context))
      .rejects.toThrow("--tax-rate reads one fund's yield");
    await expect(definition.load(withOptions({ "tax-rate": "40.8", "state-rate": "13.3" }), context)).rejects.toThrow("--state-rate and --state go together");
  });

  test("a bond facts read that fails leaves the report as it was", async () => {
    const definition = createDividendYieldHeadless({ loadData: async () => mubData, loadBond: async () => { throw new Error("offline"); } });
    expect(await report(definition)).toMatch(/\nForward yield +3\.27% \(latest distribution annualized, as of 2026-10-01\)\n/);
  });

  test("a ranking with a bond fund says its yields are distribution yields and gives each its SEC yield, dated; one without reads as before", async () => {
    const priced = (data: DividendData, trailingYield: number, forwardYield: number): DividendData =>
      ({ ...data, currency: "USD", priceAsOf: "2026-10-16T20:00:00.000Z", metrics: { ...data.metrics, trailingYield, forwardYield } });
    const rows: Record<string, DividendData> = { MUB: priced(mubData, 0.0333561, 0.0327109), KO: priced(fixture, 0.0291, 0.0294) };
    const bonds: Record<string, FundBondFacts | null> = { MUB, KO: null };
    const request: HeadlessPaneLoadArgs = { rawArgument: "MUB, KO", argument: "MUB, KO", symbols: ["MUB", "KO"], options: {} };
    const rank = async (loadBond: (symbol: string) => Promise<FundBondFacts | null>) => {
      const definition = createDividendYieldHeadless({ loadData: async (symbol) => rows[symbol]!, loadBond });
      const result = await definition.load(request, context);
      const freshness = deriveHeadlessFreshness(definition, result);
      return {
        result,
        text: renderHeadlessPaneText(definition, result, request, "DVD"),
        csv: renderReportCsv(headlessReportTables(definition, result, request, "DVD", freshness, { complete: true, unavailableSymbols: [] }), freshness)
          .split("\n"),
      };
    };

    const { result, text, csv } = await rank(async (symbol) => bonds[symbol] ?? null);
    expect(text).toContain("Ranked by trailing yield; payout is over TTM diluted EPS; a bond fund's yields are distribution yields, not SEC yield");
    expect(text).toMatch(/Ticker +Yield TTM +Fwd yield +SEC yield +SEC as of +Payout/);
    expect(text).toMatch(/\nMUB +3\.34% +3\.27% +4\.04% +2026-10-15 /);
    expect(text).toMatch(/\nKO +2\.91% +2\.94% +— +— /);
    // Each row still names its ticker, the percent unit and its price's time; the SEC yield has its own date.
    expect(csv[0]).toStartWith("Ticker,Yield TTM (%),Fwd yield (%),SEC yield (%),SEC as of,Payout (%),");
    expect(csv.find((line) => line.startsWith("MUB,"))).toMatch(/^MUB,3\.3356,3\.2711,4\.0418,2026-10-15,.*,MUB,pct,,Gloom Cloud,2026-10-16T20:00:00\.000Z$/);
    expect(csv.find((line) => line.startsWith("KO,"))).toMatch(/^KO,2\.91,2\.94,,,.*,KO,pct,,Gloom Cloud,2026-10-16T20:00:00\.000Z$/);
    expect(result.metadata).toMatchObject({ secYieldMethod: expect.stringContaining("distribution yields, not SEC yield") });

    // No bond fund ranked, or its facts not read: the ranking as before, with no SEC columns or fields.
    const plain = await rank(async () => null);
    const failed = await rank(async () => { throw new Error("offline"); });
    expect(failed.text).toBe(plain.text);
    expect(plain.text).toMatch(/Ticker +Yield TTM +Fwd yield +Payout/);
    expect(plain.text).not.toMatch(/SEC|distribution yields/);
    expect(JSON.stringify(plain.result)).not.toMatch(/secYield/);
  });
});
