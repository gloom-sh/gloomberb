import { FRED_CATALOG_SERIES } from "../../plugins/builtin/shared/fred-catalog";
import { ICE_CREDIT_PUBLISHER, ICE_CREDIT_SERIES } from "../../time-series/ice-credit";
import { seriesNotOnFred } from "./fred-series";

const publishers = new Map([
  ...FRED_CATALOG_SERIES.map((series): [string, string] => [series.id.slice(5), series.publisher!]),
  ...ICE_CREDIT_SERIES.map((series): [string, string] => [series.seriesId, ICE_CREDIT_PUBLISHER]),
]);
const additional: Readonly<Record<string, string>> = {
  GDPNOW: "Federal Reserve Bank of Atlanta",
  NFCI: "Federal Reserve Bank of Chicago",
  STLFSI4: "Federal Reserve Bank of St. Louis",
  MEDCPIM158SFRBCLE: "Federal Reserve Bank of Cleveland",
};

export function fredPublisher(seriesId: string, source?: string | null): string | null {
  const normalized = seriesId.trim().toUpperCase();
  return publishers.get(normalized) ?? additional[normalized]
    ?? (/^DGS\d|^DFII\d/.test(normalized) ? "Federal Reserve Board" : source?.trim() || null);
}

export function fredCitation(seriesId: string, source?: string | null): string {
  const publisher = fredPublisher(seriesId, source);
  return seriesNotOnFred(seriesId) ? publisher ?? "Gloom Cloud" : publisher ? `${publisher} via FRED` : "Publisher not stated via FRED";
}
