/**
 * A US listing written the way a market data terminal names it, read as the
 * listing it is. Reuters codes put the venue after a dot (WFC.N for the New
 * York Stock Exchange, AAPL.O or AAPL.OQ for Nasdaq) and a share class in
 * lower case before it (BRKb.N); Bloomberg writes the symbol, the venue and
 * the asset class (JPM US Equity, the US composite; JPM UN Equity, the New
 * York Stock Exchange; BRK/B US Equity). Anything else, including the
 * suffixes of listings abroad (VOD.L, 7203.T, RY.TO, 0700.HK) and US share
 * classes (BRK.B), is not one.
 */
export interface TerminalListingCode {
  /** The code as typed, trimmed: `WFC.N`, `JPM US Equity`. */
  typed: string;
  /** The US symbol, with its share class after a dot: `WFC`, `BRK.B`. */
  symbol: string;
  /** The canonical code of the venue the code names; "" for Bloomberg's US composite, the symbol's own US listing. */
  exchange: string;
  /** `WFC:NYSE`, or `JPM` for the US composite. */
  key: string;
}

const REUTERS_VENUES: Record<string, string> = { N: "NYSE", O: "NASDAQ", OQ: "NASDAQ" };

/** Bloomberg's US exchange codes: the composite and the venues a US equity lists on. */
const BLOOMBERG_VENUES: Record<string, string> = {
  US: "",
  UN: "NYSE",
  UW: "NASDAQ",
  UQ: "NASDAQ",
  UR: "NASDAQ",
  UA: "AMEX",
  UP: "ARCA",
  UF: "BATS",
};

/** `WFC.N`, `BRKb.N` (class B, in lower case as Reuters writes it), `wfc.n`, `AAPL.OQ`. */
const REUTERS_CODE = /^([A-Za-z]{1,6})\.(N|O|OQ)$/i;
/** A root in capitals with one lower-case letter after it: the letter is the share class (BRKb). */
const REUTERS_CLASS = /^([A-Z]{1,5})([a-z])$/;
/** `JPM US Equity`, `BRK/B UN Equity`, `brk/b us equity`. */
const BLOOMBERG_CODE = /^([A-Za-z]{1,6})(?:\/([A-Za-z]))?\s+([A-Za-z]{2})\s+equity$/i;

function listing(typed: string, root: string, shareClass: string | undefined, exchange: string): TerminalListingCode {
  const symbol = `${root.toUpperCase()}${shareClass ? `.${shareClass.toUpperCase()}` : ""}`;
  return { typed, symbol, exchange, key: exchange ? `${symbol}:${exchange}` : symbol };
}

export function readTerminalListingCode(raw: string): TerminalListingCode | null {
  const typed = raw.trim().replace(/\s+/g, " ");
  const reuters = REUTERS_CODE.exec(typed);
  if (reuters) {
    // Typed all in lower case (wfc.n), the last letter is part of the symbol, not a class.
    const shareClass = REUTERS_CLASS.exec(reuters[1]!);
    const exchange = REUTERS_VENUES[reuters[2]!.toUpperCase()]!;
    return shareClass ? listing(typed, shareClass[1]!, shareClass[2], exchange) : listing(typed, reuters[1]!, undefined, exchange);
  }
  const bloomberg = BLOOMBERG_CODE.exec(typed);
  if (bloomberg) {
    const exchange = BLOOMBERG_VENUES[bloomberg[3]!.toUpperCase()];
    if (exchange === undefined) return null;
    return listing(typed, bloomberg[1]!, bloomberg[2], exchange);
  }
  return null;
}

/** `Read WFC.N as WFC:NYSE.`, for a command's warnings. */
export function terminalCodeReadAs(code: TerminalListingCode): string {
  return `Read ${/\s/.test(code.typed) ? `"${code.typed}"` : code.typed} as ${code.key}.`;
}
