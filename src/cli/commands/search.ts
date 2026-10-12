import {
  cliStyles,
  cliTerminalWidth,
  renderDefinitions,
  renderSection,
  renderTable,
  wrapText,
} from "../../utils/cli-output";
import type { DataProvider } from "../../types/data-provider";
import type { TickerRecord } from "../../types/ticker";
import {
  LISTING_SEARCH_LIMIT,
  searchTickerCandidates,
  type TickerSearchCandidate,
} from "../../tickers/search";
import { initMarketData, withMarketData } from "../context";
import { fail } from "../errors";
import type { MarketContext } from "../types";
import type { CliCommandContext, GloomPlugin } from "../../types/plugin";
import { indexRootFor, indexRootTryLine } from "../index-roots";
import { knownGapMessage } from "../known-gaps";
import { instrumentTypeLabel } from "../../tickers/instrument-kind";
import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import { groupByCompany } from "../../tickers/company-name";
import { findCatalogSeries, renderSeriesMatches, type SeriesMatch } from "../series-search";
import { createPaneCatalog } from "../pane-functions/discovery";
import { buildPaneCatalogEntries, filterPaneCatalogEntries, selectPaneCatalogMatches } from "../pane-functions/catalog";

interface SearchCommandDependencies {
  initMarketData?: () => Promise<MarketContext>;
  fail?: (message: string, details?: string) => never;
  printResult?: CliCommandContext["printResult"];
  /**
   * Plugins whose data catalog series a query can name, listed before the
   * tickers, and whose functions a search that finds no ticker lists.
   */
  plugins?: GloomPlugin[];
}

/** Series a search lists before pointing at the catalog for the rest. */
const SEARCH_SERIES_LIMIT = 3;
/** Functions a search that finds no ticker lists, as `catalog` would. */
const SEARCH_FUNCTION_LIMIT = 3;

/** A function a search lists: what `catalog` shows of it in a list. */
export interface SearchFunctionMatch {
  token: string;
  label: string;
  description: string;
}

/**
 * The functions that carry every word of the query in their name, keywords
 * or description, best first, as `catalog <query>` ranks them: "target
 * weights rebalance" names no company, but PF does that. None when only some
 * of the words match.
 */
export async function searchFunctionsForCli(query: string, plugins: GloomPlugin[], context: MarketContext): Promise<SearchFunctionMatch[]> {
  let registry: Awaited<ReturnType<typeof createPaneCatalog>> | null = null;
  try {
    registry = await createPaneCatalog(context, plugins);
    const entries = await buildPaneCatalogEntries(registry, context);
    const { shown, loose } = selectPaneCatalogMatches(filterPaneCatalogEntries(entries, query), query, SEARCH_FUNCTION_LIMIT);
    return loose ? [] : shown.map(({ token, label, description }) => ({ token, label, description }));
  } catch {
    // A plugin that cannot set up for discovery leaves the search as it was.
    return [];
  } finally {
    registry?.destroy();
  }
}

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
    return (await withPrimaryListingFirst(trimmedQuery, candidates, dataProvider)).slice(0, totalLimit);
  } catch {
    return [];
  }
}

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
async function withPrimaryListingFirst(
  query: string,
  candidates: TickerSearchCandidate[],
  dataProvider: DataProvider,
): Promise<TickerSearchCandidate[]> {
  const symbol = query.toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(symbol)) return candidates;
  const exact = candidates.filter((candidate) => candidate.symbol.toUpperCase() === symbol);
  if (exact.some((candidate) => candidate.kind === "ticker" || candidate.saved)) return candidates;
  const listed = exact.filter((candidate) => candidate.kind === "search" && (candidate.instrumentClass === "equity" || candidate.instrumentClass === "other"));
  const companies = groupByCompany(listed, resolveSearchName);
  if (companies.length < 2) return candidates;
  const quote = await dataProvider.getQuote(symbol, "").catch(() => null);
  const quoted = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName);
  if (!quoted) return candidates;
  // The US exchanges share one symbol: a quote on any of them is the symbol's one US line.
  const primary = listed.find((candidate) => candidateExchange(candidate) === quoted)
    ?? (isUsListingExchange(quoted) ? listed.find((candidate) => isUsListingExchange(candidateExchange(candidate))) : undefined);
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
 * unless a known gap or the functions listed already said where to look instead.
 */
function searchNotes(query: string, candidates: TickerSearchCandidate[], functions: readonly SearchFunctionMatch[]): string[] {
  const gap = knownGapMessage(query);
  return [indexRootNote(query, candidates), gap, candidates.length === 0 && !gap && functions.length === 0 ? catalogHint(query) : null]
    .filter((note): note is string => !!note);
}

/** The functions an empty search lists: each with what it does, whole, since that is why it matched. */
function renderFunctionMatches(functions: readonly SearchFunctionMatch[]): string {
  const width = Math.min(cliTerminalWidth() ?? 100, 100);
  return [
    renderSection("Functions"),
    ...renderDefinitions(functions.map((match) => [`${match.token}  ${match.label}`, match.description] as const), { width, termStyle: cliStyles.command }),
    "",
    ...wrapText("No ticker or company matches. gloomberb catalog <function> shows a function's options and examples.", width)
      .map((line) => cliStyles.muted(line)),
  ].join("\n");
}

export function buildSearchReport({
  query,
  candidates,
  series = [],
  functions = [],
}: {
  query: string;
  candidates: TickerSearchCandidate[];
  /** Data catalog series the query names: data, such as a price or a rate, that no ticker is. */
  series?: readonly SeriesMatch[];
  /** The functions that carry every word of a query no ticker matches. */
  functions?: readonly SearchFunctionMatch[];
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
    if (functions.length > 0) lines.push("", renderFunctionMatches(functions));
    else if (!gap && !charted) lines.push(cliStyles.muted("No matches found."), cliStyles.muted(catalogHint(query)));
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

  await withMarketData(initMarketDataFn, async (context) => {
    const { store, dataProvider } = context;
    const tickers = await store.loadAllTickers();
    const candidates = await searchCandidatesForCli({
      query: trimmedQuery,
      tickers,
      dataProvider,
    });

    const series = findCatalogSeries(dependencies.plugins ?? [], trimmedQuery, "names");
    // A query that names no ticker may name what a function does; a known gap already says where to look.
    const functions = candidates.length === 0 && !knownGapMessage(trimmedQuery) && dependencies.plugins
      ? await searchFunctionsForCli(trimmedQuery, dependencies.plugins, context)
      : [];
    if (dependencies.printResult) {
      const warnings = searchNotes(trimmedQuery, candidates, functions);
      dependencies.printResult({
        data: searchCandidateRows(candidates),
        metadata: { query: trimmedQuery, ...(series.length ? { series } : {}), ...(functions.length ? { functions } : {}) },
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
      functions,
    }));
  });
}
