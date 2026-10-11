import { FUTURES_CONTRACTS, type FuturesContract, type FuturesSector } from "../../plugins/builtin/futures/contracts";
import { isFuturesInstrument } from "../../market-data/futures-contract";
import type { Quote } from "../../types/financials";

/**
 * A company whose news follows a futures market, for the hint `news` gives a
 * futures code: news is filed under company tickers, and funds such as UNG
 * rarely carry stories of their own. Index, rates and currency futures have
 * none; market headlines fit them better.
 */
const CONTRACT_COMPANIES: Readonly<Record<string, string>> = {
  NG: "EQT", TTF: "LNG", CL: "XOM", BZ: "XOM", RB: "XOM", HO: "XOM",
  GC: "NEM", SI: "NEM", PL: "NEM", PA: "NEM", HG: "FCX", ALI: "AA",
};
const SECTOR_COMPANIES: Partial<Record<FuturesSector, string>> = {
  energy: "XOM",
  metals: "NEM",
  agriculture: "DE",
  livestock: "TSN",
};

function boardContract(symbol: string): FuturesContract | null {
  const wanted = symbol.trim().toUpperCase();
  return FUTURES_CONTRACTS.find((contract) => contract.code === wanted || contract.symbol === wanted) ?? null;
}

/** "try news LNG", or market headlines where no company follows the contract. */
function contractSuggestion(contract: FuturesContract): string {
  const company = CONTRACT_COMPANIES[contract.code] ?? SECTOR_COMPANIES[contract.sector];
  return company ? `try news ${company}` : "for market headlines run news with no symbol";
}

/**
 * What `news <symbol>` says when it finds no stories: news is filed under
 * company tickers, so a futures board code (TTF), a futures contract (CL=F)
 * or a symbol no listing answers to gets told so, with something to try.
 */
export function newsEmptyMessage(
  symbol: string,
  title: string,
  quote: Pick<Quote, "instrumentType"> | null,
  resolved: boolean,
): string {
  const contract = boardContract(symbol);
  const typed = symbol.trim().toUpperCase();
  if (!resolved) {
    return contract
      ? `${typed} is the futures board's code for ${contract.name}, not a ticker. news takes a company ticker: ${contractSuggestion(contract)}.`
      : `No listing answers to ${typed}. news takes a company ticker, such as news AAPL. Try \`gloomberb search ${typed}\`.`;
  }
  if (isFuturesInstrument(symbol, quote?.instrumentType)) {
    return `No news for ${title}: news is filed under company tickers, not futures${contract ? `; ${contractSuggestion(contract)}` : ""}.`;
  }
  return contract
    ? `No news for ${title}. ${typed} is also the futures board's code for ${contract.name}: ${contractSuggestion(contract)}.`
    : `No news for ${title}.`;
}
