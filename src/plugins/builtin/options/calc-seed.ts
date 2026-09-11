import type { OptionContract } from "../../../types/financials";
import { buildOptionCalcParams, type OptionSide } from "../options-calculator/model";
import type { OptionTableRow } from "./types";
import { optionMarketReference } from "./market-reference";

/**
 * Which contract the calculator should open on. An explicit pick (clicking a
 * call or put cell) wins; otherwise an option position's own side is preferred,
 * then calls, then whichever side the strike actually has.
 */
export function resolveCalcSide(
  explicitSide: OptionSide | null,
  positionSide: "C" | "P" | null | undefined,
  row: OptionTableRow | null | undefined,
): OptionSide | null {
  if (!row) return null;
  const preferred = explicitSide ?? (positionSide === "P" ? "put" : "call");
  if (preferred === "call" && row.call) return "call";
  if (preferred === "put" && row.put) return "put";
  if (row.call) return "call";
  if (row.put) return "put";
  return null;
}

/** A valid two-sided midpoint is more useful than a potentially old last trade. */
function contractMarketPrice(contract: OptionContract): { price: number; source?: "mid" | "last" } {
  if (Number.isFinite(contract.bid) && Number.isFinite(contract.ask)
    && contract.bid > 0 && contract.ask >= contract.bid) {
    return { price: (contract.bid + contract.ask) / 2, source: "mid" };
  }
  if (Number.isFinite(contract.lastPrice) && contract.lastPrice > 0) {
    return { price: contract.lastPrice, source: "last" };
  }
  return { price: 0 };
}

export function buildChainCalcParams(options: {
  symbol: string;
  row: OptionTableRow | null | undefined;
  side: OptionSide | null;
  spot: number | null | undefined;
  dividendYield: number | null | undefined;
  now?: number;
}): Record<string, string> | null {
  const { row, side } = options;
  const contract = side === "put" ? row?.put : side === "call" ? row?.call : undefined;
  if (!contract || !(options.spot != null && Number.isFinite(options.spot) && options.spot > 0)) return null;

  const market = contractMarketPrice(contract);
  const params = buildOptionCalcParams({
    symbol: options.symbol,
    side,
    spot: options.spot,
    strike: contract.strike,
    expiration: contract.expiration,
    volatility: contract.impliedVolatility,
    marketPrice: market.price,
    dividendYield: options.dividendYield,
  }, options.now);
  if (market.source) params.marketPriceSource = market.source;
  const reference = optionMarketReference(contract);
  if (reference) params.marketReference = JSON.stringify(reference);
  return params;
}
