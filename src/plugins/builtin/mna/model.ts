import type { MnaDeal, MnaStatus, MnaTerms } from "../../../api-client/mna";
import type { Quote } from "../../../types/financials";
import { formatCompact } from "../../../utils/format";

export const MNA_PANE_ID = "mna";
export const MISSING = "--";

const MS_PER_DAY = 86_400_000;

const CURRENCY_SIGNS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩" };

/** "$10.50", "€4.20", "1,250p", "CHF 88.00". */
export function formatPerShare(amount: number, currency: string | null, maxDigits = 4): string {
  const code = (currency ?? "USD").trim();
  if (code === "GBp" || code === "GBX") return `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}p`;
  const fixed = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxDigits });
  const sign = CURRENCY_SIGNS[code.toUpperCase()];
  return sign ? `${sign}${fixed}` : `${code} ${fixed}`;
}

/** A headline amount: "$1.8B", "€420M", "GBP 1.2B". */
export function formatDealValue(value: number | null, currency: string | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return MISSING;
  const code = (currency ?? "USD").toUpperCase();
  const compact = formatCompact(value, { fixedDecimals: false });
  const sign = CURRENCY_SIGNS[code];
  return sign ? `${sign}${compact}` : `${code} ${compact}`;
}

function ratioLabel(ratio: number, symbol: string | null): string {
  const shares = ratio.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return symbol ? `${shares} ${symbol}` : `${shares} sh`;
}

/** What one target share gets, in as few characters as the terms allow. */
export function termsLabel(terms: MnaTerms): string {
  const parts: string[] = [];
  if (terms.cashPerShare != null) {
    parts.push(terms.exchangeRatio == null
      ? `${formatPerShare(terms.cashPerShare, terms.currency)} cash`
      : formatPerShare(terms.cashPerShare, terms.currency));
  }
  if (terms.exchangeRatio != null) parts.push(ratioLabel(terms.exchangeRatio, terms.ratioSymbol));
  if (parts.length === 0) {
    parts.push(terms.consideration === "cash" ? "Cash"
      : terms.consideration === "stock" ? "Stock"
        : terms.consideration === "mixed" ? "Cash and stock"
          : MISSING);
  }
  let label = parts.join(" + ");
  if (terms.cvr) label += " + CVR";
  if (terms.partial) label += ", partial";
  return label;
}

export const STATUS_LABELS: Record<MnaStatus, string> = {
  talks: "Talks",
  pending: "Pending",
  completed: "Completed",
  terminated: "Terminated",
};

/** The stage says more than "Pending" once a deal has one. */
export function stageLabel(deal: MnaDeal): string {
  if (deal.stale) return `No news since ${formatListDate(deal.lastReported)}`;
  if (deal.status === "pending") return deal.hostile ? `Hostile${deal.stage ? `, ${deal.stage.toLowerCase()}` : ""}` : deal.stage ?? "Pending";
  if (deal.status === "talks") return deal.acquirer ? "Talks" : "Exploring sale";
  return STATUS_LABELS[deal.status];
}

const PENCE = new Set(["GBp", "GBX"]);

/**
 * London quotes arrive in pounds while UK offers are often in pence, so the
 * two compare after scaling; any other currency mismatch has no price.
 */
function inQuoteCurrency(amount: number, from: string | null, quoteCurrency: string | undefined): number | null {
  const offer = from ?? "USD";
  const quote = quoteCurrency ?? "USD";
  if (offer === quote) return amount;
  if (offer === "GBP" && PENCE.has(quote)) return amount * 100;
  if (PENCE.has(offer) && quote === "GBP") return amount / 100;
  if (PENCE.has(offer) || PENCE.has(quote)) return null;
  return offer.toUpperCase() === quote.toUpperCase() ? amount : null;
}

/**
 * What the terms pay per target share at the latest prices, in the target
 * quote's currency. Null when a leg cannot be priced: no terms, a ratio
 * without its listing, or cash in another currency.
 */
export function offerValue(deal: MnaDeal, targetQuote: Quote | null, ratioQuote: Quote | null): number | null {
  const { terms } = deal;
  if (terms.cashPerShare == null && terms.exchangeRatio == null) return null;
  let total = 0;
  if (terms.cashPerShare != null) {
    const cash = inQuoteCurrency(terms.cashPerShare, terms.currency, targetQuote?.currency);
    if (cash == null) return null;
    total += cash;
  }
  if (terms.exchangeRatio != null) {
    const price = ratioQuote?.price;
    if (!terms.ratioSymbol || price == null || !Number.isFinite(price) || price <= 0) return null;
    const leg = inQuoteCurrency(price, ratioQuote?.currency ?? null, targetQuote?.currency);
    if (leg == null) return null;
    total += terms.exchangeRatio * leg;
  }
  return total > 0 ? total : null;
}

export interface DealSpread {
  offer: number;
  price: number;
  /** Fraction of the target price, e.g. 0.004 for 0.4%. */
  spread: number;
  /** Simple annualized spread to the expected close; null past it or without a date. */
  annualized: number | null;
}

/** Last day of a "Q1 2027", "H2 2026" or "2026" close; a full date passes through. */
export function expectedCloseDate(value: string | null): Date | null {
  if (!value) return null;
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const date = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    return date.toISOString().slice(0, 10) === text ? date : null;
  }
  const quarter = /^Q([1-4])\s+(\d{4})$/i.exec(text);
  if (quarter) return new Date(Date.UTC(Number(quarter[2]), Number(quarter[1]) * 3, 0));
  const half = /^H([12])\s+(\d{4})$/i.exec(text);
  if (half) return new Date(Date.UTC(Number(half[2]), Number(half[1]) * 6, 0));
  const year = /^(\d{4})$/.exec(text);
  if (year) return new Date(Date.UTC(Number(year[1]), 12, 0));
  return null;
}

/** "Oct 15", "Q1 27", "2027". */
export function formatExpectedClose(value: string | null, now = new Date()): string {
  if (!value) return MISSING;
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const date = new Date(`${text}T00:00:00Z`);
    const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    return date.getUTCFullYear() === now.getUTCFullYear() ? `${month} ${Number(day[3])}` : `${month} ${day[1]!.slice(2)}`;
  }
  const period = /^([QH][1-4])\s+(\d{4})$/i.exec(text);
  if (period) return `${period[1]!.toUpperCase()} ${period[2]!.slice(2)}`;
  return text;
}

/**
 * The arbitrage spread of a pending deal at the latest prices. A partial
 * offer's spread applies only to the prorated slice, so it has no
 * annualized figure; neither has a negative spread, which says the market
 * expects better terms rather than a return.
 */
export function dealSpread(
  deal: MnaDeal,
  targetQuote: Quote | null,
  ratioQuote: Quote | null,
  now = Date.now(),
): DealSpread | null {
  if (deal.status !== "pending" || !deal.target.symbol) return null;
  const price = targetQuote?.price;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const offer = offerValue(deal, targetQuote, ratioQuote);
  if (offer == null) return null;
  const spread = offer / price - 1;
  const close = expectedCloseDate(deal.expectedClose);
  const days = close ? (close.getTime() - now) / MS_PER_DAY : null;
  const annualized = !deal.terms.partial && spread > 0 && days != null && days >= 1
    ? spread * 365 / days
    : null;
  return { offer, price, spread, annualized };
}

/** Days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/** Target name for a table cell: the symbol when listed, else the name. */
export function partyCell(party: { name: string; symbol: string | null } | null, preferSymbol: boolean): string {
  if (!party) return MISSING;
  return preferSymbol && party.symbol ? party.symbol : party.name;
}

/** "Sep 10" this year, "Dec 2025" before it. */
export function formatListDate(value: string, now = new Date()): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return MISSING;
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return date.getUTCFullYear() === now.getUTCFullYear() ? `${month} ${date.getUTCDate()}` : `${month} ${date.getUTCFullYear()}`;
}

/** 0.0038 is "0.38%", -0.049 is "-4.9%": tight arb spreads keep two decimals. */
export function formatPercentShort(value: number): string {
  const percent = value * 100;
  const digits = Math.abs(percent) < 1 ? 2 : 1;
  const fixed = percent.toFixed(digits);
  return `${/[1-9]/.test(fixed) ? fixed : fixed.replace("-", "")}%`;
}

export function formatPrice(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 });
}
