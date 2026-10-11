import { expect, test } from "bun:test";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { ExposureExtensionObservation, ExposurePayload, ExposureRequest } from "../../../api-client/exposure";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import type { HeadlessBundleResult } from "../../../types/headless";
import { createTestTicker } from "../../../test-support/ticker";
import { exposureHeadless } from "./headless";
import { DEFAULT_SCENARIO } from "./model";
import audited from "./fixtures/taiwan.fixture.json";
import drivers from "./fixtures/drivers.fixture.json";

function context(requests: ExposureRequest[], payload = audited as ExposurePayload) {
  return createTestHeadlessContext({ apiClient: {
    getCloudExposureScenarios: async () => ({ scenarios: [DEFAULT_SCENARIO] }),
    analyzeCloudExposure: async (request: ExposureRequest) => { requests.push(request); return structuredClone(payload); },
  } as ReturnType<typeof createTestHeadlessContext>["apiClient"] });
}
async function report(payload: ExposurePayload, rawArgument: string) {
  const args = createTestHeadlessArgs({ rawArgument });
  const result = await exposureHeadless.load(args, context([], payload)) as HeadlessBundleResult;
  const freshness = deriveHeadlessFreshness(exposureHeadless, result);
  const exports = (from: HeadlessBundleResult) => ({ json: JSON.stringify(serializeHeadlessPaneResult(exposureHeadless, from)),
    csv: renderReportCsv(headlessReportTables(exposureHeadless, from, args, "EXPO", freshness, { complete: false, unavailableSymbols: [] })) });
  return { result, text: renderHeadlessPaneText(exposureHeadless, result, args, "EXPO", freshness), exports };
}
/** Table lines, without the caveats printed under a row or the message lines after the tables. */
const tableLines = (text: string) => text.slice(0, text.search(/^(Pro|Errors):/m)).split("\n").filter(line => !line.startsWith("  "));

test("headless sends signed weights and exports complete per-hop evidence plus source limitations", async () => {
  const requests: ExposureRequest[] = [];
  const result = await exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "AAPL=1.2 NVDA=-.4", options: { depth: 3, cash: "0.2" } }), context(requests));
  expect(requests[0]).toMatchObject({ holdings: [{ symbol: "AAPL", weight: 1.2 }, { symbol: "NVDA", weight: -.4 }], depth: 3, cashWeight: .2 });
  expect(result.complete).toBe(false);
  expect(result.sections.find(section => section.title === "Paths and evidence")!.rows!.some(r => Array.isArray(r.evidence) && r.evidence.some(e => e.quote && e.url))).toBe(true);
  expect(result.metadata?.payload).toMatchObject({ portfolio: { grossWeight: .95, cashWeight: .05 } });
});
test("headless watchlists resolve local membership before remote analysis and unknown watchlists fail closed", async () => {
  const requests: ExposureRequest[] = [], ctx = context(requests);
  const ticker = createTestTicker("2330", "TSMC", { exchange: "TWSE", watchlists: ["chips"] });
  ctx.resolveWatchlist = async id => id === "chips" ? [ticker] : null;
  await exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "WATCH:chips" }), ctx);
  expect(requests[0]!.holdings[0]).toEqual({ symbol: "2330:TWSE", weight: 1 });
  await expect(exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "WATCH:missing" }), ctx)).rejects.toThrow("Unknown local watchlist");
  expect(requests.length).toBe(1);
});
test("an unknown library id or invalid cash cannot produce a default scenario under a different label", async () => {
  const requests: ExposureRequest[] = [], ctx = context(requests);
  await expect(exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "AAPL", options: { scenario: "not-a-scenario" } }), ctx)).rejects.toThrow("Unknown scenario");
  await expect(exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "AAPL", options: { cash: "unknown" } }), ctx)).rejects.toThrow("Cash");
  expect(requests).toHaveLength(0);
});

test("the text report prints every section as the pane draws it within 100 columns, while JSON and CSV keep the raw records", async () => {
  const payload = structuredClone(audited) as ExposurePayload;
  // Company drivers of every kind: segment KPIs, adjusted guidance ranges and a credit line with caveats.
  payload.holdings[1]!.extensions = [...drivers.AAPL, ...drivers.WMT, ...drivers.FICO] as unknown as ExposureExtensionObservation[];
  const { result, text, exports } = await report(payload, "NVDA=.3 AAPL=.25 AMD=.15 LIN=.15 FANG=.1");
  const line = (start: RegExp) => text.split("\n").find(row => start.test(row)) ?? "";

  // The title names the scenario, so its one shock is not a column.
  expect(text).toStartWith("Exposure | NVDA=.3 AAPL=.25 AMD=.15 LIN=.15 FANG=.1 | Taiwan disruption (TW -100%)");
  expect(text).not.toContain("Shock");
  expect(line(/^NVDA +Revenue/)).toMatch(/^NVDA +Revenue +19\.6% +Estimated · partial +-19\.6% +2026-01-25 +30\.0%$/);
  expect(line(/^AAPL +Revenue/)).toMatch(/0\.0 to 15\.5% +Estimated +-15\.5 to 0\.0%/);
  // Drivers: compact value with its unit, the scope in words, a credit figure named without its instrument, caveats under the row.
  expect(line(/^AAPL +Product sales +201/)).toMatch(/201\.18B USD +Fiscal year 2024 end… +iPhone$/);
  expect(line(/^AAPL +Revenue +167/)).toContain("Americas · geographic…");
  expect(line(/^AAPL +Earnings per share +2\.58/)).toMatch(/2\.58 to 2\.63 USD\/share +full fiscal year 2026 +Adjusted$/);
  expect(text).toMatch(/^AAPL +Drawn +265\.00M USD +2026-03-31 +\$1\.0 billion revolvin…\n/m);
  expect(text).toMatch(/Uncomputable +2025-12-31 .*\n {2}Covenant boundary inclusivity is not established\n/);
  expect(line(/^NVDA +NVDA → 2317/)).toMatch(/Unknown +Unknown +-- +2026-01-25$/);
  // Stress lines say how much of the book they could not see; concentrations name their kind and holding.
  expect(text).toMatch(/^NVDA +Revenue +5\.9% +-5\.9% +2026-01-25 +30\.0%\n {2}Unknown gross holding weight: 65\.0%\n/m);
  expect(line(/^Country +NVDA +United States/)).toMatch(/Revenue +20\.8% +2026-01-25 +30\.0%$/);
  expect(text).not.toMatch(/[{}[\]]|kpi:|taiwan:/);
  expect(Math.max(...tableLines(text).map(row => Bun.stringWidth(row)))).toBeLessThanOrEqual(100);

  // The text-only tables never reach an export: JSON and CSV are byte for byte the records' own.
  const raw = { ...result, sections: result.sections.map(({ textColumns: _columns, textRows: _rows, ...section }) => section) } as HeadlessBundleResult;
  expect(exports(result)).toEqual(exports(raw));
  expect(result.sections[0]!.columns).toBeUndefined();
  expect(exports(result).csv).toContain("167045000000");
  expect(JSON.parse(exports(result).json).sections[0].rows[0]).toMatchObject({ symbol: "NVDA", weight: .3, coverage: { revenueRows: expect.any(Number) } });
});

test("a one-holding preview leaves out what only repeats the holding and marks an incomplete concentration bound", async () => {
  const payload = structuredClone(audited) as ExposurePayload;
  payload.access = "preview";
  payload.lockedHoldings = 4;
  payload.holdings = payload.holdings.filter(holding => holding.symbol === "AAPL");
  payload.portfolio.measures = [];
  payload.portfolio.concentrations = payload.portfolio.concentrations.filter(row => row.symbols.join() === "AAPL");
  payload.portfolio.concentrations[0]!.incomplete = true;
  const { text } = await report(payload, "AAPL");

  expect(text).toContain("Company drivers\nNo data.");
  expect(text).toContain("Portfolio operating stress\nNo data.");
  expect(text).toMatch(/^Kind +Target +Basis +Gross exp\. % +Bound +Period$/m);
  expect(text).toMatch(/^Country +United States +Revenue +9\.1% +Incomplete +2025-09-27$/m);
  expect(text).toMatch(/^Country +Greater China +Revenue +3\.9% +2025-09-27$/m);
  expect(text).toContain("Pro: Free preview: one holding, depth one. Full analysis requires Pro.");
});
