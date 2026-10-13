/** Names per request: one page of a list, such as a clinical trial search page's lead sponsors. */
export const ORGANIZATION_TICKERS_BATCH_LIMIT = 50;

/**
 * What Gloom Cloud resolved an organization name to: the listing of the
 * company the name belongs to, or why there is none. The match is the
 * server's, from reviewed and exact aliases only; the app never matches a
 * name to a ticker itself.
 */
export interface OrganizationTicker {
  name: string;
  /** Null when the name is unlinked, ambiguous, or resolved to a company without a listing. */
  ticker: string | null;
  exchange: string | null;
  /** The company the name resolved to; null when unlinked. */
  entityName: string | null;
  resolution: "identifier" | "alias" | "unresolved";
  /** Left unlinked because the name fits more than one company. */
  ambiguous: boolean;
}

export interface OrganizationTickersResponse {
  results: OrganizationTicker[];
}

function isResult(value: unknown): value is OrganizationTicker {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const text = (field: unknown) => field === null || typeof field === "string";
  return typeof row.name === "string"
    && text(row.ticker) && text(row.exchange) && text(row.entityName)
    && (row.resolution === "identifier" || row.resolution === "alias" || row.resolution === "unresolved")
    && typeof row.ambiguous === "boolean";
}

/** The answers in the order asked; throws when the server answered something else. */
export function validateOrganizationTickers(payload: unknown, names: readonly string[]): OrganizationTicker[] {
  const results = (payload as Partial<OrganizationTickersResponse> | null)?.results;
  if (!Array.isArray(results) || results.length !== names.length || !results.every(isResult)
    || results.some((result, index) => result.name !== names[index])) {
    throw new Error("The server returned invalid organization tickers.");
  }
  return results;
}
