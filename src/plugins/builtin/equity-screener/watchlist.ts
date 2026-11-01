import type { ScreenDefinition, ScreenRow } from "../../../api-client/equity-screener";
import type { MemberList } from "../shared/members-menu";
import { SCREEN_IDEAS } from "./ideas";
import { screenDefinitionKey } from "./model";

/** What a screen is called: the idea it is, else the saved screen it was opened from, else EQS. */
export function screenTitle(definition: ScreenDefinition, savedName?: string | null): string {
  const key = screenDefinitionKey(definition);
  return SCREEN_IDEAS.find((idea) => screenDefinitionKey(idea.definition) === key)?.name ?? (savedName?.trim() || "EQS");
}

/**
 * A screen's matches as the shared watchlist menu takes them: the rows loaded, in
 * the order shown, each listing with its exchange and quote currency, and how
 * many match in all. A watchlist keeps at most the first 100 of them.
 */
export function screenWatchlistList(options: {
  definition: ScreenDefinition;
  rows: readonly Pick<ScreenRow, "symbol" | "name" | "exchange" | "currency">[];
  matched: number;
  savedName?: string | null;
}): MemberList | null {
  if (!options.rows.length) return null;
  const title = screenTitle(options.definition, options.savedName);
  return {
    title,
    watchlistName: title === "EQS" ? "EQS screen" : title,
    noun: "matches",
    total: options.matched,
    openIn: false,
    members: options.rows.map((row) => ({ symbol: row.symbol, name: row.name, exchange: row.exchange, currency: row.currency })),
  };
}
