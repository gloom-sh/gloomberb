/**
 * What a pane's list menu says under a portfolio's or a watchlist's name: "Portfolio" or "Watchlist", unless the name
 * already says so ("Main Portfolio"). Every menu that offers the user's lists (ERN's Names, HM's List) says it alike.
 */
export function collectionKindNote(name: string, kind: "Portfolio" | "Watchlist"): string | undefined {
  return name.toLowerCase().includes(kind.toLowerCase()) ? undefined : kind;
}
