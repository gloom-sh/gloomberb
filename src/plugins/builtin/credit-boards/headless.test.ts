import { expect, test } from "bun:test";
import type { CdxBoardIndex, CdxBoardPayload, SovrBoardPayload, SovrBoardSovereign } from "../../../api-client/credit-boards";
import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneLoadArgs, HeadlessPaneRow } from "../../../types/plugin";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { cdxHeadless, sovrHeadless } from "./headless";
import { cdxDay, findIndex, findSovereign } from "./model";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

function index(id: string, name: string, quote: CdxBoardIndex["quote"], level: number, change1D: number, change1W: number): CdxBoardIndex {
  return {
    id, name, quote, currency: "USD", couponBp: 100, date: "2026-10-09", maturity: "2031-12-20", level, prints: 200, change1D, change1W,
    points: [{ date: "2026-10-08", maturity: "2031-12-20", level: level - change1D, prints: 180 }, { date: "2026-10-09", maturity: "2031-12-20", level, prints: 200 }],
  } as CdxBoardIndex;
}

const payload: CdxBoardPayload = {
  source: "DTCC PPD",
  asOf: "2026-10-10T00:00:00.000Z",
  tenor: "5Y",
  indexes: [index("IG", "CDX IG", "spread", 58.3, -0.73, -1.41), index("HY", "CDX HY", "price", 106.695, 0.174, 0.17)],
};

test("CDX levels and moves are numbers with their unit beside them: text draws them as the board does, CSV names each unit", async () => {
  const context = { apiClient: { getCloudCdxBoard: async () => payload } } as unknown as HeadlessPaneContext;
  const result = await cdxHeadless.load(args, context) as HeadlessBundleResult;
  const rows = (result.sections[0] as { rows: HeadlessPaneRow[] }).rows;
  expect(rows.map(({ name, level, unit, change1D, change1W, changeUnit }) => ({ name, level, unit, change1D, change1W, changeUnit }))).toEqual([
    { name: "CDX IG", level: 58.3, unit: "bp", change1D: -0.73, change1W: -1.41, changeUnit: "bp" },
    { name: "CDX HY", level: 106.695, unit: "price", change1D: 0.174, change1W: 0.17, changeUnit: "pts" },
  ]);

  const text = renderHeadlessPaneText(cdxHeadless, result, args, "CDX").split("\n");
  expect(text.find((line) => line.startsWith("CDX IG"))).toMatch(/58\.3bp\s+-0\.7bp\s+-1\.4bp/);
  expect(text.find((line) => line.startsWith("CDX HY"))).toMatch(/106\.69\s+\+0\.17\s+\+0\.17/);

  const freshness = deriveHeadlessFreshness(cdxHeadless, result);
  const csv = renderReportCsv(headlessReportTables(cdxHeadless, result, args, "CDX", freshness, { complete: true, unavailableSymbols: [] })).split("\n");
  expect(csv.slice(0, 3).map((line) => line.split(",").slice(0, 7).join(","))).toEqual([
    "Index,5Y,5Y unit,1D,1D unit,1W,1W unit",
    "CDX IG,58.3,bp,-0.73,bp,-1.41,bp",
    "CDX HY,106.695,price,0.174,pts,0.17,pts",
  ]);
  expect(csv).toContain("# Publisher: DTCC Public Price Dissemination");
  expect(csv).toContain("# Observation date: 2026-10-09");
  // A server that predates the spread equivalent sends none, and the report draws no column of blanks for it.
  expect(csv[0]).not.toContain("Spread eq");
});

/** A CSV line's cells, without the quoting of one that holds a comma. */
const cells = (line: string) => line.match(/("[^"]*"|[^,]*)(,|$)/g)!.map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, "")).slice(0, -1);

test("every exported board row carries its own observation date, series and unit, and a rounded 1Y rank", async () => {
  // HY's level is from Friday and its rank a midrank fraction; Main has printed this morning.
  const hy = { ...payload.indexes[1]!, date: "2026-10-16", level: 106.005, prints: 572, spreadBp: 357.5, recovery: 0.3, partial: false, lastPrintAt: "2026-10-16T20:58:02.000Z", changeDate: "2026-10-16",
    points: Array.from({ length: 250 }, (_, day) => ({ date: new Date(Date.UTC(2025, 11, 1) + day * 86_400_000).toISOString().slice(0, 10), maturity: "2031-12-20", level: 100 + day / 25, prints: 300, spreadBp: 400 - day / 2 })) };
  hy.points.push({ date: "2026-10-16", maturity: "2031-12-20", level: 106.005, prints: 572, spreadBp: 357.5 });
  const main: CdxBoardIndex = { ...index("MAIN", "iTraxx Main", "spread", 64.7, -1.1, 0.17), currency: "EUR", date: "2026-10-19", prints: 38,
    partial: true, lastPrintAt: "2026-10-19T08:09:41.000Z", changeDate: "2026-10-16", recovery: 0.4,
    points: [{ date: "2026-10-15", maturity: "2031-12-20", level: 64.38, prints: 330 }, { date: "2026-10-16", maturity: "2031-12-20", level: 63.28, prints: 261 },
      { date: "2026-10-19", maturity: "2031-12-20", level: 64.7, prints: 38 }] };
  const board = { ...payload, asOf: "2026-10-19T08:11:00.000Z", indexes: [hy, main] };
  const context = { apiClient: { getCloudCdxBoard: async () => board } } as unknown as HeadlessPaneContext;
  const result = await cdxHeadless.load(args, context) as HeadlessBundleResult;
  const freshness = deriveHeadlessFreshness(cdxHeadless, result);
  const csv = renderReportCsv(headlessReportTables(cdxHeadless, result, args, "CDX", freshness, { complete: true, unavailableSymbols: [] }), freshness).split("\n");
  const header = cells(csv[0]!);
  const row = (line: string) => Object.fromEntries(cells(line).map((cell, column) => [header[column], cell]));
  expect(row(csv[1]!)["Pctl 1Y"]).toMatch(/^\d{1,3}$/);
  expect(row(csv[1]!)).toMatchObject({ Index: "CDX HY", "5Y": "106.005", "Spread eq (bp)": "357.5", "As of": "2026-10-16", Day: "",
    symbol_or_series: "cdx:hy", currency_or_unit: "price", interval: "daily", as_of: "2026-10-16" });
  // Main is so far: flagged with its prints and last print, its 1D Friday against Thursday, dated by its own day.
  expect(row(csv[2]!)).toMatchObject({ Index: "iTraxx Main", "1D": "-1.1", "Spread eq (bp)": "", Day: "so far, 38 prints, last 08:09 UTC",
    symbol_or_series: "cdx:main", currency_or_unit: "bp", as_of: "2026-10-19" });
  expect(csv).toContain("# note: Today's New York trade date is still trading: its level and prints are so far, and 1D, 1W and 1M run to the last complete day.");

  const text = renderHeadlessPaneText(cdxHeadless, result, args, "CDX").split("\n");
  expect(text.find((line) => line.startsWith("CDX HY"))).toMatch(/^CDX HY\s+106\.00\s.*357\.5bp\s+\d+\s/);
  expect(text.find((line) => line.startsWith("iTraxx Main"))).toMatch(/64\.7bp\s+-1\.1bp.*2026-10-19\s+so far, 38 prints, last 08:09 UTC$/);

  // The named index's history dates each row by its day and flags only today's.
  const named = await cdxHeadless.load({ ...args, rawArgument: "main", argument: "main" }, context) as HeadlessBundleResult;
  const history = renderReportCsv(headlessReportTables(cdxHeadless, named, args, "CDX", freshness, { complete: true, unavailableSymbols: [] }), freshness)
    .split("# section: ")[2]!.split("\n");
  expect(history.slice(1, 4)).toEqual([
    "Date,Spread (bp),Prints,Contract,Day,status,symbol_or_series,currency_or_unit,interval,source,as_of",
    "2026-10-19,64.7,38,2031-12-20,\"so far, 38 prints, last 08:09 UTC\",,cdx:main,bp,daily,DTCC,2026-10-19",
    "2026-10-16,63.28,261,2031-12-20,,,cdx:main,bp,daily,DTCC,2026-10-16",
  ]);
});

test("a server that does not flag the day: today's New York trade date is partial and its moves are measured between complete days", () => {
  const main: CdxBoardIndex = { ...index("MAIN", "iTraxx Main", "spread", 64.7, 1.42, 1.59), date: "2026-10-19", prints: 38,
    points: [
      { date: "2026-10-08", maturity: "2031-12-20", level: 64.5, prints: 388 },
      { date: "2026-10-09", maturity: "2031-12-20", level: 63.11, prints: 190 },
      { date: "2026-09-15", maturity: "2031-06-20", level: 59.9, prints: 300 },
      { date: "2026-10-15", maturity: "2031-12-20", level: 64.38, prints: 330 },
      { date: "2026-10-16", maturity: "2031-12-20", level: 63.28, prints: 261 },
      { date: "2026-10-19", maturity: "2031-12-20", level: 64.7, prints: 38 },
    ].sort((a, b) => a.date.localeCompare(b.date)) };
  // 08:11 UTC Monday is 04:11 Monday in New York.
  const monday = cdxDay(main, Date.parse("2026-10-19T08:11:00Z"));
  expect(monday).toMatchObject({ partial: true, lastPrintAt: null, changeDate: "2026-10-16" });
  expect(monday.change1D).toBeCloseTo(63.28 - 64.38, 6);
  expect(monday.change1W).toBeCloseTo(63.28 - 63.11, 6);
  // A month back was the contract before the roll: no move from these points alone.
  expect(monday.change1M).toBeNull();
  // Once New York's date has turned, the day is complete and the served moves stand.
  expect(cdxDay(main, Date.parse("2026-10-20T05:00:00Z"))).toMatchObject({ partial: false, changeDate: "2026-10-19", change1D: 1.42 });
});

test("a server that does not flag the day: Asia's prints, dated New York's tomorrow, are partial too", () => {
  // Tue 01:00 UTC is Mon 21:00 in New York; Tokyo's first four prints are dated Tuesday, and the server's 1D is theirs.
  const main: CdxBoardIndex = { ...index("MAIN", "iTraxx Main", "spread", 66.9, 2.2, 3.62), date: "2026-10-20", prints: 4,
    points: [
      { date: "2026-10-15", maturity: "2031-12-20", level: 64.38, prints: 330 },
      { date: "2026-10-16", maturity: "2031-12-20", level: 63.28, prints: 261 },
      { date: "2026-10-19", maturity: "2031-12-20", level: 64.7, prints: 290 },
      { date: "2026-10-20", maturity: "2031-12-20", level: 66.9, prints: 4 },
    ] };
  const tuesday = cdxDay(main, Date.parse("2026-10-20T01:00:00Z"));
  expect(tuesday).toMatchObject({ partial: true, changeDate: "2026-10-19" });
  // Monday against Friday, not Tuesday's four prints against Monday.
  expect(tuesday.change1D).toBeCloseTo(64.7 - 63.28, 6);
});

test("a named index adds its daily levels newest first, which do not date the board", async () => {
  const hy = payload.indexes[1]!;
  const history = { ...payload, indexes: [payload.indexes[0]!, { ...hy, points: [{ ...hy.points[0]!, date: "2026-08-03" }, ...hy.points] }] };
  const context = { apiClient: { getCloudCdxBoard: async () => history } } as unknown as HeadlessPaneContext;
  const named = { ...args, rawArgument: "cdx hy", argument: "cdx hy" };
  const result = await cdxHeadless.load(named, context) as HeadlessBundleResult;
  expect(result.sections.map((section) => "rows" in section ? section.rows?.length : 0)).toEqual([1, 3]);
  expect((result.sections[1] as { rows: HeadlessPaneRow[] }).rows.map((row) => row.day)).toEqual(["2026-10-09", "2026-10-08", "2026-08-03"]);
  const freshness = deriveHeadlessFreshness(cdxHeadless, result);
  expect([freshness.asOf, freshness.oldest]).toEqual(["2026-10-09", undefined]);
  await expect(cdxHeadless.load({ ...args, rawArgument: "itraxx", argument: "itraxx" }, context)).rejects.toThrow("Use one of: IG, HY.");
});

const sovereign = (id: string, name: string, currency: string, level: number): SovrBoardSovereign => ({
  id, name, currency, date: "2026-10-09", maturity: "2031-12-20", level, prints: 40, reported: 30, change1W: 1, change1M: 2,
  points: [{ date: "2026-10-09", maturity: "2031-12-20", level, prints: 40 }],
});

const sovrPayload: SovrBoardPayload = {
  source: "DTCC PPD",
  asOf: "2026-10-10T00:00:00.000Z",
  tenor: "5Y",
  sovereigns: [sovereign("BR", "Brazil", "BRL", 119.7), sovereign("CI", "Ivory Coast", "XOF", 246.7), sovereign("ZA", "South Africa", "ZAR", 132.5)],
};

test("an index or a country is named by its code or name in any case, the same way for fn and for the board that opens on it", () => {
  const indexes = [...payload.indexes, index("MAIN", "iTraxx Main", "spread", 63, 0, 0), index("XOVER", "iTraxx Crossover", "spread", 312, 0, 0)];
  expect(["ig", "CDX hy", "itraxx-main", "MAIN", "Crossover", "xover", "itraxx", ""].map((query) => findIndex(indexes, query)?.id ?? null))
    .toEqual(["IG", "HY", "MAIN", "MAIN", "XOVER", "XOVER", null, null]);
  // A country is its whole name or its code; a last word could be another country's.
  expect(["brazil", "BR", " ivory-coast ", "IVORY COAST", "south africa", "africa", "Narnia", ""]
    .map((query) => findSovereign(sovrPayload.sovereigns, query)?.id ?? null))
    .toEqual(["BR", "BR", "CI", "CI", "ZA", null, null, null]);
});

test("every SOVR export row names its series, unit and own date", async () => {
  const dated = { ...sovrPayload, sovereigns: [sovereign("BR", "Brazil", "BRL", 119.7), { ...sovereign("EG", "Egypt", "EGP", 322.8), date: "2026-10-02" }] };
  const context = {
    apiClient: { getCloudSovrBoard: async () => dated },
    marketData: { getPriceHistory: async () => [] },
  } as unknown as HeadlessPaneContext;
  const result = await sovrHeadless.load(args, context);
  const freshness = deriveHeadlessFreshness(sovrHeadless, result);
  const csv = renderReportCsv(headlessReportTables(sovrHeadless, result, args, "SOVR", freshness, { complete: true, unavailableSymbols: [] }), freshness).split("\n");
  expect(csv[1]!.split(",").slice(-5)).toEqual(["sovereign-cds:br", "bp", "daily", "DTCC", "2026-10-09"]);
  expect(csv[2]!.split(",").slice(-5)).toEqual(["sovereign-cds:eg", "bp", "daily", "DTCC", "2026-10-02"]);
});

test("a level that is the day's settlement price is marked in its own column, which a report without one leaves out", async () => {
  const context = (board: SovrBoardPayload) => ({
    apiClient: { getCloudSovrBoard: async () => board },
    marketData: { getPriceHistory: async () => [] },
  }) as unknown as HeadlessPaneContext;
  const csvOf = async (board: SovrBoardPayload) => {
    const result = await sovrHeadless.load(args, context(board));
    const freshness = deriveHeadlessFreshness(sovrHeadless, result);
    return renderReportCsv(headlessReportTables(sovrHeadless, result, args, "SOVR", freshness, { complete: true, unavailableSymbols: [] }), freshness).split("\n");
  };
  expect((await csvOf(sovrPayload))[0]).not.toContain("Level");

  const settled = { ...sovrPayload, sovereigns: [{ ...sovereign("AR", "Argentina", "ARS", 640.2), prints: 0, reported: 0, kind: "settlement" as const }, sovereign("BR", "Brazil", "BRL", 119.7)] };
  const result = await sovrHeadless.load(args, context(settled));
  expect((result as { rows: HeadlessPaneRow[] }).rows.map((row) => row.kind)).toEqual(["settlement", "traded"]);
  const csv = await csvOf(settled);
  const header = cells(csv[0]!);
  const level = header.indexOf("Level");
  expect(level).toBeGreaterThan(0);
  expect([cells(csv[1]!)[level], cells(csv[2]!)[level]]).toEqual(["settlement", ""]);
});

test("SOVR lists one country's row when a country is named, and says which countries it has when it is not one", async () => {
  const context = {
    apiClient: { getCloudSovrBoard: async () => sovrPayload },
    marketData: { getPriceHistory: async () => [] },
  } as unknown as HeadlessPaneContext;
  const names = async (argument: string | null) => {
    const result = await sovrHeadless.load({ ...args, rawArgument: argument ?? "", argument }, context);
    return (result as { rows: HeadlessPaneRow[] }).rows.map((row) => row.name);
  };
  expect(await names(null)).toEqual(["Brazil", "Ivory Coast", "South Africa"]);
  expect(await names("ivory coast")).toEqual(["Ivory Coast"]);
  expect(await names("za")).toEqual(["South Africa"]);
  await expect(names("Narnia")).rejects.toThrow("No sovereign Narnia. Use one of: Brazil, Ivory Coast, South Africa.");
});
