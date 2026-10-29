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
  closestCoveredIssuers,
  coveredIssuerMatch,
  issuerNameOf,
  normalizeCdsTrades,
  spreadLevelsOf,
  type CdsNoLevelReason,
  type CdsSpreadLevels,
  type CdsSpreadLine,
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
  /**
   * Set when a name matched no covered issuer and was sent as typed or as its
   * listing's name: the covered issuers closest to what was typed, for the
   * view to offer when the tape has nothing under it either.
   */
  unmatched?: { nearest: string[] } | null;
  /** How many days of the tape the trades cover. */
  days: number;
  trades: CdsTrade[];
}

export type CdsActivityLoader = (issuer: string | null) => Promise<CdsActivity>;

export type CdsFetch = (params: { issuer?: string; days?: number; limit?: number }) => Promise<CloudCdsResponse>;
export type InstrumentSearch = (query: string, limit?: number) => Promise<InstrumentSearchResult[]>;
/** The names of the issuers whose 5Y line has a level, as the tape spells them. */
export type CoveredIssuers = () => Promise<readonly string[]>;

/**
 * A ticker as typed: symbol punctuation, no spaces, and no lowercase letter.
 * `WHR` and `BRK.B` are tickers; `goodyear` and `Paramount` are names.
 */
const TICKER_LIKE = /^[A-Z0-9][A-Z0-9.^:-]{0,11}$/;
const US_PRIMARY_EXCHANGES = new Set(["AMEX", "NASDAQ", "NYSE", "NYSEAMERICAN", "NYSEARCA"]);

/** The US venues besides the primary exchanges a listing can trade on: a receipt's or a delisted company's line. */
const US_OTHER_EXCHANGES = new Set(["ARCA", "BATS", "IEX", "OTC", "OTCMKTS", "PNK"]);

const listingExchange = (result: InstrumentSearchResult) => (result.primaryExchange || result.exchange).toUpperCase().replace(/[^A-Z]/g, "");

function isPrimaryUsCommonStock(result: InstrumentSearchResult): boolean {
  const type = result.type.toLowerCase();
  return result.currency === "USD"
    && US_PRIMARY_EXCHANGES.has(listingExchange(result))
    && (type === "stk" || type === "equity" || type.includes("common stock"));
}

/** A line on a US venue in dollars (a receipt, a line over the counter); a listing abroad is not one. */
function isUsLine(result: InstrumentSearchResult): boolean {
  const exchange = listingExchange(result);
  return (!result.currency || result.currency === "USD") && (US_PRIMARY_EXCHANGES.has(exchange) || US_OTHER_EXCHANGES.has(exchange));
}

/**
 * Whether a listing carries what was typed: the words in its name or a name
 * search knows it by (`searchAliases`), or a ticker it had (`formerIssuer`:
 * BRCM on Broadcom Inc.). The first US hit for a name that does not is
 * another company.
 */
function carriesTyped(result: InstrumentSearchResult, typed: string): boolean {
  const symbol = typed.toUpperCase();
  if (result.formerIssuer?.symbol?.toUpperCase() === symbol) return true;
  return [result.name, ...result.searchAliases ?? [], result.formerIssuer?.name]
    .some((name) => !!name && coveredIssuerMatch(typed, [name]) != null);
}

/** The covered issuers' names, from the same request as their levels. */
export function coveredIssuersFrom(fetchLevels: CdsLevelsFetch): CoveredIssuers {
  return async () => ((await fetchLevels()).levels ?? []).flatMap((level) => (typeof level.issuer === "string" ? [level.issuer] : []));
}

const defaultCoveredIssuers = coveredIssuersFrom(() => apiClient.getCloudCdsLevels());

async function searchOrNone(searchInstruments: InstrumentSearch, query: string): Promise<InstrumentSearchResult[]> {
  try {
    return await searchInstruments(query);
  } catch {
    // Intentional ignore: a search outage sends the name as typed instead of failing the CDS request.
    return [];
  }
}

async function coveredOrNone(coveredIssuers: CoveredIssuers): Promise<readonly string[]> {
  try {
    return await coveredIssuers();
  } catch {
    // Intentional ignore: without the covered list the name goes on to the listing and the tape.
    return [];
  }
}

interface CdsIssuerResolution {
  /** The name the tape is asked for. */
  issuer: string;
  /** Set when a name matched no covered issuer; see `CdsActivity.unmatched`. */
  unmatched: { nearest: string[] } | null;
}

/**
 * The backend matches DTCC issuer names, so what was typed has to become one.
 *
 * Any one-word input, whatever its case (`CHTR`, `chtr`), is first looked up
 * among the tickers whose debt sits with another entity: CHTR is CCO
 * Holdings, LLC.
 *
 * A ticker (`WHR`) becomes the listed company's name without its share class
 * ("Alphabet Inc.", not "Alphabet Inc. Class A Common Stock"): its primary US
 * common stock where exchanges reuse the symbol, else its US line. An
 * untracked symbol has no local metadata to expand it, and its quote name
 * never arrives for a fixed binding, so the shared instrument search is the
 * only reliable expansion.
 *
 * Then the names of the covered issuers (`goodyear`, `GOODYEAR`, `paramount `
 * are The Goodyear Tire & Rubber Company and Paramount Global), by words of
 * three letters or more: `f` and `ge` go to the symbol they are. Only then a
 * listing abroad with that exact symbol, and only when it names a covered
 * issuer: Goodyear India, the first hit for `goodyear`, is no CDS name. Last,
 * the primary US common stock with the symbol, or the first one whose name
 * carries what was typed. Nothing matched, the input goes to the tape as
 * typed, with the covered issuers closest to it.
 *
 * A longer name in capitals and lowercase is already a company name and is
 * sent as written. A search outage falls back to the raw input rather than
 * taking the CDS request down with it.
 */
async function resolveCdsIssuer(
  query: string,
  searchInstruments: InstrumentSearch,
  coveredIssuers: CoveredIssuers = defaultCoveredIssuers,
): Promise<CdsIssuerResolution> {
  const ticker = TICKER_LIKE.test(query);
  const oneWord = !/\s/.test(query);
  if (!oneWord && query !== query.toLowerCase()) return { issuer: issuerNameOf(query), unmatched: null };
  const referenceEntity = oneWord ? cdsReferenceEntity(query) : null;
  if (referenceEntity) return { issuer: referenceEntity, unmatched: null };
  const symbol = query.toUpperCase();
  let results: InstrumentSearchResult[] | null = null;
  let abroad: InstrumentSearchResult | undefined;
  if (ticker) {
    results = await searchOrNone(searchInstruments, query);
    const exactMatches = results.filter((result) => result.symbol.toUpperCase() === symbol);
    const name = (exactMatches.find(isPrimaryUsCommonStock) ?? exactMatches.find(isUsLine))?.name?.trim();
    if (name) return { issuer: issuerNameOf(name), unmatched: null };
    abroad = exactMatches.find((result) => !!result.name?.trim());
  }
  const covered = await coveredOrNone(coveredIssuers);
  const named = coveredIssuerMatch(query, covered);
  if (named) return { issuer: named, unmatched: null };
  // A line abroad never wins on its own: only as the covered issuer it names.
  const abroadIssuer = abroad ? coveredIssuerMatch(issuerNameOf(abroad.name.trim()), covered) : null;
  if (abroadIssuer) return { issuer: abroadIssuer, unmatched: null };
  results ??= await searchOrNone(searchInstruments, query);
  const primary = results.filter(isPrimaryUsCommonStock);
  const listing = (primary.find((result) => result.symbol.toUpperCase() === symbol) ?? primary.find((result) => carriesTyped(result, query)))?.name?.trim();
  if (listing) {
    const issuer = issuerNameOf(listing);
    const listed = coveredIssuerMatch(issuer, covered);
    return listed
      ? { issuer: listed, unmatched: null }
      : { issuer, unmatched: { nearest: closestCoveredIssuers(query, covered) } };
  }
  return { issuer: ticker ? query : issuerNameOf(query), unmatched: { nearest: closestCoveredIssuers(query, covered) } };
}

/** The name `resolveCdsIssuer` sends to the tape, for a caller that only needs that. */
export async function resolveIssuerName(
  issuer: string,
  searchInstruments: InstrumentSearch,
  coveredIssuers?: CoveredIssuers,
): Promise<string> {
  return (await resolveCdsIssuer(issuer, searchInstruments, coveredIssuers)).issuer;
}

export async function loadCdsActivity(
  issuer: string | null,
  fetchCds: CdsFetch = (params) => apiClient.getCloudCds(params),
  searchInstruments: InstrumentSearch = (query, limit) => apiClient.searchInstruments(query, limit),
  coveredIssuers: CoveredIssuers = defaultCoveredIssuers,
): Promise<CdsActivity> {
  const query = issuer?.trim() || null;
  const resolved = query ? await resolveCdsIssuer(query, searchInstruments, coveredIssuers) : null;
  const response = await fetchCds({
    ...(resolved ? { issuer: resolved.issuer } : {}),
    days: CDS_TRADE_DAYS,
    limit: CDS_TRADE_LIMIT,
  });
  return {
    source: response.source,
    asOf: response.asOf,
    query,
    issuer: resolved?.issuer ?? null,
    ...(resolved?.unmatched ? { unmatched: resolved.unmatched } : {}),
    days: CDS_TRADE_DAYS,
    trades: normalizeCdsTrades(response.trades ?? []),
  };
}

/** Two years: what DTCC keeps readable, so the backend holds no more. */
const CDS_SPREAD_HISTORY_DAYS = 730;

export interface CdsSpreadHistory extends CdsSpreadLine {
  issuer: string | null;
  points: CloudCdsHistoryPointPayload[];
  /** Why the line has no level in the month to its newest print, when the server can say. */
  noLevelReason: CdsNoLevelReason | null;
}

const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const NO_UPFRONT_LINE = { quote: "spread", couponBp: null, upfrontPts: null, change1WPts: null, change1MPts: null } as const;

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
  const upfrontPts = finiteOrNull(response.upfrontPts);
  return {
    issuer: response.issuer,
    points,
    change1W: finiteOrNull(response.change1W),
    change1M: finiteOrNull(response.change1M),
    // A server before points upfront, or a level it could not convert, stays in bp.
    ...(response.quote === "upfront" && upfrontPts != null ? {
      quote: "upfront" as const,
      couponBp: finiteOrNull(response.couponBp),
      upfrontPts,
      change1WPts: finiteOrNull(response.change1WPts),
      change1MPts: finiteOrNull(response.change1MPts),
    } : NO_UPFRONT_LINE),
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
