import type { AppConfig } from "../../../../types/config";
import type { TickerRecord } from "../../../../types/ticker";
import type { BrokerAccount } from "../../../../types/trading";
import { describePortfolioTab } from "../../analytics/portfolio-selection";
import type { ASKGUserData } from "./protocol";

/** The bounds the platform accepts; more is cut here rather than refused there. */
const MAX_PORTFOLIOS = 30;
const MAX_WATCHLISTS = 30;
const MAX_BROKER_ACCOUNTS = 20;
const MAX_ID_LENGTH = 80;
const MAX_NAME_LENGTH = 60;

interface UserDataSource {
  config: Pick<AppConfig, "portfolios" | "watchlists" | "brokerInstances">;
  /** Accounts each broker connection reported, keyed by broker instance id. */
  brokerAccounts?: Readonly<Record<string, readonly BrokerAccount[]>>;
  /** Local tickers, for watchlist sizes. */
  tickers?: Iterable<TickerRecord>;
}

/** An id is used verbatim by a tool, so one too long to send is left out, not cut. */
function usableId(id: string | undefined): string | null {
  const trimmed = id?.trim() ?? "";
  return trimmed && trimmed.length <= MAX_ID_LENGTH ? trimmed : null;
}

function displayName(name: string | undefined, fallback: string): string {
  const line = (name ?? "").replace(/\s+/g, " ").trim() || fallback;
  return Array.from(line).slice(0, MAX_NAME_LENGTH).join("");
}

function watchlistCounts(tickers: Iterable<TickerRecord> | undefined): Map<string, number> | null {
  if (!tickers) return null;
  const counts = new Map<string, number>();
  for (const ticker of tickers) {
    for (const id of ticker.metadata.watchlists) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * What Gloom needs to call tools on the user's own data: each portfolio,
 * watchlist and broker account by the id tools take and the name the user
 * sees. Undefined when there is nothing to send.
 */
export function buildASKGUserData({ config, brokerAccounts, tickers }: UserDataSource): ASKGUserData | undefined {
  const portfolios = config.portfolios.flatMap((portfolio) => {
    const id = usableId(portfolio.id);
    if (!id) return [];
    return [{
      id,
      name: displayName(describePortfolioTab(portfolio, config.brokerInstances), id),
      kind: portfolio.brokerId || portfolio.brokerInstanceId ? "broker" as const : "manual" as const,
    }];
  }).slice(0, MAX_PORTFOLIOS);

  const counts = watchlistCounts(tickers);
  const watchlists = config.watchlists.flatMap((watchlist) => {
    const id = usableId(watchlist.id);
    if (!id) return [];
    // A team list's tickers live on the server, so a local count would read as empty.
    const count = counts && !watchlist.teamId ? counts.get(id) ?? 0 : null;
    return [{ id, name: displayName(watchlist.name, id), ...(count == null ? {} : { count }) }];
  }).slice(0, MAX_WATCHLISTS);

  const accounts = config.brokerInstances.flatMap((instance) => (
    (brokerAccounts?.[instance.id] ?? []).flatMap((account) => {
      const id = usableId(account.accountId);
      if (!id) return [];
      const named = account.name?.trim() && account.name.trim() !== account.accountId ? account.name : null;
      const portfolioId = usableId(config.portfolios.find((portfolio) => (
        portfolio.brokerInstanceId === instance.id && portfolio.brokerAccountId === account.accountId
      ))?.id);
      return [{
        id,
        name: displayName(named ?? `${instance.label} ${account.accountId}`, id),
        ...(portfolioId ? { portfolioId } : {}),
      }];
    })
  )).slice(0, MAX_BROKER_ACCOUNTS);

  const userData: ASKGUserData = {
    ...(portfolios.length ? { portfolios } : {}),
    ...(watchlists.length ? { watchlists } : {}),
    ...(accounts.length ? { brokerAccounts: accounts } : {}),
  };
  return Object.keys(userData).length ? userData : undefined;
}
