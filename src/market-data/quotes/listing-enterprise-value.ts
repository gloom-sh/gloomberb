import type { BalanceSheetRate, EnterpriseValueCheck, FinancialStatement, TickerFinancials } from "../../types/financials";
import { cashAndShortTermInvestments } from "../../utils/cash-runway";
import { formatShortDate } from "../../utils/datetime-format";
import { formatCompact } from "../../utils/format";
import {
  enterpriseValueCheck, enterpriseValueNotMeaningful, enterpriseValueWithdrawn, reportedEnterpriseValue, withBankEnterpriseValue,
} from "../../utils/fundamentals";
import { debtAndLeases, leaseBasis } from "../../utils/lease-liabilities";
import { atRegularSessionPrice } from "./regular-session-valuation";

/**
 * Market cap + total debt (+ leases) - cash + minority interest and preferred
 * equity on one balance sheet, in the market cap's currency: what stands in
 * for a source EV Gloom Cloud withdrew. Every amount is converted already.
 */
export interface EnterpriseValueBridge {
  /** The balance sheet's date, YYYY-MM-DD. */
  sheetDate: string;
  marketCap: number;
  totalDebt: number;
  /** The lease liabilities added to debt (0 where the listing's are not, leaseBasis). */
  leases: number;
  cash: number;
  /** What `cash` holds: the reported total with short-term investments, or cash and equivalents alone. */
  cashBasis: "cash and short-term investments" | "cash";
  /** Null where the balance sheet has no line to read it from: named, never counted as zero. */
  minority: number | null;
  /**
   * A balance sheet in another currency, converted at the close of `from` in `to` on or before its date: `closeDate`
   * where we read it (withBalanceSheetRate); null for Gloom Cloud's bridge, which does not say.
   */
  fx: { from: string; to: string; rate: number; closeDate: string | null } | null;
  /** The source's figure that failed against the balance sheet, where it served one. */
  source: number | null;
  /** The currency the source converted its figure from twice, where that is why it failed. */
  convertedTwice?: string;
}

export type ListingEnterpriseValue =
  | {
    kind: "value";
    value: number;
    currency: string;
    /** `computed`: the bridge, standing in for a provider figure Gloom Cloud withdrew. */
    basis: "served" | "computed";
    /** The withdrawn check a bridge Gloom Cloud computed comes from. */
    check?: EnterpriseValueCheck;
    /** The bridge with its inputs, for a computed EV. */
    bridge?: EnterpriseValueBridge;
    /**
     * The rate the EV's balance sheet converted the statements' currency at
     * (an ADR's EUR or TWD into its USD EV), from any check or bridge that names one.
     */
    fx?: { from: string; rate: number };
  }
  | { kind: "not-meaningful"; reason: string }
  /** `needs`: what a bridge in place of a withdrawn EV lacks ("total debt on the Jun 30, 2026 balance sheet"). */
  | { kind: "unavailable"; needs?: string };

type EnterpriseValueInputs = Pick<TickerFinancials, "quote" | "fundamentals" | "profile">
  & Partial<Pick<TickerFinancials, "annualStatements" | "quarterlyStatements" | "balanceSheetRate">>;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const DAY_MS = 86_400_000;
/** A balance sheet older than this does not price today's EV, as Gloom Cloud's bridge holds. */
export const BALANCE_SHEET_MAX_AGE_DAYS = 550;

/** "Jun 30, 2026": a balance sheet's day as the reports write a date. */
export const balanceSheetDay = (date: string) => formatShortDate(`${date.slice(0, 10)}T00:00:00Z`, { utc: true, fallback: date.slice(0, 10) });

/**
 * The enterprise value every surface divides and shows (`fundamentals`,
 * `valuation`, RV's EV/S, the reverse DCF, the screener's EV/EBITDA), at the
 * regular session price: the one Gloom Cloud serves, or where it withdrew the
 * provider's figure, the bridge: the one it computed beside the withdrawal,
 * else one read here from the latest balance sheet (statementBridge). Not
 * meaningful at or below zero and for a bank.
 */
export function listingEnterpriseValue(financials: EnterpriseValueInputs, now = Date.now()): ListingEnterpriseValue {
  const priced = atRegularSessionPrice({ quote: financials.quote, fundamentals: withBankEnterpriseValue(financials.fundamentals, financials.profile) });
  const fundamentals = priced.fundamentals;
  const notMeaningful = enterpriseValueNotMeaningful(fundamentals);
  if (notMeaningful) return { kind: "not-meaningful", reason: notMeaningful };
  const check = enterpriseValueCheck(fundamentals);
  const served = reportedEnterpriseValue(fundamentals);
  const currency = check?.currency ?? fundamentals?.marketCapCurrency ?? priced.quote?.currency;
  const fx = check?.fx && check.fx.from && finite(check.fx.rate) && check.fx.rate > 0 ? { fx: check.fx } : {};
  if (served != null) return currency ? { kind: "value", value: served, currency, basis: "served", ...fx } : { kind: "unavailable" };
  if (!enterpriseValueWithdrawn(fundamentals)) return { kind: "unavailable" };
  if (check?.status === "withdrawn" && finite(check.computed) && check.currency) {
    const bridge = checkBridge(check, financials);
    const value = check.computed + (bridge.minority ?? 0);
    return value > 0
      ? { kind: "value", value, currency: check.currency, basis: "computed", check, bridge, ...fx }
      : { kind: "not-meaningful", reason: notPositive(bridge) };
  }
  if (!financials.annualStatements || !financials.quarterlyStatements) return { kind: "unavailable" };
  const read = statementBridge({ ...financials, fundamentals, annualStatements: financials.annualStatements,
    quarterlyStatements: financials.quarterlyStatements }, now);
  if ("needs" in read) return { kind: "unavailable", needs: read.needs };
  const { bridge } = read;
  const value = bridge.marketCap + bridge.totalDebt + bridge.leases - bridge.cash + (bridge.minority ?? 0);
  if (!(value > 0)) return { kind: "not-meaningful", reason: notPositive(bridge) };
  return { kind: "value", value, currency: read.currency, basis: "computed", bridge,
    ...bridge.fx ? { fx: { from: bridge.fx.from, rate: bridge.fx.rate } } : {} };
}

/** The balance sheet rows dated by today, newest first. */
function datedSheets(financials: Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">, now: number): FinancialStatement[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return [...financials.quarterlyStatements, ...financials.annualStatements]
    .filter((row) => /^\d{4}-\d{2}-\d{2}/.test(row.date) && row.date.slice(0, 10) <= today)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Total equity including minority interest less common equity; null where either line is missing. */
function minorityOnSheet(row: FinancialStatement | undefined): number | null {
  const gross = row?.totalEquityGrossMinorityInterest, common = row?.commonStockEquity;
  return finite(gross) && finite(common) ? Math.max(0, gross - common) : null;
}

/** The bridge Gloom Cloud computed beside a withdrawal, its minority interest and cash read as its balance sheet holds them. */
function checkBridge(check: EnterpriseValueCheck, financials: EnterpriseValueInputs): EnterpriseValueBridge {
  const sheetDate = check.balanceSheetDate ?? "";
  const row = [...financials.quarterlyStatements ?? [], ...financials.annualStatements ?? []]
    .find((statement) => statement.date.slice(0, 10) === sheetDate);
  // Gloom Cloud serves the line only where both equity lines give a positive figure; a sheet on file without them is named.
  const minority = finite(check.minorityAndPreferred) ? check.minorityAndPreferred : row ? minorityOnSheet(row) : 0;
  const shortTerm = !check.investmentsKept && (!row || finite(row.cashCashEquivalentsAndShortTermInvestments));
  return {
    sheetDate, marketCap: check.marketCap ?? 0, totalDebt: check.totalDebt ?? 0, leases: check.leases ?? 0, cash: check.cash ?? 0,
    cashBasis: shortTerm ? "cash and short-term investments" : "cash", minority,
    fx: check.fx && check.currency && finite(check.fx.rate) ? { from: check.fx.from, to: check.currency, rate: check.fx.rate, closeDate: null } : null,
    source: finite(check.source) ? check.source : null,
    ...check.convertedTwice && check.convertedFrom ? { convertedTwice: check.convertedFrom } : {},
  };
}

/** "total debt and cash": lines a bridge lacks, in a sentence. */
const listed = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";

/** The latest balance sheet a bridge here reads: the newest with debt, leases or cash. */
function bridgeSheet(financials: Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">, now: number) {
  const sheets = datedSheets(financials, now);
  const latest = sheets.find((row) => finite(row.totalDebt) || finite(row.capitalLeaseObligations) || cashAndShortTermInvestments(row) != null);
  return { sheets, latest };
}

/**
 * The bridge from the latest balance sheet here, where Gloom Cloud computed
 * none: one older than 550 days, one that states no currency, or one in
 * another currency without the close on its date (balanceSheetRate) is
 * refused, saying why. A line the sheet does not report is named, never
 * taken as zero; minority interest without its lines is named in the note.
 */
function statementBridge(
  financials: EnterpriseValueInputs & Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">,
  now: number,
): { bridge: EnterpriseValueBridge; currency: string } | { needs: string; rate?: Omit<BalanceSheetRate, "rate" | "closeDate"> } {
  const fundamentals = financials.fundamentals;
  const { sheets, latest } = bridgeSheet(financials, now);
  if (!latest) return { needs: "a balance sheet with debt and cash" };
  const date = latest.date.slice(0, 10);
  const day = balanceSheetDay(date);
  if (Date.parse(`${date}T00:00:00Z`) < now - BALANCE_SHEET_MAX_AGE_DAYS * DAY_MS) {
    return { needs: `a balance sheet from the last ${BALANCE_SHEET_MAX_AGE_DAYS} days; the latest is ${day}` };
  }
  const from = latest.currency?.trim().toUpperCase();
  if (!from) return { needs: `the currency of the ${day} balance sheet, which states none` };
  const debt = leaseBasis(sheets) === "included" ? debtAndLeases(latest)
    : finite(latest.totalDebt) ? { totalDebt: latest.totalDebt, leases: 0 } : undefined;
  const cash = cashAndShortTermInvestments(latest);
  const absent = [...!debt ? [finite(latest.totalDebt) ? "lease liabilities" : "total debt"] : [], ...!cash ? ["cash"] : []];
  if (absent.length) return { needs: `${listed(absent)} on the ${day} balance sheet` };
  const marketCap = fundamentals?.marketCap;
  const currency = fundamentals?.marketCapCurrency?.trim().toUpperCase();
  if (!finite(marketCap) || !(marketCap > 0) || !currency) return { needs: "a market cap" };
  let rate = 1;
  let fx: EnterpriseValueBridge["fx"] = null;
  if (from !== currency) {
    const close = financials.balanceSheetRate;
    if (!close || close.from !== from || close.to !== currency || close.date !== date || !finite(close.rate) || !(close.rate > 0)) {
      return { needs: `the ${from}/${currency} close on ${day}`, rate: { from, to: currency, date } };
    }
    rate = close.rate;
    fx = { from, to: currency, rate, closeDate: close.closeDate };
  }
  const minority = minorityOnSheet(latest);
  return {
    currency,
    bridge: {
      sheetDate: date, marketCap, totalDebt: debt!.totalDebt * rate, leases: debt!.leases * rate, cash: cash!.amount * rate,
      cashBasis: cash!.includesShortTerm ? "cash and short-term investments" : "cash",
      minority: minority == null ? null : minority * rate, fx,
      source: finite(fundamentals?.enterpriseValueCheck?.source) ? fundamentals.enterpriseValueCheck.source : null,
    },
  };
}

/**
 * The close a bridge here wants: a balance sheet in another currency than the
 * market cap, where Gloom Cloud computed no bridge, and the sheet is recent
 * and states its currency. Loaded by the caller (withBalanceSheetRate), as
 * the EV is read synchronously. Null where none is needed.
 */
export function balanceSheetRateWanted(financials: EnterpriseValueInputs, now = Date.now()): Omit<BalanceSheetRate, "rate" | "closeDate"> | null {
  const { annualStatements, quarterlyStatements } = financials;
  if (!annualStatements || !quarterlyStatements) return null;
  const priced = atRegularSessionPrice({ quote: financials.quote, fundamentals: withBankEnterpriseValue(financials.fundamentals, financials.profile) });
  const fundamentals = priced.fundamentals;
  if (enterpriseValueNotMeaningful(fundamentals) || reportedEnterpriseValue(fundamentals) != null || !enterpriseValueWithdrawn(fundamentals)) return null;
  const check = enterpriseValueCheck(fundamentals);
  if (check?.status === "withdrawn" && finite(check.computed) && check.currency) return null;
  const read = statementBridge({ ...financials, fundamentals, annualStatements, quarterlyStatements, balanceSheetRate: undefined }, now);
  return "needs" in read ? read.rate ?? null : null;
}

/** Why a bridge at or below zero prices nothing: "Cash and short-term investments exceed market cap + total debt (balance sheet 2026-06-30)". */
function notPositive(bridge: EnterpriseValueBridge): string {
  const cash = bridge.cashBasis === "cash" ? "Cash exceeds" : "Cash and short-term investments exceed";
  return `${cash} market cap + total debt${bridge.leases > 0 ? " + leases" : ""}${bridge.minority ? " + minority interest and preferred equity" : ""}`
    + ` (balance sheet ${sheetText(bridge)})`;
}

/** "2026-06-30, CNY/HKD 1.0921 at the 2026-06-30 close": the balance sheet and the rate it was converted at. */
function sheetText(bridge: EnterpriseValueBridge): string {
  if (!bridge.fx) return bridge.sheetDate;
  const close = bridge.fx.closeDate ? `the ${bridge.fx.closeDate} close` : "its date's close";
  return `${bridge.sheetDate}, ${bridge.fx.from}/${bridge.fx.to} ${bridge.fx.rate.toPrecision(5)} at ${close}`;
}

/**
 * "market cap + total debt + leases - cash and short-term investments (balance sheet 2026-06-30, CNY/HKD 1.0921 at the
 * 2026-06-30 close)": what a bridge adds up, without its figures, for a note that names the EV alone (RV's EV/S).
 */
export function enterpriseValueBridgeBasis(bridge: EnterpriseValueBridge): string {
  return `market cap + total debt${bridge.leases > 0 ? " + leases" : ""} - ${bridge.cashBasis}`
    + `${bridge.minority ? " + minority interest and preferred equity" : ""} (balance sheet ${sheetText(bridge)})`;
}

/**
 * The line under a computed EV, its inputs as they were read: "EV 182.71B HKD
 * is market cap 194.47B + total debt 0 + leases 4.38B - cash and short-term
 * investments 16.4B + minority interest and preferred equity 269.37M (balance
 * sheet 2026-06-30, CNY/HKD 1.0921 at the 2026-06-30 close), in place of the
 * provider's 104.9B, which failed validation against it." A sheet without the
 * minority interest lines says none was added.
 */
export function enterpriseValueBridgeNote(listing: Extract<ListingEnterpriseValue, { kind: "value" }>): string | null {
  const bridge = listing.bridge;
  if (listing.basis !== "computed" || !bridge) return null;
  const leases = bridge.leases > 0 ? ` + leases ${formatCompact(bridge.leases)}` : "";
  const minority = bridge.minority ? ` + minority interest and preferred equity ${formatCompact(bridge.minority)}` : "";
  const noMinority = bridge.minority == null ? "; the balance sheet has no minority interest line, so none is added" : "";
  const failed = bridge.convertedTwice ? `converts ${bridge.convertedTwice} to ${listing.currency} twice` : "failed validation against it";
  const source = bridge.source != null ? `, in place of the provider's ${formatCompact(bridge.source)}, which ${failed}` : ", the source's EV being withdrawn";
  return `EV ${formatCompact(listing.value)} ${listing.currency} is market cap ${formatCompact(bridge.marketCap)} + total debt ${formatCompact(bridge.totalDebt)}`
    + `${leases} - ${bridge.cashBasis} ${formatCompact(bridge.cash)}${minority} (balance sheet ${sheetText(bridge)})${source}${noMinority}.`;
}
