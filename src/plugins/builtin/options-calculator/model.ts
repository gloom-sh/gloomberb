import { optionMarketReference, parseOptionMarketReference, type OptionMarketReference } from "../options/market-reference";
import { daysToExpiryFrom, type OptionPricingInput, type OptionSide } from "../shared/volatility";
import type { CashDividend } from "./binomial";

export const OPTIONS_CALCULATOR_PANE_ID = "options-calculator";
export const OPTIONS_CALCULATOR_TEMPLATE_ID = "options-calculator-pane";

export interface OptionCalcDraft extends OptionPricingInput {
  symbol: string;
  /** 0 means "not supplied", which is also the only price no option can trade at. */
  marketPrice: number;
  marketPriceSource?: "mid" | "last";
  marketReference?: OptionMarketReference;
  pricingModel?: "european" | "american";
  steps?: number;
  dividends?: CashDividend[];
  volSource?: "input" | "surface";
}

/** Edited contracts retain numeric what-if inputs, but lose the old contract's market attribution. */
export function updateOptionCalcDraft(current: OptionCalcDraft, patch: Partial<OptionCalcDraft>): OptionCalcDraft {
  const changedContract = (["symbol", "side", "strike", "daysToExpiry"] as const)
    .some((key) => patch[key] !== undefined && patch[key] !== current[key]);
  const changedPrice = Object.hasOwn(patch, "marketPrice");
  return { ...current, ...patch, ...(changedContract || changedPrice
    ? { marketPriceSource: undefined, marketReference: undefined } : {}) };
}

/** Repair already-saved edited drafts from clients that retained the seed's attribution. */
export function reconcileOptionCalcDraft(current: OptionCalcDraft, seed: OptionCalcDraft): OptionCalcDraft {
  const sameContract = (["symbol", "side", "strike", "daysToExpiry"] as const)
    .every((key) => current[key] === seed[key]);
  if (!sameContract || current.marketPrice !== seed.marketPrice || current.marketPriceSource !== seed.marketPriceSource) {
    return { ...current, marketPriceSource: undefined, marketReference: undefined };
  }
  return { ...current, marketReference: optionMarketReference(current.marketReference) };
}

export const DEFAULT_OPTION_CALC_DRAFT: OptionCalcDraft = {
  symbol: "",
  side: "call",
  spot: 100,
  strike: 100,
  daysToExpiry: 30,
  rate: 0.04,
  volatility: 0.25,
  dividendYield: 0,
  marketPrice: 0,
};

export function describeDraftProblem(draft: OptionCalcDraft): string | null {
  if (!(draft.spot > 0)) return "Spot must be positive.";
  if (!(draft.strike > 0)) return "Strike must be positive.";
  if (draft.daysToExpiry < 0) return "Days to expiry cannot be negative.";
  if (draft.volatility < 0) return "Volatility cannot be negative.";
  return null;
}

export interface OptionCalcSeed {
  symbol?: string | null;
  side?: OptionSide | null;
  spot?: number | null;
  strike?: number | null;
  /** Unix seconds, as options chains report it. */
  expiration?: number | null;
  volatility?: number | null;
  dividendYield?: number | null;
  marketPrice?: number | null;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function buildOptionCalcParams(
  seed: OptionCalcSeed,
  now: number = Date.now(),
): Record<string, string> {
  const params: Record<string, string> = {};
  if (seed.symbol) params.symbol = seed.symbol.toUpperCase();
  if (seed.side) params.side = seed.side;
  const spot = positive(seed.spot);
  const strike = positive(seed.strike);
  const volatility = positive(seed.volatility);
  const marketPrice = positive(seed.marketPrice);
  if (spot != null) params.spot = String(spot);
  if (strike != null) params.strike = String(strike);
  if (seed.expiration != null) params.days = String(daysToExpiryFrom(seed.expiration, now));
  if (volatility != null) params.volatility = String(volatility);
  if (marketPrice != null) params.marketPrice = String(marketPrice);
  if (seed.dividendYield != null && Number.isFinite(seed.dividendYield) && seed.dividendYield > 0) {
    params.dividendYield = String(seed.dividendYield);
  }
  return params;
}

function numberParam(params: Record<string, string>, key: string, fallback: number): number {
  const parsed = Number(params[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function draftFromParams(params: Record<string, string> | undefined): OptionCalcDraft {
  if (!params) return DEFAULT_OPTION_CALC_DRAFT;
  const marketReference = parseOptionMarketReference(params.marketReference);
  return {
    symbol: params.symbol ?? DEFAULT_OPTION_CALC_DRAFT.symbol,
    side: params.side === "put" ? "put" : "call",
    spot: numberParam(params, "spot", DEFAULT_OPTION_CALC_DRAFT.spot),
    strike: numberParam(params, "strike", DEFAULT_OPTION_CALC_DRAFT.strike),
    daysToExpiry: numberParam(params, "days", DEFAULT_OPTION_CALC_DRAFT.daysToExpiry),
    rate: numberParam(params, "rate", DEFAULT_OPTION_CALC_DRAFT.rate),
    volatility: numberParam(params, "volatility", DEFAULT_OPTION_CALC_DRAFT.volatility),
    dividendYield: numberParam(params, "dividendYield", DEFAULT_OPTION_CALC_DRAFT.dividendYield),
    marketPrice: numberParam(params, "marketPrice", DEFAULT_OPTION_CALC_DRAFT.marketPrice),
    ...(params.marketPriceSource === "mid" || params.marketPriceSource === "last"
      ? { marketPriceSource: params.marketPriceSource } : {}),
    ...(marketReference ? { marketReference } : {}),
  };
}
