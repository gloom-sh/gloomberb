import type { OptionContract } from "../../../types/financials";
import { formatExpDate } from "../../../utils/options";

/** A saved contract observation, never a claim that its prices are executable. */
export type OptionMarketReference = Pick<OptionContract,
  "contractSymbol" | "expiration" | "currency" | "bid" | "ask" | "lastPrice" | "lastTradeDate" | "lastUpdated">;

export function optionMarketReference(value: unknown): OptionMarketReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.contractSymbol !== "string" || !raw.contractSymbol.trim()
    || typeof raw.expiration !== "number" || !Number.isFinite(raw.expiration)
    || raw.expiration <= 0 || !Number.isFinite(new Date(raw.expiration * 1000).getTime())) return undefined;
  const number = (key: string): number => typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0
    ? raw[key] : 0;
  return {
    contractSymbol: raw.contractSymbol,
    expiration: raw.expiration,
    currency: typeof raw.currency === "string" ? raw.currency : "",
    bid: number("bid"), ask: number("ask"), lastPrice: number("lastPrice"), lastTradeDate: number("lastTradeDate"),
    ...(number("lastUpdated") > 0 ? { lastUpdated: number("lastUpdated") } : {}),
  };
}

export function parseOptionMarketReference(value: string | undefined): OptionMarketReference | undefined {
  if (!value) return undefined;
  try { return optionMarketReference(JSON.parse(value)); } catch { return undefined; }
}

function timestamp(milliseconds: number | undefined): string | null {
  if (!milliseconds || !Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : null;
}

const price = (value: number) => Number.isFinite(value) && value > 0 ? String(Number(value.toPrecision(12))) : "—";

/**
 * The spread is the one quote fact the chain table cannot show: its columns
 * carry bid and ask separately, never the width between them. Callers format
 * it at their own density, so the arithmetic lives here only once.
 */
export type OptionSpread =
  | { kind: "two-sided"; spread: number; percentOfMid: number }
  | { kind: "crossed" | "one-sided" | "unavailable" };

export function optionSpread({ bid, ask }: Pick<OptionMarketReference, "bid" | "ask">): OptionSpread {
  if (bid > 0 && ask >= bid) {
    const spread = ask - bid;
    return { kind: "two-sided", spread: Number(spread.toPrecision(12)), percentOfMid: spread / ((bid + ask) / 2) * 100 };
  }
  if (bid > ask && ask > 0) return { kind: "crossed" };
  return { kind: bid > 0 || ask > 0 ? "one-sided" : "unavailable" };
}

/**
 * Providers send 0 for a side with no quote. A zero ask is never a real offer;
 * a zero bid is one (nobody pays for a far wing) unless the ask is missing too.
 */
export function optionQuoteSide(contract: Pick<OptionContract, "bid" | "ask">, side: "bid" | "ask"): number | null {
  const valid = (value: number) => Number.isFinite(value) && value > 0;
  if (side === "ask") return valid(contract.ask) ? contract.ask : null;
  return valid(contract.bid) || valid(contract.ask) ? contract.bid : null;
}

export function optionMarketReferenceLines(reference: OptionMarketReference): string[] {
  const { bid, ask } = reference;
  const spread = optionSpread(reference);
  const market = spread.kind === "two-sided"
    ? `spread ${spread.spread} (${spread.percentOfMid.toFixed(2)}% of mid)`
    : spread.kind === "crossed" ? "crossed quote; no midpoint"
      : spread.kind === "one-sided" ? "one-sided quote; no midpoint" : "bid/ask unavailable";
  const quoteTime = timestamp(reference.lastUpdated);
  const tradeTime = timestamp(reference.lastTradeDate * 1000);
  return [
    `${reference.contractSymbol} · ${reference.currency || "currency unknown"} · expires ${formatExpDate(reference.expiration)}`,
    `Bid ${price(bid)} · Ask ${price(ask)} · ${market}`,
    `Quote ${quoteTime ?? "time unavailable"} · Last ${price(reference.lastPrice)} · trade ${tradeTime ?? "time unavailable"}`,
  ];
}
