import {
  cliStyles,
  cliTerminalWidth,
  renderSection,
  renderTable,
} from "../../utils/cli-output";
import type { DataProvider } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { quotedListingName } from "../../tickers/listing-name";
import type { TickerRecord } from "../../types/ticker";
import {
  LISTING_SEARCH_LIMIT,
  searchTickerCandidates,
  type TickerSearchCandidate,
} from "../../tickers/search";
import { initMarketData, withMarketData } from "../context";
import { fail } from "../errors";
import type { MarketContext } from "../types";
import type { CliCommandContext } from "../../types/plugin";
import { indexRootFor, indexRootTryLine } from "../index-roots";
import { knownGapMessage } from "../known-gaps";
import { instrumentTypeLabel } from "../../tickers/instrument-kind";
import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import { groupByCompany } from "../../tickers/company-name";
import { findCatalogSeries, renderSeriesMatches, type SeriesMatch } from "../series-search";
import type { SeriesDefinition } from "../../series/types";

interface SearchCommandDependencies {
  initMarketData?: () => Promise<MarketContext>;
  fail?: (message: string, details?: string) => never;
  printResult?: CliCommandContext["printResult"];
  /** Plugins whose data catalog series a query can name, listed before the tickers. */
  plugins?: ReadonlyArray<{ series?: readonly SeriesDefinition[] }>;
}

/** Series a search lists before pointing at the catalog for the rest. */
const SEARCH_SERIES_LIMIT = 3;

export async function searchCandidatesForCli({
  query,
  tickers,
  dataProvider,
  totalLimit = 10,
  localLimit = 6,
}: {
  query: string;
  tickers: TickerRecord[];
  dataProvider: DataProvider;
  totalLimit?: number;
  localLimit?: number;
}): Promise<TickerSearchCandidate[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const localTickerMap = new Map(
    tickers.map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const),
  );
  try {
    const candidates = await searchTickerCandidates({
      query: trimmedQuery,
      tickers: localTickerMap,
      dataProvider,
      localLimit,
      // Every company's listing of a symbol several use (CAR's ASX line is past the first ten), cut after ordering.
      totalLimit: Math.max(totalLimit, LISTING_SEARCH_LIMIT),
      searchContext: { limit: LISTING_SEARCH_LIMIT },
    });
    const symbol = trimmedQuery.toUpperCase();
    // A bare symbol search lists asks for the quote `quote SYM` reads, once, for its venue and its name:
    // on the venue a saved row of the symbol is on, as `quote` asks for it, else the bare symbol.
    const savedExchange = localTickerMap.get(symbol)?.metadata.exchange ?? "";
    const quote = BARE_SYMBOL.test(symbol) && candidates.some((candidate) => candidate.symbol.toUpperCase() === symbol)
      ? await Promise.resolve().then(() => dataProvider.getQuote(symbol, savedExchange)).catch(() => null)
      : null;
    return withQuotedNames(symbol, withPrimaryListingFirst(symbol, candidates, quote), quote).slice(0, totalLimit);
  } catch {
    return [];
  }
}

/** A query that is a bare symbol (CAR, BRK.B), not a name or a phrase. */
const BARE_SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;

function candidateExchange(candidate: TickerSearchCandidate): string {
  return canonicalExchange(candidate.result?.exchange === "SMART"
    ? candidate.result.primaryExchange
    : candidate.result?.exchange || candidate.result?.primaryExchange || candidate.ticker?.metadata.exchange || candidate.right);
}

/**
 * For a bare symbol several companies list (CAR: Avis, Carrefour, CAR Group),
 * the listing `quote CAR` reads goes first as the primary listing, then each
 * other company's first listing, then the rest of their venues, so a short
 * list still shows every company. A saved listing is the user's choice and
 * stays where search put it. Any other query keeps search's order.
 */
function withPrimaryListingFirst(
  symbol: string,
  candidates: TickerSearchCandidate[],
  quote: Quote | null,
): TickerSearchCandidate[] {
  if (!BARE_SYMBOL.test(symbol)) return candidates;
  const exact = candidates.filter((candidate) => candidate.symbol.toUpperCase() === symbol);
  if (exact.some((candidate) => candidate.kind === "ticker" || candidate.saved)) return candidates;
  const listed = exact.filter((candidate) => candidate.kind === "search" && (candidate.instrumentClass === "equity" || candidate.instrumentClass === "other"));
  const companies = groupByCompany(listed, resolveSearchName);
  if (companies.length < 2) return candidates;
  const primary = quotedCandidate(listed, quote);
  if (!primary) return candidates;
  const firsts = companies.filter((group) => !group.includes(primary)).map((group) => group[0]!);
  const ordered = [primary, ...firsts, ...listed.filter((candidate) => candidate !== primary && !firsts.includes(candidate))];
  const at = candidates.indexOf(listed[0]!);
  const rest = candidates.filter((candidate) => !listed.includes(candidate));
  return [...rest.slice(0, at), ...ordered, ...rest.slice(at)].map((candidate) => (
    candidate === primary ? { ...candidate, category: "Primary Listing" as const }
      : listed.includes(candidate) || candidate.category === "Primary Listing" ? { ...candidate, category: "Other Listings" as const }
      : candidate
  ));
}

/** The candidate on the venue the quote prices; the US exchanges share one symbol, so a quote on any of them is its one US line. */
function quotedCandidate(candidates: readonly TickerSearchCandidate[], quote: Quote | null): TickerSearchCandidate | undefined {
  const quoted = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName);
  if (!quoted) return undefined;
  return candidates.find((candidate) => candidateExchange(candidate) === quoted)
    ?? (isUsListingExchange(quoted) ? candidates.find((candidate) => isUsListingExchange(candidateExchange(candidate))) : undefined);
}

/**
 * A catalogue can keep a listing's name from before a rename. For a bare
 * symbol, the listing its quote prices goes by the quote's name, as `quote`,
 * `history` and the portfolio name it, and so do the same company's other
 * venues of the symbol. Other companies' listings keep their own.
 */
function withQuotedNames(symbol: string, candidates: TickerSearchCandidate[], quote: Quote | null): TickerSearchCandidate[] {
  const exact = candidates.filter((candidate) => candidate.symbol.toUpperCase() === symbol && !candidate.contractKey);
  const onVenue = quotedCandidate(exact, quote);
  const name = onVenue ? quotedListingName(candidateExchange(onVenue), quote) : null;
  if (!onVenue || !name) return candidates;
  const company = groupByCompany(exact, resolveSearchName).find((group) => group.includes(onVenue)) ?? [onVenue];
  return candidates.map((candidate) => {
    if (!company.includes(candidate) || resolveSearchName(candidate) === name) return candidate;
    const [, ...rest] = candidate.detail.split(" | ");
    return { ...candidate, detail: [name, ...rest].join(" | "), ...candidate.result ? { result: { ...candidate.result, name } } : {} };
  });
}

/** "Saved", or the broker a row came from; never the data service's internal id. */
function searchSourceLabel(candidate: TickerSearchCandidate): string {
  return candidate.kind === "ticker" ? "Saved" : candidate.result?.brokerLabel || "";
}

function resolveSearchName(candidate: TickerSearchCandidate): string {
  return candidate.detail.split(" | ")[0] || candidate.detail || "—";
}

/** The listing's type as the table shows it; a perpetual price a provider types as a coin says what it is. */
function searchType(candidate: TickerSearchCandidate): string | undefined {
  return instrumentTypeLabel(candidate.result?.type
    || candidate.result?.brokerContract?.secType
    || candidate.ticker?.metadata.assetCategory, resolveSearchName(candidate));
}

function searchCandidateRows(candidates: TickerSearchCandidate[]) {
  return candidates.map((candidate) => ({
    category: candidate.category,
    symbol: candidate.label,
    name: resolveSearchName(candidate),
    exchange: candidate.result?.exchange
      || candidate.result?.primaryExchange
      || candidate.ticker?.metadata.exchange
      || candidate.right
      || "",
    type: candidate.result?.type
      || candidate.result?.brokerContract?.secType
      || candidate.ticker?.metadata.assetCategory
      || "",
    source: searchSourceLabel(candidate),
    providerId: candidate.result?.providerId ?? "",
    saved: candidate.kind === "ticker",
  }));
}

/**
 * "^VIX  Cboe Volatility Index (try: gloomberb quote ^VIX)" for a bare index root, whose
 * search finds funds named after the index but not the index, unless it does list it.
 */
function indexRootNote(query: string, candidates: TickerSearchCandidate[]): string | null {
  const root = indexRootFor(query);
  if (!root || candidates.some((candidate) => candidate.label.toUpperCase() === root.symbol)) return null;
  return indexRootTryLine(root);
}

/** Search finds tickers and companies; a function, a dataset or a term is in the catalog, so an empty search points there. */
function catalogHint(query: string): string {
  return `Search finds tickers and company names. Try: gloomberb catalog "${query.replace(/"/g, "")}"`;
}

/**
 * The notes beside the results: the index a bare root names, data the query
 * asks for that no source carries yet, and for an empty search the catalog,
 * unless a known gap already said where to look instead.
 */
function searchNotes(query: string, candidates: TickerSearchCandidate[]): string[] {
  const gap = knownGapMessage(query);
  return [indexRootNote(query, candidates), gap, candidates.length === 0 && !gap ? catalogHint(query) : null]
    .filter((note): note is string => !!note);
}

export function buildSearchReport({
  query,
  candidates,
  series = [],
}: {
  query: string;
  candidates: TickerSearchCandidate[];
  /** Data catalog series the query names: data, such as a price or a rate, that no ticker is. */
  series?: readonly SeriesMatch[];
}): string {
  const lines = [renderSection(`Search: ${query}`)];
  const indexNote = indexRootNote(query, candidates);
  if (indexNote) lines.push("", indexNote);
  const gap = knownGapMessage(query);
  if (gap) lines.push("", gap);
  const charted = renderSeriesMatches(query, series, SEARCH_SERIES_LIMIT, cliTerminalWidth() ?? 100, "catalog");
  // A query that names the data ("carbon", "day-ahead") lists its series first; words that happen to
  // be in a series name ("apple") list them after the tickers.
  const seriesFirst = series.some((match) => match.exact);
  if (charted && (seriesFirst || candidates.length === 0)) lines.push("", charted);

  if (candidates.length === 0) {
    if (!gap && !charted) lines.push(cliStyles.muted("No matches found."), cliStyles.muted(catalogHint(query)));
    return lines.join("\n");
  }

  const categories = Array.from(new Set(candidates.map((candidate) => candidate.category)));
  // Where a row came from, only when one is saved or from a broker.
  const showSource = candidates.some((candidate) => searchSourceLabel(candidate));
  for (const category of categories) {
    const categoryRows = candidates.filter((candidate) => candidate.category === category);
    lines.push("");
    lines.push(renderSection(category));
    lines.push(renderTable(
      [
        { header: "Symbol" },
        { header: "Name" },
        { header: "Exchange" },
        { header: "Type" },
        ...(showSource ? [{ header: "Source" }] : []),
      ],
      categoryRows.map((candidate) => [
        candidate.label,
        resolveSearchName(candidate),
        candidate.result?.exchange
          || candidate.result?.primaryExchange
          || candidate.ticker?.metadata.exchange
          || candidate.right
          || "—",
        searchType(candidate) ?? "—",
        ...(showSource ? [searchSourceLabel(candidate) || "—"] : []),
      ]),
    ));
  }
  if (charted && !seriesFirst) lines.push("", charted);

  return lines.join("\n");
}

export async function search(query: string, dependencies: SearchCommandDependencies = {}) {
  const trimmedQuery = query.trim();
  const failCommand = dependencies.fail ?? fail;
  const initMarketDataFn = dependencies.initMarketData ?? initMarketData;
  if (!trimmedQuery) {
    failCommand("Usage: gloomberb search <query>");
  }

  await withMarketData(initMarketDataFn, async ({ store, dataProvider }) => {
    const tickers = await store.loadAllTickers();
    const candidates = await searchCandidatesForCli({
      query: trimmedQuery,
      tickers,
      dataProvider,
    });

    const series = findCatalogSeries(dependencies.plugins ?? [], trimmedQuery, "names");
    if (dependencies.printResult) {
      const warnings = searchNotes(trimmedQuery, candidates);
      dependencies.printResult({
        data: searchCandidateRows(candidates),
        metadata: { query: trimmedQuery, ...(series.length ? { series } : {}) },
        warnings: warnings.length ? warnings : undefined,
      }, {
        columns: [
          { key: "category", header: "Category" },
          { key: "symbol", header: "Symbol" },
          { key: "name", header: "Name" },
          { key: "exchange", header: "Exchange" },
          { key: "type", header: "Type" },
          { key: "source", header: "Source" },
        ],
      });
      return;
    }

    console.log(buildSearchReport({
      query: trimmedQuery,
      candidates,
      series,
    }));
  });
}
