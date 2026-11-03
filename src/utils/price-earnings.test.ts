import { expect, test } from "bun:test";
import type { TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import { getColumnValue, getSortValue } from "../portfolio/column-values";
import { buildOverviewStats } from "../plugins/builtin/ticker-detail/overview/model";
import { relativeValuationValues } from "../plugins/builtin/research/relative-valuation-model";
import { createTestTicker } from "../test-support/ticker";
import { renderFundamentalsReport } from "../cli/commands/ticker";
import { exportedFundamentals } from "./price-earnings";
import { MISSING_VALUE } from "./format";

const ticker: TickerRecord = createTestTicker("TEST", "Test");
const context = { baseCurrency: "USD", exchangeRates: new Map<string, number>(), now: 1 };

test.each([
  { value: -5.2, text: "N/M", comparable: null },
  { value: 0, text: "N/M", comparable: null },
  { value: undefined, text: "—", comparable: null },
  { value: Number.NaN, text: "—", comparable: null },
  { value: Number.POSITIVE_INFINITY, text: "—", comparable: null },
  { value: 12.3, text: "12.3", comparable: 12.3 },
])("portfolio and peer P/E comparisons handle $value consistently", ({ value, text, comparable }) => {
  const data: TickerFinancials = { annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { trailingPE: value, forwardPE: value } };
  for (const id of ["pe", "forward_pe"]) {
    const column = { id, label: id, width: 8, align: "right" as const };
    expect(getColumnValue(column, ticker, data, context).text).toBe(text);
    expect(getSortValue(column, ticker, data, context)).toBe(comparable);
  }
  expect(relativeValuationValues(data)).toMatchObject({ trailingPE: comparable, forwardPE: comparable });
});

test("overview keeps reported losses and a positive forecast while marking the trailing multiple non-comparable", () => {
  const fundamentals = { trailingPE: -5.2, forwardPE: 12.3, eps: -3.1, financialCurrency: "USD" };
  const stats = buildOverviewStats({ quote: undefined, fundamentals, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value });
  expect(stats.find(({ label }) => label === "P/E (TTM)")?.value).toBe("N/M");
  expect(stats.find(({ label }) => label === "Fwd P/E")?.value).toBe("12.3");
  expect(stats.find(({ label }) => label === "EPS")?.value).toBe("-$3.10");
  expect(fundamentals).toMatchObject({ trailingPE: -5.2, forwardPE: 12.3, eps: -3.1 });
});

test("a served positive P/E beside a trailing loss reads N/M everywhere and exports null with its reason", () => {
  // MSTR: the source's 5.47 was priced at an older, profitable period; trailing EPS is -99.08.
  const fundamentals = { trailingPE: 5.47, forwardPE: 3.32, eps: -99.08, financialCurrency: "USD" };
  const data: TickerFinancials = { annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals };
  const column = { id: "pe", label: "pe", width: 8, align: "right" as const };
  expect(getColumnValue(column, ticker, data, context).text).toBe("N/M");
  expect(getSortValue(column, ticker, data, context)).toBeNull();
  const overview = buildOverviewStats({ quote: undefined, fundamentals, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value });
  expect(overview.find(({ label }) => label === "P/E (TTM)")?.value).toBe("N/M");
  // Without a forward EPS the forward multiple is judged on its own.
  expect(overview.find(({ label }) => label === "Fwd P/E")?.value).toBe("3.3");
  expect(relativeValuationValues(data)).toMatchObject({ trailingPE: null, forwardPE: 3.32, notMeaningful: { trailingPE: "trailing EPS is not positive" } });
  const report = renderFundamentalsReport({ ...data, symbol: "MSTR" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "");
  expect(report).toMatch(/P\/E \(TTM\) +N\/M/);
  expect(report).toMatch(/Forward P\/E +3\.32/);
  expect(exportedFundamentals(fundamentals)).toMatchObject({
    trailingPE: null, forwardPE: 3.32, notMeaningful: { trailingPE: "trailing EPS is not positive" },
  });
  // A forward estimate at a loss makes the forward multiple N/M too.
  expect(exportedFundamentals({ ...fundamentals, forwardEps: -1 })).toMatchObject({ forwardPE: null });
});

// NFE: the vendor's 1.6 was priced on an unlabelled estimate; next fiscal year's consensus is 2.08 at a loss today.
test("forward P/E names the fiscal year of its consensus, N/M over a forecast loss and a dash when there is none", () => {
  const consensus = { forwardPE: 2.43, forwardEps: 2.08, forwardEpsPeriodEnd: "2027-12-31", eps: -329, financialCurrency: "USD" };
  const forwardLine = (fundamentals: TickerFinancials["fundamentals"]) =>
    buildOverviewStats({ quote: undefined, fundamentals, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value })
      .find(({ label }) => label.startsWith("Fwd P/E"));
  expect(forwardLine(consensus)).toMatchObject({ label: "Fwd P/E FY27", value: "2.4" });
  expect(forwardLine({ ...consensus, forwardPE: undefined, forwardEps: -1.2 })).toMatchObject({ label: "Fwd P/E FY27", value: "N/M" });
  // The source was asked and had no consensus, or one from before the last split: the line stays, empty.
  expect(forwardLine({ eps: -329, forwardEpsPeriodEnd: null })).toMatchObject({ label: "Fwd P/E", value: MISSING_VALUE });
  expect(forwardLine({ forwardEpsPeriodEnd: null })).toBeUndefined();
  // A server from before fiscal years were named serves the bare multiple as before.
  expect(forwardLine({ forwardPE: 12.3, eps: 1 })).toMatchObject({ label: "Fwd P/E", value: "12.3" });
  const data: TickerFinancials = { annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals: consensus };
  const report = renderFundamentalsReport({ ...data, symbol: "NFE" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "");
  expect(report).toMatch(/Forward P\/E FY27 +2\.43/);
  expect(renderFundamentalsReport({ ...data, symbol: "NFE" }, "fundamentals").replace(/\u001b\[[0-9;]*m/g, ""))
    .toMatch(/Forward P\/E FY27 +2\.43/);
});
