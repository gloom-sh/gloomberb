import type { Portfolio } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { resolvePortfolioCash } from "../../../portfolio/allocation";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { canonicalExchange, normalizeSymbol } from "../../../utils/exchanges";

/**
 * The whole book beside the equity basket: the cash it holds by currency, and
 * the stress shocks that reprice every line of it (holdings and cash) through
 * its currency or its own price, rather than through a basket regression.
 */

/** One currency of the cash a portfolio holds beside its positions. */
export interface RiskCashLine {
  currency: string;
  /** In `currency`; negative for a balance owed. */
  amount: number;
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

/**
 * The portfolio's cash by currency: the broker account's own balances when it
 * reports them per currency, else its total cash (in the portfolio's currency
 * when the account names none), else the amount entered with `portfolio cash set`.
 */
export function riskCashLines(
  portfolio: Pick<Portfolio, "cash" | "currency">,
  account: Pick<BrokerAccount, "cashBalances" | "totalCashValue" | "currency"> | null | undefined,
): RiskCashLine[] {
  const byCurrency = new Map<string, number>();
  for (const balance of account?.cashBalances ?? []) {
    const currency = balance.currency?.trim().toUpperCase() ?? "";
    // A broker's summary row (IBKR's BASE) is no currency of its own.
    if (!ISO_CURRENCY.test(currency) || !Number.isFinite(balance.quantity) || Math.abs(balance.quantity) < 1e-9) continue;
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + balance.quantity);
  }
  if (byCurrency.size) return [...byCurrency].map(([currency, amount]) => ({ currency, amount }));
  const line = resolvePortfolioCash(portfolio, account);
  const currency = (line?.currency.trim() || portfolio.currency || "").toUpperCase();
  return line && ISO_CURRENCY.test(currency) && Number.isFinite(line.amount) && line.amount !== 0
    ? [{ currency, amount: line.amount }]
    : [];
}

/** A currency's move against USD, in percent of its USD value: TRY -20 is the lira 20% weaker. */
export interface RiskFxShift {
  currency: string;
  percent: number;
}
/** A holding's own price move, in percent, in its listing currency. */
export interface RiskAssetShift {
  symbol: string;
  exchange?: string;
  percent: number;
}

/** The moves a shock takes, in percent: a fall to nothing is no scenario, a rise past six times is no stress. */
export const RISK_SHOCK_LIMITS = { minimum: -99, maximum: 500 } as const;

/** `-20%` and `+10%` as a shock names its move. */
const signedPercent = (percent: number) => `${percent > 0 ? "+" : ""}${percent}%`;

/** The commas that separate shocks: not a decimal comma between two digits (`TRY -2,5`). */
const SHOCK_SEPARATOR = /(?<!\d),|,(?!\d)/;

/** `TRY -20, EUR 5`: each item a name and a percent, or why one is not. */
function shockItems(text: string, flag: string, what: string, example: string): Array<{ name: string; percent: number }> {
  const items = text.split(SHOCK_SEPARATOR).map((item) => item.trim()).filter(Boolean);
  if (!items.length) throw new Error(`${flag} takes ${what} and a percent, such as ${example}.`);
  return items.map((item) => {
    const match = /^(\S+)\s+([-+]?\d+(?:[.,]\d+)?)\s*%?$/.exec(item);
    if (!match) throw new Error(`${flag} takes ${what} and a percent, such as ${example}; got "${item}".`);
    const percent = Number(match[2]!.replace(",", "."));
    if (percent < RISK_SHOCK_LIMITS.minimum || percent > RISK_SHOCK_LIMITS.maximum)
      throw new Error(`${flag} moves by ${RISK_SHOCK_LIMITS.minimum}% to +${RISK_SHOCK_LIMITS.maximum}%; got ${match[2]} for ${match[1]}.`);
    return { name: match[1]!, percent };
  });
}

/** `--fx-shift TRY -20, EUR 5`, read; throws naming what is wrong. */
export function parseFxShifts(text: string, flag = "--fx-shift"): RiskFxShift[] {
  const shifts = shockItems(text, flag, "a currency", "TRY -20").map(({ name, percent }) => {
    const currency = name.toUpperCase();
    if (!ISO_CURRENCY.test(currency)) throw new Error(`${flag} takes a three-letter currency code such as TRY or EUR; got "${name}".`);
    if (currency === "USD")
      throw new Error(`${flag} moves a currency against USD, so USD itself does not shift: a stronger dollar is the other currency falling (TRY -20).`);
    return { currency, percent };
  });
  const twice = shifts.find((shift, index) => shifts.findIndex((other) => other.currency === shift.currency) !== index);
  if (twice) throw new Error(`${flag} names ${twice.currency} twice.`);
  return shifts;
}

/** `--asset-shift GLD 10, BTC-USD -30`, read; throws naming what is wrong. */
export function parseAssetShifts(text: string, flag = "--asset-shift"): RiskAssetShift[] {
  const shifts = shockItems(text, flag, "a holding", "GLD 10").map(({ name, percent }) => {
    if (!/^[A-Za-z0-9^][A-Za-z0-9.=^&/-]{0,23}(?::[A-Za-z0-9.]{1,12})?$/.test(name))
      throw new Error(`${flag} takes a holding's symbol, such as GLD or BTC-USD; got "${name}".`);
    const [symbol, exchange] = name.toUpperCase().split(":");
    return { symbol: symbol!, ...(exchange ? { exchange } : {}), percent };
  });
  const key = (shift: RiskAssetShift) => `${shift.symbol}:${shift.exchange ?? ""}`;
  const twice = shifts.find((shift, index) => shifts.findIndex((other) => key(other) === key(shift)) !== index);
  if (twice) throw new Error(`${flag} names ${twice.symbol} twice.`);
  return shifts;
}

/** The canonical text of shocks, as an option keeps it (`TRY -20, EUR 5`). */
export function formatShocks(shifts: readonly (RiskFxShift | RiskAssetShift)[]): string {
  return shifts.map((shift) => {
    const name = "currency" in shift ? shift.currency : `${shift.symbol}${shift.exchange ? `:${shift.exchange}` : ""}`;
    return `${name} ${shift.percent}`;
  }).join(", ");
}

/** One line of the book to reprice: a holding or a currency's cash. */
export interface RiskBookLine {
  id: string;
  label: string;
  /** The currency its value moves with against USD: a listing's own (GBP for pence), or the cash's. */
  currency: string;
  /** Signed value in the account currency; null when nothing values it. */
  value: number | null;
  /** The listing an asset shift names; null for cash. */
  listing: { symbol: string; exchange: string } | null;
}
interface RiskRepricedLine {
  id: string;
  label: string;
  /** The shocks that move it, as named: "TRY -20% vs USD", "BTC-USD -30%". */
  shocks: string[];
  before: number | null;
  after: number | null;
  change: number | null;
  /** Change in percent of the line's own gross value. */
  percent: number | null;
}
/** Every given shock applied at once, each line of the book repriced at its own currency and price. */
export interface RiskRepricing {
  /** "TRY -20% vs USD, BTC-USD -30%". */
  scenario: string;
  /** Lines a shock moves, largest change first; lines without a value last. */
  lines: RiskRepricedLine[];
  /** The book's net value before the shocks, cash included, in the account currency. */
  bookValue: number;
  change: number;
  /** Change in percent of `bookValue`; null when the book is worth nothing net. */
  percent: number | null;
  /** Lines a shock moves that have no value, so are not in the change. */
  unvalued: string[];
  /** Shocks nothing in the book moves with: a currency it holds nothing in, a holding it does not hold. */
  unmatched: Array<{ kind: "currency" | "holding"; name: string }>;
}

const fxName = (shift: RiskFxShift) => `${shift.currency} ${signedPercent(shift.percent)} vs USD`;
const assetName = (shift: RiskAssetShift) => `${shift.symbol}${shift.exchange ? `:${shift.exchange}` : ""} ${signedPercent(shift.percent)}`;

/**
 * Reprices every line of the book under the shocks at once. A line's value in
 * the account currency is its USD value over the USD price of one account
 * unit, so a currency's move changes it by (1 + its currency's move) and (for
 * a listing a shock names) (1 + its own move), over (1 + the account
 * currency's move): TRY -20 takes a fifth off lira cash in a USD account, and
 * adds a quarter to a USD holding in a lira account. Null without a shock.
 */
export function repriceBook(
  lines: readonly RiskBookLine[],
  accountCurrency: string,
  fx: readonly RiskFxShift[] = [],
  assets: readonly RiskAssetShift[] = [],
): RiskRepricing | null {
  if (!fx.length && !assets.length) return null;
  const currencyOf = (currency: string) => resolveCurrencyUnit(currency).currency || "USD";
  const account = currencyOf(accountCurrency);
  const fxShift = new Map(fx.map((shift) => [shift.currency, shift]));
  const matches = (shift: RiskAssetShift, line: RiskBookLine) =>
    !!line.listing && normalizeSymbol(line.listing.symbol) === normalizeSymbol(shift.symbol)
    && (!shift.exchange || canonicalExchange(line.listing.exchange) === canonicalExchange(shift.exchange));
  const moved = new Set<string>();
  const repriced = lines.flatMap((line): RiskRepricedLine[] => {
    const own = currencyOf(line.currency);
    const ownShift = own === account ? undefined : fxShift.get(own);
    const accountShift = own === account ? undefined : fxShift.get(account);
    const asset = assets.find((shift) => matches(shift, line));
    const factor = (1 + (ownShift?.percent ?? 0) / 100) * (1 + (asset?.percent ?? 0) / 100) / (1 + (accountShift?.percent ?? 0) / 100);
    if (Math.abs(factor - 1) < 1e-12) return [];
    for (const shift of [ownShift, accountShift]) if (shift) moved.add(shift.currency);
    if (asset) moved.add(assetName(asset));
    const shocks = [...(ownShift ? [fxName(ownShift)] : []), ...(accountShift ? [fxName(accountShift)] : []), ...(asset ? [assetName(asset)] : [])];
    if (line.value == null)
      return [{ id: line.id, label: line.label, shocks, before: null, after: null, change: null, percent: null }];
    const after = line.value * factor;
    return [{
      id: line.id, label: line.label, shocks, before: line.value, after, change: after - line.value,
      percent: line.value === 0 ? 0 : ((after - line.value) / Math.abs(line.value)) * 100,
    }];
  }).sort((left, right) => (left.change == null ? 1 : 0) - (right.change == null ? 1 : 0)
    || Math.abs(right.change ?? 0) - Math.abs(left.change ?? 0));
  const bookValue = lines.reduce((sum, line) => sum + (line.value ?? 0), 0);
  const change = repriced.reduce((sum, line) => sum + (line.change ?? 0), 0);
  return {
    scenario: [...fx.map(fxName), ...assets.map(assetName)].join(", "),
    lines: repriced,
    bookValue,
    change,
    percent: bookValue > 0 ? (change / bookValue) * 100 : null,
    unvalued: repriced.filter((line) => line.change == null).map((line) => line.label),
    unmatched: [
      ...fx.filter((shift) => !moved.has(shift.currency)).map((shift) => ({ kind: "currency" as const, name: shift.currency })),
      ...assets.filter((shift) => !moved.has(assetName(shift)))
        .map((shift) => ({ kind: "holding" as const, name: `${shift.symbol}${shift.exchange ? `:${shift.exchange}` : ""}` })),
    ],
  };
}
