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

function resolveSearchName(candidate: TickerSearchCandidate): string {
  return candidate.detail.split(" | ")[0] || candidate.detail || "—";
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
    source: candidate.kind === "ticker"
      ? "Saved"
      : candidate.result?.brokerLabel || candidate.result?.providerId || "Provider",
    providerId: candidate.result?.providerId ?? "",
    saved: candidate.kind === "ticker",
  }));
}

export function buildSearchReport({
  query,
  candidates,
}: {
  query: string;
  candidates: TickerSearchCandidate[];
}): string {
  const lines = [renderSection(`Search: ${query}`)];

  if (candidates.length === 0) {
    lines.push(cliStyles.muted("No matches found."));
    return lines.join("\n");
  }

  const categories = Array.from(new Set(candidates.map((candidate) => candidate.category)));
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
        { header: "Source" },
      ],
      categoryRows.map((candidate) => [
        candidate.label,
        resolveSearchName(candidate),
        candidate.result?.exchange
          || candidate.result?.primaryExchange
          || candidate.ticker?.metadata.exchange
          || candidate.right
          || "—",
        candidate.result?.type
          || candidate.result?.brokerContract?.secType
          || candidate.ticker?.metadata.assetCategory
          || "—",
        candidate.kind === "ticker"
          ? "Saved"
          : candidate.result?.brokerLabel || candidate.result?.providerId || "Provider",
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
      dependencies.printResult({ data: searchCandidateRows(candidates), metadata: { query: trimmedQuery } }, {
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
