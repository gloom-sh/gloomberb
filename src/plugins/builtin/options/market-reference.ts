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

export function optionMarketReferenceLines(reference: OptionMarketReference): string[] {
  const { bid, ask } = reference;
  const twoSided = bid > 0 && ask >= bid;
  const spread = twoSided ? ask - bid : null;
  const market = twoSided
    ? `spread ${Number(spread!.toPrecision(12))} (${(spread! / ((bid + ask) / 2) * 100).toFixed(2)}% of mid)`
    : bid > ask && ask > 0 ? "crossed quote; no midpoint"
      : bid > 0 || ask > 0 ? "one-sided quote; no midpoint" : "bid/ask unavailable";
  const quoteTime = timestamp(reference.lastUpdated);
  const tradeTime = timestamp(reference.lastTradeDate * 1000);
  return [
    `${reference.contractSymbol} · ${reference.currency || "currency unknown"} · expires ${formatExpDate(reference.expiration)}`,
    `Bid ${price(bid)} · Ask ${price(ask)} · ${market}`,
    `Quote ${quoteTime ?? "time unavailable"} · Last ${price(reference.lastPrice)} · trade ${tradeTime ?? "time unavailable"}`,
  ];
}
