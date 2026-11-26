import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { createTestCliContext } from "../../test-support/cli-context";
import { serializeCliResult } from "../result";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { formatFreshnessLine } from "../pane-functions/freshness";
import { marketDataCliCommands } from "./market";

const events = marketDataCliCommands.find((command) => command.name === "events")!;

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
const PLTR = [
  { date: "2026-11-02", dateType: "announcement", currency: "USD", fiscalPeriod: "2026-09", epsEstimate: 0.41222, epsAnalysts: 24,
    epsBasis: null, dateStatus: "confirmed" },
  { date: "2026-08-03", dateType: "announcement", currency: "USD", fiscalPeriod: "2026-06", epsEstimate: 0.28, epsActual: 0.31,
    difference: 0.03, epsBasis: "adjusted", dateStatus: "reported" },
  { date: "2026-02-02", dateType: "announcement", currency: "USD", fiscalPeriod: "2025-12", epsEstimate: 0.17, epsActual: 0.24,
    difference: 0.07, epsBasis: "gaap", dateStatus: "reported" },
  { date: "2025-05-05", dateType: "announcement", currency: "USD", epsEstimate: 0.08, epsActual: 0.04, difference: -0.04, epsBasis: null },
];

test("events preserve earnings inputs in NDJSON while formatting known bases, periods and rounded estimates", async () => {
  const { rows, result, options } = await eventRows(PLTR);
  expect(rows.map((row) => row.detail)).toEqual([
    "est $0.41, confirmed, 24 analysts (Sep 2026)",
    "eps $0.31, EPS basis unconfirmed (Jun 2026)",
    "eps $0.24, GAAP, +0.07 vs est (Dec 2025)",
    "eps $0.04, -0.04 vs est",
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
