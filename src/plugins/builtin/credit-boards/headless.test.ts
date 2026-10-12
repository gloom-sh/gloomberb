import { expect, test } from "bun:test";
import type { CdxBoardIndex, CdxBoardPayload } from "../../../api-client/credit-boards";
import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneLoadArgs, HeadlessPaneRow } from "../../../types/plugin";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { cdxHeadless } from "./headless";

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
