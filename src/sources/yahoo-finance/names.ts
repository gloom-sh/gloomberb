/**
 * Yahoo's shortName is a fixed-width field. Xetra lines pad the issuer to a column and
 * append a share-class code ("SAP SE                        I"), and long fund names are cut
 * off ("JPMorgan Nasdaq Equity Premium "). longName is preferred; a cleaned shortName is the
 * fallback. Cloud names quotes the same way.
 */
export function yahooSecurityName(shortName: string | undefined, longName: string | undefined): string | undefined {
  const long = longName?.trim().replace(/\s+/g, " ");
  if (long) return long;
  return shortName?.split(/\s{2,}/)[0]?.trim() || undefined;
}

const FUTURES_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TRAILING_MONTH = /[\s,]*\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b(?:[ -](?:\d{4}|\d{2})?)?$/i;

/**
 * A continuous futures alias keeps its old month in its name for weeks after its
 * price rolls (SB=F read "Sugar #11 Oct 26" while quoting March). Its underlying
 * symbol (SBH27.NYB) names the contract actually priced; any other root or an
 * underlying without a month leaves the name alone.
 */
export function yahooFuturesAliasName(symbol: string, name: string | undefined, underlyingSymbol: string | undefined): string | undefined {
  const alias = /^([A-Z0-9]+)=F$/i.exec(symbol.trim());
  const contract = /^([A-Z0-9]+)([FGHJKMNQUVXZ])(\d{2})\.[A-Z]+$/i.exec(underlyingSymbol?.trim() ?? "");
  if (!alias || !contract || !name || contract[1]!.toUpperCase() !== alias[1]!.toUpperCase()) return undefined;
  const month = FUTURES_MONTHS["FGHJKMNQUVXZ".indexOf(contract[2]!.toUpperCase())]!;
  return `${name.replace(TRAILING_MONTH, "")} ${month} ${contract[3]}`;
}
