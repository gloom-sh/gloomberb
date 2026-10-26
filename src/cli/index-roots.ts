import { indexRootFor, type IndexRoot } from "../tickers/index-roots";

/** A broker's code for an index: VIX.X and $VIX.X as thinkorswim writes it, $VIX as Schwab does. */
export interface BrokerIndexCode extends IndexRoot {
  /** As typed, upper-cased: $VIX. */
  typed: string;
  /**
   * The root's letters, when the code is `$ROOT`: a cashtag writes a stock the
   * same way ($AAPL), so the letters are the index only when no security
   * trades as them (MOVE is Corvex). Null for `ROOT.X`, which only an index is.
   */
  bare: string | null;
}

/** The index a broker's code names (VIX.X, $VIX.X, $VIX are ^VIX); null for any other spelling, and for a root not known as an index. */
export function brokerIndexCode(input: string): BrokerIndexCode | null {
  const typed = input.trim().toUpperCase();
  const match = /^(\$?)([A-Z][A-Z0-9]*)(\.X)?$/.exec(typed);
  if (!match || (!match[1] && !match[3])) return null;
  const root = indexRootFor(match[2]!);
  return root ? { ...root, typed, bare: match[3] ? null : match[2]! } : null;
}

/** "Read VIX.X as ^VIX (Cboe Volatility Index)." */
export function brokerIndexReadAs(code: BrokerIndexCode): string {
  return `Read ${code.typed} as ${code.symbol} (${code.name}).`;
}

/** "^VIX  Cboe Volatility Index (try: gloom quote ^VIX)", under a bare root that found nothing. */
export function indexRootTryLine(root: IndexRoot, command = "quote"): string {
  return `${root.symbol}  ${root.name} (try: gloom ${command} ${root.symbol})`;
}

/** "also ^MOVE ICE BofA MOVE Index (gloom quote ^MOVE)", under a bare root that quoted another instrument. */
export function indexRootAlsoLine(root: IndexRoot, command = "quote"): string {
  return `also ${root.symbol} ${root.name} (gloom ${command} ${root.symbol})`;
}

/** Cboe's Treasury yield indices: 13-week bill, 5-, 10- and 30-year notes. Each level is a yield in percent. */
const YIELD_INDEX_SYMBOLS: ReadonlySet<string> = new Set(["^IRX", "^FVX", "^TNX", "^TYX"]);

export function isYieldIndexSymbol(symbol: string): boolean {
  return YIELD_INDEX_SYMBOLS.has(symbol.trim().toUpperCase());
}
