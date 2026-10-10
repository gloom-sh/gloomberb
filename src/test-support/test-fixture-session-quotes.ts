import type { Quote } from "../types/financials";

/**
 * One US ETF through the sessions around a close, for the reports that
 * headline the regular session and give an extended print its own column.
 * Friday 2026-10-09 closed at 198.78, up 1.00 (+0.51%) from 197.78, and
 * printed 198.80 after hours. Each quote carries the regular close beside the
 * price the source sends, as Gloom Cloud does.
 */
const CLOSE = {
  previousClose: 197.78,
  regularClose: 198.78,
  regularCloseSessionDate: "2026-10-09",
  regularChange: 1,
  regularChangePercent: 0.5056,
};

export function sessionQuotes(symbol = "XLK", overrides: Partial<Quote> = {}) {
  const base = { symbol, currency: "USD", listingExchangeName: "ARCA", instrumentType: "ETF", ...overrides };
  return {
    /** Friday 13:00 ET: the regular session trading at 199.10. */
    regular: {
      ...base, price: 199.1, change: 1.32, changePercent: 0.6674, previousClose: 197.78,
      changeSessionDate: "2026-10-09", marketState: "REGULAR", lastUpdated: Date.parse("2026-10-09T17:00:00Z"),
    } as Quote,
    /** Friday 17:30 ET: the after-hours session open, its print beside the close. */
    afterHours: {
      ...base, ...CLOSE, price: 198.78, change: 1, changePercent: 0.5056,
      postMarketPrice: 198.8, postMarketChange: 0.02, postMarketChangePercent: 0.0101,
      changeSessionDate: "2026-10-09", marketState: "POST", lastUpdated: Date.parse("2026-10-09T21:30:00Z"),
    } as Quote,
    /** Saturday: price and change are Friday's last after-hours print against Thursday's close. */
    weekend: {
      ...base, ...CLOSE, price: 198.8, change: 1.02, changePercent: 0.5157,
      changeSessionDate: "2026-10-09", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:58:08Z"),
    } as Quote,
    /** Monday 08:00 ET: a pre-market print at 199.50, with Friday's close and its move. */
    preMarket: {
      ...base, ...CLOSE, price: 199.5, change: 0.72, changePercent: 0.3622, previousClose: 198.78,
      preMarketPrice: 199.5, preMarketChange: 0.72, preMarketChangePercent: 0.3622,
      changeSessionDate: "2026-10-12", marketState: "PRE", lastUpdated: Date.parse("2026-10-12T12:00:00Z"),
    } as Quote,
  };
}
