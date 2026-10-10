import { apiClient } from "../../../api-client";
import type {
  BeneficialOwnerFiling,
  BeneficialOwnerReportingPerson,
  BeneficialOwnerStatus,
  BeneficialOwnersForm,
  BeneficialOwnersPayload,
} from "../../../api-client/beneficial-owners";
import { ApiRequestError, isAccessDenied } from "../../../api-client/errors";
import { listingAbroad, type IssuerListingParams } from "../../../api-client/paths";
import { createPluginCache } from "../../../data/plugin-cache";
import { secListingKey } from "../../../utils/sec";
import { finiteOrNull, recordOrNull } from "../../../utils/guards";
import { cachedCloudResource, loadCloudResource, type CloudResource } from "../shared/cloud-resource";
import { CLOUD_SESSION_REQUIRED } from "../shared/research-cloud-session";

/** One page of the route; the loader follows `nextOffset` until it has every report. */
const PAGE_SIZE = 100;
/** More than any issuer has filers; a history this long is cut and marked incomplete. */
const MAX_ROWS = 2_000;

export const beneficialOwnersCache = createPluginCache<BeneficialOwnersPayload>({
  kind: "beneficial-owners",
  source: "gloom-cloud",
  schemaVersion: 1,
  policy: { staleMs: 30 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

export interface BeneficialOwnersRequest {
  form?: BeneficialOwnersForm;
  /** Every report instead of the latest per filer. */
  history?: boolean;
  /** The listing's venue and company, for a listing outside the US. */
  listing?: IssuerListingParams;
}

type BeneficialOwnersClient = Pick<typeof apiClient, "getCloudSecBeneficialOwners">;

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const isoDate = (value: unknown): string | null => {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
};
const cikOrNull = (value: unknown): string | null => {
  const raw = typeof value === "number" ? String(value) : text(value);
  return raw && /\d/.test(raw) ? raw : null;
};

function normalizeReportingPerson(value: unknown): BeneficialOwnerReportingPerson | null {
  const raw = recordOrNull(value);
  const name = text(raw?.name);
  if (!raw || !name) return null;
  return { name, cik: cikOrNull(raw.cik), percentOfClass: finiteOrNull(raw.percentOfClass), shares: finiteOrNull(raw.shares) };
}

const STATUSES: readonly BeneficialOwnerStatus[] = ["holder", "below-threshold", "exited"];

/**
 * A report as the table can trust it. Fields the route adds later pass
 * through; a report without a filer, accession or filing date is dropped,
 * and a number that is not one stays null instead of being guessed. History
 * reports carry no previous report or status, and none is made up for them.
 */
function normalizeBeneficialOwnerFiling(value: unknown): BeneficialOwnerFiling | null {
  const raw = recordOrNull(value);
  if (!raw) return null;
  const filerName = text(raw.filerName);
  const accessionNumber = text(raw.accessionNumber);
  const filingDate = isoDate(raw.filingDate);
  const form = text(raw.form) ?? "";
  const kind = raw.kind === "13D" || raw.kind === "13G" ? raw.kind
    : /13D/i.test(form) ? "13D" : /13G/i.test(form) ? "13G" : null;
  if (!filerName || !accessionNumber || !filingDate || !kind) return null;
  const source = raw.source === "xml" || raw.source === "text" ? raw.source : "index";
  return {
    ...raw,
    filerCik: cikOrNull(raw.filerCik),
    filerName,
    form: form || `SCHEDULE ${kind}`,
    kind,
    amendment: raw.amendment === true || /\/A\b/i.test(form),
    amendmentNo: finiteOrNull(raw.amendmentNo),
    percentOfClass: finiteOrNull(raw.percentOfClass),
    shares: finiteOrNull(raw.shares),
    classTitle: text(raw.classTitle),
    cusip: text(raw.cusip),
    eventDate: isoDate(raw.eventDate),
    filingDate,
    accessionNumber,
    filingUrl: text(raw.filingUrl) ?? "",
    previousPercent: "previousPercent" in raw ? finiteOrNull(raw.previousPercent) : undefined,
    previousFilingDate: "previousFilingDate" in raw ? isoDate(raw.previousFilingDate) : undefined,
    status: STATUSES.includes(raw.status as BeneficialOwnerStatus) ? raw.status as BeneficialOwnerStatus : undefined,
    provisional: raw.provisional === true ? true : undefined,
    source,
    reportingPersons: Array.isArray(raw.reportingPersons)
      ? raw.reportingPersons.map(normalizeReportingPerson).filter((person) => person != null)
      : [],
  };
}

function normalizeFilings(value: unknown): BeneficialOwnerFiling[] {
  return Array.isArray(value)
    ? value.map(normalizeBeneficialOwnerFiling).filter((filing) => filing != null)
    : [];
}

function normalizeBeneficialOwnersPayload(value: unknown, ticker: string): BeneficialOwnersPayload {
  const raw = recordOrNull(value);
  if (!raw || !Array.isArray(raw.owners)) throw new Error("The server returned an invalid 13D/13G list");
  const coverage = recordOrNull(raw.coverage);
  const nextOffset = finiteOrNull(raw.nextOffset);
  return {
    ...raw,
    ticker: text(raw.ticker) ?? ticker,
    cik: cikOrNull(raw.cik) ?? "",
    companyName: text(raw.companyName) ?? "",
    asOf: text(raw.asOf),
    owners: normalizeFilings(raw.owners),
    ...(Array.isArray(raw.filings) ? { filings: normalizeFilings(raw.filings) } : {}),
    hasMore: raw.hasMore === true && nextOffset != null,
    nextOffset,
    coverage: coverage ? {
      ...coverage,
      from: isoDate(coverage.from),
      filings: finiteOrNull(coverage.filings) ?? 0,
      parsed: finiteOrNull(coverage.parsed) ?? 0,
      unparsed: finiteOrNull(coverage.unparsed) ?? 0,
      unavailable: finiteOrNull(coverage.unavailable) ?? 0,
    } : null,
  };
}

function describeFailure(error: unknown, ticker: string): unknown {
  if (isAccessDenied(error)) return new Error(CLOUD_SESSION_REQUIRED);
  // An unknown ticker, and a server that does not serve the route yet.
  if (error instanceof ApiRequestError && error.status === 404) {
    return new Error(`13D/13G filings are not available for ${ticker}.`);
  }
  return error;
}

/**
 * Every page of the issuer's reports: the latest per filer, or with
 * `history` every report. A list cut at the row cap keeps `hasMore`.
 */
export async function fetchBeneficialOwners(
  ticker: string,
  { form = "all", history = false, listing }: BeneficialOwnersRequest = {},
  { client = apiClient, signal }: { client?: BeneficialOwnersClient; signal?: AbortSignal } = {},
): Promise<BeneficialOwnersPayload> {
  const symbol = ticker.trim().toUpperCase();
  try {
    let offset = 0;
    let first: BeneficialOwnersPayload | null = null;
    const owners: BeneficialOwnerFiling[] = [];
    const filings: BeneficialOwnerFiling[] = [];
    for (;;) {
      const page = normalizeBeneficialOwnersPayload(await client.getCloudSecBeneficialOwners({
        ticker: symbol,
        exchange: listing?.exchange,
        name: listing?.name,
        form,
        history,
        limit: PAGE_SIZE,
        offset,
      }, { signal }), symbol);
      first ??= page;
      owners.push(...page.owners);
      filings.push(...(page.filings ?? []));
      const loaded = history ? filings.length : owners.length;
      const nextOffset = page.nextOffset ?? 0;
      if (!page.hasMore || nextOffset <= offset || loaded >= MAX_ROWS) {
        return {
          ...first,
          asOf: page.asOf ?? first.asOf,
          coverage: page.coverage ?? first.coverage,
          owners: dedupe(owners),
          ...(history ? { filings: dedupe(filings) } : {}),
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
        };
      }
      offset = nextOffset;
    }
  } catch (error) {
    // A listing abroad whose company the SEC does not know has no reports.
    const abroad = listingAbroad(symbol, listing?.exchange);
    if (abroad && error instanceof ApiRequestError && error.status === 404) return noReports(symbol, history);
    throw describeFailure(error, symbol);
  }
}

function noReports(ticker: string, history: boolean): BeneficialOwnersPayload {
  return {
    ticker, cik: "", companyName: "", asOf: null, owners: [], ...(history ? { filings: [] } : {}),
    hasMore: false, nextOffset: null, coverage: null,
  };
}

/** Pages can overlap when a report lands between two requests. */
function dedupe(rows: BeneficialOwnerFiling[]): BeneficialOwnerFiling[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.accessionNumber}:${row.filerCik ?? row.filerName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// SAN in Paris is not SAN in New York: a listing abroad is cached under its venue.
const cacheKey = (ticker: string, listing?: IssuerListingParams) => secListingKey(ticker, listing?.exchange);

export function cachedBeneficialOwners(ticker: string, listing?: IssuerListingParams): CloudResource<BeneficialOwnersPayload> | null {
  return cachedCloudResource(beneficialOwnersCache, cacheKey(ticker, listing));
}

/** The pane's list: the latest report per filer, both kinds, cached on disk. */
export async function loadBeneficialOwners(
  ticker: string,
  force = false,
  listing?: IssuerListingParams,
): Promise<CloudResource<BeneficialOwnersPayload>> {
  const key = cacheKey(ticker, listing);
  try {
    return await loadCloudResource(beneficialOwnersCache, key, () => fetchBeneficialOwners(ticker, { listing }), { force });
  } catch (error) {
    throw describeFailure(error, key);
  }
}
