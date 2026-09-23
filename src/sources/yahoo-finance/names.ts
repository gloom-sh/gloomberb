/**
 * Yahoo's shortName is a fixed-width field. Xetra lines pad the issuer to a column and
 * append a share-class code ("SAP SE                        I"), and London names carry a
 * trailing space. A padded shortName yields to longName; otherwise shortName stays preferred.
 */
export function yahooSecurityName(shortName: string | undefined, longName: string | undefined): string | undefined {
  const short = shortName?.trim();
  const long = longName?.trim().replace(/\s+/g, " ");
  if (short && /\s{2,}/.test(short)) return long || short.split(/\s{2,}/)[0];
  return short || long || undefined;
}
