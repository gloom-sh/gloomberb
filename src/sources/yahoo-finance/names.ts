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
