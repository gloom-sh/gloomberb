import { logFailure } from "../../utils/log-failure";
import {
  cliStyles,
  cliTerminalWidth,
  renderDefinitions,
  renderSection,
  renderTable,
  wrapText,
  wrapToTerminal,
} from "../../utils/cli-output";
import type { DataProvider } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { quotedListingName } from "../../tickers/listing-name";
import type { TickerRecord } from "../../types/ticker";
import {
  candidateExchange,
  LISTING_SEARCH_LIMIT,
  listingDistance,
  primaryCompanyLine,
  searchTickerCandidates,
  type TickerSearchCandidate,
} from "../../tickers/search";
import { initMarketData, withMarketData } from "../context";
import { listingChangeLine, loadListingFate } from "../../tickers/listing-fate";
import { formatMarketPriceWithCurrency, quoteFormatOptions } from "../../market-data/market/format";
import { formerIssuerLine, startTickerChangeLookup, type TickerChangeLookup } from "../../tickers/ticker-changes";
import { fail, failRetryable } from "../errors";
import { isProviderBusy, SEARCH_BUSY_CODE, SEARCH_BUSY_MESSAGE } from "../../sources/provider-errors";
import { isNetworkFailure } from "../../utils/network-failure";
import type { MarketContext } from "../types";
import type { CliCommandContext, GloomPlugin } from "../../types/plugin";
import { indexRootTryLine } from "../index-roots";
import { indexRootFor } from "../../tickers/index-roots";
import { readBrokerIndexCode } from "../listing-arg";
import { knownGapMessage, commandPointer } from "../known-gaps";
import { instrumentTypeLabel } from "../../tickers/instrument-kind";
import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import { companyNameExtraWords, groupByCompany, namedByService, sameCompany } from "../../tickers/company-name";
import { findCatalogSeries, renderSeriesMatches, type SeriesMatch } from "../series-search";
import { centralBankAskedAbout, centralBankCiting, type CentralBank } from "../../utils/central-banks";
import { createPaneCatalog } from "../pane-functions/discovery";
import { buildPaneCatalogEntries, filterPaneCatalogEntries, selectPaneCatalogMatches } from "../pane-functions/catalog";
import { normalizeSearchText } from "../../tickers/search/ranking";
import { hasNonLatinLetters } from "../../utils/typed-text";

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
  } catch (error) {
    logFailure("cli.commands-search", "Discover plugin functions for search failed")(error);
    // A plugin that cannot set up for discovery leaves the search as it was.
    return [];
  } finally {
    registry?.destroy();
  }
}

/** A bare symbol's quote, asked as `quote SYM` asks it: on the venue a saved row of the symbol is on, else the bare symbol. */
function loadSearchedQuote(symbol: string, savedExchange: string, dataProvider: DataProvider): Promise<Quote | null> {
  return Promise.resolve().then(() => dataProvider.getQuote(symbol, savedExchange)).catch(logFailure("cli.commands-search", "Read searched symbol quote failed", null));
}

export async function searchCandidatesForCli({
  query,
  tickers,
  dataProvider,
  totalLimit = 10,
  localLimit = 6,
  quote: quoted,
}: {
  query: string;
  tickers: TickerRecord[];
  dataProvider: DataProvider;
  totalLimit?: number;
  localLimit?: number;
  /** The symbol's quote when the caller asked for it beside the search; otherwise asked only when search lists the symbol. */
  quote?: Promise<Quote | null>;
}): Promise<TickerSearchCandidate[]> {
  const trimmedQuery = query.trim();
  // Only signs (`!!!`) name nothing: no saved ticker is a match for them.
  if (!normalizeSearchText(trimmedQuery)) return [];

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
      ? await (quoted ?? loadSearchedQuote(symbol, savedExchange, dataProvider))
      : null;
    return withQuotedNames(symbol, withUsLineOfPrimary(withHomeListingPrimary(trimmedQuery, withPrimaryListingFirst(symbol, candidates, quote))), quote)
      .slice(0, totalLimit);
  } catch (error) {
    // Not "No matches found": a script or a reader would take that for a name nothing lists.
    if (isProviderBusy(error)) failRetryable(SEARCH_BUSY_MESSAGE, SEARCH_BUSY_CODE);
    // Nor is no answer at all: the command fails as "couldn't reach", as any command offline does.
    if (isNetworkFailure(error)) throw error;
    logFailure("cli.commands-search", "Search ticker candidates failed")(error);
    return [];
  }
}

/** A symbol search does not list whose quote stopped long ago: TWTR, last traded 2022-10-27. */
interface StoppedListing {
  symbol: string;
  /** The security's name, from its quote or the company that left the symbol; null when neither says. */
  name: string | null;
  /** The exchange-local date it last traded. */
  lastTraded: string;
  /** Its last price with its currency: $53.86. */
  lastPrice: string;
  /** What history and options say of it: "TWTR stopped trading 2022-10-27; no history or options served". */
  note: string;
}

interface SearchFate {
  /** The symbol searched for, when search no longer lists it and its quote stopped long ago. */
  stopped: StoppedListing | null;
  /** Lines beside the results: `quote`'s line for a company that left the symbol (FB), or a listed symbol that stopped trading. */
  notes: string[];
}

const NO_SEARCH_FATE: SearchFate = { stopped: null, notes: [] };

/**
 * What became of a bare symbol, read as `quote` reads it (`loadListingFate`):
 * one search does not list but whose quote stopped long ago is listed as no
 * longer trading, and a line says when its company left the symbol (FB) or a
 * listing search still lists stopped trading. Nothing for anything else.
 */
async function searchFate(
  symbol: string,
  candidates: readonly TickerSearchCandidate[],
  quote: Quote | null,
  dataProvider: DataProvider,
  changes: TickerChangeLookup,
): Promise<SearchFate> {
  const fate = await loadListingFate({ symbol }, dataProvider, { quote, changes });
  const unlisted = !candidates.some((candidate) => candidate.symbol.toUpperCase() === symbol);
  const stopped = unlisted && quote && fate.endedOn && fate.note
    ? {
      symbol,
      name: quote.name?.trim() || fate.change?.issuer || null,
      lastTraded: fate.endedOn,
      lastPrice: formatMarketPriceWithCurrency(quote.price, quote.currency, quoteFormatOptions(quote)),
      note: fate.note,
    }
    : null;
  // The row says when a listing stopped; a company that left the symbol, or merged away from it (GOGL), is a line of its own.
  const changed = listingChangeLine(fate);
  return { stopped, notes: changed ? [changed] : fate.note && !stopped ? [fate.note] : [] };
}

/**
 * A row search found by the old name of a company that merged into it
 * ("Golden Ocean" finds CMB.Tech's CMBT): the line `quote GOGL` prints.
 */
function formerIssuerNote(candidate: TickerSearchCandidate): string | null {
  const former = candidate.result?.formerIssuer;
  if (!former?.symbol || !former.name || !former.until || former.symbol.toUpperCase() === candidate.symbol.toUpperCase()) return null;
  // A leftover line of the merged company names the listing it became; the successor's own row is that listing.
  return formerIssuerLine(former.symbol, former, former.successor ?? { symbol: candidate.label, name: resolveSearchName(candidate) });
}

/**
 * A row search found by the name its company had before it was renamed
 * ("cassava" finds Filana Therapeutics' FLNA): says what it was called.
 */
function formerNameNote(candidate: TickerSearchCandidate): string | null {
  const formerName = candidate.result?.formerName;
  if (typeof formerName !== "string" || !formerName.trim()) return null;
  return `${candidate.label} is ${resolveSearchName(candidate)}, formerly ${formerName.trim()}`;
}

/** The merged companies' and renamed companies' lines, once each, unless the symbol's own line already says it. */
function formerIssuerNotes(candidates: readonly TickerSearchCandidate[], fate: SearchFate): string[] {
  const notes = new Set(candidates.flatMap((candidate) => formerIssuerNote(candidate) ?? formerNameNote(candidate) ?? []));
  return [...notes].filter((note) => !fate.notes.some((line) => line.split(" ")[0] === note.split(" ")[0]));
}

/** A query that is a bare symbol (CAR, BRK.B), not a name or a phrase. */
const BARE_SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;

/**
 * For a bare symbol several companies list (CAR: Avis, Carrefour, CAR Group),
 * the company of the listing `quote CAR` reads goes first, under its home
 * line when the service marks one of its listings so, then each
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
  const quoted = quotedCandidate(listed, quote);
  if (!quoted) return candidates;
  // That company leads with its home line where it lists one under the symbol too (TD on TSX before NYSE).
  const primary = companies.find((group) => group.includes(quoted))?.find((candidate) => candidate.result?.homeListing === true) ?? quoted;
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

/**
 * A company searched by name lists its home line as the primary listing. A
 * search row names no home exchange or volume, so a company's lines go by
 * how far each is from being its own line (`listingDistance`), then by the
 * search score the service gives the listings people look up most. The
 * listing search put first, often the one-off cross-listing whose short name
 * matched the query (LUFTHANSA on Budapest), gives way only to a closer line,
 * or to one searched at least twice as often, or any scored line when it has
 * no score. A listing searched by its own symbol is not moved, and nor is
 * the line the service marks as the company's home (`homeListing`).
 *
 * The line the service marks with the name as typed is the company the name
 * means ("coca cola" is The Coca-Cola Company's KO). A company whose name
 * only adds words to it (Coca-Cola Consolidated, Coca-Cola Europacific) is
 * not one of its lines, and no score outweighs the mark: only a closer line
 * of the same name takes the lead, its home line for a receipt.
 */
function withHomeListingPrimary(query: string, candidates: TickerSearchCandidate[]): TickerSearchCandidate[] {
  const primary = candidates.find((candidate) => candidate.category === "Primary Listing");
  if (!primary || primary.kind !== "search" || primary.result?.homeListing === true
    || primary.symbol.toUpperCase() === query.toUpperCase()) return candidates;
  const company = resolveSearchName(primary);
  const marked = !!primary.result && namedByService(query, primary.result);
  const lines = candidates.filter((candidate) => candidate.kind === "search" && candidate.category !== "Funds & Derivatives"
    && (candidate.instrumentClass === "equity" || candidate.instrumentClass === "other") && sameCompany(resolveSearchName(candidate), company)
    && (!marked || companyNameExtraWords(resolveSearchName(candidate), company) != null));
  const home = primaryCompanyLine(primary, lines, (candidate) => ({
    distance: listingDistance(candidate), score: candidate.result?.popularity ?? candidate.popularity ?? null,
  }), { named: marked });
  if (home === primary) return candidates;
  const rest = candidates.filter((candidate) => candidate !== home);
  const at = rest.indexOf(primary);
  return [...rest.slice(0, at), { ...home, category: "Primary Listing" as const }, { ...primary, category: "Other Listings" as const }, ...rest.slice(at + 1)];
}

/**
 * A company whose primary listing is abroad lists the US line of the same
 * symbol right after it: the line `quote SHEL` reads (a bare symbol is its US
 * listing), which a name search ("shell") would otherwise rank below the
 * company's lines on other venues and cut. Any other list keeps its order.
 */
function withUsLineOfPrimary(candidates: TickerSearchCandidate[]): TickerSearchCandidate[] {
  const primary = candidates.find((candidate) => candidate.category === "Primary Listing");
  if (!primary || primary.kind !== "search" || isUsListingExchange(candidateExchange(primary))) return candidates;
  const symbol = primary.symbol.toUpperCase();
  const company = resolveSearchName(primary);
  const us = candidates.find((candidate) => candidate !== primary && candidate.kind === "search" && !candidate.contractKey
    && candidate.category !== "Funds & Derivatives" && candidate.symbol.toUpperCase() === symbol
    && isUsListingExchange(candidateExchange(candidate)) && sameCompany(resolveSearchName(candidate), company));
  if (!us) return candidates;
  const rest = candidates.filter((candidate) => candidate !== us);
  const at = rest.indexOf(primary) + 1;
  return [...rest.slice(0, at), { ...us, category: "Other Listings" as const }, ...rest.slice(at)];
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

/** What `--json` lists for a symbol search no longer lists: its category says so, and it keeps its last date and price. */
function stoppedListingRow(stopped: StoppedListing) {
  return {
    category: STOPPED_CATEGORY, symbol: stopped.symbol, name: stopped.name ?? "", exchange: "", type: "", source: "", providerId: "",
    saved: false, lastTraded: stopped.lastTraded, lastPrice: stopped.lastPrice, note: stopped.note,
  };
}

const STOPPED_CATEGORY = "No Longer Trading";

/** The stopped listing in its own section, as the search results list: its name when known, its last date and price. */
function renderStoppedListing(stopped: StoppedListing): string {
  return [renderSection(STOPPED_CATEGORY), renderTable(
    [{ header: "Symbol" }, ...stopped.name ? [{ header: "Name" }] : [], { header: "Last traded" }, { header: "Last price", align: "right" as const }],
    [[stopped.symbol, ...stopped.name ? [stopped.name] : [], stopped.lastTraded, stopped.lastPrice]],
  )].join("\n");
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
    // The company that merged into this one, whose old name the query is.
    ...candidate.result?.formerIssuer ? { formerIssuer: candidate.result.formerIssuer } : {},
    // The name a renamed company had, which the query is.
    ...typeof candidate.result?.formerName === "string" && candidate.result.formerName.trim()
      ? { formerName: candidate.result.formerName.trim() } : {},
  }));
}

/**
 * "^VIX  Cboe Volatility Index (try: gloom quote ^VIX)" for a bare index root, whose
 * search finds funds named after the index but not the index, unless it does list it.
 */
function indexRootNote(query: string, candidates: TickerSearchCandidate[]): string | null {
  const root = indexRootFor(query);
  if (!root || candidates.some((candidate) => candidate.label.toUpperCase() === root.symbol)) return null;
  return indexRootTryLine(root);
}

/**
 * The bank on the CBR board a query names ("SNB", "Norges Bank"), asks the
 * policy rate of ("bank of japan rate"), or whose row reads the FRED series
 * it names (DFEDTARU).
 */
function searchedCentralBank(query: string): CentralBank | null {
  return centralBankAskedAbout(query) ?? centralBankCiting(query.replace(/^FRED:/i, ""));
}

/** "Swiss National Bank (Switzerland): policy rate on the CBR board, gloom fn CBR." */
function centralBankLine(bank: CentralBank): string {
  return `${bank.name} (${bank.place}): policy rate on the CBR board, gloom fn CBR.`;
}

/** Search finds tickers and companies; a function, a dataset or a term is in the catalog, so an empty search points there. */
function catalogHint(query: string): string {
  return `Search finds tickers and company names. Try: gloom catalog "${query.replace(/"/g, "")}"`;
}

/** What a search for a name in another script (任天堂) that found nothing says: listings are named in Latin letters. */
const OTHER_SCRIPT_NO_MATCH = "No matches. Try the ticker or the English name.";

/** The line an empty search ends with: where else to look, or for a name in another script, what to type instead. */
function emptySearchHint(query: string): string {
  return hasNonLatinLetters(query) ? OTHER_SCRIPT_NO_MATCH : catalogHint(query);
}

/**
 * The notes beside the results: the index a bare root names, data the query
 * asks for that no source carries yet, the central bank it names, the setting
 * it names ("light theme"), and for an empty search the catalog, unless one of
 * those or the functions listed already said where to look instead.
 */
function searchNotes(
  query: string,
  candidates: TickerSearchCandidate[],
  functions: readonly SearchFunctionMatch[],
  fate: SearchFate,
): string[] {
  const gap = knownGapMessage(query);
  const bank = searchedCentralBank(query);
  const setting = commandPointer(query);
  const empty = candidates.length === 0 && !fate.stopped;
  // A gap line that names the index (TNX's yield line names ^TNX) says it once.
  return [...fate.notes, ...formerIssuerNotes(candidates, fate), gap ? null : indexRootNote(query, candidates), gap, bank ? centralBankLine(bank) : null, setting,
    empty && !gap && !bank && !setting && functions.length === 0 ? emptySearchHint(query) : null]
    .filter((note): note is string => !!note);
}

/** The functions an empty search lists: each with what it does, whole, since that is why it matched. */
function renderFunctionMatches(functions: readonly SearchFunctionMatch[]): string {
  const width = Math.min(cliTerminalWidth() ?? 100, 100);
  return [
    renderSection("Functions"),
    ...renderDefinitions(functions.map((match) => [`${match.token}  ${match.label}`, match.description] as const), { width, termStyle: cliStyles.command }),
    "",
    ...wrapText("No ticker or company matches. gloom catalog <function> shows a function's options and examples.", width)
      .map((line) => cliStyles.muted(line)),
  ].join("\n");
}

export function buildSearchReport({
  query,
  candidates,
  series = [],
  functions = [],
  fate = NO_SEARCH_FATE,
  pointToCatalog = false,
  readAs,
}: {
  query: string;
  candidates: TickerSearchCandidate[];
  /** Data catalog series the query names: data, such as a price or a rate, that no ticker is. */
  series?: readonly SeriesMatch[];
  /** The functions that carry every word of a query no ticker matches. */
  functions?: readonly SearchFunctionMatch[];
  /** What became of the symbol searched for: a listing that stopped trading, a company that left it. */
  fate?: SearchFate;
  /** End with the catalog hint whatever search found: `quote` searched a phrase the user did not ask to search. */
  pointToCatalog?: boolean;
  /** What the query was searched as: "Read VIX.X as ^VIX (Cboe Volatility Index)." */
  readAs?: string;
}): string {
  const lines = [renderSection(`Search: ${query}`)];
  if (readAs) lines.push("", readAs);
  const notes = [...fate.notes, ...formerIssuerNotes(candidates, fate)];
  if (notes.length > 0) lines.push("", ...notes);
  const gap = knownGapMessage(query);
  const indexNote = gap ? null : indexRootNote(query, candidates);
  if (indexNote) lines.push("", indexNote);
  if (gap) lines.push("", gap);
  const bank = searchedCentralBank(query);
  if (bank) lines.push("", wrapToTerminal(centralBankLine(bank)));
  const setting = commandPointer(query);
  if (setting) lines.push("", setting);
  const charted = renderSeriesMatches(query, series, SEARCH_SERIES_LIMIT, cliTerminalWidth() ?? 100, "catalog");
  // A query that names the data ("carbon", "day-ahead") lists its series first; words that happen to
  // be in a series name ("apple") list them after the tickers.
  const seriesFirst = series.some((match) => match.exact);
  if (charted && (seriesFirst || candidates.length === 0)) lines.push("", charted);
  // The symbol asked for goes first, though search no longer lists it.
  if (fate.stopped) lines.push("", renderStoppedListing(fate.stopped));

  if (candidates.length === 0) {
    if (fate.stopped) return lines.join("\n");
    if (functions.length > 0) lines.push("", renderFunctionMatches(functions));
    else if (!gap && !bank && !setting && !charted) {
      return [...lines, ...hasNonLatinLetters(query) ? [cliStyles.muted(OTHER_SCRIPT_NO_MATCH)]
        : [cliStyles.muted("No matches found."), cliStyles.muted(catalogHint(query))]].join("\n");
    }
    if (pointToCatalog) lines.push("", cliStyles.muted(catalogHint(query)));
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
  if (pointToCatalog) lines.push("", cliStyles.muted(catalogHint(query)));

  return lines.join("\n");
}

/** The functions a search lists when it found no ticker, unless a known gap or a central bank already says where to look. */
function searchedFunctions(
  query: string,
  candidates: readonly TickerSearchCandidate[],
  fate: SearchFate,
  plugins: GloomPlugin[] | undefined,
  context: MarketContext,
): Promise<SearchFunctionMatch[]> {
  // Functions are named in English: a name in another script is no function's.
  return candidates.length === 0 && !fate.stopped && !knownGapMessage(query) && !searchedCentralBank(query) && plugins && !hasNonLatinLetters(query)
    ? searchFunctionsForCli(query, plugins, context)
    : Promise.resolve([]);
}

/**
 * What `quote "10 year yield"` prints for a phrase that is no ticker and no
 * company's name: what `search` finds for it, then the catalog, where the
 * functions and data series are found by what they do.
 */
export async function phraseSearchReport(phrase: string, context: MarketContext, plugins?: GloomPlugin[]): Promise<string> {
  const candidates = await searchCandidatesForCli({ query: phrase, tickers: await context.store.loadAllTickers(), dataProvider: context.dataProvider });
  const series = findCatalogSeries(plugins ?? [], phrase, "names");
  const functions = await searchedFunctions(phrase, candidates, NO_SEARCH_FATE, plugins, context);
  return buildSearchReport({ query: phrase, candidates, series, functions, pointToCatalog: true });
}

export async function search(query: string, dependencies: SearchCommandDependencies = {}) {
  const trimmedQuery = query.trim();
  const failCommand = dependencies.fail ?? fail;
  const initMarketDataFn = dependencies.initMarketData ?? initMarketData;
  if (!trimmedQuery) {
    failCommand("Usage: gloom search <query>");
  }

  await withMarketData(initMarketDataFn, async (context) => {
    const { store, dataProvider } = context;
    const tickers = await store.loadAllTickers();
    // A broker's code for an index (VIX.X, $VIX) searches for the index, as `quote` reads it.
    const index = await readBrokerIndexCode(trimmedQuery, context);
    const symbol = (index?.symbol ?? trimmedQuery).toUpperCase();
    // A bare symbol's quote and whether it changed (FB is now META) are asked beside the search, so they cost no wait.
    const bare = BARE_SYMBOL.test(symbol);
    const savedExchange = tickers.find((ticker) => ticker.metadata.ticker.toUpperCase() === symbol)?.metadata.exchange ?? "";
    const quote = bare ? loadSearchedQuote(symbol, savedExchange, dataProvider) : null;
    const changes = bare ? startTickerChangeLookup(dataProvider, symbol) : null;
    const candidates = await searchCandidatesForCli({
      query: index?.symbol ?? trimmedQuery,
      tickers,
      dataProvider,
      ...quote ? { quote } : {},
    });
    const fate = quote && changes ? await searchFate(symbol, candidates, await quote, dataProvider, changes) : NO_SEARCH_FATE;

    const series = findCatalogSeries(dependencies.plugins ?? [], trimmedQuery, "names");
    const bank = searchedCentralBank(trimmedQuery);
    // A query that names no ticker may name what a function does.
    const functions = await searchedFunctions(trimmedQuery, candidates, fate, dependencies.plugins, context);
    if (dependencies.printResult) {
      const warnings = searchNotes(trimmedQuery, candidates, functions, fate);
      dependencies.printResult({
        data: [...fate.stopped ? [stoppedListingRow(fate.stopped)] : [], ...searchCandidateRows(candidates)],
        metadata: { query: trimmedQuery, ...(index ? { searched: index.symbol } : {}), ...(series.length ? { series } : {}), ...(functions.length ? { functions } : {}),
          ...(bank ? { centralBank: { id: bank.id, name: bank.name, place: bank.place, function: "CBR" } } : {}) },
        warnings: index?.readAs || warnings.length ? [...index?.readAs ? [index.readAs] : [], ...warnings] : undefined,
      }, {
        columns: [
          { key: "category", header: "Category" },
          { key: "symbol", header: "Symbol" },
          { key: "name", header: "Name" },
          { key: "exchange", header: "Exchange" },
          { key: "type", header: "Type" },
          { key: "source", header: "Source" },
          ...fate.stopped ? [{ key: "lastTraded", header: "Last traded" }, { key: "lastPrice", header: "Last price" }] : [],
        ],
      });
      return;
    }

    console.log(buildSearchReport({
      query: trimmedQuery,
      candidates,
      series,
      functions,
      fate,
      readAs: index?.readAs,
    }));
  });
}
