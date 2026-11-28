import { expect, test } from "bun:test";
import type { TickerFinancials } from "../../types/financials";
import { fundamentalsReportTables, renderFundamentalsReport } from "./ticker";
import { renderReportCsv } from "../report-tables";

const quote = { symbol: "UNITTEST", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11"),
  listingExchangeName: "NYSE" };
const plainText = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u00a0/g, " ").replace(/ {2,}/g, " ");

// COHR after the 2026-11-27 early close: Gloom Cloud's cap and EV bridge at the 225.25 after-hours print, the close 223.79.
test("the EV bridge adds the market cap the report shows, a held stale quote's included; a cap in another currency is named apart", () => {
  const shares = 196_958_669;
  const extendedCap = Math.round(225.25 * shares);
  const financials = (fields: Partial<TickerFinancials["quote"] & object> = {}) => ({ symbol: "COHR", exchange: "NYSE", quarterlyStatements: [], annualStatements: [], priceHistory: [],
    quote: { ...quote, symbol: "COHR", marketState: "POSTPOST" as const, regularClose: 223.79, price: 225.25,
      lastUpdated: Date.parse("2026-11-27T21:59:58.499Z"), changeSessionDate: "2026-11-27", regularCloseSessionDate: "2026-11-27", ...fields },
    fundamentals: { sharesOutstanding: shares, marketCap: extendedCap, marketCapCurrency: "USD", enterpriseValue: extendedCap + 4e9 - 1.75e9 + 331.72e6,
      enterpriseValueCheck: { status: "differs" as const, computed: extendedCap + 4e9 - 1.75e9, source: 51.14e9, balanceSheetDate: "2026-09-30",
        marketCap: extendedCap, currency: "USD", totalDebt: 4e9, cash: 1.75e9, minorityAndPreferred: 331.72e6 } } });
  const bridged = "EV 46.66B USD is market cap 44.08B + total debt 4B - cash 1.75B + minority interest and preferred equity 331.72M";
  for (const stale of [false, true]) {
    const text = plainText(renderFundamentalsReport(financials({ stale }), "fundamentals"));
    expect(text).toContain("Market Cap 44.08B USD");
    expect(text).toContain("Enterprise Value 46.66B USD");
    expect(text).toContain(bridged);
    const exported = renderReportCsv(fundamentalsReportTables(financials({ stale }), "fundamentals", { source: "Gloom Cloud", asOf: null, status: "unreported" }));
    expect(exported).toMatch(/Enterprise Value \(USD\),4665910053\d/);
  }
  const other = plainText(renderFundamentalsReport(financials({ currency: "CAD", marketCap: 70e9, stale: true }), "fundamentals"));
  expect(other).toContain("Market Cap 70B CAD");
  expect(other).toContain("EV 46.95B USD is market cap 44.36B + total debt 4B");
  expect(other).toContain("That market cap is in USD, not the 70B CAD the Market Cap row shows.");
});
