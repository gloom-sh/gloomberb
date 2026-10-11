import { apiClient } from "../api-client";
import type { FuturesContractSpec, FuturesContractTermsPayload } from "../api-client/futures-curve";
import { classifyInstrumentType } from "../tickers/instrument-kind";
import type { Quote } from "../types/financials";
import { formatMarketPrice, formatMarketPriceWithCurrency, quoteFormatOptions, withCurrencyMinorDigits } from "./market/format";

/**
 * What a futures symbol trades, as `ticker`, `quote` and the Overview tab read
 * it: one Settle value dated by its session and one list of contract lines, so
 * the three cannot word the same contract differently. Margins are not part of
 * the terms: nothing here shows or estimates one.
 */

/** A settlement the exchange has not confirmed reads as CTM writes a missing price. */
const FUTURES_MISSING = "--";

type FuturesContractLineKey = "contract" | "unit" | "size" | "tick" | "pointValue" | "settlement" | "firstNotice" | "lastTrade";

export interface FuturesContractLine {
  key: FuturesContractLineKey;
  label: string;
  value: string;
  /** Past first notice: a long can be assigned delivery. */
  warning?: true;
}

/**
 * Which lines a short or narrow block keeps, best first: the month the symbol
 * prices, what one contract and one tick are worth, and when delivery starts.
 * The unit, last trade, settlement type and point value follow from those.
 */
const LINE_RANK: Readonly<Record<FuturesContractLineKey, number>> = {
  contract: 0, size: 1, tick: 2, firstNotice: 3, unit: 4, lastTrade: 5, settlement: 6, pointValue: 7,
};

const SETTLEMENT_TYPE: Readonly<Record<FuturesContractSpec["settlement"], string>> = {
  physical: "Physical delivery",
  cash: "Cash settled",
};

/** Whether a symbol is a futures contract, an alias (GC=F) or a generic (CL1), whose contract terms are worth asking for. */
export function isFuturesInstrument(symbol: string, instrumentType: string | null | undefined): boolean {
  return classifyInstrumentType(instrumentType) === "future" || /=F$/i.test(symbol.trim());
}

function decimals(value: number): number {
  return value.toFixed(10).replace(/0+$/, "").split(".")[1]?.length ?? 0;
}

/** A tick at its own precision and what it makes on one contract: "0.10 = $10.00", "0.015625 = $15.625". */
export function futuresTickText(spec: Pick<FuturesContractSpec, "tick" | "tickValue">): string {
  const value = spec.tickValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, decimals(spec.tickValue)) });
  return `${spec.tick.toFixed(Math.max(2, decimals(spec.tick)))} = $${value}`;
}

/** One contract of a root, from the exchange's rulebook: the terms a hedge is sized on. */
export function futuresSpecLines(spec: FuturesContractSpec): FuturesContractLine[] {
  return [
    { key: "unit", label: "Unit", value: spec.unit },
    { key: "size", label: "Size", value: spec.size },
    { key: "tick", label: "Tick", value: futuresTickText(spec) },
    { key: "pointValue", label: "Point Value", value: `$${spec.pointValue.toLocaleString("en-US")}` },
    { key: "settlement", label: "Settlement", value: SETTLEMENT_TYPE[spec.settlement] },
  ];
}

/** A contract as traders write it: GCZ26.CMX is GCZ26. */
function contractCode(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.[A-Z]+$/, "");
}

/**
 * The Contract block: the contract an alias or a generic prices, its terms and
 * the dates a long faces delivery. A line with nothing to say is left out, so
 * a cash-settled root has no first notice and a listed contract no Contract line.
 */
export function futuresContractLines(terms: FuturesContractTermsPayload, symbol: string): FuturesContractLine[] {
  const lines: FuturesContractLine[] = [];
  if (terms.contract && terms.contract !== contractCode(symbol)) lines.push({ key: "contract", label: "Contract", value: terms.contract });
  if (terms.spec) lines.push(...futuresSpecLines(terms.spec));
  if (terms.firstNotice) {
    lines.push(terms.inDelivery
      ? { key: "firstNotice", label: "First Notice", value: `${terms.firstNotice} (passed)`, warning: true }
      : { key: "firstNotice", label: "First Notice", value: terms.firstNotice });
  }
  if (terms.lastTrade) lines.push({ key: "lastTrade", label: "Last Trade", value: terms.lastTrade });
  return lines;
}

/** At most `max` lines, the least useful dropped first, in the block's own order. */
export function fitFuturesContractLines(lines: readonly FuturesContractLine[], max: number): FuturesContractLine[] {
  if (lines.length <= max) return [...lines];
  const kept = new Set([...lines].sort((a, b) => LINE_RANK[a.key] - LINE_RANK[b.key]).slice(0, Math.max(0, max)));
  return lines.filter((line) => kept.has(line));
}

/**
 * The exchange settlement dated by its session, `$4,216.30 (2026-10-09)`, as
 * `ticker` prints a futures price: in the quote's currency, padded to its minor
 * unit and at the contract's own precision, with or without a quote to hand.
 * Without a quote currency the price is a bare number, never a guessed `$`: a
 * grain settles in cents. A contract without a confirmed settlement reads
 * `--`: never an older settlement, and never the last trade.
 */
export function futuresSettleText(
  terms: Pick<FuturesContractTermsPayload, "settlement">,
  quote: Pick<Quote, "currency" | "instrumentType" | "priceBasis" | "providerPriceDivisor"> | null | undefined,
): string {
  if (!terms.settlement) return FUTURES_MISSING;
  const currency = quote?.currency;
  const options = withCurrencyMinorDigits(quoteFormatOptions(quote, "FUTURE"), currency);
  const price = currency ? formatMarketPriceWithCurrency(terms.settlement.price, currency, options) : formatMarketPrice(terms.settlement.price, options);
  return `${price} (${terms.settlement.date})`;
}

const isDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const optionalDate = (value: unknown) => value === null || isDate(value);
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Contract terms the text is computed from: a tick, its value and a point value, all positive. */
export function isFuturesContractSpec(spec: unknown): spec is FuturesContractSpec {
  if (!spec || typeof spec !== "object") return false;
  const row = spec as Record<string, unknown>;
  return typeof row.unit === "string" && typeof row.size === "string"
    && positive(row.tick) && positive(row.tickValue) && positive(row.pointValue)
    && (row.settlement === "physical" || row.settlement === "cash");
}

export function validateFuturesContractTerms(data: FuturesContractTermsPayload): FuturesContractTermsPayload {
  const settlement = data?.settlement as unknown;
  if (!data || typeof data !== "object" || typeof data.root !== "string"
    || !(data.contract === null || typeof data.contract === "string")
    || !(data.spec === null || isFuturesContractSpec(data.spec))
    || !optionalDate(data.lastTrade) || !optionalDate(data.firstNotice) || typeof data.inDelivery !== "boolean"
    || !(settlement === null || typeof settlement === "object" && Number.isFinite((settlement as { price?: unknown }).price)
      && isDate((settlement as { date?: unknown }).date))) {
    throw new Error("The server returned invalid futures contract terms");
  }
  return data;
}

/** A futures symbol's contract, terms and latest confirmed settlement; throws when the server has none for it. */
export async function loadFuturesContractTerms(
  symbol: string,
  client: Pick<typeof apiClient, "getCloudFuturesContract"> = apiClient,
): Promise<FuturesContractTermsPayload> {
  return validateFuturesContractTerms(await client.getCloudFuturesContract(symbol.trim()));
}
