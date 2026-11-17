import type { Portfolio, PortfolioCash } from "../types/ticker";
import { isRecord } from "../utils/guards";

/**
 * A manual portfolio's cash, one balance per currency (HKD and USD side by
 * side). The first balance is saved in `Portfolio.cash`, which every build
 * before several currencies reads, and the others in `Portfolio.otherCash`,
 * so such a build sees one valid balance and never a second copy of it.
 * Every reader takes the balances from `portfolioCashBalances`, which counts
 * each currency once, and every writer saves them with
 * `withPortfolioCashBalances`.
 */

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** A balance as saved: a finite amount in an upper-case ISO code; null for anything else. */
function savedBalance(value: unknown): PortfolioCash | null {
  if (!isRecord(value) || typeof value.amount !== "number" || !Number.isFinite(value.amount)) return null;
  return typeof value.currency === "string" && CURRENCY_CODE.test(value.currency)
    ? { amount: value.amount, currency: value.currency }
    : null;
}

/**
 * The portfolio's cash entered by hand, `cash` first and then the other
 * currencies in the order they were set. A currency is counted once: a
 * second entry of it (an older build that set `cash` to a currency
 * `otherCash` also holds) gives way to the first, which is `cash`.
 */
export function portfolioCashBalances(portfolio: Pick<Portfolio, "cash" | "otherCash"> | null | undefined): PortfolioCash[] {
  if (!portfolio) return [];
  const balances: PortfolioCash[] = [];
  const others: unknown[] = Array.isArray(portfolio.otherCash) ? portfolio.otherCash : [];
  for (const entry of [portfolio.cash, ...others]) {
    const balance = savedBalance(entry);
    if (balance && !balances.some((kept) => kept.currency === balance.currency)) balances.push(balance);
  }
  return balances;
}

/**
 * The portfolio holding these balances: the first in `cash`, the others in
 * `otherCash`, neither field when there are none. Each currency once, the
 * first entry of it kept.
 */
export function withPortfolioCashBalances<T extends object>(
  portfolio: T,
  balances: readonly PortfolioCash[],
): Omit<T, "cash" | "otherCash"> & Pick<Portfolio, "cash" | "otherCash"> {
  const { cash: _cash, otherCash: _otherCash, ...rest } = portfolio as T & Pick<Portfolio, "cash" | "otherCash">;
  const [first, ...others] = portfolioCashBalances({ otherCash: [...balances] });
  return {
    ...rest,
    ...(first ? { cash: first } : {}),
    ...(others.length > 0 ? { otherCash: others } : {}),
  };
}

/**
 * A pulled portfolio from a build that does not send `otherCash` (an older
 * desktop build, which strips it from every push), keeping the other
 * currencies this device holds. That build saw `cash` alone, so its `cash`
 * stands, set, replaced or cleared, and a balance here in that same currency
 * gives way to it rather than counting twice. Anything else is taken as it
 * came.
 */
export function withKeptOtherCash(pulled: unknown, local: Pick<Portfolio, "cash" | "otherCash"> | null | undefined): unknown {
  if (!isRecord(pulled) || pulled.otherCash !== undefined || !local) return pulled;
  const [, ...others] = portfolioCashBalances(local);
  if (others.length === 0) return pulled;
  const seen = savedBalance(pulled.cash);
  return withPortfolioCashBalances(pulled, [
    ...(seen ? [seen] : []),
    ...others.filter((balance) => balance.currency !== seen?.currency),
  ]);
}
