import { formatFxRate } from "../cli/fx-pair";
import type { EnterpriseValueCheck, Fundamentals, Quote, TickerFinancials } from "../types/financials";
import { quotedFxPair } from "./currency-pair";
import { resolveCurrencyUnit } from "./currency-units";
import { isUsListingExchange } from "./exchanges";
import { formatCompact } from "./format";
import { formatUtcTime } from "./utc-time";

export const RETRACTABLE_VALUATION_FIELDS = ["enterpriseValue", "enterpriseToRevenue"] as const;
/** Every field a source can retract: the valuation fields, and a receipt's market cap (`marketCapUnavailable`). */
export const RETRACTED_FUNDAMENTALS_FIELDS = [...RETRACTABLE_VALUATION_FIELDS, "marketCap"] as const;

/** A retraction survives serialization and overrides a contradictory cached number; its reason goes with it. */
export function redactUnavailableFundamentals(value: Fundamentals | undefined): Fundamentals | undefined {
  if (!value || (value.unavailableFields === undefined && value.marketCapUnavailable === undefined)) return value;
  const unavailableFields = Array.isArray(value.unavailableFields)
    ? RETRACTED_FUNDAMENTALS_FIELDS.filter((field) => value.unavailableFields!.includes(field)) : [];
  const result = { ...value };
  if (unavailableFields.length) result.unavailableFields = unavailableFields;
  else delete result.unavailableFields;
  for (const field of unavailableFields) delete result[field];
  if (!unavailableFields.includes("marketCap")) delete result.marketCapUnavailable;
  return result;
}

/**
 * What a bank's enterprise value reads wherever one is shown: its deposits are
 * its funding, not debt, so market cap + debt - cash measures nothing of it.
 * Its reported cash flow stays as reported.
 */
export const BANK_ENTERPRISE_VALUE = "n/m for banks";

/** A bank by its industry ("Banks - Diversified", "Banks - Regional"), as the Bank section and its EV read one. */
function isBankIndustry(industry: string | null | undefined): boolean {
  return /\bbanks?\b/i.test(industry ?? "");
}

/**
 * A bank's fundamentals with its EV and EV/revenue not meaningful
 * (`BANK_ENTERPRISE_VALUE`), the source's figure kept on the check: every view
 * that reads an EV then reads N/M. Any other company's as they are.
 */
export function withBankEnterpriseValue<F extends Fundamentals | undefined>(
  fundamentals: F,
  profile: { industry?: string | null } | null | undefined,
): F {
  if (!fundamentals || !isBankIndustry(profile?.industry)) return fundamentals;
  const { enterpriseValue: _value, enterpriseToRevenue: _ratio, ...rest } = fundamentals;
  const source = servedEnterpriseValue(fundamentals) ?? fundamentals.enterpriseValueCheck?.source;
  // Only where an EV would be shown: a bank the source gave none for shows no line, as before.
  if (!finiteNumber(source)) return fundamentals;
  const withdrawn = new Set([...fundamentals.unavailableFields ?? [], "enterpriseValue" as const, "enterpriseToRevenue" as const]);
  return {
    ...rest,
    unavailableFields: [...withdrawn],
    enterpriseValueCheck: { status: "not-meaningful", ...finiteNumber(source) ? { source } : {}, reason: BANK_ENTERPRISE_VALUE },
  } as F;
}

/** Whether a not meaningful EV is so because the company is a bank (`withBankEnterpriseValue`). */
export function isBankEnterpriseValue(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): boolean {
  return enterpriseValueNotMeaningful(fundamentals) === BANK_ENTERPRISE_VALUE;
}

/** The enterprise value as served, or undefined when it has none: banks and insurers come back as 0, which is a gap, not a value. */
function servedEnterpriseValue(fundamentals: Pick<Fundamentals, "enterpriseValue"> | undefined): number | undefined {
  const value = fundamentals?.enterpriseValue;
  return typeof value === "number" && Number.isFinite(value) && value !== 0 ? value : undefined;
}

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Minority interest and preferred equity a check's balance sheet shows, else none. */
function minorityAndPreferred(check: Pick<EnterpriseValueCheck, "minorityAndPreferred">): number {
  return finiteNumber(check.minorityAndPreferred) && check.minorityAndPreferred > 0 ? check.minorityAndPreferred : 0;
}

/**
 * Market cap + total debt (+ leases) - cash and short-term investments + minority interest and preferred equity: the
 * EV the provider's is checked against, and the one shown in its place. PAGP on 2026-06-30: 13.58B computed and
 * 13.73B of minority interest, 27.31B.
 */
function bridgeEnterpriseValue(check: Pick<EnterpriseValueCheck, "computed" | "minorityAndPreferred">): number | undefined {
  return finiteNumber(check.computed) ? check.computed + minorityAndPreferred(check) : undefined;
}

/** Beyond this relative gap from the bridge the provider's EV is not shown; within it, it is. */
const ENTERPRISE_VALUE_TOLERANCE = 0.05;
/** On the other side of the market cap from the balance sheet's net debt, a smaller gap is enough. */
const ENTERPRISE_VALUE_SIDE_TOLERANCE = 0.02;

/**
 * Whether the bridge stands in for the provider's EV, as Gloom Cloud's check rules it: more than 5% from it, or more
 * than 2% on the other side of the market cap from net debt (WPM's 61.75B beside a 61.88B cap and net debt). Read
 * here on the bridge with minority interest and preferred equity in, so a check served before the check counted them
 * (PAGP's `differs`, its 26.57B 0.97x of 27.31B) keeps the provider's figure. Not across currencies: a check in another
 * currency than the EV is shown in describes another figure.
 */
function bridgeStandsIn(check: EnterpriseValueCheck, currency: string | undefined): boolean {
  if (check.status !== "differs" && check.status !== "matches") return false;
  if (currency && check.currency && check.currency !== currency) return false;
  const bridge = bridgeEnterpriseValue(check);
  if (bridge === undefined || !(bridge > 0) || !finiteNumber(check.source)) return false;
  const gap = Math.abs(check.source - bridge);
  if (gap > ENTERPRISE_VALUE_TOLERANCE * bridge) return true;
  if (!finiteNumber(check.marketCap) || !finiteNumber(check.totalDebt) || !finiteNumber(check.cash)) return false;
  const netDebt = check.totalDebt + (finiteNumber(check.leases) ? check.leases : 0) - check.cash + minorityAndPreferred(check);
  return Math.sign(check.source - check.marketCap) * Math.sign(netDebt) < 0 && gap > ENTERPRISE_VALUE_SIDE_TOLERANCE * bridge;
}

/**
 * The enterprise value every surface shows and divides, so `ticker`, the overview, `valuation`, RV and the reverse
 * DCF read one number: market cap + total debt - cash and short-term investments + minority interest and preferred
 * equity (bridgeEnterpriseValue) where the provider's figure is more than 5% from it, the provider's within it, and
 * the served figure with no check. `currency` is the one the EV is shown in, the market cap's by default. Undefined
 * when there is none.
 */
export function reportedEnterpriseValue(
  fundamentals: Pick<Fundamentals, "enterpriseValue" | "enterpriseValueCheck" | "unavailableFields" | "marketCapCurrency"> | undefined,
  currency: string | undefined = fundamentals?.marketCapCurrency,
): number | undefined {
  const served = servedEnterpriseValue(fundamentals);
  if (served === undefined) return undefined;
  const check = enterpriseValueCheck(fundamentals);
  if (!check || (check.status !== "differs" && check.status !== "matches")) return served;
  if (bridgeStandsIn(check, currency)) return bridgeEnterpriseValue(check)!;
  // Gloom Cloud serves the bridge for a `differs` check; the provider's figure is shown where it is within 5% of it.
  return (currency && check.currency && check.currency !== currency) || !finiteNumber(check.source) ? served : check.source;
}

/** EV over revenue on the enterprise value shown (reportedEnterpriseValue): the served multiple, moved with the EV. */
export function reportedEnterpriseToRevenue(
  fundamentals: Pick<Fundamentals, "enterpriseValue" | "enterpriseValueCheck" | "unavailableFields" | "enterpriseToRevenue" | "marketCapCurrency"> | undefined,
): number | undefined {
  const ratio = fundamentals?.enterpriseToRevenue;
  if (!finiteNumber(ratio)) return undefined;
  const served = servedEnterpriseValue(fundamentals);
  const shown = reportedEnterpriseValue(fundamentals);
  return served !== undefined && shown !== undefined && served > 0 && shown !== served ? ratio * (shown / served) : ratio;
}

/**
 * The served check of the enterprise value beside it, when it describes that value: a provider EV the check labels or
 * matches is the one shown, a computed one is the check's own figure, and a withdrawn or not meaningful one is no
 * longer shown. A check merged beside another source's EV is none.
 */
export function enterpriseValueCheck(
  fundamentals: Pick<Fundamentals, "enterpriseValue" | "enterpriseValueCheck" | "unavailableFields"> | undefined,
): EnterpriseValueCheck | undefined {
  const check = fundamentals?.enterpriseValueCheck;
  if (!check) return undefined;
  const withdrawn = fundamentals?.enterpriseValue === undefined && !!fundamentals?.unavailableFields?.includes("enterpriseValue");
  // Not meaningful needs no figure of its own: a source EV below zero may come with no cap or currency.
  if (check.status === "not-meaningful") return withdrawn ? check : undefined;
  if (!check.currency) return undefined;
  // A withdrawn EV comes with the figure it was checked against, or with why no balance sheet checked it.
  if (check.status === "withdrawn") {
    return withdrawn && ((finiteNumber(check.computed) && finiteNumber(check.source)) || !!check.reason?.trim()) ? check : undefined;
  }
  if (check.status === "computed") {
    return finiteNumber(check.computed) && fundamentals?.enterpriseValue === check.computed ? check : undefined;
  }
  // A `differs` check comes beside the bridge Gloom Cloud serves in the provider's place, or the provider's figure.
  if (check.status === "differs" && fundamentals?.enterpriseValue !== undefined
    && fundamentals.enterpriseValue === bridgeEnterpriseValue(check)) return check;
  return finiteNumber(check.source) && fundamentals?.enterpriseValue === check.source ? check : undefined;
}

/** Why a source EV below zero that nothing checked is not meaningful: its cash and investments exceed the rest. */
const SOURCE_ENTERPRISE_VALUE_NOT_POSITIVE = "Cash and investments exceed market cap + debt in the source's EV";

/**
 * Why the enterprise value is not meaningful, if it is: Gloom Cloud's reason for an EV that comes out at or below
 * zero, or for an EV below zero from any source that served no check. A bank's 0 is a gap, not N/M. EV/S, EV/EBITDA
 * and a reverse DCF over it are N/M too.
 */
export function enterpriseValueNotMeaningful(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): string | undefined {
  const check = enterpriseValueCheck(fundamentals);
  if (check?.status === "not-meaningful") return check.reason?.trim() || SOURCE_ENTERPRISE_VALUE_NOT_POSITIVE;
  const value = fundamentals?.enterpriseValue;
  return finiteNumber(value) && value < 0 ? SOURCE_ENTERPRISE_VALUE_NOT_POSITIVE : undefined;
}

/**
 * Whether the provider's EV was withdrawn: retracted (`unavailableFields`) and none served in its place, by the
 * served check or by Gloom Cloud's own validation of the source observation, which leaves no check. Not one that is
 * not meaningful (enterpriseValueNotMeaningful), which says N/M instead.
 */
export function enterpriseValueWithdrawn(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): boolean {
  return fundamentals?.enterpriseValue === undefined && !!fundamentals?.unavailableFields?.includes("enterpriseValue")
    && enterpriseValueNotMeaningful(fundamentals) === undefined;
}

/** "unavailable" for a withdrawn EV, N/M for one at or below zero; none for one that is shown, served or computed. */
export function enterpriseValueLabel(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): "unavailable" | "not-meaningful" | undefined {
  if (enterpriseValueNotMeaningful(fundamentals)) return "not-meaningful";
  const status = enterpriseValueCheck(fundamentals)?.status;
  return status === "withdrawn" || enterpriseValueWithdrawn(fundamentals) ? "unavailable" : undefined;
}

/** Whether the EV shown is the bridge in place of the provider's (reportedEnterpriseValue). */
export function enterpriseValueComputed(
  fundamentals: Parameters<typeof reportedEnterpriseValue>[0],
  currency: string | undefined = fundamentals?.marketCapCurrency,
): boolean {
  const check = enterpriseValueCheck(fundamentals);
  return !!check && servedEnterpriseValue(fundamentals) !== undefined && bridgeStandsIn(check, currency);
}

/**
 * Whether a company's overview names the gap between the provider's EV and market cap + debt - cash: past 10% of
 * the computed figure. A smaller gap (a 4.87T EV beside 5T computed) is a data detail the
 * valuation panes (RV, the reverse DCF) still give in full, not a warning to greet a first look at the company.
 * Any other check (withdrawn, not meaningful) is always named: it is why a figure is missing.
 */
export function enterpriseValueGapIsLarge(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): boolean {
  const check = enterpriseValueCheck(fundamentals);
  // The provider's figure shown as it is: what the note says of its inputs is a detail for `ticker`.
  if (check?.status === "matches" || check?.status === "unchecked") return false;
  const bridge = check ? bridgeEnterpriseValue(check) : undefined;
  if (check?.status !== "differs" || !finiteNumber(check.source) || bridge === undefined || bridge <= 0) return true;
  return Math.abs(check.source / bridge - 1) > OVERVIEW_ENTERPRISE_VALUE_GAP;
}

const OVERVIEW_ENTERPRISE_VALUE_GAP = 0.1;

/**
 * The line under a computed, withdrawn or not meaningful EV: "EV 63.75B USD is market cap 60B + total debt 5B - cash
 * and short-term investments 1.25B (balance sheet 2026-06-30), in place of the provider's 61.75B.", "EV N/M: cash and short-term investments
 * exceed market cap + total debt (balance sheet 2026-06-30)." A balance sheet in another currency names the rate it
 * was converted at ("balance sheet 2026-06-30, EUR at 0.8614 GBP"). A withdrawn EV no balance sheet checked gives
 * Gloom Cloud's reason; one withdrawn without a check, that the source failed validation. A provider's EV that
 * matches or is unchecked has a line only where the balance sheet's minority interest is not on its lines
 * (providerEnterpriseValueNote). Undefined when the EV is computed, or has no check. Read it from the
 * fundamentals the rows show (atRegularSessionPrice moves the check with the EV and the market cap), so its figures
 * are theirs.
 */
export function enterpriseValueReconciliationNote(
  fundamentals: Parameters<typeof reportedEnterpriseValue>[0],
  currency: string | undefined = fundamentals?.marketCapCurrency,
  /** The statements on file, whose balance sheet says what the check's cash holds (checkCashBasis). */
  statements?: BalanceSheets,
): string | undefined {
  const notMeaningful = enterpriseValueNotMeaningful(fundamentals);
  // A bank's EV line says it all: "n/m for banks".
  if (notMeaningful === BANK_ENTERPRISE_VALUE) return undefined;
  if (notMeaningful) return `EV N/M: ${notMeaningful.charAt(0).toLowerCase()}${notMeaningful.slice(1)}.`;
  const check = enterpriseValueCheck(fundamentals);
  if (!check && enterpriseValueWithdrawn(fundamentals)) return "EV unavailable: the provider's figure failed validation.";
  const reason = check?.reason?.trim().replace(/\.$/, "");
  if (check?.status === "withdrawn" && !finiteNumber(check.computed) && reason) {
    return `EV unavailable: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`;
  }
  if (!check || !finiteNumber(check.computed) || !finiteNumber(check.source)) return undefined;
  const otherCurrency = !!currency && !!check.currency && check.currency !== currency;
  if ((check.status === "matches" || check.status === "unchecked") && !otherCurrency) {
    return providerEnterpriseValueNote({ ...check, computed: check.computed, source: check.source }, currency, statements);
  }
  if (check.status !== "differs" && check.status !== "withdrawn") return undefined;
  const source = `${formatCompact(check.source)} ${check.currency}`;
  const computed = formatCompact(check.computed);
  const leases = finiteNumber(check.leases) && check.leases > 0 ? " + leases" : "";
  const fx = check.fx && finiteNumber(check.fx.rate) ? `, ${check.fx.from} at ${check.fx.rate.toPrecision(4)} ${check.currency}` : "";
  const sheet = check.balanceSheetDate ? ` (balance sheet ${check.balanceSheetDate}${fx})` : "";
  const basis = `market cap + total debt${leases} - cash${sheet}`;
  // The EV shown is the bridge: its inputs, and the provider's figure it stands in for. The provider's shown needs none.
  if (check.status === "differs") {
    return bridgeStandsIn(check, currency)
      ? `${computedEnterpriseValueInputs(check, sheet, checkCashBasis(check, statements))}, in place of the provider's ${formatCompact(check.source)}.`
      : undefined;
  }
  const ratio = check.computed > 0 ? ` is ${(check.source / check.computed).toFixed(1)}x` : " is far from";
  const twice = check.convertedTwice && check.convertedFrom ? `; it converts ${check.convertedFrom} to ${check.currency} twice` : "";
  return `EV unavailable: the provider's ${source}${ratio} the ${computed} computed from ${basis}${twice}.`;
}

/**
 * The line under a provider's EV the bridge did not replace, where the balance sheet's minority interest is not on
 * its lines: "EV 26.41B USD is the provider's, within 5% of 27.28B: market cap 6.04B + total debt 9.92B - cash 880M +
 * minority interest and preferred equity 12.21B from the company's filing (balance sheet 2026-09-30).", and where
 * neither the sheet nor its filing gives one, why the provider's figure stands. Undefined for any other check.
 */
function providerEnterpriseValueNote(
  check: EnterpriseValueCheck & { computed: number; source: number },
  currency: string | undefined,
  statements: BalanceSheets | undefined,
): string | undefined {
  const fx = check.fx && finiteNumber(check.fx.rate) ? `, ${check.fx.from} at ${check.fx.rate.toPrecision(4)} ${check.currency}` : "";
  const sheet = check.balanceSheetDate ? ` (balance sheet ${check.balanceSheetDate}${fx})` : "";
  const inputs = enterpriseValueInputs(check, sheet, checkCashBasis(check, statements));
  const provider = `EV ${formatCompact(check.source)} ${check.currency} is the provider's`;
  if (check.status === "matches" && check.minorityFiled && !bridgeStandsIn(check, currency)) {
    return `${provider}, within 5% of ${formatCompact(bridgeEnterpriseValue(check)!)}: ${inputs}.`;
  }
  const earlier = check.minorityUnreported;
  if (check.status !== "unchecked" || !earlier || !finiteNumber(earlier.value)) return undefined;
  return `${provider}: ${inputs} is ${formatCompact(check.computed)} with no minority interest, which that balance sheet does not`
    + ` report (${formatCompact(earlier.value)} on ${earlier.balanceSheetDate}), so the provider's figure stands.`;
}

/** The balance sheets a note reads to say what a check's cash holds. */
type BalanceSheets = Partial<Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">>;

/**
 * What the cash in Gloom Cloud's bridge holds: cash and short-term investments where its balance sheet is on file and
 * reports that total, which Gloom Cloud takes before cash alone. Cash where the check keeps investments in, and where
 * the sheet is not on file: the check does not say, so the note claims no more than cash.
 */
export function checkCashBasis(
  check: Pick<EnterpriseValueCheck, "balanceSheetDate" | "investmentsKept">,
  statements?: BalanceSheets,
): "cash and short-term investments" | "cash" {
  const sheetDate = check.balanceSheetDate?.slice(0, 10);
  if (check.investmentsKept || !sheetDate) return "cash";
  const row = [...statements?.quarterlyStatements ?? [], ...statements?.annualStatements ?? []]
    .find((statement) => statement.date.slice(0, 10) === sheetDate);
  return row && finiteNumber(row.cashCashEquivalentsAndShortTermInvestments) ? "cash and short-term investments" : "cash";
}

/**
 * "EV 7.48B USD is market cap 8.22B + total debt 864.07M - cash and short-term investments 1.6B (balance sheet
 * 2026-06-30)": the bridge with its inputs (enterpriseValueInputs).
 */
function computedEnterpriseValueInputs(check: EnterpriseValueCheck, sheet: string, cashBasis: ReturnType<typeof checkCashBasis>): string {
  return `EV ${formatCompact(bridgeEnterpriseValue(check)!)} ${check.currency} is ${enterpriseValueInputs(check, sheet, cashBasis)}`;
}

/**
 * "market cap 8.22B + total debt 864.07M - cash and short-term investments 1.6B (balance sheet 2026-06-30)": what the
 * bridge adds up, each where the check carries it, minority interest and preferred equity among them where the balance
 * sheet shows any (named as the company's filing's where the sheet has no equity lines), and its cash as
 * checkCashBasis reads it.
 */
function enterpriseValueInputs(check: EnterpriseValueCheck, sheet: string, cashBasis: ReturnType<typeof checkCashBasis>): string {
  const part = (label: string, value: number | undefined) => finiteNumber(value) ? `${label} ${formatCompact(value)}` : label;
  const leases = finiteNumber(check.leases) && check.leases > 0 ? ` + ${part("leases", check.leases)}` : "";
  const minority = minorityAndPreferred(check);
  const filed = check.minorityFiled ? " from the company's filing" : "";
  const equity = minority > 0 ? ` + ${part("minority interest and preferred equity", minority)}${filed}` : "";
  return `${part("market cap", check.marketCap)} + ${part("total debt", check.totalDebt)}${leases} - ${part(cashBasis, check.cash)}${equity}${sheet}`;
}

/**
 * What `valuation` says of an insurer's or a holding company's EV, which Gloom Cloud computes rather than takes from
 * the provider: "EV 1.23T USD is market cap + total debt - 40.61B of cash and equivalents (balance sheet 2026-06-30);
 * investments stay in." Undefined for any other EV. The overview stat says it in two words ("investments in").
 */
export function computedEnterpriseValueNote(fundamentals: Parameters<typeof enterpriseValueCheck>[0]): string | undefined {
  const check = enterpriseValueCheck(fundamentals);
  if (check?.status !== "computed" || !finiteNumber(check.computed) || !finiteNumber(check.cash)) return undefined;
  const sheet = check.balanceSheetDate ? ` (balance sheet ${check.balanceSheetDate})` : "";
  return `EV ${formatCompact(check.computed)} ${check.currency} is market cap + total debt - ${formatCompact(check.cash)} of cash and equivalents${sheet}; investments stay in.`;
}

/** What names the currency of the trailing figures: the fundamentals' own labels, else the statements' on a listing that trades in theirs. */
type FundamentalsCurrencies = Pick<TickerFinancials, "financialCurrency" | "statementHistory"> & {
  fundamentals?: Pick<Fundamentals, "financialCurrency" | "epsCurrency" | "marketCapCurrency"> | null;
  quote?: Pick<Quote, "currency" | "exchangeName" | "listingExchangeName" | "isDepositaryReceipt"> | null;
};

/** What a caller knows of the listing beyond its quote: the day it listed (its IPO's), when known. */
interface ListingAge {
  listedSince?: string | null;
  now?: Date;
}

/** A listing that started within about a year: its statements may not be served yet. */
const RECENT_LISTING_DAYS = 372;

/**
 * The listing's own currency, standing in for figures with no statements to tell their currency by: only for a
 * listing of the last year or so (a recent IPO such as HAWK) or a US listing in dollars that is no receipt, and
 * never after a statements read that failed. A minor unit (GBp) does not say whether figures are pence or pounds.
 */
function listingCurrencyFallback(financials: FundamentalsCurrencies | null | undefined, listing: ListingAge): string | undefined {
  const listed = financials?.fundamentals?.marketCapCurrency?.trim() || financials?.quote?.currency?.trim();
  if (!listed || resolveCurrencyUnit(listed).divisor !== 1) return undefined;
  if (financials?.statementHistory?.status === "retryable-failure") return undefined;
  const currency = resolveCurrencyUnit(listed).currency;
  const since = listing.listedSince ? Date.parse(`${listing.listedSince.slice(0, 10)}T00:00:00Z`) : NaN;
  const recent = Number.isFinite(since) && (listing.now ?? new Date()).getTime() - since <= RECENT_LISTING_DAYS * 86_400_000;
  const quote = financials?.quote;
  const home = currency === "USD" && quote?.isDepositaryReceipt !== true
    && isUsListingExchange(quote?.listingExchangeName || quote?.exchangeName);
  return recent || home ? currency : undefined;
}

/**
 * The currency of the trailing EPS, revenue, income and cash flows: the one the fundamentals declare for themselves.
 * A block that declares none is in the statements' currency only when the listing trades in it; on a listing quoted
 * in another (a receipt in USD beside TWD books, YPFD in ARS beside USD statements) its currency is unknown, since
 * Gloom Cloud labels every block whose currency it can tell. With no statements to tell by, the listing's own
 * currency where that is safe (listingCurrencyFallback).
 */
export function fundamentalsCurrency(
  financials: FundamentalsCurrencies | null | undefined,
  listing: ListingAge = {},
): string | undefined {
  const declared = financials?.fundamentals?.financialCurrency?.trim();
  if (declared) return declared;
  const statements = financials?.financialCurrency?.trim();
  if (!statements) return listingCurrencyFallback(financials, listing);
  const listed = financials?.fundamentals?.marketCapCurrency?.trim() || financials?.quote?.currency?.trim();
  return !listed || resolveCurrencyUnit(listed).currency === resolveCurrencyUnit(statements).currency ? statements : undefined;
}

/**
 * The currency of the trailing EPS: the one stated for it when it differs from the block's amounts (an EPS converted
 * to the listing's currency beside revenue left in the reporting one), else the block's.
 */
export function fundamentalsEpsCurrency(
  financials: FundamentalsCurrencies | null | undefined,
  listing: ListingAge = {},
): string | undefined {
  return financials?.fundamentals?.epsCurrency?.trim() || fundamentalsCurrency(financials, listing);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const usableRate = (rate: number | null | undefined): rate is number => typeof rate === "number" && Number.isFinite(rate) && rate > 0;

/** The currency a trailing block was converted from into another it is labelled with; undefined for a block in the reporting currency. */
function ttmConvertedFrom(fundamentals: Pick<Fundamentals, "financialCurrency" | "ttmConversion"> | undefined): string | undefined {
  const from = fundamentals?.ttmConversion?.from?.trim();
  const to = fundamentals?.financialCurrency?.trim();
  return from && to && from !== to ? from : undefined;
}

/** A rate the app converts at, the one `fx` reports: units of the target currency per unit of the source one, and when it was observed. */
export interface AppFxRate {
  rate: number;
  /** Epoch ms of the older leg's observation; null when the source did not date it. */
  asOf: number | null;
}

/** One currency's US dollar rate as the app holds it, a minor unit's by its major currency. */
type UsdLeg = (currency: string) => AppFxRate | null | undefined;

/**
 * The app's rate for a converted trailing block: units of its currency per unit of the one it was converted from,
 * through the two US dollar legs `fx` reads, dated by the older. Null for an unconverted block or a missing leg.
 */
export function appTtmRate(fundamentals: Pick<Fundamentals, "financialCurrency" | "ttmConversion"> | undefined, usd: UsdLeg): AppFxRate | null {
  const from = ttmConvertedFrom(fundamentals);
  if (!from || !usableRate(fundamentals?.ttmConversion?.rate)) return null;
  const leg = (currency: string) => {
    const major = resolveCurrencyUnit(currency).currency;
    return major === "USD" ? { rate: 1, asOf: null } : usd(major);
  };
  const source = leg(from), target = leg(fundamentals!.financialCurrency!.trim());
  if (!usableRate(source?.rate) || !usableRate(target?.rate)) return null;
  const dates = [source!.asOf, target!.asOf].filter((time): time is number => time != null && Number.isFinite(time));
  return { rate: source!.rate / target!.rate, asOf: dates.length > 0 ? Math.min(...dates) : null };
}

const TTM_AMOUNTS = ["revenue", "netIncome", "operatingCashFlow", "freeCashFlow"] as const;

/**
 * A converted trailing block at the app's own rate, so a screen converts at one rate, the one `fx` reports: revenue,
 * income and cash flows the source converted at `ttmConversion.rate` go back to the reporting currency and are
 * converted again at `rate`, which the conversion then names with its time. EPS stays at report-date rates. The block
 * as served when it is not converted, states no rate, or the app has none.
 */
export function ttmAtAppRate<T extends Fundamentals>(fundamentals: T, rate: AppFxRate | null | undefined): T {
  const conversion = fundamentals.ttmConversion;
  if (!rate || !usableRate(rate.rate) || !conversion || !ttmConvertedFrom(fundamentals) || !usableRate(conversion.rate)) return fundamentals;
  const factor = rate.rate / conversion.rate;
  const shown: T = { ...fundamentals };
  for (const key of TTM_AMOUNTS) {
    const value = fundamentals[key];
    if (finiteNumber(value)) (shown as Fundamentals)[key] = Math.round(value * factor);
  }
  const { asOf: _served, ...kept } = conversion;
  shown.ttmConversion = { ...kept, rate: rate.rate, ...(rate.asOf != null ? { asOf: new Date(rate.asOf).toISOString() } : {}) };
  return shown;
}

/** `2026-10-09`, or `2026-10-23 21:29 UTC` for the time of a rate. */
function conversionTime(asOf: string | undefined): string | undefined {
  if (!asOf) return undefined;
  if (ISO_DAY.test(asOf)) return asOf;
  const time = Date.parse(asOf);
  return Number.isFinite(time) ? formatUtcTime(new Date(time)) || undefined : undefined;
}

/**
 * "TTM converted from ARS at USD/ARS 1529, as of 2026-10-23 21:29 UTC; EPS at report-date rates.": what a converted
 * trailing block was converted from, at which rate, as markets quote the pair and `fx` reads it, and when. Undefined
 * for a block in the currency the company reports in.
 */
export function ttmConversionNote(fundamentals: Pick<Fundamentals, "financialCurrency" | "ttmConversion"> | undefined): string | undefined {
  const from = ttmConvertedFrom(fundamentals);
  if (!from) return undefined;
  const conversion = fundamentals!.ttmConversion!;
  const quoted = usableRate(conversion.rate) ? quotedFxPair(from, fundamentals!.financialCurrency!, conversion.rate) : undefined;
  const rate = quoted ? ` at ${quoted.pair} ${formatFxRate(quoted.rate)}` : "";
  const time = conversionTime(conversion.asOf);
  const when = time ? `${rate ? "," : ""} as of ${time}` : "";
  const eps = conversion.eps === "report_date" ? "; EPS at report-date rates" : "";
  return `TTM converted from ${from}${rate}${when}${eps}.`;
}

/**
 * "EPS (TTM) in USD, converted from CLP at report-date rates.": an EPS in another currency than the trailing amounts
 * beside it. Undefined when they share one.
 */
export function epsConversionNote(fundamentals: Pick<Fundamentals, "financialCurrency" | "epsCurrency"> | undefined): string | undefined {
  const eps = fundamentals?.epsCurrency?.trim();
  const amounts = fundamentals?.financialCurrency?.trim();
  return eps && amounts && eps !== amounts ? `EPS (TTM) in ${eps}, converted from ${amounts} at report-date rates.` : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * A fiscal year's EPS stands for the trailing twelve months only until the
 * quarter after it is reported: its quarter's 90 days and some 45 of filing.
 */
const FISCAL_YEAR_EPS_CURRENT_DAYS = 135;

/**
 * "FY Mar-26": the fiscal year the headline trailing EPS is, when its stated
 * period is a fiscal year's and that year ended long enough ago that a quarter
 * after it is due, so the figure is not today's trailing twelve months: the
 * filed EPS read through a fiscal year's end (filed-trailing-eps), with no
 * quarter after it filed. Mitsubishi Corporation's 209.78 and Itochu's 128 on
 * 9 Nov 2026 were their years to March 2026. Every place that shows the EPS
 * or the P/E on it (valuation, the overview, RV) names that year in place of
 * "TTM", in this one form. Undefined for any other figure, and for Gloom
 * Cloud's served trailing EPS, which states no period.
 */
export function trailingEpsFiscalYear(
  financials: Pick<TickerFinancials, "fundamentals" | "annualStatements">,
  now = Date.now(),
): string | undefined {
  const end = trailingEpsFiscalYearEnd(financials, now);
  return end ? `FY ${MONTHS[Number(end.slice(5, 7)) - 1]}-${end.slice(2, 4)}` : undefined;
}

/** The end of the fiscal year `trailingEpsFiscalYear` names, YYYY-MM-DD. */
function trailingEpsFiscalYearEnd(
  financials: Pick<TickerFinancials, "fundamentals" | "annualStatements">,
  now = Date.now(),
): string | undefined {
  const fundamentals = financials.fundamentals;
  const eps = fundamentals?.eps;
  const period = fundamentals?.trailingEpsSource === "filed-quarters" ? fundamentals.trailingEpsPeriodEnd?.slice(0, 10) : undefined;
  if (!period || typeof eps !== "number" || !Number.isFinite(eps) || eps === 0) return undefined;
  if (now - Date.parse(`${period}T00:00:00Z`) <= FISCAL_YEAR_EPS_CURRENT_DAYS * 86_400_000) return undefined;
  // The period stated is a fiscal year's end, one the annual statements report.
  const yearEnd = (financials.annualStatements ?? []).some((row) => row.date.slice(0, 10) === period);
  return yearEnd ? period : undefined;
}

/** What a trailing EPS that is not the filed quarters' is called where it is shown (EE's TTM row). */
export const SERVED_TRAILING_EPS = "Gloom Cloud's TTM";

/**
 * "EPS (TTM) and P/E (TTM) are Gloom Cloud's trailing figures, not the last four filed quarters'.": the headline EPS
 * and P/E are the filed quarters' (time-series/filed-trailing-eps), so served ones say so, naming those `shown`
 * ("P/E (TTM) is Gloom Cloud's trailing figure, ..." for a fund's P/E with no EPS). Undefined otherwise.
 */
export function trailingEpsSourceNote(
  fundamentals: Pick<Fundamentals, "trailingEpsSource"> | undefined,
  shown: { eps: boolean; pe: boolean },
): string | undefined {
  if (fundamentals?.trailingEpsSource !== "served" || (!shown.eps && !shown.pe)) return undefined;
  const figures = shown.eps && shown.pe ? "EPS (TTM) and P/E (TTM) are Gloom Cloud's trailing figures"
    : `${shown.eps ? "EPS (TTM)" : "P/E (TTM)"} is Gloom Cloud's trailing figure`;
  return `${figures}, not the last four filed quarters'.`;
}

type PriceEarningsBasis = Pick<Fundamentals, "financialCurrency" | "ttmConversion" | "epsCurrency" | "trailingPEConversion">;

/** The trailing EPS in the price's currency: converted at the rate the served P/E used when it says so. */
export function priceEarningsEps(fundamentals: Pick<Fundamentals, "eps" | "trailingPEConversion"> | undefined): number | undefined {
  const eps = fundamentals?.eps;
  const rate = fundamentals?.trailingPEConversion?.rate;
  return typeof eps === "number" && typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? eps * rate : eps;
}

/**
 * The trailing P/E's footnote: the rate its EPS was converted at when that EPS is in another currency than the
 * price, or that it divides a spot price by EPS converted at report-date rates.
 */
export function convertedPriceEarningsNote(fundamentals: PriceEarningsBasis | undefined, quoteCurrency?: string): string | undefined {
  const conversion = fundamentals?.trailingPEConversion;
  const from = conversion?.from?.trim();
  const to = resolveCurrencyUnit(quoteCurrency).currency;
  if (from && to && from !== to && typeof conversion?.rate === "number" && Number.isFinite(conversion.rate) && conversion.rate > 0) {
    return `P/E (TTM): price over EPS converted at 1 ${from} = ${Number(conversion.rate.toPrecision(5))} ${to}.`;
  }
  return (ttmConvertedFrom(fundamentals) && fundamentals?.ttmConversion?.eps === "report_date") || epsConversionNote(fundamentals)
    ? "P/E (TTM): spot price over EPS at report-date rates."
    : undefined;
}
