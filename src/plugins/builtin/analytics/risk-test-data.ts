import type {
  CloudMarketResponse,
  CloudPricePointPayload,
  CloudQuotePayload,
} from "../../../api-client/types";
export const now = new Date("2026-09-22T12:00:00Z");
export const instrument = { symbol: "SPY", exchange: "ARCA" };
export const riskQuote = (symbol = "SPY", listing = "ARCA"): CloudQuotePayload => ({
  symbol,
  currency: "USD",
  price: 110,
  change: 1,
  changePercent: 1,
  lastUpdated: now.getTime() - 86_400_000,
  listingExchangeName: listing,
  providerId: "gloomberb-cloud",
});
export function riskHistory(): CloudMarketResponse<CloudPricePointPayload[]> {
  const data: CloudPricePointPayload[] = [];
  for (
    let day = Date.parse("2026-05-01");
    day <= Date.parse("2026-09-21");
    day += 86_400_000
  ) {
    const date = new Date(day),
      key = date.toISOString().slice(0, 10);
    if (
      [0, 6].includes(date.getUTCDay()) ||
      ["2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07"].includes(key)
    )
      continue;
    const close = 100 + data.length * 0.1 + Math.sin(data.length) * 2;
    data.push({
      date: date.toISOString(),
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
    });
  }
  return {
    status: "success",
    data,
    providerMeta: {
      servedResolution: "1d",
      currency: "USD",
      normalizedSymbol: "SPY",
      normalizedExchange: "ARCA",
    },
  };
}
