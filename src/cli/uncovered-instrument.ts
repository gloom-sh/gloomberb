import { VOLATILITY_INDICES } from "../plugins/builtin/shared/volatility-indices";
import type { InstrumentOfKind } from "../tickers/instrument-coverage";
import { parsePublicTickerKey } from "../utils/exchanges";

/** The volatility indices the VIX function charts on its curve and board: for one of them it is the place to look. */
const VIX_FUNCTION_INDICES: ReadonlySet<string> = new Set(VOLATILITY_INDICES.map((index) => index.symbol));

/**
 * The command that reads what an instrument outside a function's coverage does
 * have, for the CLI to offer: the VIX function for a volatility index it
 * reads, a fund's fundamentals (yield, facts, profile), and the research
 * report of anything else (the quote, ranges and history of an index or pair).
 */
export function uncoveredInstrumentCommand(instrument: InstrumentOfKind): string {
  const symbol = instrument.symbol;
  const bare = parsePublicTickerKey(symbol).symbol.toUpperCase();
  if (instrument.kind === "index" && VIX_FUNCTION_INDICES.has(bare)) return "gloom fn VIX";
  if (instrument.kind === "fund") return `gloom fundamentals ${symbol}`;
  return `gloom ticker ${symbol}`;
}
