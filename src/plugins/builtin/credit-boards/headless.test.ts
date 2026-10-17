import { expect, test } from "bun:test";
import type { CdxBoardIndex, CdxBoardPayload, SovrBoardPayload, SovrBoardSovereign } from "../../../api-client/credit-boards";
import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneLoadArgs, HeadlessPaneRow } from "../../../types/plugin";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { cdxHeadless, sovrHeadless } from "./headless";
import { findIndex, findSovereign } from "./model";

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
