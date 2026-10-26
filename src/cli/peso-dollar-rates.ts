import type { Quote } from "../types/financials";
import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../types/data-provider";
import {
  bymaDollarLineKeys, formatPairRate, listingDepositaryPair, pairPriceInput, pairTimeText, pesoImpliedRates,
  PESO_REFERENCE_RECEIPT, spotRateKind, type ImpliedDollarRate,
} from "../market-data/depositary-pair";

/** Galicia's peso line, which the receipt and both Buenos Aires dollar lines are compared with. */
const PESO_REFERENCE_HOME = "GGAL.BA";

export interface PesoDollarRates {
  /** `official wholesale`: what the served USD/ARS rate is. */
  spotKind: string;
  rates: ImpliedDollarRate[];
  /** The listings no price came back for. */
  missing: string[];
}

/** Whether a pair is the peso against the dollar, either way round. */
export function isPesoDollarPair(currency: string, baseCurrency: string): boolean {
  const codes = new Set([currency, baseCurrency]);
  return codes.has("ARS") && codes.has("USD");
}

/**
 * The peso's market dollar rates beside the official one: the CCL rate
 * Galicia's receipt implies against its peso line, and the CCL and MEP rates
 * of its Buenos Aires C and D lines. The four quotes are read in one batch,
 * through the same quote path as `quote`. The receipt's ratio is the one
 * Gloom Cloud serves on it; without it that row is left out.
 */
export async function loadPesoDollarRates(
  getQuotesBatch: (targets: QuoteSubscriptionTarget[]) => Promise<QuoteBatchResult[]>,
): Promise<PesoDollarRates> {
  const lines = bymaDollarLineKeys(PESO_REFERENCE_HOME)!;
  const keys = [PESO_REFERENCE_RECEIPT, PESO_REFERENCE_HOME, lines.ccl, lines.mep];
  const results = await getQuotesBatch(keys.map((symbol) => ({ symbol, exchange: "" })));
  const quotes = new Map<string, Quote | null>(keys.map((key, index) => [key, results[index]?.quote ?? null]));
  const receiptQuote = quotes.get(PESO_REFERENCE_RECEIPT) ?? null;
  const pair = listingDepositaryPair({ quote: receiptQuote });
  const pairsWithHome = pair?.ordinary.some((line) => line.toUpperCase() === PESO_REFERENCE_HOME) ?? false;
  const input = (key: string) => pairPriceInput(key, quotes.get(key));
  // A ratio not on record leaves the receipt's rate out rather than guess it.
  const rates = pesoImpliedRates(pair && pairsWithHome ? pair.ratio : null, {
    home: input(PESO_REFERENCE_HOME),
    receipt: input(PESO_REFERENCE_RECEIPT),
    ccl: input(lines.ccl),
    mep: input(lines.mep),
  });
  return { spotKind: spotRateKind("ARS")!, rates, missing: keys.filter((key) => !input(key)) };
}

/** `CCL via GGAL ADR  1,651.28  = 6,260 × 10 / 37.91 (GGAL.BA Fri 23 Oct 20:00 UTC, GGAL Fri 23 Oct 20:00 UTC)`. */
export function pesoDollarRateLines(report: PesoDollarRates, now = Date.now()): string[] {
  if (report.rates.length === 0) return [];
  const labelWidth = Math.max(...report.rates.map((rate) => rate.label.length));
  const valueWidth = Math.max(...report.rates.map((rate) => formatPairRate(rate.rate).length));
  return [
    "Market rates implied by Buenos Aires prices, pesos per dollar:",
    ...report.rates.map((rate) => {
      const times = rate.inputs.map((input) => `${input.symbol} ${input.observedAt == null ? "undated" : pairTimeText(input.observedAt, now)}${input.open ? "" : ", closed"}`);
      return `  ${rate.label.padEnd(labelWidth)}  ${formatPairRate(rate.rate).padStart(valueWidth)}  = ${rate.formula}  (${times.join("; ")})`;
    }),
  ];
}

/** The rates as `fx --json` gives them. */
export function pesoDollarRatesJson(report: PesoDollarRates) {
  return {
    spotKind: report.spotKind,
    impliedRates: report.rates.map((rate) => ({
      kind: rate.kind, label: rate.label, rate: rate.rate, formula: rate.formula,
      inputs: rate.inputs.map((input) => ({
        symbol: input.symbol, price: input.price, currency: input.currency,
        observedAt: input.observedAt == null ? null : new Date(input.observedAt).toISOString(), sessionOpen: input.open,
      })),
    })),
  };
}
