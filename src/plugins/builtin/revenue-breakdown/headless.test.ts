import { expect, test } from "bun:test";
import type { RevenueBreakdownPayload } from "../../../api-client/revenue-breakdown";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { renderReportCsv, renderReportNdjson } from "../../../cli/report-tables";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { revenueBreakdownHeadless } from "./headless";

const payload: RevenueBreakdownPayload = {
  symbol: "CORZ", cik: "0001839341", currency: "USD", view: "product", views: ["product", "segment"],
  periods: [{ end: "2024-03-31", fiscalYear: 2024, fiscalQuarter: 1 }, { end: "2024-06-30", fiscalYear: 2024, fiscalQuarter: 2 }],
  total: [179_300_000, 141_100_000],
  rows: [
    { key: "p:colo", label: "Colocation revenue", values: [0, 5_520_000], ttm: 95_360_000, yoy: null, share: 0.039 },
    { key: "p:mining", label: "Digital asset self-mining", values: [179_300_000, 135_580_000], ttm: 400_000_000, yoy: -0.21, share: 0.961 },
  ],
  filed: "2024-08-07", access: "full", lockedRows: 0,
};

// What JSON, CSV and NDJSON wrote before the text report took one scale per table, byte for byte.
const JSON_BEFORE = "{\"errors\":[],\"metadata\":{\"symbol\":\"CORZ\",\"cik\":\"0001839341\",\"currency\":\"USD\",\"filed\":\"2024-08-07\",\"views\":[\"product\",\"segment\"]},\"sections\":[{\"title\":\"Quarterly revenue by product\",\"columns\":[{\"key\":\"product\",\"header\":\"Product\"},{\"key\":\"Q1 2024\",\"header\":\"Q1 2024\",\"align\":\"right\"},{\"key\":\"Q2 2024\",\"header\":\"Q2 2024\",\"align\":\"right\"},{\"key\":\"ttm\",\"header\":\"TTM\",\"align\":\"right\"},{\"key\":\"share\",\"header\":\"Share\",\"align\":\"right\"},{\"key\":\"yoy\",\"header\":\"YoY\",\"align\":\"right\"}],\"rows\":[{\"product\":\"Colocation revenue\",\"Q1 2024\":0,\"Q2 2024\":5520000,\"ttm\":95360000,\"share\":0.039,\"yoy\":null},{\"product\":\"Digital asset self-mining\",\"Q1 2024\":179300000,\"Q2 2024\":135580000,\"ttm\":400000000,\"share\":0.961,\"yoy\":-0.21}]},{\"title\":\"Total revenue\",\"columns\":[{\"key\":\"quarter\",\"header\":\"Quarter\"},{\"key\":\"end\",\"header\":\"End\"},{\"key\":\"revenue\",\"header\":\"Revenue\",\"align\":\"right\"}],\"rows\":[{\"quarter\":\"Q1 2024\",\"end\":\"2024-03-31\",\"revenue\":179300000},{\"quarter\":\"Q2 2024\",\"end\":\"2024-06-30\",\"revenue\":141100000}]}]}";
const CSV_BEFORE = `# section: Quarterly revenue by product
Product,Q1 2024,Q2 2024,TTM,Share,YoY,symbol_or_series,currency_or_unit,interval,source,as_of
Colocation revenue,0,5520000,95360000,0.039,,CORZ,,,SEC EDGAR,
Digital asset self-mining,179300000,135580000,400000000,0.961,-0.21,CORZ,,,SEC EDGAR,

# section: Total revenue
Quarter,End,Revenue,symbol_or_series,currency_or_unit,interval,source,as_of
Q1 2024,2024-03-31,179300000,CORZ,,,SEC EDGAR,
Q2 2024,2024-06-30,141100000,CORZ,,,SEC EDGAR,

# Source: SEC EDGAR · retrieved Sat 10 Aug 2024 12:00 UTC · not a live feed (10-Q and 10-K filings)
# Publisher: not published
# Observation date: not published
# Publication time: not published
# Retrieval time: 2024-08-10T12:00:00.000Z`;
const NDJSON_BEFORE = `{"section":"Quarterly revenue by product","Product":"Colocation revenue","Q1 2024":0,"Q2 2024":5520000,"TTM":95360000,"Share":0.039,"YoY":null,"symbol_or_series":"CORZ","currency_or_unit":null,"interval":null,"source":"SEC EDGAR","as_of":null}
{"section":"Quarterly revenue by product","Product":"Digital asset self-mining","Q1 2024":179300000,"Q2 2024":135580000,"TTM":400000000,"Share":0.961,"YoY":-0.21,"symbol_or_series":"CORZ","currency_or_unit":null,"interval":null,"source":"SEC EDGAR","as_of":null}
{"section":"Total revenue","Quarter":"Q1 2024","End":"2024-03-31","Revenue":179300000,"symbol_or_series":"CORZ","currency_or_unit":null,"interval":null,"source":"SEC EDGAR","as_of":null}
{"section":"Total revenue","Quarter":"Q2 2024","End":"2024-06-30","Revenue":141100000,"symbol_or_series":"CORZ","currency_or_unit":null,"interval":null,"source":"SEC EDGAR","as_of":null}`;

test("the text report names each table's scale in its heading; JSON, CSV and NDJSON keep the section names and whole numbers", async () => {
  const NOW = Date.parse("2024-08-10T12:00:00Z");
  const args = createTestHeadlessArgs({ symbols: ["CORZ"], argument: "CORZ", rawArgument: "CORZ", options: {} });
  const result = await revenueBreakdownHeadless.load(args, createTestHeadlessContext({
    apiClient: { getCloudRevenueBreakdown: async () => payload } as never,
  }));
  const freshness = deriveHeadlessFreshness(revenueBreakdownHeadless, result, NOW);
  const tables = headlessReportTables(revenueBreakdownHeadless, result, args, "SEG", freshness, { complete: true, unavailableSymbols: [] });
  expect(JSON.stringify(serializeHeadlessPaneResult(revenueBreakdownHeadless, result))).toBe(JSON_BEFORE);
  expect(renderReportCsv(tables, freshness)).toBe(CSV_BEFORE);
  expect(renderReportNdjson(tables, freshness)).toBe(NDJSON_BEFORE);

  setCliColorEnabledOverride(false);
  try {
    const text = renderHeadlessPaneText(revenueBreakdownHeadless, result, args, "SEG", freshness);
    expect(text).toContain("Quarterly revenue by product, USD millions");
    expect(text).toContain("Total revenue, USD millions");
    expect(text).toMatch(/Colocation revenue +0\.0 +5\.5 +95\.4/);
  } finally {
    setCliColorEnabledOverride(null);
  }
});
