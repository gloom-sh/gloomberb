import { describe, expect, test } from "bun:test";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import type { TickerPosition } from "../../../types/ticker";
import { buildAddToPortfolioWorkflow, buildSetPortfolioPositionWorkflow } from "./portfolio-position";

const config = createDefaultConfig("/unused-portfolio-position");
const lot = (shares: number, avgCost: number, currency = "USD"): TickerPosition =>
  ({ portfolio: "main", broker: "manual", shares, avgCost, currency });
const apple = (...positions: TickerPosition[]) => createTestTicker("AAPL", "Apple", { portfolios: ["main"], positions });
const form = (ticker: ReturnType<typeof apple>) => buildAddToPortfolioWorkflow(config, { preferredPortfolioId: "main", ticker })!;
const hints = (workflow: ReturnType<typeof form>) => workflow.fields.flatMap((field) => field.id === "costFx" ? [] : field.description ?? []);

describe("position form with several lots", () => {
  test("fills the total shares, the share-weighted cost and the common currency, and says saving replaces the lots", () => {
    for (const workflow of [
      form(apple(lot(10, 150), lot(5, 170))),
      buildSetPortfolioPositionWorkflow(config, { activeCollectionId: "main", activeTicker: apple(lot(10, 150), lot(5, 170)) })!,
    ]) {
      expect(workflow.values).toMatchObject({ ticker: "AAPL", shares: "15", currency: "USD" });
      expect(Number(workflow.values.avgCost) * 15).toBeCloseTo(2350, 9);
      expect(hints(workflow)).toEqual(['Totals of your 2 lots in "Main Portfolio". Saving replaces them with one position, dated by the earliest.']);
    }
  });

  test("lots in different currencies are not totalled: nothing is filled in and the hint names the currencies", () => {
    const workflow = buildAddToPortfolioWorkflow(config, {
      preferredPortfolioId: "main",
      ticker: apple(lot(10, 150), lot(5, 140, "EUR")),
      defaultAvgCost: 190,
    })!;

    expect(workflow.values).toMatchObject({ shares: "", avgCost: "", currency: "" });
    expect(hints(workflow)).toEqual(['2 lots in "Main Portfolio" are in different currencies (USD, EUR), so none is filled in. Saving replaces them with one position.']);
  });

  test("a single lot and no lot fill in as before, the count hinting only at how a short is entered", () => {
    const single = form(apple(lot(10, 150)));
    expect(single.values).toEqual({ portfolioId: "main", ticker: "AAPL", shares: "10", avgCost: "150", currency: "USD", dateAcquired: "", costFx: "" });
    expect(hints(single)).toEqual(["Negative for a short."]);

    const empty = buildAddToPortfolioWorkflow(config, { preferredPortfolioId: "main", ticker: apple(), defaultAvgCost: 190 })!;
    expect(empty.values).toEqual({ portfolioId: "main", ticker: "AAPL", shares: "", avgCost: "190", currency: "", dateAcquired: "", costFx: "" });
    expect(hints(empty)).toEqual(["Negative for a short."]);
  });

  test("a future counts contracts, and its blank currency is the cents it quotes in when it quotes in cents", () => {
    const oats = createTestTicker("ZO=F", "Oats Dec 26", { exchange: "CBT", assetCategory: "FUTURE" });
    const field = (workflow: ReturnType<typeof form>, id: string) => workflow.fields.find((entry) => entry.id === id)!;
    const cents = buildAddToPortfolioWorkflow(config, { preferredPortfolioId: "main", ticker: oats, quoteCurrency: "USX", defaultAvgCost: 350 })!;
    expect(field(cents, "shares").label).toBe("Contracts");
    expect(field(cents, "currency").placeholder).toBe("USX");
    // A lot saved in dollars before contract sizes is read in cents, so saving it unchanged keeps it in cents.
    const legacy = createTestTicker("ZO=F", "Oats Dec 26", { exchange: "CBT", assetCategory: "FUTURE", portfolios: ["main"], positions: [lot(2, 350)] });
    expect(buildAddToPortfolioWorkflow(config, { preferredPortfolioId: "main", ticker: legacy, quoteCurrency: "USX" })!.values.currency).toBe("USX");
    // Gold quotes in dollars: a blank currency is the portfolio's.
    const gold = createTestTicker("GC=F", "Gold Dec 26", { exchange: "CMX", assetCategory: "FUTURE" });
    expect(field(buildSetPortfolioPositionWorkflow(config, { activeCollectionId: "main", activeTicker: gold, activeQuoteCurrency: "USD" })!, "currency").placeholder)
      .toBe("USD");
  });
});
