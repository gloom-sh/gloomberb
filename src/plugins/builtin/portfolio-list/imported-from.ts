import type { Portfolio } from "../../../types/ticker";

/** One line naming the filing an imported portfolio comes from, as `portfolio show`, `fn PF` and the import print it. */
export function importedFromText(portfolio: Pick<Portfolio, "importedFrom">): string | null {
  const source = portfolio.importedFrom;
  if (!source) return null;
  return `Weights from ${source.name}'s 13F for ${source.period}, filed ${source.filed}; not your holdings.`;
}
