import {
  apiClient,
  type CloudCdsHistoryPointPayload,
  type CloudCdsHistoryResponse,
  type CloudCdsResponse,
} from "../../../api-client";
import type { CloudCdsHistoryParams } from "../../../api-client/paths";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { mapWithConcurrency } from "../../../utils/concurrency";
import {
  cdsReferenceEntity,
  issuerNameOf,
  normalizeCdsTrades,
  spreadSummary,
  type CdsIssuerSummary,
  type CdsSpreadLevels,
  type CdsTrade,
} from "./model";

/** One trading week of public dissemination is what "recent activity" means here. */
export const CDS_TRADE_DAYS = 5;
const CDS_TRADE_LIMIT = 500;

export interface CdsActivity {
  source: string;
  asOf: string | null;
  /** What was asked for, as typed: a ticker or a name. Null for the market-wide view. */
  query: string | null;
  /** The issuer name actually sent, after any symbol lookup. */
  issuer: string | null;
  /** How many days of the tape the trades cover. */
  days: number;
  trades: CdsTrade[];
}

export type CdsActivityLoader = (issuer: string | null) => Promise<CdsActivity>;

export type CdsFetch = (params: { issuer?: string; days?: number; limit?: number }) => Promise<CloudCdsResponse>;
export type InstrumentSearch = (query: string, limit?: number) => Promise<InstrumentSearchResult[]>;

/**
 * A bare ticker with normal symbol punctuation and no spaces. Anything longer or
 * containing a space is already a company name and is sent as the tape would
 * name it.
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
 * name first: its reference entity when the debt sits with another entity,
 * else the listed company's name without its share class ("Alphabet Inc.",
 * not "Alphabet Inc. Class A Common Stock"). An untracked symbol has no local
 * metadata to expand it, and its quote name never arrives for a fixed
 * binding, so the shared instrument search is the only reliable expansion. A
 * search outage falls back to the raw input rather than taking the CDS
 * request down with it.
 */
export async function resolveIssuerName(
  issuer: string,
  searchInstruments: InstrumentSearch,
): Promise<string> {
  if (!TICKER_LIKE.test(issuer)) return issuerNameOf(issuer);
  const referenceEntity = cdsReferenceEntity(issuer);
  if (referenceEntity) return referenceEntity;
  try {
    const results = await searchInstruments(issuer);
    const symbol = issuer.toUpperCase();
    const exactMatches = results.filter((result) => result.symbol.toUpperCase() === symbol);
    const match = exactMatches.find(isPrimaryUsCommonStock) ?? exactMatches[0] ?? results[0];
    const name = match?.name?.trim();
    return name ? issuerNameOf(name) : issuer;
  } catch {
    return issuer;
  }
}

export async function loadCdsActivity(
  issuer: string | null,
  fetchCds: CdsFetch = (params) => apiClient.getCloudCds(params),
  searchInstruments: InstrumentSearch = (query, limit) => apiClient.searchInstruments(query, limit),
): Promise<CdsActivity> {
  const query = issuer?.trim() || null;
  const resolved = query ? await resolveIssuerName(query, searchInstruments) : null;
  const response = await fetchCds({
    ...(resolved ? { issuer: resolved } : {}),
    days: CDS_TRADE_DAYS,
    limit: CDS_TRADE_LIMIT,
  });
  return {
    source: response.source,
    asOf: response.asOf,
    query,
    issuer: resolved,
    days: CDS_TRADE_DAYS,
    trades: normalizeCdsTrades(response.trades ?? []),
  };
}

/** Two years: what DTCC keeps readable, so the backend holds no more. */
const CDS_SPREAD_HISTORY_DAYS = 730;

export interface CdsSpreadHistory {
  issuer: string | null;
  points: CloudCdsHistoryPointPayload[];
}

export type CdsSpreadHistoryLoader = (issuer: string) => Promise<CdsSpreadHistory>;
export type CdsHistoryFetch = (params: CloudCdsHistoryParams) => Promise<CloudCdsHistoryResponse>;

/**
 * Daily on-the-run 5Y levels for the name the trade request already resolved,
 * so no second instrument search runs. Oldest first.
 */
export async function loadCdsSpreadHistory(
  issuer: string,
  fetchHistory: CdsHistoryFetch = (params) => apiClient.getCloudCdsHistory(params),
  days = CDS_SPREAD_HISTORY_DAYS,
): Promise<CdsSpreadHistory> {
  const response = await fetchHistory({ issuer, days });
  const points = (response.points ?? [])
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.spreadBp))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  return { issuer: response.issuer, points };
}

/** The month of 5Y line a listed issuer's level is read from, the shortest the backend serves. */
const CDS_LEVEL_DAYS = 30;
const CDS_LEVEL_CONCURRENCY = 8;

export type CdsSpreadLevelsLoader = (issuers: readonly Pick<CdsIssuerSummary, "key" | "issuer">[]) => Promise<CdsSpreadLevels>;

/**
 * The latest 5Y level of every listed issuer, from the same line the pane
 * charts, so the list can be ranked by it. A name with no level in the last
 * month is left out; it fails only when no name could be read at all.
 */
export async function loadCdsSpreadLevels(
  issuers: readonly Pick<CdsIssuerSummary, "key" | "issuer">[],
  fetchHistory: CdsHistoryFetch = (params) => apiClient.getCloudCdsHistory(params),
): Promise<CdsSpreadLevels> {
  const levels = new Map<string, { spreadBp: number; date: string }>();
  let failed = 0;
  let lastError: unknown = null;
  await mapWithConcurrency(issuers, CDS_LEVEL_CONCURRENCY, async ({ key, issuer }) => {
    try {
      const summary = spreadSummary((await loadCdsSpreadHistory(issuer, fetchHistory, CDS_LEVEL_DAYS)).points);
      if (summary) levels.set(key, { spreadBp: summary.spreadBp, date: summary.date });
    } catch (error) {
      failed += 1;
      lastError = error;
    }
  });
  if (issuers.length > 0 && failed === issuers.length) {
    throw lastError instanceof Error ? lastError : new Error("5Y spreads unavailable.");
  }
  return levels;
}
