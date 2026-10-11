import {
  cliStyles,
  renderSection,
  renderTable,
} from "../../utils/cli-output";
import type { DataProvider } from "../../types/data-provider";
import type { TickerRecord } from "../../types/ticker";
import {
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

interface SearchCommandDependencies {
  initMarketData?: () => Promise<MarketContext>;
  fail?: (message: string, details?: string) => never;
  printResult?: CliCommandContext["printResult"];
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
    return await searchTickerCandidates({
      query: trimmedQuery,
      tickers: localTickerMap,
      dataProvider,
      localLimit,
      totalLimit,
    });
  } catch {
    return [];
  }
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
}: {
  query: string;
  candidates: TickerSearchCandidate[];
}): string {
  const lines = [renderSection(`Search: ${query}`)];
  const indexNote = indexRootNote(query, candidates);
  if (indexNote) lines.push("", indexNote);
  const gap = knownGapMessage(query);
  if (gap) lines.push("", gap);

  if (candidates.length === 0) {
    if (!gap) lines.push(cliStyles.muted("No matches found."), cliStyles.muted(catalogHint(query)));
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

    if (dependencies.printResult) {
      const warnings = searchNotes(trimmedQuery, candidates);
      dependencies.printResult({
        data: searchCandidateRows(candidates),
        metadata: { query: trimmedQuery },
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
    }));
  });
}
