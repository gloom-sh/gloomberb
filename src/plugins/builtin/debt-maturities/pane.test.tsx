import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { DebtMaturitiesPayload, DebtMetric } from "../../../api-client/debt-maturities";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { BUCKET_IDS } from "./client";
import { DebtMaturitiesPane } from "./pane";

const asOf = "2025-06-30", filed = "2025-07-25", accession = "0000000001-25-000001", currency = "USD";
function payload(): DebtMaturitiesPayload {
  const metric = (value: number | null, unit = currency): DebtMetric => ({ value, unit, asOf, filed,
    percentile: { value: null, rank: null, sampleCount: value === null ? 0 : 1, minimumSamples: 5, windowStart: "2015-06-30",
      windowEnd: asOf, historyStart: value === null ? null : asOf, historyEnd: value === null ? null : asOf, min: value, max: value, mean: value } });
  const buckets = BUCKET_IDS.map((id, index) => ({ id, label: id, year: index === 5 ? null : 2026 + index, value: (index + 1) * 10_000_000,
    fact: { value: (index + 1) * 10_000_000, tag: `LongTermDebtMaturitiesRepaymentsOfPrincipal${id}`, unit: currency, start: null, end: asOf, accession, filed, form: "10-K" } }));
  const last = { asOf, filed, accession, currency, complete: true, totalPrincipal: 210_000_000, next12Months: 10_000_000,
    next12MonthsShare: 100 * 10 / 210, next3Years: 60_000_000, next3YearsShare: 100 * 60 / 210, interestExpense: null,
    borrowingCostPercent: null, interestExpenseTag: null, borrowingCostDebtTags: null };
  const history = [2022, 2023, 2024].map((year, index) => ({ ...last, asOf: `${year}-06-30`, filed: `${year}-07-25`,
    accession: `0000000001-${String(year - 2000)}-000001`, totalPrincipal: 190_000_000 + index * 5_000_000 }));
  return { version: 1, symbol: "TEST", cik: "0000000001", entityName: "Example", taxonomy: "us-gaap", status: "available",
    fetchedAt: "2025-07-26T00:00:00.000Z", asOf, source: { name: "SEC", url: "https://data.sec.gov/one", cadence: "Annual" }, warnings: [],
    latest: { asOf, filed, accession, form: "10-K", currency, filingUrl: "https://www.sec.gov/one", complete: true, buckets,
      totalPrincipal: metric(210_000_000), next12Months: metric(10_000_000), next12MonthsShare: metric(100 * 10 / 210, "%"),
      next3Years: metric(60_000_000), next3YearsShare: metric(100 * 60 / 210, "%"), interestExpense: metric(null),
      borrowingCostPercent: metric(null, "%"), interestExpenseFact: null, borrowingCostEvidence: null },
    history: [...history, last] };
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let spy: { mockRestore(): void } | undefined;
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  spy?.mockRestore(); spy = undefined;
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); });
}

async function render(width: number, height: number, tab = "maturities"): Promise<string[]> {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-debt-test", { instanceId: "ddis", paneId: "debt-maturities" }));
  state.focusedPaneId = "ddis";
  state.paneState.ddis = { cursorSymbol: "TEST", pluginState: { "debt-maturities": { "debt:tab": tab } } };
  state.tickers.set("TEST", createTestTicker("TEST", "Controlled issuer", { assetCategory: "STK" }));
  await act(async () => { setup = await testRender(<TestPaneFrame state={state} paneId="ddis" pluginId="debt-maturities" runtime={createTestPluginRuntime()} width={width} height={height}>
    {(body) => <DebtMaturitiesPane paneId="ddis" paneType="debt-maturities" focused {...body} />}
  </TestPaneFrame>, { width, height }); });
  await settle();
  return setup!.captureCharFrame().split("\n");
}

test("the terminal body runs to the footer, which sits outside the pane height", async () => {
  spy = spyOn(apiClient, "getCloudDebtMaturities").mockImplementation(async () => payload());
  // The table holds its header and six buckets; the chart takes every other row.
  let lines = await render(94, 29);
  expect(lines[21]).toContain("MATURITY");
  expect(lines[27]).toContain("AfterYearFive");
  expect(lines[28]).toContain("just now");
  // Four filings and the column scrollbar fill the history table to the footer.
  lines = await render(60, 16, "history");
  expect(lines[13]).toContain("2022-06-30");
  expect(lines[14]!.trim()).not.toBe("");
  expect(lines[15]).toContain("just now");
  // Without room for the chart the buckets take the rest of the body and no
  // more, so the column scrollbar stays above the footer and the cursor in view.
  lines = await render(40, 11);
  expect(lines.join("\n")).not.toContain("Next 12m");
  expect(lines[9]!.trim()).toStartWith("█");
  for (let i = 0; i < 5; i++) await emitKeypress(setup!, { name: "down" });
  await settle();
  expect(setup!.captureCharFrame()).toContain("AfterYearFive");
});
