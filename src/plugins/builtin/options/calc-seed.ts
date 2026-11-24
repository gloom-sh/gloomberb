import type { OptionContract } from "../../../types/financials";
import { buildOptionCalcParams, type ChainIvBasis } from "../options-calculator/model";
import type { OptionSide } from "../shared/volatility";
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

/** Where the chain's IV and Greeks are valued, which a calculator opened on one of its contracts starts from. */
export interface ChainCalcValuation {
  /** The instant time to expiry runs from: the chain's quote time outside the session. */
  time: number;
  /** How the chain stamps its spot (`close Mon 23 Nov`), null when it is the regular session's latest price. */
  spotLabel: string | null;
  /** The forward the contract's expiry was solved against, when the chain solved it. */
  forward?: { forward: number; parity: boolean } | null;
}

/**
 * How the chain came by the IV it hands the calculator, when solving this
 * contract's own midpoint from spot would not give it back: a strike's IV is
 * solved from its out-of-the-money side against the parity forward, or read
 * off its neighbours. Null when the chain's forward is spot carried at the
 * calculator's own rate and yield and this side is the one solved.
 */
function chainIvBasis(row: OptionTableRow, side: OptionSide, valuation: ChainCalcValuation | null | undefined): ChainIvBasis | null {
  const volatility = row.impliedVolatility;
  if (volatility == null || !Number.isFinite(volatility) || volatility <= 0) return null;
  if (row.impliedVolatilityFilled) return { volatility, kind: "filled" };
  const forward = valuation?.forward;
  if (!forward || !(forward.forward > 0)) return null;
  const solvedSide: OptionSide = row.strike >= forward.forward ? "call" : "put";
  if (solvedSide !== side) return { volatility, kind: "other-side", side: solvedSide };
  return forward.parity ? { volatility, kind: "forward", forward: forward.forward } : null;
}

export function buildChainCalcParams(options: {
  symbol: string;
  row: OptionTableRow | null | undefined;
  side: OptionSide | null;
  /** The spot the chain's Greeks are valued at, so the calculator starts where the chain does. */
  spot: number | null | undefined;
  dividendYield: number | null | undefined;
  /** The chain's valuation: days to expiry run from its time, not from now. */
  valuation?: ChainCalcValuation | null;
  now?: number;
}): Record<string, string> | null {
  const { row, side } = options;
  const contract = side === "put" ? row?.put : side === "call" ? row?.call : undefined;
  if (!contract || !side || !(options.spot != null && Number.isFinite(options.spot) && options.spot > 0)) return null;

  const market = contractMarketPrice(contract);
  const valuedAt = options.valuation && Number.isFinite(options.valuation.time) ? options.valuation.time : null;
  const params = buildOptionCalcParams({
    symbol: options.symbol,
    side,
    spot: options.spot,
    strike: contract.strike,
    expiration: contract.expiration,
    volatility: row?.impliedVolatility,
    marketPrice: market.price,
    dividendYield: options.dividendYield,
    ...(valuedAt != null ? { valuation: { at: valuedAt, spot: options.spot, spotLabel: options.valuation!.spotLabel } } : {}),
  }, valuedAt ?? options.now);
  if (market.source) params.marketPriceSource = market.source;
  const reference = optionMarketReference(contract);
  if (reference) params.marketReference = JSON.stringify(reference);
  const basis = market.source === "mid" && row ? chainIvBasis(row, side, options.valuation) : null;
  if (basis) params.chainIv = JSON.stringify(basis);
  return params;
}
