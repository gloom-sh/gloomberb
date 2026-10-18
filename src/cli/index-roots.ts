/**
 * Well-known index roots that people type bare. As a bare symbol each one is
 * another instrument (MOVE is Corvex, MID a fund) or nothing at all (VIX); the
 * index itself is quoted as ^ROOT. Every entry is offered as a command to run,
 * so only roots whose ^ symbol returns a quote belong here.
 */
const INDEX_ROOTS = new Map([
  ["VIX", "Cboe Volatility Index"],
  ["VVIX", "Cboe VIX of VIX Index"],
  ["VIX9D", "Cboe S&P 500 9-Day Volatility Index"],
  ["VIX3M", "Cboe S&P 500 3-Month Volatility Index"],
  ["VXN", "Cboe Nasdaq-100 Volatility Index"],
  ["OVX", "Cboe Crude Oil ETF Volatility Index"],
  ["GVZ", "Cboe Gold ETF Volatility Index"],
  ["SKEW", "Cboe SKEW Index"],
  ["TNX", "Cboe 10-Year Treasury Yield Index"],
  ["SPX", "S&P 500 Index"],
  ["OEX", "S&P 100 Index"],
  ["MID", "S&P MidCap 400 Index"],
  ["DJI", "Dow Jones Industrial Average"],
  ["NDX", "Nasdaq-100 Index"],
  ["SOX", "PHLX Semiconductor Index"],
  ["RUT", "Russell 2000 Index"],
  ["RUI", "Russell 1000 Index"],
  ["RUA", "Russell 3000 Index"],
  ["MOVE", "ICE BofA MOVE Index"],
  ["NYA", "NYSE Composite Index"],
]);

export interface IndexRoot {
  /** The index's own symbol: ^VIX. */
  symbol: string;
  name: string;
}

/** The index a bare root names (VIX is ^VIX); null for any other symbol, ^VIX included. */
export function indexRootFor(symbol: string): IndexRoot | null {
  const root = symbol.trim().toUpperCase();
  const name = INDEX_ROOTS.get(root);
  return name ? { symbol: `^${root}`, name } : null;
}

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

/** "^VIX  Cboe Volatility Index (try: gloomberb quote ^VIX)", under a bare root that found nothing. */
export function indexRootTryLine(root: IndexRoot, command = "quote"): string {
  return `${root.symbol}  ${root.name} (try: gloomberb ${command} ${root.symbol})`;
}

/** "also ^MOVE ICE BofA MOVE Index (gloomberb quote ^MOVE)", under a bare root that quoted another instrument. */
export function indexRootAlsoLine(root: IndexRoot, command = "quote"): string {
  return `also ${root.symbol} ${root.name} (gloomberb ${command} ${root.symbol})`;
}

/** Cboe's Treasury yield indices: 13-week bill, 5-, 10- and 30-year notes. Each level is a yield in percent. */
const YIELD_INDEX_SYMBOLS: ReadonlySet<string> = new Set(["^IRX", "^FVX", "^TNX", "^TYX"]);

export function isYieldIndexSymbol(symbol: string): boolean {
  return YIELD_INDEX_SYMBOLS.has(symbol.trim().toUpperCase());
}
