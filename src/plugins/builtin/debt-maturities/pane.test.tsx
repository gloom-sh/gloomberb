import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import type { DebtMaturitiesPayload, DebtMetric } from "../../../api-client/debt-maturities";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
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

const tui = createOpenTuiTestHarness();
let spy: { mockRestore(): void } | undefined;
afterEach(() => {
  spy?.mockRestore(); spy = undefined;
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
}

async function render(width: number, height: number, tab = "maturities"): Promise<string[]> {
  await tui.destroy();
  spy ??= spyOn(apiClient, "getCloudDebtMaturities").mockImplementation(async () => payload());
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-debt-test", { instanceId: "ddis", paneId: "debt-maturities" }));
  initial.focusedPaneId = "ddis";
  initial.paneState.ddis = { cursorSymbol: "TEST", pluginState: { "debt-maturities": { "debt:tab": tab } } };
  initial.tickers.set("TEST", createTestTicker("TEST", "Controlled issuer", { assetCategory: "STK" }));
  const runtime = createTestPluginRuntime();
  // Selection is pane state, so the harness keeps the reducer's state.
  function Harness() {
    const [state, setState] = useState(initial);
    return <TestPaneFrame state={state} dispatch={(action) => setState((current) => appReducer(current, action))}
      paneId="ddis" pluginId="debt-maturities" runtime={runtime} width={width} height={height}>
      {(body) => <DebtMaturitiesPane paneId="ddis" paneType="debt-maturities" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
  await settle();
  return tui.frame().split("\n");
}

const bar = (line: string | undefined) => (line?.match(/[█▏▎▍▌▋▊▉]+/)?.[0] ?? "").length;

test("the maturity wall is an inline bar column scaled to the dated years", async () => {
  const lines = await render(94, 29);
  const row = (label: string) => lines.find((line) => line.includes(label));
  expect(row("MATURITY")).toContain("WALL");
  // The chart above is the wall's near end across filings, not the six rows again.
  expect(lines.some((line) => line.includes("● Due next 12 months"))).toBe(true);
  // 10M to 50M across the dated years: the longest dated bucket fills the scale.
  const dated = ["InNextTwelve", "InYearTwo", "InYearThree", "InYearFour", "InYearFive"].map((label) => bar(row(label)));
  expect(dated).toEqual([...dated].sort((left, right) => left - right));
  expect(dated[1]! / dated[0]!).toBeCloseTo(2, 0);
  // Thereafter (60M) runs past the scale, capped; its PRINCIPAL cell says how much, once.
  const thereafter = row("AfterYearFive")!;
  expect(bar(thereafter)).toBe(dated[4]);
  expect(thereafter).toContain("▸");
  expect(thereafter.split("60.00M")).toHaveLength(2);
  // The figures stay above the table.
  expect(lines.slice(0, 4).join("\n")).toContain("Principal total");
});

test("a short or narrow maturity pane keeps the table's rows, and the chart shrinks to a strip", async () => {
  const lines = await render(40, 10);
  expect(lines.join("\n")).not.toContain("WALL");
  // One row of figures, the strip, then the table's header and five buckets.
  expect(lines[2]).toMatch(/^ ● Due next 12 months .*%/);
  expect(lines[3]).toContain("MATURITY");
  expect(lines.filter((line) => /^ In(NextTwelve|Year)/.test(line))).toHaveLength(5);
  expect(lines[9]).toContain("just now");
});

test("the filing history names its bars and puts each year under its own bar", async () => {
  const lines = await render(94, 29, "history");
  expect(lines[1]).toContain("● Principal total (USD) 210.00M");
  const axis = lines.findIndex((line) => /(^|\s)2022(\s|$)/.test(line));
  expect(axis).toBeGreaterThan(1);
  // The bottom plot row has a cell of every bar; each year's label spans its bar.
  const columns = [...lines[axis - 1]!].flatMap((char, index) => /[█┼]/.test(char) ? [index] : []);
  expect(columns).toHaveLength(4);
  for (const [index, year] of ["2022", "2023", "2024"].entries()) {
    const start = lines[axis]!.indexOf(year);
    expect(columns[index]!).toBeGreaterThanOrEqual(start);
    expect(columns[index]!).toBeLessThan(start + 4);
  }
  // The newest filing is selected, so the cursor reads its date on the axis.
  expect(lines[axis]).toContain("2025-06-30");
});

test("moving the filing selection moves the chart cursor", async () => {
  await render(94, 29, "history");
  await tui.emitKeypress({ name: "down" });
  await settle();
  const lines = tui.frame().split("\n");
  expect(lines[1]).toContain("● Principal total (USD) 200.00M");
  expect(lines.find((line) => /(^|\s)2022(\s|$)/.test(line))).toContain("2024-06-30");
});

test("a short history pane keeps the filings and shrinks the chart to a strip", async () => {
  const lines = await render(60, 12, "history");
  expect(lines[1]).toContain("● Principal total");
  expect(lines[1]).toContain("210.00M");
  expect(lines[2]).toContain("AS OF");
  for (const date of ["2025-06-30", "2024-06-30", "2023-06-30", "2022-06-30"]) {
    expect(lines.some((line) => line.includes(date))).toBe(true);
  }
});
