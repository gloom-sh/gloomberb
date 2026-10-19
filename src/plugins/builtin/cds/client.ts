import {
  apiClient,
  type CloudCdsHistoryPointPayload,
  type CloudCdsHistoryResponse,
  type CloudCdsLevelsResponse,
  type CloudCdsResponse,
} from "../../../api-client";
import type { CloudCdsHistoryParams } from "../../../api-client/paths";
import type { InstrumentSearchResult } from "../../../types/instrument";
import {
  cdsReferenceEntity,
  issuerNameOf,
  normalizeCdsTrades,
  spreadLevelsOf,
  type CdsNoLevelReason,
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
  /** The latest level's 1W and 1M moves in bp, through the roll; null without a comparable level. */
  change1W: number | null;
  change1M: number | null;
  /** Why the line has no level in the month to its newest print, when the server can say. */
  noLevelReason: CdsNoLevelReason | null;
}

const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type CdsSpreadHistoryLoader = (issuer: string) => Promise<CdsSpreadHistory>;
export type CdsHistoryFetch = (params: CloudCdsHistoryParams) => Promise<CloudCdsHistoryResponse>;

/**
 * Daily on-the-run 5Y levels for the name the trade request already resolved,
 * so no second instrument search runs. Oldest first.
 */
export async function loadCdsSpreadHistory(
  issuer: string,
  fetchHistory: CdsHistoryFetch = (params) => apiClient.getCloudCdsHistory(params),
): Promise<CdsSpreadHistory> {
  const response = await fetchHistory({ issuer, days: CDS_SPREAD_HISTORY_DAYS });
  const points = (response.points ?? [])
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.spreadBp))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  return {
    issuer: response.issuer,
    points,
    change1W: finiteOrNull(response.change1W),
    change1M: finiteOrNull(response.change1M),
    noLevelReason: response.noLevelReason === "upfront-side-unknown" ? response.noLevelReason : null,
  };
}

export type CdsLevelsFetch = () => Promise<CloudCdsLevelsResponse>;
export type CdsSpreadLevelsLoader = () => Promise<CdsSpreadLevels>;

/**
 * Every listed issuer's latest 5Y level and its 1W and 1M moves, in one
 * request: the last point of each name's line in the last month, the line
 * the pane charts, so the list can be ranked by them. A name without one is
 * not in the response.
 */
export async function loadCdsSpreadLevels(
  fetchLevels: CdsLevelsFetch = () => apiClient.getCloudCdsLevels(),
): Promise<CdsSpreadLevels> {
  const response = await fetchLevels();
  return spreadLevelsOf(response.levels ?? []);
}
