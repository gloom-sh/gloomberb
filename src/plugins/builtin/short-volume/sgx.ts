import type { SgxShortSales } from "../../../api-client/exchange-short-balances";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";

export function sgxVolumeSymbol(input: string, exchange?: string) {
  const parsed = parsePublicTickerKey(input);
  const venue = parsed.exchange || canonicalExchange(exchange);
  if (venue ? venue !== "SGX" : !parsed.symbol.endsWith(".SI")) return null;
  const symbol = parsed.symbol.replace(/\.SI$/, "");
  return /^[A-Z0-9]{2,5}$/.test(symbol) ? symbol : null;
}

export const sgxVolumeColumns = [
  { key: "day", header: "Trading date", width: 14 },
  { key: "shortVolume", header: "Shares sold short", width: 20, align: "right" },
  { key: "currency", header: "Currency", width: 10 },
  { key: "shortValue", header: "Short sale value", width: 20, align: "right" },
] as const;

export function sgxVolumeEmpty(data: SgxShortSales) {
  return data.reportsReviewed
    ? `No short sales reported for ${data.symbol} in ${data.reportsReviewed} SGX daily files reviewed.`
    : "No SGX daily short sale files available.";
}
