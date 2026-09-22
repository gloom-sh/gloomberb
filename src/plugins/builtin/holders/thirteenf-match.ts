import { listThirteenFForms, searchThirteenFFunds } from "../thirteenf/api";
import { buildPeriodReports, dateYearsAgo, todayIso } from "../thirteenf/model";
import type { HolderRow } from "./types";

export interface Holder13FMatch {
  cik: string;
  fundName: string;
  periodOfReport?: string;
  filedAsOfDate?: string;
  tableValueTotal?: number | null;
}

const HOLDER_MATCH_LIMIT = 25;
const HOLDER_MATCH_CONCURRENCY = 4;

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|ltd|lp|corp|corporation|co|company|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ambiguous manager names must remain unlinked, not choose the first search hit. */
export function bestFundMatch(holderName: string, funds: Array<{ cik: string; name: string }>) {
  const normalizedHolder = normalizeName(holderName);
  if (!normalizedHolder) return undefined;
  const unique = [...new Map(funds.map(fund => [fund.cik, fund])).values()];
  const exact = unique.filter(fund => normalizeName(fund.name) === normalizedHolder);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const matches = unique.filter(fund => {
    const normalizedFund = normalizeName(fund.name);
    if (!normalizedFund) return false;
    const shorter = normalizedFund.length < normalizedHolder.length ? normalizedFund : normalizedHolder;
    const longer = normalizedFund.length < normalizedHolder.length ? normalizedHolder : normalizedFund;
    return shorter.split(" ").length >= 2 && ` ${longer} `.includes(` ${shorter} `);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export async function loadHolder13FMatches(
  rows: HolderRow[],
  signal: AbortSignal,
): Promise<Map<string, Holder13FMatch>> {
  const now = new Date();
  const from = dateYearsAgo(2, now);
  const to = todayIso(now);
  const matches = new Map<string, Holder13FMatch>();
  const sourceRows = rows.filter((row) => row.name).slice(0, HOLDER_MATCH_LIMIT);

  let index = 0;
  async function worker() {
    while (!signal.aborted && index < sourceRows.length) {
      const row = sourceRows[index++];
      if (!row) continue;
      try {
        const funds = await searchThirteenFFunds(row.name, 25, signal);
        if (funds.length >= 25) continue;
        const fund = bestFundMatch(row.name, funds);
        if (!fund) continue;
        const forms = await listThirteenFForms(fund.cik, from, to, 100, signal);
        const report = buildPeriodReports(forms)[0];
        const form = report?.filings.at(-1);
        matches.set(row.id, {
          cik: fund.cik,
          fundName: fund.name,
          periodOfReport: form?.periodOfReport,
          filedAsOfDate: form?.filedAsOfDate,
          tableValueTotal: report?.complete && forms.length < 100 ? report.tableValueTotal : null,
        });
      } catch {
        // Matching 13F metadata is an enhancement; holder rows should remain usable.
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(HOLDER_MATCH_CONCURRENCY, sourceRows.length) },
    () => worker(),
  ));

  return matches;
}
