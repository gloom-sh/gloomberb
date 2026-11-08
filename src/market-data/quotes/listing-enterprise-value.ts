import type { EnterpriseValueCheck, TickerFinancials } from "../../types/financials";
import {
  enterpriseValueCheck, enterpriseValueNotMeaningful, enterpriseValueWithdrawn, reportedEnterpriseValue, withBankEnterpriseValue,
} from "../../utils/fundamentals";
import { atRegularSessionPrice } from "./regular-session-valuation";

export type ListingEnterpriseValue =
  | {
    kind: "value";
    value: number;
    currency: string;
    /** `computed`: market cap + total debt - cash, standing in for a provider figure Gloom Cloud withdrew. */
    basis: "served" | "computed";
    /** The withdrawn check a computed EV comes from, which names its balance sheet and rate. */
    check?: EnterpriseValueCheck;
  }
  | { kind: "not-meaningful"; reason: string }
  | { kind: "unavailable" };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The enterprise value every surface divides, at the regular session price:
 * the one Gloom Cloud serves (`valuation`'s EV, RV's EV/S, the screener's
 * EV/EBITDA), or, where it withdrew the provider's figure against the balance
 * sheet, the market cap + total debt - cash it checked that figure against.
 * Not meaningful at or below zero and for a bank.
 */
export function listingEnterpriseValue(financials: Pick<TickerFinancials, "quote" | "fundamentals" | "profile">): ListingEnterpriseValue {
  const priced = atRegularSessionPrice({ quote: financials.quote, fundamentals: withBankEnterpriseValue(financials.fundamentals, financials.profile) });
  const fundamentals = priced.fundamentals;
  const notMeaningful = enterpriseValueNotMeaningful(fundamentals);
  if (notMeaningful) return { kind: "not-meaningful", reason: notMeaningful };
  const check = enterpriseValueCheck(fundamentals);
  const served = reportedEnterpriseValue(fundamentals);
  const currency = check?.currency ?? fundamentals?.marketCapCurrency ?? priced.quote?.currency;
  if (served != null) return currency ? { kind: "value", value: served, currency, basis: "served" } : { kind: "unavailable" };
  if (enterpriseValueWithdrawn(fundamentals) && check?.status === "withdrawn" && finite(check.computed) && check.currency) {
    return check.computed > 0
      ? { kind: "value", value: check.computed, currency: check.currency, basis: "computed", check }
      : { kind: "not-meaningful", reason: "Cash and short-term investments exceed market cap + total debt" };
  }
  return { kind: "unavailable" };
}
