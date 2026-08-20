import type { OptionContract } from "../../../types/financials";
import { buildOptionCalcParams, type OptionSide } from "../options-calculator/model";
import type { OptionTableRow } from "./types";

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

/** Last trade when there is one, otherwise the mid; never a one-sided quote. */
function contractMarketPrice(contract: OptionContract): number {
  if (contract.lastPrice > 0) return contract.lastPrice;
  return contract.bid > 0 && contract.ask > 0 ? (contract.bid + contract.ask) / 2 : 0;
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

  return buildOptionCalcParams({
    symbol: options.symbol,
    side,
    spot: options.spot,
    strike: contract.strike,
    expiration: contract.expiration,
    volatility: contract.impliedVolatility,
    marketPrice: contractMarketPrice(contract),
    dividendYield: options.dividendYield,
  }, options.now);
}
