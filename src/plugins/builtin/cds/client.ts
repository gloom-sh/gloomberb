import { apiClient, type CloudCdsResponse } from "../../../api-client";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { normalizeCdsTrades, type CdsTrade } from "./model";

/** One trading week of public dissemination is what "recent activity" means here. */
const CDS_HISTORY_DAYS = 5;
const CDS_TRADE_LIMIT = 500;

export interface CdsActivity {
  source: string;
  asOf: string | null;
  /** The issuer name actually sent, after any symbol lookup. */
  issuer: string | null;
  trades: CdsTrade[];
}

export type CdsActivityLoader = (issuer: string | null) => Promise<CdsActivity>;

export type CdsFetch = (params: { issuer?: string; days?: number; limit?: number }) => Promise<CloudCdsResponse>;
export type InstrumentSearch = (query: string, limit?: number) => Promise<InstrumentSearchResult[]>;

/**
 * A bare ticker with normal symbol punctuation and no spaces. Anything longer or
 * containing a space is already a company name and is sent to the backend as-is.
 */
const TICKER_LIKE = /^[A-Za-z0-9][A-Za-z0-9.^:-]{0,11}$/;
const US_PRIMARY_EXCHANGES = new Set(["AMEX", "NASDAQ", "NYSE", "NYSEAMERICAN", "NYSEARCA"]);

function isPrimaryUsCommonStock(result: InstrumentSearchResult): boolean {
  const exchange = (result.primaryExchange || result.exchange).toUpperCase().replace(/[^A-Z]/g, "");
  const type = result.type.toLowerCase();
  return result.currency === "USD"
    && US_PRIMARY_EXCHANGES.has(exchange)
    && (type === "stk" || type === "equity" || type.includes("common stock"));
}

/**
 * The backend matches DTCC issuer names, so a ticker has to become a company
 * name first. An untracked symbol has no local metadata to expand it, and its
 * quote name never arrives for a fixed binding, so the shared instrument search
 * is the only reliable expansion. A search outage falls back to the raw input
 * rather than taking the CDS request down with it.
 */
export async function resolveIssuerName(
  issuer: string,
  searchInstruments: InstrumentSearch,
): Promise<string> {
  if (!TICKER_LIKE.test(issuer)) return issuer;
  try {
    const results = await searchInstruments(issuer);
    const symbol = issuer.toUpperCase();
    const exactMatches = results.filter((result) => result.symbol.toUpperCase() === symbol);
    const match = exactMatches.find(isPrimaryUsCommonStock) ?? exactMatches[0] ?? results[0];
    return match?.name?.trim() || issuer;
  } catch {
    return issuer;
  }
}

export async function loadCdsActivity(
  issuer: string | null,
  fetchCds: CdsFetch = (params) => apiClient.getCloudCds(params),
  searchInstruments: InstrumentSearch = (query, limit) => apiClient.searchInstruments(query, limit),
): Promise<CdsActivity> {
  const resolved = issuer ? await resolveIssuerName(issuer, searchInstruments) : null;
  const response = await fetchCds({
    ...(resolved ? { issuer: resolved } : {}),
    days: CDS_HISTORY_DAYS,
    limit: CDS_TRADE_LIMIT,
  });
  return {
    source: response.source,
    asOf: response.asOf,
    issuer: resolved,
    trades: normalizeCdsTrades(response.trades ?? []),
  };
}
