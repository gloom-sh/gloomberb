import { expect, test } from "bun:test";
import { deriveHeadlessFreshness, deriveRenderedFreshness, formatFreshnessLine, paneStatusLine } from "../../../cli/pane-functions/freshness";
import type { HeadlessBundleResult, HeadlessPaneFreshness } from "../../../types/plugin";
import { createTestQuote } from "../../../test-support/data-provider";
import type { OptionsChain, Quote } from "../../../types/financials";
import type { ScenarioMarketSnapshot } from "./client";
import { scenarioFreshness } from "./freshness";
import { optionsScenarioHeadless } from "./headless";

const at = (iso: string) => Date.parse(iso);

/** SPY as Gloom Cloud serves it signed out: 15 minutes behind the venue, with the session its feed reports. */
const spy = (lastUpdated: string, overrides: Partial<Quote> = {}): Quote => createTestQuote({
  symbol: "SPY", price: 770.9, lastUpdated: at(lastUpdated), providerId: "gloomberb-cloud", dataSource: "delayed",
  listingExchangeName: "ARCA", exchangeName: "ARCA", ...overrides,
});

const chain = (overrides: Partial<OptionsChain> = {}): OptionsChain => ({
  underlyingSymbol: "SPY", expirationDates: [], calls: [], puts: [], asOf: "2026-10-15T20:14:00.000Z",
  dataSource: "delayed", delayMinutes: 15, ...overrides,
});

const market = (quote: Quote | null, optionsChain: OptionsChain | null = chain()): ScenarioMarketSnapshot => ({
  symbol: "SPY", spot: quote?.price ?? null, currency: "USD", asOf: quote?.lastUpdated ?? at("2026-10-15T23:44:30Z"), chain: optionsChain, expirationDates: [],
  rate: 0.04, dividendYield: 0.01, source: "gloom", underlyingQuote: quote, rateAsOf: [], warnings: [],
});

/** The line `fn OSA` ends with, and the line a capture of the pane ends with from what the pane publishes for the same market. */
function lines(snapshot: ScenarioMarketSnapshot, now: string, inputsOnly = false) {
  const declared = scenarioFreshness(snapshot, inputsOnly, at(now));
  const report = deriveHeadlessFreshness(optionsScenarioHeadless, { sections: [], freshness: declared } as HeadlessBundleResult, at(now));
  // The pane publishes the same declaration: its feed and delay as the report's own fields, its observations as rows.
  const published: HeadlessPaneFreshness = { ...declared, observations: undefined };
  const pane = deriveRenderedFreshness(published, { footerText: "", cellTimes: [], observed: declared.observations as Record<string, unknown>[] | undefined }, at(now));
  expect(pane).toEqual(report);
  return { report: formatFreshnessLine(report), capture: paneStatusLine(report) };
}

test("OSA dates its figures by the underlying's quote, its delay and where its market stands, as OMON and quote do", () => {
  // Thursday evening: the position is valued at an after-hours print, 15 minutes behind.
  expect(lines(market(spy("2026-10-15T23:30:08Z", { marketState: "POST", postMarketPrice: 770.9, extendedSessionPrint: true })), "2026-10-15T23:45:00Z")).toEqual({
    report: "Source: Gloom Cloud · Thu 15 Oct 2026 23:30 UTC · 15 min delayed · after hours",
    capture: "23:30 UTC · 15 min delayed · after hours",
  });
  // Saturday: the print is Friday's close, and the markets reopen Monday.
  expect(lines(market(spy("2026-10-16T20:00:00Z", { marketState: "CLOSED" })), "2026-10-17T15:00:00Z").report)
    .toBe("Source: Gloom Cloud · US trading day Fri 16 Oct 2026 close · 15 min delayed · markets closed until Mon");
});

test("OSA with no current quote is dated by its load, and a position typed whole is the reader's own inputs", () => {
  expect(lines(market(null), "2026-10-15T23:45:00Z").report)
    .toBe("Source: Gloom Cloud · Thu 15 Oct 2026 23:44 UTC · 15 min delayed");
  expect(lines(market(null, null), "2026-10-15T23:45:00Z", true).report)
    .toBe("Source: Your inputs · retrieved Thu 15 Oct 2026 23:45 UTC · not a live feed (scenario)");
});
