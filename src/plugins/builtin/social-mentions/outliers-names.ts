import type { SocialOutliersPayload } from "../../../api-client/social-mentions";
import { LISTING_SEARCH_LIMIT, listingExchange } from "../../../tickers/search";
import type { DataProvider } from "../../../types/data-provider";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { isUsListingExchange } from "../../../utils/exchanges";
import { logFailure } from "../../../utils/log-failure";

/** What a name lookup reads through: the data provider's batched search, or nothing. */
export type OutlierNameSource = Partial<Pick<DataProvider, "searchBatch">> | null | undefined;

/**
 * The name ticker search lists a bare symbol under. A cashtag is a US ticker,
 * so the symbol's US listing leads, as it does when the app resolves a bare
 * symbol; the listing the service marks as the company's home comes first
 * among them, then search's own order. A row that carries only the symbol
 * for a name (QCOM on TSX) names nothing, as the overview's title reads it.
 */
export function outlierListingName(rows: readonly InstrumentSearchResult[], symbol: string): string | null {
  const exact = rows.filter((row) => row.symbol.trim().toUpperCase() === symbol);
  const us = exact.filter((row) => isUsListingExchange(listingExchange(row)));
  const pool = us.length ? us : exact;
  for (const row of [...pool.filter((candidate) => candidate.homeListing === true), ...pool.filter((candidate) => candidate.homeListing !== true)]) {
    const name = row.name?.trim();
    if (name && name.toUpperCase() !== symbol) return name;
  }
  return null;
}

/**
 * The ranking with each row's company named as ticker search names it. The
 * stored screener names are kept as they came (some in capitals, ETFs and
 * foreign listings without one), so the ranking read them wrong beside the
 * name DES and search show for the same ticker. One batched search asks for
 * every symbol (the provider sends up to 100 to the service in one request),
 * never one request a row. A row search has no name for, a provider that
 * cannot batch, and a search that fails keep the stored name: names are
 * never worth losing the ranking for.
 */
export async function withListingNames(
  payload: SocialOutliersPayload,
  source: OutlierNameSource,
  signal?: AbortSignal,
): Promise<SocialOutliersPayload> {
  const symbols = [...new Set(payload.rows.map((row) => row.symbol.trim().toUpperCase()))];
  if (!symbols.length || !source?.searchBatch) return payload;
  const answers = await source.searchBatch(symbols, { limit: LISTING_SEARCH_LIMIT, ...signal ? { signal } : {} })
    .catch(logFailure("social-mentions.outliers", "Naming the outliers through search failed", null));
  if (!answers) return payload;
  const names = new Map(symbols.map((symbol) => [symbol, outlierListingName(answers.get(symbol) ?? [], symbol)] as const));
  return { ...payload, rows: payload.rows.map((row) => ({ ...row, name: names.get(row.symbol.trim().toUpperCase()) ?? row.name })) };
}
