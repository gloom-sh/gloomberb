import type { EarningsAction, FinancialStatement } from "../types/financials";
import { regularSessionCloseOn } from "../market-data/market/freshness";
import { financialAvailabilityTime } from "../utils/financial-statements";

/** A reported event for this fiscal quarter, never a projected calendar date. */
function releaseFor(statement: FinancialStatement, releases: readonly EarningsAction[]) {
  return releases.filter((release) => release.dateType !== "fiscal-period-end"
    && release.dateStatus === "reported"
    && release.fiscalPeriod === statement.date.slice(0, 7)
    && Date.parse(release.date) >= Date.parse(statement.date))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
}

/** Preserve dated inputs; an earnings release can precede the filing of the same period. */
export function statementAtRelease(statement: FinancialStatement, releases: readonly EarningsAction[], exchange?: string): FinancialStatement {
  const release = releaseFor(statement, releases);
  if (!release) return statement;
  const timestamp = release.reportedAt && Number.isFinite(Date.parse(release.reportedAt)) ? release.reportedAt : undefined;
  const beforeClose = /^(bmo|dmh|pre[ -]?market|before (?:open|market)|during (?:market|hours))$/i.test(release.time ?? "");
  const close = beforeClose ? regularSessionCloseOn(exchange, release.date) : null;
  // A known session establishes availability by its close. Unknown timing,
  // like an after-close release, takes effect on the following daily bar.
  const publication = timestamp ?? (close != null ? new Date(close).toISOString() : release.date);
  const earlier = (filed: string | undefined) => {
    if (!filed) return undefined;
    // A later comparative/restatement is not evidence that this value was in
    // the original release. Restrict the substitution to this period's filing.
    const lag = Date.parse(filed) - Date.parse(statement.date);
    return lag >= 0 && lag <= 120 * 86_400_000 && financialAvailabilityTime(publication) <= financialAvailabilityTime(filed)
      ? publication : filed;
  };
  return { ...statement,
    availableAt: earlier(statement.availableAt),
    ...(statement.fieldSources ? { fieldSources: Object.fromEntries(Object.entries(statement.fieldSources)
      .map(([field, source]) => [field, source && { ...source, filed: earlier(source.filed) }])) } : {}),
    ...(statement.fieldAvailability ? { fieldAvailability: Object.fromEntries(Object.entries(statement.fieldAvailability)
      .map(([field, filed]) => [field, earlier(filed)!])) } : {}),
  };
}
