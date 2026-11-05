import { parseFxArgs, parseFxRequest } from "../../../cli/fx-pair";
import { currencyMinorDigits } from "../../../market-data/market/format";
import { parseTypedNumber } from "../../../utils/decimal-comma";
import { isFxCurrency, type FxCurrency } from "./pairs";

/** An amount of one of the board's currencies, shown in every currency it lists. */
export interface FxBoardAmount {
  amount: number;
  currency: FxCurrency;
}

/** What an amount typed for the board reads as: the amount, and the currency it was asked in when one is named. */
export interface FxBoardAmountRequest extends FxBoardAmount {
  /** `EUR/USD` and `eur to usd` ask for USD: the board lists it too. */
  to: FxCurrency | null;
}

/** The words a converter is asked with that name no amount or currency: `convert 100 eur to usd`. */
const FILLER_WORDS = new Set(["convert", "converter", "conversion", "fx", "to", "in", "into", "=", "->", "→"]);

/** The board is asked for codes it carries, which are three letters; anything else is no currency for it. */
function boardCurrency(code: string, typed: string): FxCurrency | { error: string } {
  return isFxCurrency(code) ? code : { error: `${typed.trim()} is not on the board; type a code such as EUR.` };
}

/**
 * An amount typed for the board, as `fx` takes one: `2,500,000 EUR`,
 * `2500000 eur/usd`, `100 EUR USD`, `convert 100 eur to usd`, and the
 * currency first (`EUR 2,500,000`). A currency or a pair alone is one unit
 * of it (`eur to usd`). Null for blank text, the error sentence for text that
 * names no amount of a currency the board carries.
 */
export function parseFxBoardAmount(text: string): FxBoardAmountRequest | { error: string } | null {
  const words = text.trim().split(/\s+/).filter((word) => word && !FILLER_WORDS.has(word.toLowerCase()));
  if (words.length === 0) return null;
  // The currency typed first (EUR 2,500,000) reads as fx reads the amount first.
  const ordered = words.length >= 2 && parseTypedNumber(words[0]).kind === "invalid" && parseTypedNumber(words[1]).kind !== "invalid"
    ? [words[1]!, words[0]!, ...words.slice(2)]
    : words;
  const amountFirst = parseTypedNumber(ordered[0]).kind !== "invalid";
  let amount = 1;
  let from: string;
  let to: string | null = null;
  if (amountFirst) {
    const parsed = parseFxArgs(ordered, "USD");
    if ("error" in parsed) return { error: parsed.error.replace(/\bfx (?=\d)/g, "") };
    amount = parsed.amount ?? 1;
    from = parsed.request.currency;
    to = parsed.toUsdByDefault ? null : parsed.request.baseCurrency;
  } else {
    if (ordered.length > 2) return { error: `Type an amount and a currency, such as 2,500,000 EUR; got ${text.trim()}.` };
    const request = parseFxRequest(ordered.join("/"), "USD");
    if ("error" in request) return request;
    from = request.currency;
    to = ordered.length === 2 || ordered[0]!.includes("/") || request.baseCurrency !== "USD" ? request.baseCurrency : null;
  }
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Type an amount above zero, such as 2,500,000 EUR." };
  const currency = boardCurrency(from, from);
  if (typeof currency !== "string") return currency;
  const target = to ? boardCurrency(to, to) : null;
  if (target && typeof target !== "string") return target;
  return { amount, currency, to: target === currency ? null : target };
}

/** An amount as its currency writes it, grouped: 2,500,000 and 2,500,000.50 in EUR, 445,000,000 in JPY. */
export function formatAmountFigure(amount: number, currency: string): string {
  const digits = currencyMinorDigits(currency);
  // A small figure keeps significant digits instead of rounding to 0.00.
  if (amount !== 0 && Math.abs(amount) < 10 ** -digits) return amount.toPrecision(3);
  return amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * The amount as the board saves it: ungrouped, with a point for decimals
 * (`5000 EUR`, `2500000.5 EUR`), so it reads back as itself. Grouped, `5,000
 * EUR` read back as 5 or 5000 and dropped the column; the grouping is only
 * for showing it (`formatFxBoardAmount`).
 */
export function storedFxBoardAmount({ amount, currency }: FxBoardAmount): string {
  const figure = String(amount);
  return `${/e/i.test(figure) ? amount.toFixed(20).replace(/\.?0+$/, "") : figure} ${currency}`;
}

const STORED_AMOUNT = /^(\d+(?:\.\d+)?) ([A-Z]{3})$/;

/**
 * The board's saved amount: as the board saves it (`storedFxBoardAmount`),
 * else as `fx` reads a typed one. Null for none; the reason for one it
 * cannot read.
 */
export function readFxBoardAmount(saved: unknown): FxBoardAmount | { error: string } | null {
  if (typeof saved !== "string" || !saved.trim()) return null;
  const stored = STORED_AMOUNT.exec(saved.trim());
  if (stored) {
    const currency = boardCurrency(stored[2]!, stored[2]!);
    if (typeof currency !== "string") return currency;
    const amount = Number(stored[1]);
    return amount > 0 ? { amount, currency } : { error: "Type an amount above zero, such as 2,500,000 EUR." };
  }
  const typed = parseFxBoardAmount(saved);
  return typed && !("error" in typed) ? { amount: typed.amount, currency: typed.currency } : typed;
}

/**
 * An amount typed where the board's saved one stood: that amount, put back as
 * it was saved, reads as saved (`1.234 EUR` is not asked about as 1234); any
 * other text reads as `fx` reads an amount (`parseFxBoardAmount`).
 */
export function parseFxBoardAmountEdit(text: string, saved: unknown): FxBoardAmountRequest | { error: string } | null {
  if (typeof saved === "string" && saved.trim() && text.trim() === saved.trim()) {
    const kept = readFxBoardAmount(saved);
    if (kept && !("error" in kept)) return { ...kept, to: null };
  }
  return parseFxBoardAmount(text);
}

/** The amount as the board's field and its column name it: `2,500,000 EUR`, whole amounts without cents. */
export function formatFxBoardAmount({ amount, currency }: FxBoardAmount): string {
  const figure = Number.isInteger(amount)
    ? amount.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : formatAmountFigure(amount, currency);
  return `${figure} ${currency}`;
}

/**
 * The board's currencies with the ones an amount names added at the end, as
 * `fx 2500000 EUR/USD` opens the board on EUR and USD whatever it listed.
 */
export function withAmountCurrencies(currencies: readonly FxCurrency[], request: FxBoardAmountRequest): FxCurrency[] {
  const named = [request.currency, ...(request.to ? [request.to] : [])];
  return [...currencies, ...named.filter((code) => !currencies.includes(code))];
}
