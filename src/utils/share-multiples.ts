import type { Fundamentals, TickerFinancials } from "../types/financials";
import { resolveCurrencyUnit } from "./currency-units";
import { canonicalExchange, US_LISTING_EXCHANGES } from "./exchanges";

/** Beyond this either way, a trailing EPS is not net income over the shares. */
const OWN_EPS_RATIO_LIMIT = 10;

/** Nasdaq's fifth letter W, R or U is a warrant, a right or a unit (BZFDW, TDWDR, SAAQU). */
const NASDAQ_INSTRUMENT = /^[A-Z]{4}([WRU])$/;
/** NYSE's suffixes: NWAX.WS, ABC.U, ABC.RT. */
const NYSE_INSTRUMENT = /[.\-/ ](WS|WT|U|RT)(?:\.[A-Z])?$/;
/** A warrant, right or unit by its name: the word at its end, or before its terms. */
const INSTRUMENT_NAME =
  /(?:^|[\s,.(-])(warrants?|wts?|rights?|units?)(?:\s*(?:\([^)]*\))?\s*$|[\s,]+(?:each|exp(?:iring|ire|\.)?|exercisable|to\s+(?:purchase|buy|acquire|subscribe)|consisting)\b)/i;
/** A partnership's or a trust's units are its share. */
const SHARE_UNITS = /\b(?:common|partnership|ordinary|stapled|beneficial|trust|lp|l\.p\.|llc|class\s+[a-z])\s+units?\b/i;
/** SET's own warrants: JMART-W4. */
const SET_WARRANT = /-W\d*$/;
/**
 * A Thai depositary receipt: the foreign company's code and the two-digit
 * number of the Thai broker that issued it (SOFTBANK80, AAPL01, NVDA19). Its
 * ratio to the company's share is the issuer's and is not on record.
 */
const THAI_RECEIPT = /^[A-Z][A-Z0-9]{1,7}(?:01|03|06|11|13|19|23|24|80)$/;

type Instrument = "warrant" | "right" | "unit";

const instrumentOf = (code: string): Instrument => {
  const lower = code.toLowerCase();
  return lower.startsWith("r") ? "right" : lower.startsWith("u") ? "unit" : "warrant";
};

type ShareInputs = Pick<TickerFinancials, "quote" | "profile" | "fundamentals">;

/**
 * Why a listing's price over its company's EPS is no P/E, if it is not: a
 * warrant, a right or a unit is not the share (BZFDW, BuzzFeed's warrant at
 * $0.0054, read 0.03x), and a depositary receipt with no ratio on record is
 * on another count than the share (SOFTBANK80 on SET, a Thai receipt at
 * 7.85 THB over SoftBank's 203.71 THB a share, read 0.04x). Gloom Cloud puts
 * a receipt whose ratio is on record on the receipt already. EQS reads the
 * same (the server's equity-screener share-multiples).
 */
export function notTheShare(financials: ShareInputs): string | undefined {
  const quote = financials.quote;
  if (!quote) return undefined;
  const venue = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  const code = quote.symbol.split(":")[0]!.trim().toUpperCase();
  const name = quote.name ?? "";
  const named = INSTRUMENT_NAME.exec(name)?.[1];
  const byName = named && !(instrumentOf(named) === "unit" && SHARE_UNITS.test(name)) ? instrumentOf(named) : undefined;
  const bySymbol = US_LISTING_EXCHANGES.has(venue)
    ? (venue === "NASDAQ" ? NASDAQ_INSTRUMENT.exec(code)?.[1] : undefined) ?? NYSE_INSTRUMENT.exec(code)?.[1]
    : venue === "SET" && SET_WARRANT.test(code) ? "W" : undefined;
  const instrument = byName ?? (bySymbol ? instrumentOf(bySymbol) : undefined);
  if (instrument) return `a ${instrument} is not the share the EPS is per`;
  const country = financials.profile?.country?.trim().toUpperCase();
  const ratio = financials.fundamentals?.adrRatio ?? quote.adrRatio;
  if (venue === "SET" && THAI_RECEIPT.test(code) && country !== "TH" && !(typeof ratio === "number" && ratio > 0)) {
    return "a depositary receipt with no ratio on record to the share the EPS is per";
  }
  return undefined;
}

const isReceipt = (financials: ShareInputs) => !!(
  financials.quote?.isDepositaryReceipt || financials.fundamentals?.isDepositaryReceipt
  || financials.fundamentals?.shareBasis === "depositary_receipt" || financials.quote?.adrRatio || financials.fundamentals?.adrRatio
);

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const perShare = (value: number) => Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);

/**
 * Why a trailing EPS is not the company's, if it is not: of the other sign
 * than the block's trailing net income over its shares outstanding, or more
 * than OWN_EPS_RATIO_LIMIT times off it either way. STKH served an EPS of
 * 96.00 beside a 7.01M loss over 605,876 shares (-11.57) and read 0.02x;
 * SNBN's 577,618 CHF over 100,000 shares is its own and stands at 0.01x. The
 * size is judged only where both are on one share and currency: not for a
 * receipt, whose shares can be ordinary ones, nor an EPS in another currency
 * than the net income. Undefined without the three figures.
 */
export function epsAgainstIncome(financials: ShareInputs): string | undefined {
  const fundamentals = financials.fundamentals;
  const eps = fundamentals?.eps;
  const income = fundamentals?.netIncome;
  const shares = fundamentals?.sharesOutstanding;
  if (!finite(eps) || eps === 0 || !finite(income) || income === 0 || !finite(shares) || shares <= 0) return undefined;
  const own = income / shares;
  const text = `trailing net income over shares outstanding (${perShare(own)})`;
  if (Math.sign(eps) !== Math.sign(own)) return `EPS (TTM) ${perShare(eps)} has the other sign than ${text}`;
  const epsCurrency = fundamentals?.epsCurrency?.trim();
  const incomeCurrency = fundamentals?.financialCurrency?.trim();
  if (isReceipt(financials)
    || (epsCurrency && incomeCurrency && resolveCurrencyUnit(epsCurrency).currency !== resolveCurrencyUnit(incomeCurrency).currency)) return undefined;
  const ratio = eps / own;
  return ratio > OWN_EPS_RATIO_LIMIT || ratio < 1 / OWN_EPS_RATIO_LIMIT
    ? `EPS (TTM) ${perShare(eps)} is more than ${OWN_EPS_RATIO_LIMIT} times off ${text}`
    : undefined;
}

type Withdrawn = NonNullable<Fundamentals["notMeaningful"]>;

/**
 * The financials with the multiples that are no multiple of the share
 * withdrawn and their reason under `notMeaningful`: every P/E and the PEG of
 * a warrant, a right, a unit or a receipt with no ratio (notTheShare), the
 * trailing P/E and the PEG over an EPS that is not the company's
 * (epsAgainstIncome). Reads the trailing EPS withFiledTrailingEps leaves, so
 * it runs after it. Returns the same object when nothing is withdrawn.
 */
export function withShareMultiples<T extends ShareInputs>(financials: T): T {
  const fundamentals = financials.fundamentals;
  if (!fundamentals) return financials;
  const share = notTheShare(financials);
  const own = share ? undefined : epsAgainstIncome(financials);
  const reasons: Withdrawn = share
    ? { trailingPE: share, forwardPE: share, pegRatio: share }
    : own ? { trailingPE: own, pegRatio: own } : {};
  const fields = Object.keys(reasons) as Array<keyof Withdrawn>;
  if (fields.length === 0) {
    if (!fundamentals.notMeaningful) return financials;
    const { notMeaningful: _stale, ...rest } = fundamentals;
    return { ...financials, fundamentals: rest };
  }
  const next: Fundamentals = { ...fundamentals, notMeaningful: reasons };
  for (const field of fields) delete next[field];
  return { ...financials, fundamentals: next };
}
