/**
 * Public records about companies in difficulty: US 8-K filings under the
 * bankruptcy, obligation and listing items, SEC going-concern disclosures,
 * exchange listing designations and company insolvency notices. Every route
 * is anonymous; field names follow the server, which serves the last three in
 * snake case.
 */
import type { CloudFilingEventPayload } from "./types";

/** `distress` is Items 1.03 and 2.04; `listing` is Item 3.01. */
export type DistressFilingKind = "distress" | "listing";

export interface DistressFilingsParams {
  kind: DistressFilingKind;
  /** 1 to 200; the route has no offset, so this is the whole list. */
  limit?: number;
}

export interface DistressFilingsPayload {
  events: CloudFilingEventPayload[];
}

export type GoingConcernVerdict = "doubt_raised" | "doubt_alleviated" | "policy_only" | "unclear";

export interface GoingConcernParams {
  verdict?: GoingConcernVerdict;
  limit?: number;
  offset?: number;
}

export interface GoingConcernDisclosure {
  id: string;
  cik: string;
  /** Venue-qualified trading symbol (`BMRA:NASDAQ`), null for a filer without one. */
  ticker: string | null;
  accession: string;
  form: string;
  period_end: string | null;
  filed_at: string;
  fact_date: string | null;
  tag: string;
  verdict: GoingConcernVerdict;
  /** Whether the filing frames its assessment over one year; null when it does not say. */
  within_one_year: boolean | null;
  source_within_one_year: boolean | null;
  summary: string;
  quote: string;
  text: string;
  text_truncated: boolean;
  dataset_month: string;
  company: { ticker: string; cik: string | null; name: string; shortName: string };
  filing_url: string;
}

export interface GoingConcernPayload {
  disclosures: GoingConcernDisclosure[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

export type DesignationDateBasis = "designation" | "effective" | "first_observed";

export interface DistressDesignationsParams {
  kind?: string;
  exchange?: string;
  limit?: number;
  offset?: number;
}

export interface DistressDesignation {
  id: string;
  source: string;
  region: string;
  exchange: string;
  /** Canonical listing key, e.g. `2867:TWSE`. */
  symbol: string | null;
  local_code: string;
  entity_name: string;
  entity_name_en: string | null;
  market_segment: string | null;
  /** `delisted`, `changed_trading_method` or `suspended`. */
  kind: string;
  designated_at: string | null;
  effective_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  ended_at: string | null;
  remarks: string;
  source_url: string;
  notice_url: string | null;
  date_basis: DesignationDateBasis;
}

/** The licence terms a source's rows are published under, reproduced with them. */
export interface DistressAttribution {
  source: string;
  organization: string;
  dataset: string | null;
  version: string | null;
  year: number | null;
  datasetUrls: string[];
  licence: string;
  licenceUrl: string;
  notice: string;
}

export interface DistressDesignationsPayload {
  designations: DistressDesignation[];
  hasMore: boolean;
  limit: number;
  offset: number;
  attributions: DistressAttribution[];
}

export interface InsolvencyNoticesParams {
  country?: string;
  kind?: string;
  /** Company name prefix, two characters or more. */
  name_prefix?: string;
  limit?: number;
  offset?: number;
}

export interface InsolvencyNotice {
  source: string;
  country: string;
  /** SIREN in France, the Companies House number in the UK. */
  registry_id: string;
  entity_name: string;
  symbol: string | null;
  kind: string;
  /** The official judgment label (France) or Gazette notice code (UK). */
  raw_code: string;
  /** Judgment or procedure date, when the notice states one. */
  notice_date: string | null;
  published_date: string;
  court: string;
  notice_id: string;
  notice_url: string;
  /** `annonce`, `rectificatif` or `annulation`. */
  notice_type: string;
  original_notice_id: string | null;
  /** `active`, `superseded` or `cancelled`. */
  status: string;
}

export interface InsolvencyNoticesPayload {
  notices: InsolvencyNotice[];
  hasMore: boolean;
  limit: number;
  offset: number;
  attributions: DistressAttribution[];
}

/** `?a=1&b=2` from the defined, non-empty values; empty when there are none. */
export function distressQuery(params: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
