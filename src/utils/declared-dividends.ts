import type { CorporateActionsData, DeclaredDividendAction, DividendNoticeSource } from "../types/financials";
import { formatDistributionAmount } from "./format";
import { normalizedHttpUrl } from "./url";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A paid row this close to a declared one is that distribution, dated a day apart. */
const SAME_DISTRIBUTION_DAYS = 3;
const DAY_MS = 86_400_000;

export function dividendNoticeSource(raw: DividendNoticeSource | undefined): DividendNoticeSource | undefined {
  const publisher = typeof raw?.publisher === "string" ? raw.publisher.trim() : "";
  const url = normalizedHttpUrl(raw?.url);
  if (!publisher || !url) return undefined;
  const scheduleUrl = normalizedHttpUrl(raw?.scheduleUrl);
  return { publisher, url, ...(scheduleUrl ? { scheduleUrl } : {}) };
}

export function declaredDividendCash(row: DeclaredDividendAction, currency?: string | null): { amount: string; estimate?: string } {
  const cash = currency ? formatDistributionAmount(row.amount, currency) : String(row.amount);
  const estimate = row.cashEstimate;
  if (!estimate || estimate.declaredAmount == null) return { amount: cash };
  return {
    amount: `${formatDistributionAmount(estimate.declaredAmount, estimate.declaredCurrency)} ${estimate.declaredCurrency}`,
    estimate: `${currency || "Cash"} estimated ${cash}; FX ${estimate.fixingDate ? `fixing ${estimate.fixingDate}` : "fixing unavailable"}${estimate.basis ? `; ${estimate.basis}` : ""}`,
  };
}

function isoDate(value: unknown): string | undefined {
  return typeof value === "string" && ISO_DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : undefined;
}

/**
 * The declared, unpaid distributions a corporate actions payload carries,
 * oldest first: rows the source states with a real ex-date and amount, still
 * owed today (not yet paid, or with no pay date, not yet ex), and not in the
 * paid history yet. Kept apart from `dividends`, which history, yields and
 * growth read. A server that does not send them, or a listing it has none
 * for, gives none.
 */
export function declaredDividends(
  actions: Pick<CorporateActionsData, "dividends" | "declaredDividends"> | null | undefined,
  now = new Date(),
): DeclaredDividendAction[] {
  if (!Array.isArray(actions?.declaredDividends)) return [];
  const today = now.toISOString().slice(0, 10);
  const paid = (actions.dividends ?? []).map((payment) => Date.parse(`${payment.exDate}T00:00:00Z`));
  return actions.declaredDividends.flatMap((row): DeclaredDividendAction[] => {
    const exDate = isoDate(row?.exDate);
    if (!exDate || typeof row.amount !== "number" || !Number.isFinite(row.amount) || row.amount <= 0) return [];
    const payDate = isoDate(row.payDate);
    const declarationDate = isoDate(row.declarationDate);
    const recordDate = isoDate(row.recordDate);
    if ((payDate ?? exDate) < today) return [];
    const at = Date.parse(`${exDate}T00:00:00Z`);
    if (paid.some((time) => Math.abs(time - at) <= SAME_DISTRIBUTION_DAYS * DAY_MS)) return [];
    const source = dividendNoticeSource(row.source);
    return [{ exDate, amount: row.amount, ...declarationDate ? { declarationDate } : {},
      ...recordDate ? { recordDate } : {}, ...payDate ? { payDate } : {}, ...row.special === true ? { special: true as const } : {},
      ...row.cashEstimate ? { cashEstimate: row.cashEstimate } : {}, ...source ? { source } : {} }];
  }).sort((left, right) => left.exDate.localeCompare(right.exDate));
}
