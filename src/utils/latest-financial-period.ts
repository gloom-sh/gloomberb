/** A source-reported calendar period end, without rolling impossible dates forward. */
function isFinancialPeriodDate(period: unknown): period is string {
  if (typeof period !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(period)) return false;
  const date = new Date(`${period}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === period;
}

/** Select a reported calendar period, without inferring dates or merging revisions. */
export function latestFinancialPeriod<T>(
  rows: readonly T[] | undefined,
  periodOf: (row: T) => string,
): T | undefined {
  let latest: T | undefined;
  let latestPeriod = "";
  for (const row of rows ?? []) {
    const period = periodOf(row);
    if (!isFinancialPeriodDate(period)) continue;
    // Equal periods retain the source's last row, as the previous positional
    // lookup did. A filing/publication date is not a reporting-period end.
    if (period >= latestPeriod) {
      latest = row;
      latestPeriod = period;
    }
  }
  return latest;
}
