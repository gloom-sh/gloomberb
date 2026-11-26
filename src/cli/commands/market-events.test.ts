import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { createTestCliContext } from "../../test-support/cli-context";
import { serializeCliResult } from "../result";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { formatFreshnessLine } from "../pane-functions/freshness";
import type { EarningsEvent } from "../../types/data-provider";
import type { CorporateActionsData, EarningsAction } from "../../types/financials";
import { marketDataCliCommands } from "./market";

const events = marketDataCliCommands.find((command) => command.name === "events")!;
const calendar = marketDataCliCommands.find((command) => command.name === "earnings")!;

// The next report below is on 2 Nov 2026: read it on a fixed day before that, so it stays upcoming.
beforeAll(() => { setSystemTime(new Date("2026-10-15T12:00:00Z")); });
afterAll(() => { setSystemTime(); });

async function eventRows(earnings: unknown[], actions: { dividends?: unknown[]; splits?: unknown[]; demergers?: unknown[] } = {}) {
  const run = createTestCliContext({
    dataProvider: {
      getCorporateActions: async () => ({ symbol: "PLTR", currency: "USD", dividends: [], splits: [], earnings, ...actions }),
      getQuote: async () => ({ symbol: "PLTR", price: 200, currency: "USD", name: "Palantir Technologies Inc." }),
    },
  });
  await events.execute(["PLTR:NASDAQ"], run.context);
  const { result, options } = run.printed[0]!;
  return { rows: options!.rows!(result.data) as Array<Record<string, unknown>>, result, options: options! };
}

// PLTR as Gloom Cloud serves it: two adjusted quarters, two GAAP ones, an older one with no basis, and the next report.
const PLTR: EarningsAction[] = [
  { date: "2026-11-02", dateType: "announcement", currency: "USD", fiscalPeriod: "2026-09", epsEstimate: 0.41222, epsAnalysts: 24,
    epsBasis: null, dateStatus: "confirmed" },
  { date: "2026-08-03", dateType: "announcement", currency: "USD", fiscalPeriod: "2026-06", epsEstimate: 0.28, epsActual: 0.31,
    difference: 0.03, surprisePercent: 10.71, epsBasis: "adjusted", dateStatus: "reported" },
  { date: "2026-02-02", dateType: "announcement", currency: "USD", fiscalPeriod: "2025-12", epsEstimate: 0.17, epsActual: 0.24,
    difference: 0.07, surprisePercent: 41.18, epsBasis: "gaap", dateStatus: "reported" },
  { date: "2025-05-05", dateType: "announcement", currency: "USD", epsEstimate: 0.08, epsActual: 0.04,
    difference: -0.04, surprisePercent: -50, epsBasis: null },
];

test("events preserve earnings inputs in NDJSON while formatting known bases, periods and rounded estimates", async () => {
  const { rows, result, options } = await eventRows(PLTR);
  expect(rows.map((row) => row.detail)).toEqual([
    "est $0.41, confirmed, 24 analysts (Sep 2026)",
    "eps $0.31, EPS basis unconfirmed (Jun 2026)",
    "eps $0.24, GAAP (Dec 2025)",
    "eps $0.04",
  ]);
  expect(rows[0]).toMatchObject({ type: "earnings", date: "2026-11-02", epsEstimate: 0.41222, epsAnalysts: 24, dateStatus: "confirmed", fiscalPeriod: "2026-09" });
  // An upcoming estimate no basis was served for carries none.
  const lines = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "ndjson" }, options).split("\n").map((line) => JSON.parse(line));
  expect(lines[0]).not.toHaveProperty("epsBasis");
  expect(lines[0]).toMatchObject({ type: "earnings", date: "2026-11-02", detail: "est $0.41, confirmed, 24 analysts (Sep 2026)" });
  expect(rows[1]).toMatchObject({ epsActual: 0.31, epsEstimate: 0.28, epsBasis: "unknown" });
  expect(rows[3]).toMatchObject({ epsActual: 0.04, epsBasis: "unknown" });
  expect(result.data.earnings[0].epsEstimate).toBe(0.41222);
  expect(result.data.earnings[1]).toMatchObject({ epsActual: 0.31, epsEstimate: 0.28, epsBasis: null, epsComparisonUnconfirmed: true });
  expect(result.data.earnings[1]).not.toHaveProperty("difference");
  const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options);
  expect(csv.split("\n")[0]).toStartWith("Date,Type,Detail,");
  expect(csv.split("\n")[0]).not.toContain("eps");
});

const release: EarningsAction = { ...PLTR[2]!, epsActualSource: "press-release" };
const loss: EarningsAction = { ...release, epsActual: -1.14, epsEstimate: -1.47, difference: 0.33, surprisePercent: -22.45 };

test.each([
  { name: "legacy adjusted label", report: PLTR[1]!, basis: null },
  { name: "GAAP actual only", report: PLTR[2]!, basis: "gaap" },
  { name: "unknown actual basis", report: PLTR[3]!, basis: null },
  { name: "matched release beat", report: release, basis: "gaap", difference: 0.07, percent: 41.18 },
  { name: "matched release miss", report: { ...release, epsActual: 0.1 }, basis: "gaap", difference: -0.07, percent: -41.18 },
  { name: "matched release against loss estimate", report: loss, basis: "gaap", difference: 0.33, notMeaningful: true },
  { name: "unmatched loss estimate", report: { ...loss, epsActualSource: undefined }, basis: "gaap" },
])("earnings and events exports agree for $name", async ({ report, basis, difference, percent, notMeaningful }) => {
  const run = createTestCliContext({ dataProvider: {
    getCorporateActions: async () => ({ symbol: "PLTR", currency: "USD", dividends: [], splits: [], earnings: [report] }),
    getEarningsCalendar: async () => [{ symbol: "PLTR:NASDAQ", name: "Palantir Technologies Inc.", earningsDate: new Date(`${report.date}T20:00:00Z`),
      isDateEstimate: false, epsEstimate: report.epsEstimate ?? null, epsActual: null, surprise: report.surprisePercent ?? null, revenueEstimate: null, revenueActual: null, timing: "AMC" }],
  } });
  await calendar.execute(["PLTR:NASDAQ"], run.context);
  await events.execute(["PLTR:NASDAQ"], run.context);
  const exportRow = (index: number, format: "json" | "ndjson") => {
    const { result, options } = run.printed[index]!;
    return JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format }, options));
  };
  const calendarRow = exportRow(0, "json").data[0];
  const eventsRow = exportRow(1, "json").data.earnings[0];
  const observations = { epsActual: report.epsActual, epsEstimate: report.epsEstimate };
  expect(calendarRow).toMatchObject({ ...observations, epsBasis: basis, surprise: percent ?? null });
  expect(eventsRow).toMatchObject({ ...observations, epsBasis: basis });
  expect(eventsRow.surprisePercent).toBe(percent);
  for (const row of [calendarRow, eventsRow, exportRow(0, "ndjson"), exportRow(1, "ndjson")]) {
    expect(row).toMatchObject(observations);
    expect(row.difference).toBe(difference);
    expect(row.surpriseNotMeaningful).toBe(notMeaningful);
  }
});

async function calendarExport(event: EarningsEvent, getCorporateActions: (symbol: string, exchange: string) => Promise<CorporateActionsData>) {
  const run = createTestCliContext({ dataProvider: { getCorporateActions, getEarningsCalendar: async () => [event] } }, { format: "json" });
  await calendar.execute([event.symbol], run.context);
  const { result, options } = run.printed[0]!;
  return JSON.parse(serializeCliResult(result, run.context.cliOptions, options)).data[0];
}

const dellDate = "2026-11-24";
const dellStreetEps = { actual: 9.16, estimate: 6.55, actualBasis: "including-stock-compensation", analysts: 8 } as const;
const dellFiling: EarningsAction = { date: dellDate, dateType: "announcement", fiscalPeriod: "2026-10", dateStatus: "reported",
  epsActual: 9.45, epsBasis: "company-adjusted", epsActualSource: "filing", currency: "USD", gaapEps: 8.82, streetEps: dellStreetEps };
const dellCalendar: EarningsEvent = { symbol: "DELL:NYSE", name: "Dell Technologies Inc.", earningsDate: new Date(`${dellDate}T21:00:00Z`),
  epsActual: 9.16, epsEstimate: 6.55, epsAnalysts: 8, dateStatus: "reported", timing: "AMC", surprise: 39.85,
  revenueEstimate: null, revenueActual: null, estimateBasis: { epsEstimate: { source: "calendarEvents", sourceValue: 6.55, period: null, periodEndDate: "2026-10-30", currency: "USD" } } };

test.each([
  { name: "a matching exchange", venue: { exchange: "NYSE" } },
  { name: "a matching MIC without an exchange", venue: { micCode: "XNYS" } },
  { name: "no venue metadata", venue: {} },
])("earnings exports the verified filing and separate street pair with $name", async ({ venue }) => {
  const reads: string[][] = [];
  const row = await calendarExport(dellCalendar, async (symbol, exchange) => {
    reads.push([symbol, exchange]);
    return { symbol: "DELL", ...venue, dividends: [], splits: [], earnings: [dellFiling, { date: "2099-02-25", dateStatus: "confirmed" }] };
  });
  expect(reads).toEqual([["DELL:NYSE", "NYSE"]]);
  expect(row).toMatchObject({ symbol: "DELL:NYSE", earningsDate: `${dellDate}T21:00:00.000Z`, dateStatus: "reported",
    epsActual: 9.45, epsBasis: "company-adjusted", gaapEps: 8.82, streetEps: dellStreetEps, epsEstimate: null, epsAnalysts: null, surprise: null });
  expect(row).not.toHaveProperty("difference");
});

test.each([
  { name: "another report date", filing: { ...dellFiling, date: "2026-11-23" } },
  { name: "another fiscal period", filing: { ...dellFiling, fiscalPeriod: "2026-07" } },
  { name: "another currency", filing: { ...dellFiling, currency: "CAD" } },
  { name: "another exchange", filing: dellFiling, venue: { exchange: "NASDAQ" } },
  { name: "another MIC without an exchange", filing: dellFiling, venue: { micCode: "XNAS" } },
  { name: "another MIC with a matching exchange", filing: dellFiling, venue: { exchange: "NYSE", micCode: "XNAS" } },
  { name: "another exchange with a matching MIC", filing: dellFiling, venue: { exchange: "NASDAQ", micCode: "XNYS" } },
  { name: "another exchange with a matching symbol suffix", filing: dellFiling, venue: { symbol: "DELL:NYSE", exchange: "NASDAQ" } },
  { name: "no filing attribution", filing: { ...dellFiling, epsActualSource: undefined } },
  { name: "a failed read", filing: null },
])("earnings keeps the calendar's observations for $name", async ({ filing, venue }) => {
  const row = await calendarExport(dellCalendar, async () => {
    if (!filing) throw new Error("corporate actions unavailable");
    return { symbol: "DELL", ...venue, dividends: [], splits: [], earnings: [filing] };
  });
  expect(row).toMatchObject({ symbol: "DELL:NYSE", epsActual: 9.16, epsEstimate: 6.55, epsAnalysts: 8, surprise: null });
  expect(row).not.toHaveProperty("streetEps");
  expect(row).not.toHaveProperty("gaapEps");
});

test("earnings drops the displaced EPS forecast metadata but keeps same-report revenue", async () => {
  const date = "2026-10-14";
  const basis = { source: "calendarEvents", sourceValue: 1.05, period: null, periodEndDate: "2026-09-30", currency: "USD" } as const;
  const revenueBasis = { ...basis, sourceValue: 500 };
  const row = await calendarExport({ symbol: "PLTR:NASDAQ", name: "Palantir Technologies Inc.", earningsDate: new Date(`${date}T20:00:00Z`),
    dateStatus: "reported", timing: "AMC", epsActual: null, epsEstimate: 1.05, epsAnalysts: 15, epsLow: 0.95, epsHigh: 1.15,
    epsTrend7dAgo: 1.03, epsRevisionUp7d: 3, revenueEstimate: 500, revenueHigh: 550, revenueActual: 520, surprise: null,
    estimateBasis: { epsEstimate: basis, epsAnalysts: basis, epsLow: basis, epsHigh: basis, epsTrend7dAgo: basis, epsRevisionUp7d: basis, revenueEstimate: revenueBasis },
  }, async (symbol) => ({ symbol, dividends: [], splits: [], earnings: [
    { ...release, date, fiscalPeriod: "2026-09", epsActual: 1.1, epsEstimate: 1, epsAnalysts: 8 },
  ] }));
  expect(row).toMatchObject({ epsActual: 1.1, epsEstimate: 1, epsAnalysts: 8, epsBasis: "gaap", difference: 0.1, surprise: 10,
    epsLow: null, epsHigh: null, epsTrend7dAgo: null, epsRevisionUp7d: null, revenueEstimate: 500, revenueHigh: 550, revenueActual: 520 });
  expect(row.estimateBasis).toEqual({ revenueEstimate: revenueBasis });
});

test("events is dated by when it was read: a row's date is when its event happens, so the newest past one is no as-of", async () => {
  const { result } = await eventRows(PLTR);
  expect(result.freshness).toMatchObject({ asOf: null, status: "not-a-feed", basis: "corporate actions" });
  expect(formatFreshnessLine(result.freshness!)).toMatch(/^Source: Gloom Cloud · retrieved \w{3} \d+ \w{3} \d{4} \d{2}:\d{2} UTC · not a live feed \(corporate actions\)$/);
});

// `events CTVA` listed its 6665:1000 of 2026-10-01 as a split, and the VYLR demerger on record beside it would make two rows.
test("a factor on a demerger's ex-date is that spin-off, one row; another in no share terms is a factor; what precedes them is labelled", async () => {
  const vylor = { exDate: "2026-10-01", recordDate: "2026-09-24", business: "seed", ratio: 1,
    successor: { symbol: "VYLR", exchange: "NYSE", name: "Vylor Inc.", listedOn: "2026-10-01" } };
  const factor = { date: "2026-10-01", ratio: 6.665, fromFactor: 1000, toFactor: 6665, description: "6665:1000" };
  const earnings = [
    { date: "2026-11-11", currency: "USD", epsActual: -0.04, epsEstimate: 0.09 },
    { date: "2026-07-30", currency: "USD", epsActual: 0.345086, epsEstimate: 0.336084 },
  ];
  const dividends = [{ exDate: "2026-09-01", amount: 0.027007 }];
  const confirmed = await eventRows(earnings, { dividends, splits: [factor], demergers: [vylor] });
  expect(confirmed.rows.map((row) => `${row.date} ${row.type} ${row.detail}`)).toEqual([
    "2026-11-11 earnings eps -$0.04",
    "2026-10-01 spin-off seed business into VYLR:NYSE (Vylor Inc.), 1 share per share, listed 2026-10-01; price adjustment 6665:1000",
    "2026-09-01 dividend $0.027007, adjusted for the VYLR spin-off of 2026-10-01 (6665:1000)",
    "2026-07-30 earnings eps $0.35, EPS adjusted for the VYLR spin-off of 2026-10-01 (6665:1000)",
  ]);
  // JSON keeps the history's amount: nothing is multiplied back to a paid figure.
  expect(confirmed.result.data.dividends[0]).toEqual({ exDate: "2026-09-01", amount: 0.027007 });
  expect(confirmed.result.data.splits[0]).toMatchObject({ kind: "spin-off adjustment", spinOff: "VYLR" });
  const unclassified = await eventRows(earnings, { dividends, splits: [factor] });
  expect(unclassified.rows.map((row) => `${row.date} ${row.type} ${row.detail}`).slice(1, 3)).toEqual([
    "2026-10-01 adjustment factor 6665:1000, in no share terms",
    "2026-09-01 dividend $0.027007, adjusted by the 6665:1000 factor of 2026-10-01",
  ]);
  expect(unclassified.result.data.splits[0]).toMatchObject({ kind: "adjustment factor" });
});

test("a split the same day as a spin-off stays a split, and figures the company published keep no adjusted label", async () => {
  const vylor = { exDate: "2026-10-01", recordDate: "2026-09-24", business: "seed", ratio: 1,
    successor: { symbol: "VYLR", exchange: "NYSE", name: "Vylor Inc.", listedOn: "2026-10-01" } };
  const splits = [{ date: "2026-10-01", ratio: 6.665, fromFactor: 1000, toFactor: 6665 }, { date: "2026-10-01", ratio: 2, fromFactor: 1, toFactor: 2 }];
  // The release's own EPS and a dividend its forms state are as published, whatever their date.
  const earnings = [{ date: "2026-08-05", currency: "USD", epsActual: 2.3, epsEstimate: 2.25, epsActualSource: "press-release" }];
  const form = { url: "https://example.com/dividend-form.pdf", publishedOn: "2026-08-20" };
  const dividends = [{ exDate: "2026-09-01", amount: 0.18, parts: [{ amount: 0.18, special: false, type: "interim", form }] }];
  const { rows, result } = await eventRows(earnings, { dividends, splits, demergers: [vylor] });
  expect(rows.map((row) => `${row.date} ${row.type} ${row.detail}`)).toEqual([
    "2026-10-01 spin-off seed business into VYLR:NYSE (Vylor Inc.), 1 share per share, listed 2026-10-01; price adjustment 6665:1000",
    "2026-10-01 split 2-for-1",
    "2026-09-01 dividend $0.18",
    "2026-08-05 earnings eps $2.30, provisional",
  ]);
  // JSON keeps every observation as served; only the factor says what it is.
  expect(result.data.dividends).toEqual(dividends);
  expect(result.data.earnings[0]).toMatchObject({ epsActual: 2.3, epsEstimate: 2.25, epsActualSource: "press-release" });
  expect(result.data.splits.map((split: Record<string, unknown>) => split.kind ?? "split")).toEqual(["spin-off adjustment", "split"]);
});
