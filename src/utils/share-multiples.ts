import { classifyInstrumentType } from "../tickers/instrument-kind";
import type { FinancialStatement, Fundamentals, TickerFinancials } from "../types/financials";
import { resolveCurrencyUnit } from "./currency-units";
import { canonicalExchange, US_LISTING_EXCHANGES } from "./exchanges";
import { quarterRows } from "./financial-statements";

/** Beyond this either way, a trailing EPS is not net income over the shares. */
const OWN_EPS_RATIO_LIMIT = 10;

/** Nasdaq's fifth letter W, R or U is a warrant, a right or a unit (BZFDW, TDWDR, SAAQU). */
const NASDAQ_INSTRUMENT = /^[A-Z]{4}([WRU])$/;
/** NYSE's suffixes: NWAX.WS, ABC.U, ABC.RT. */
const NYSE_INSTRUMENT = /[.\-/ ](WS|WT|U|RT)(?:\.[A-Z])?$/;
/** A preferred share's symbol (PSA.PR.U): its last letter is its series, not a unit. */
const PREFERRED_SYMBOL = /\.PR(?:\.|$)/;
/** A warrant, right or unit by its name: the word at its end, or before its terms. */
const INSTRUMENT_NAME =
  /(?:^|[\s,.(-])(warrants?|wts?|rights?|units?)(?:\s*(?:\([^)]*\))?\s*$|[\s,]+(?:each|exp(?:iring|ire|\.)?|exercisable|to\s+(?:purchase|buy|acquire|subscribe)|consisting)\b)/i;
/**
 * Units that are the share: a partnership's, a trust's, a REIT's, an income
 * fund's, depositary units and a holding company's (Brookfield Renewable
 * Partners L.P. Units, Choice Properties REIT Units, Boralex Income Fund -
 * Units, Icahn Enterprises Depositary Units, Hess Midstream Holdings Unit).
 */
const SHARE_UNITS = /\b(?:common|partnership|ordinary|stapled|beneficial|trust|lp|l\.p\.|llc|class\s+[a-z]|reit|fund|depositary|holdings?)\s*[-–]?\s*units?\b/i;
/** A blank-check company's words: its units are a share and a warrant together. */
const SPAC_NAME = /\b(?:acquisition|blank\s+check|spac)\b/i;
/** SET's own warrants: JMART-W4. */
const SET_WARRANT = /-W\d*$/;
/**
 * A Thai depositary receipt: the foreign company's code and the two-digit
 * number of the Thai broker that issued it (SOFTBANK80, AAPL01, NVDA19). Its
 * ratio to the company's share is the issuer's and is not on record.
 */
const THAI_RECEIPT = /^[A-Z][A-Z0-9]{1,7}(?:01|03|06|11|13|19|23|24|80)$/;

/**
 * A fund's own name: an exchange-traded fund, note or product (a UCITS one
 * too), a Brazilian index fund ("Fundo de Índice", "Classe de Índice"), an
 * index or mutual fund, a unit trust. "Fund", "Trust" and "REIT" alone also
 * name operating companies (Blackstone Secured Lending Fund, Northern Trust,
 * Federal Realty Investment Trust).
 */
const FUND_NAMES = [
  /\b(?:ETFs?|ETNs?|ETPs?)\b/,
  /\bUCITS\b/,
  /\bexchange[- ]traded\s+(?:funds?|notes?|products?|commodit(?:y|ies))\b/i,
  /\b(?:fundos?|classes?)\s+de\s+[íi]ndice\b/i,
  /\b(?:index|mutual)\s+funds?\b/i,
  /\bunit\s+trusts?\b/i,
];
/**
 * A profile whose first sentence says the line is a fund: "The Inv-GW CHNXT
 * 50 ETF is an exchange-traded fund", "Polar Capital Technology Trust plc is
 * a closed ended equity mutual fund", "Sprott Physical Uranium Trust is a
 * closed-end commodity trust". Not a company that sponsors or runs them, a
 * business development company ("a closed-end investment company") or a real
 * estate investment trust.
 */
const FUND_DESCRIPTION =
  /^[^.]*?\bis\s+(?:an?\s+|the\s+)?(?:(?:type|kind|form)\s+of\s+)?(?:[\w&,-]+\s+){0,3}?(?:exchange[- ]traded\s+(?:funds?|notes?|products?|commodit(?:y|ies))|closed[- ]end(?:ed)?\s+(?:[\w-]+\s+){0,2}?(?:funds?|trusts?)|mutual\s+funds?|unit\s+(?:investment\s+)?trusts?|index\s+funds?)\b(?!\s+(?:sponsor|provider|manager|management|issuer|company|business|platform|firm|operator|administrator|distributor)s?\b)/i;

/**
 * Whether a listing is a fund, whose units are no company's shares: its type
 * says so, its name (the quote's, else the profile's, which can be another
 * listing's), or the first sentence of its profile. 159682 on SZSE, the
 * ChiNext 50 ETF a source types EQUITY, read 0.87x on an EPS of 1.27. Gloom
 * Cloud's screener reads funds alike.
 */
function isFund(financials: Pick<TickerFinancials, "quote" | "profile">): boolean {
  if (classifyInstrumentType(financials.quote?.instrumentType) === "fund") return true;
  const name = financials.quote?.name?.trim() || financials.profile?.name?.trim() || "";
  return FUND_NAMES.some((rule) => rule.test(name)) || FUND_DESCRIPTION.test(financials.profile?.description?.trim() ?? "");
}

type Instrument = "warrant" | "right" | "unit";

const instrumentOf = (code: string): Instrument => {
  const lower = code.toLowerCase();
  return lower.startsWith("r") ? "right" : lower.startsWith("u") ? "unit" : "warrant";
};

type ShareInputs = Pick<TickerFinancials, "quote" | "profile" | "fundamentals">;
type EpsInputs = ShareInputs & Partial<Pick<TickerFinancials, "financialCurrency" | "annualStatements" | "quarterlyStatements" | "trailingStatement">>;

/**
 * Why a listing's price over its company's EPS is no P/E, if it is not: a
 * warrant, a right or a unit is not the share (BZFDW, BuzzFeed's warrant at
 * $0.0054, read 0.03x), and a depositary receipt with no ratio on record is
 * on another count than the share (SOFTBANK80 on SET, a Thai receipt at
 * 7.85 THB over SoftBank's 203.71 THB a share, read 0.04x; AMD on the TSX, a
 * Canadian receipt Gloom Cloud flags because AMD's home line is elsewhere,
 * read 17.1x for about 120x on the share). Gloom Cloud puts a receipt whose
 * ratio is on record on the receipt already (TSM's 5 shares, a CEDEAR's
 * published ratio). A unit is told by its name only on a US venue or for a
 * blank-check company; a REIT's, a fund's or a partnership's units are its
 * share, and PSA.PR.U is a preferred. Nor is a fund's price over the EPS a
 * source gives it a P/E (isFund).
 */
export function notTheShare(financials: ShareInputs): string | undefined {
  const quote = financials.quote;
  if (!quote) return undefined;
  const venue = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  const code = (quote.symbol ?? "").split(":")[0]!.trim().toUpperCase();
  const name = quote.name ?? "";
  const named = INSTRUMENT_NAME.exec(name)?.[1];
  const byName = named && !(instrumentOf(named) === "unit"
    && (SHARE_UNITS.test(name) || !(US_LISTING_EXCHANGES.has(venue) || SPAC_NAME.test(name))))
    ? instrumentOf(named) : undefined;
  const bySymbol = PREFERRED_SYMBOL.test(code) ? undefined
    : US_LISTING_EXCHANGES.has(venue)
      ? (venue === "NASDAQ" ? NASDAQ_INSTRUMENT.exec(code)?.[1] : undefined) ?? NYSE_INSTRUMENT.exec(code)?.[1]
      : venue === "SET" && SET_WARRANT.test(code) ? "W" : undefined;
  const instrument = byName ?? (bySymbol ? instrumentOf(bySymbol) : undefined);
  if (instrument) return `a ${instrument} is not the share the EPS is per`;
  if (isFund(financials)) return "a fund is not a company's share";
  const country = financials.profile?.country?.trim().toUpperCase();
  const fundamentals = financials.fundamentals;
  const receipt = quote.isDepositaryReceipt || fundamentals?.isDepositaryReceipt || fundamentals?.shareBasis === "depositary_receipt"
    // Thai receipts are not flagged as receipts.
    || (venue === "SET" && THAI_RECEIPT.test(code) && country !== "TH");
  const ratio = [quote.adrRatio, fundamentals?.adrRatio].some((value) => typeof value === "number" && value > 0)
    || !!(quote.cedearRatio ?? fundamentals?.cedearRatio) || !!fundamentals?.trailingEpsBasis;
  return receipt && !ratio ? "a depositary receipt with no ratio on record to the share the EPS is per" : undefined;
}

const isReceipt = (financials: ShareInputs) => !!(
  financials.quote?.isDepositaryReceipt || financials.fundamentals?.isDepositaryReceipt
  || financials.fundamentals?.shareBasis === "depositary_receipt" || financials.quote?.adrRatio || financials.fundamentals?.adrRatio
);

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
/** A per-share figure in a reason: whole above 100, cents above 0.01, else two significant digits (BZT's 0.000089). */
const perShare = (value: number) => Math.abs(value) >= 100 ? value.toFixed(0)
  : Math.abs(value) >= 0.01 ? value.toFixed(2) : value.toPrecision(2);
const majorCurrency = (currency: string | null | undefined) => resolveCurrencyUnit(currency).currency || undefined;

/** The latest statement's currency. */
function statementsCurrency(financials: EpsInputs): string | undefined {
  return [...(financials.quarterlyStatements ?? []), ...(financials.annualStatements ?? [])]
    .filter((row) => row.currency)
    .sort((left, right) => left.date.localeCompare(right.date))
    .at(-1)?.currency;
}

/** The currency of the trailing net income: the block's, else the financials', else the latest statement's. */
function incomeCurrency(financials: EpsInputs): string | undefined {
  return majorCurrency(financials.fundamentals?.financialCurrency ?? financials.financialCurrency ?? statementsCurrency(financials));
}

const DAY_MS = 86_400_000;
const SAME_DATE_DAYS = 10;
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const quarterApart = (from: string, to: string) => days(from, to) >= 80 && days(from, to) <= 100;

/**
 * The statements' trailing net income or diluted EPS in `currency`: the
 * latest fiscal year when no quarter runs past it, four consecutive quarters,
 * the year plus the half since it where Gloom Cloud serves one, or the latest
 * year plus the quarters since it less the same quarters a year earlier.
 * Gloom Cloud reads the same window to tell an EPS in the reporting currency.
 */
function statementsTrailing(financials: EpsInputs, currency: string, field: "netIncome" | "eps"): number | undefined {
  const usable = (rows: readonly FinancialStatement[]) => rows
    .filter((row) => finite(row[field]) && Number.isFinite(Date.parse(row.date)) && row.currency === currency)
    .sort((left, right) => left.date.localeCompare(right.date));
  const quarters = usable(quarterRows(financials.quarterlyStatements ?? []));
  const annual = usable(financials.annualStatements ?? []).at(-1);
  const latest = quarters.at(-1);
  const trailing = financials.trailingStatement;
  const served = trailing?.trailing?.method === "annual-plus-interim" && Number.isFinite(Date.parse(trailing.date))
    && trailing.currency === currency && finite(trailing[field])
    && !(annual && days(annual.date, trailing.date) <= SAME_DATE_DAYS)
    && !(latest && days(trailing.date, latest.date) > SAME_DATE_DAYS)
    ? { value: trailing[field], end: trailing.date } : undefined;
  if (!served && annual && (!latest || days(annual.date, latest.date) <= SAME_DATE_DAYS)) return annual[field]!;
  if (!latest) return served?.value;
  const lastFour = quarters.slice(-4);
  if ((!served || Math.abs(days(latest.date, served.end)) <= SAME_DATE_DAYS) && lastFour.length === 4
    && lastFour.every((row, index) => index === 0 || quarterApart(lastFour[index - 1]!.date, row.date))) {
    return lastFour.reduce((total, row) => total + row[field]!, 0);
  }
  if (served) return served.value;
  if (!annual) return undefined;
  const interims = quarters.filter((row) => days(annual.date, row.date) > SAME_DATE_DAYS);
  let previous = annual.date;
  for (const row of interims) {
    if (!quarterApart(previous, row.date)) return undefined;
    previous = row.date;
  }
  const prior = interims.map((row) => quarters.find((candidate) => Math.abs(days(candidate.date, row.date) - 365) <= SAME_DATE_DAYS));
  if (prior.some((row) => !row)) return undefined;
  return annual[field]! + interims.reduce((total, row) => total + row[field]!, 0)
    - prior.reduce((total, row) => total + row![field]!, 0);
}

/** An EPS the statements' own diluted EPS in `currency` matches, within 1% or half a cent (the source rounds to cents). */
function statementsOwnEps(financials: EpsInputs, currency: string, eps: number): boolean {
  if (eps === 0) return false;
  const annual = (financials.annualStatements ?? [])
    .filter((row) => row.currency === currency && finite(row.eps) && Number.isFinite(Date.parse(row.date)))
    .sort((left, right) => left.date.localeCompare(right.date))
    .at(-1)?.eps;
  return [annual, statementsTrailing(financials, currency, "eps")].some((own) =>
    finite(own) && own !== 0 && Math.abs(eps - own) <= Math.max(0.01 * Math.abs(own), 0.005));
}

/**
 * Why a trailing EPS in the statements' reporting currency beside a price in
 * another gives no P/E: there is no rate on record to price it at (the served
 * P/E's `trailingPEConversion`). U.UN on the TSX divided its CA$26.47 by a
 * USD 1.64 and read 16.14; NEW on Stuttgart €1.63 by GBP 0.0241, 67.63. The
 * EPS is shown to be in the reporting currency where it is labelled so, sits
 * beside a trailing block in it, the block's net income is the statements'
 * own in it, or the EPS is their own diluted EPS for the latest fiscal year
 * or their trailing twelve months (TBT on MUNICH's 308.64 JPY, Tokuyama's
 * year to March 2026, beside €21.60 read 0.07x). Gloom Cloud's screener reads
 * the same. Undefined for an EPS the filed quarters give (in the price's
 * currency), a receipt's on its home line, and one whose currency cannot be
 * told.
 */
function noRateForEps(financials: EpsInputs): string | undefined {
  const fundamentals = financials.fundamentals;
  const eps = fundamentals?.eps;
  const listing = majorCurrency(financials.quote?.currency);
  const reporting = incomeCurrency(financials);
  if (!fundamentals || !finite(eps) || !listing || !reporting || listing === reporting
    || fundamentals.trailingEpsBasis || fundamentals.trailingEpsSource === "filed-quarters") return undefined;
  const stated = majorCurrency(fundamentals.epsCurrency);
  if (stated === listing) return undefined;
  const conversion = fundamentals.trailingPEConversion;
  if (conversion && majorCurrency(conversion.from) === reporting && finite(conversion.rate) && conversion.rate > 0) return undefined;
  const income = fundamentals.netIncome;
  const statements = finite(income) ? statementsTrailing(financials, reporting, "netIncome") : undefined;
  const inReporting = stated === reporting || (!!fundamentals.financialCurrency && !fundamentals.epsCurrency)
    || (finite(income) && finite(statements) && Math.abs(income - statements) <= 0.01 * Math.max(Math.abs(income), Math.abs(statements)))
    || statementsOwnEps(financials, reporting, eps);
  return inReporting ? `EPS (TTM) in ${reporting} beside a price in ${listing}, with no rate on record` : undefined;
}

/**
 * Why a trailing EPS is not the company's, if it is not: of the other sign
 * than the block's trailing net income over its shares outstanding, or more
 * than OWN_EPS_RATIO_LIMIT times off it either way. STKH served an EPS of
 * 96.00 beside a 7.01M loss over 605,876 shares (-11.57) and read 0.02x;
 * SNBN's 577,618 CHF over 100,000 shares is its own and stands at 0.01x. The
 * size is judged only on one share and in one currency: not for a receipt,
 * whose shares can be ordinary ones, and not where the EPS is in another
 * currency than the net income. The net income is in the block's currency,
 * else the financials', else the latest statement's; the EPS in the one it
 * is labelled in, else the statements' for one summed from the filed
 * quarters, else the listing's. PAN on the JSE reports in dollars and is
 * quoted in rand: its EPS of 2.98 beside 0.07 dollars a share is no sign of
 * another company's. Undefined without the three figures.
 */
export function epsAgainstIncome(financials: EpsInputs): string | undefined {
  const fundamentals = financials.fundamentals;
  const eps = fundamentals?.eps;
  const income = fundamentals?.netIncome;
  const shares = fundamentals?.sharesOutstanding;
  if (!finite(eps) || eps === 0 || !finite(income) || income === 0 || !finite(shares) || shares <= 0) return undefined;
  const own = income / shares;
  const text = `trailing net income over shares outstanding (${perShare(own)})`;
  if (Math.sign(eps) !== Math.sign(own)) return `EPS (TTM) ${perShare(eps)} has the other sign than ${text}`;
  const epsCurrency = majorCurrency(fundamentals?.epsCurrency
    ?? (fundamentals?.trailingEpsSource === "filed-quarters" ? statementsCurrency(financials) : undefined)
    ?? financials.quote?.currency);
  const incomeIn = incomeCurrency(financials);
  if (isReceipt(financials) || (epsCurrency && incomeIn && epsCurrency !== incomeIn)) return undefined;
  const ratio = eps / own;
  return ratio > OWN_EPS_RATIO_LIMIT || ratio < 1 / OWN_EPS_RATIO_LIMIT
    ? `EPS (TTM) ${perShare(eps)} is more than ${OWN_EPS_RATIO_LIMIT} times off ${text}`
    : undefined;
}

type Withdrawn = NonNullable<Fundamentals["notMeaningful"]>;

/**
 * The financials with the multiples that are no multiple of the share
 * withdrawn and their reason under `notMeaningful`: every P/E and the PEG of
 * a warrant, a right, a unit or a receipt with no ratio (notTheShare), and
 * the trailing P/E and the PEG over an EPS in another currency with no rate
 * (noRateForEps) or one that is not the company's (epsAgainstIncome), in
 * that order. Only a multiple the block has, or a trailing one its EPS would
 * give, is withdrawn: one it never had stays absent. Reads the trailing EPS
 * withFiledTrailingEps leaves, so it runs after it. Returns the same object
 * when nothing is withdrawn.
 */
export function withShareMultiples<T extends EpsInputs>(financials: T): T {
  const fundamentals = financials.fundamentals;
  if (!fundamentals) return financials;
  const share = notTheShare(financials);
  const reason = share ?? noRateForEps(financials) ?? epsAgainstIncome(financials);
  // A multiple an earlier pass withdrew is one the block had.
  const had = fundamentals.notMeaningful ?? {};
  const has: Record<keyof Withdrawn, boolean> = {
    trailingPE: finite(fundamentals.trailingPE) || finite(fundamentals.eps) || !!had.trailingPE,
    forwardPE: !!share && (finite(fundamentals.forwardPE) || !!had.forwardPE),
    pegRatio: finite(fundamentals.pegRatio) || !!had.pegRatio,
  };
  const fields = reason ? (Object.keys(has) as Array<keyof Withdrawn>).filter((field) => has[field]) : [];
  const reasons: Withdrawn = Object.fromEntries(fields.map((field) => [field, reason]));
  if (fields.length === 0) {
    if (!fundamentals.notMeaningful) return financials;
    const { notMeaningful: _stale, ...rest } = fundamentals;
    return { ...financials, fundamentals: rest };
  }
  const next: Fundamentals = { ...fundamentals, notMeaningful: reasons };
  for (const field of fields) delete next[field];
  return { ...financials, fundamentals: next };
}
