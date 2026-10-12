import type { AppConfig } from "../types/config";
import type { InstrumentSearchResult } from "../types/instrument";
import type { TickerRecord, Watchlist } from "../types/ticker";
import { AmbiguousTickerError, resolveTickerSearch, type ResolvedTickerSearch } from "../tickers/search";
import { canonicalExchange, parsePublicTickerKey, publicTickerKey } from "../utils/exchanges";
import {
  applyCollectionMembershipChange,
  materializeResolvedTicker,
  type SharedWorkflowDeps,
} from "../components/command-bar/workflow/tickers";
import {
  AmbiguousCollectionTickerError,
  resolveCollectionTicker,
} from "../components/command-bar/workflow/collection-ticker";
import type { RemoteChangePrompt } from "./types";

/**
 * `watchlist.add` and `watchlist.remove`: one ticker on one of the person's
 * own watchlists, through the same membership change the AW and RW commands
 * make. A plan resolves the list and the listing without writing anything,
 * so a caller can show it, ask, and then apply exactly that plan.
 */

export type WatchlistAction = "add" | "remove";

/** A change the app will not make, in words a caller can repeat to the person. */
class WatchlistRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchlistRefusal";
  }
}

export interface WatchlistChangeInput {
  symbol: string;
  exchange?: string;
  watchlist?: string;
}

type ResolvedListing =
  | { kind: "saved"; ticker: TickerRecord }
  | { kind: "listing"; resolved: Extract<ResolvedTickerSearch, { kind: "provider" }> }
  | { kind: "absent" };

export interface WatchlistChangePlan {
  action: WatchlistAction;
  watchlist: Pick<Watchlist, "id" | "name">;
  symbol: string;
  exchange: string;
  name: string | null;
  /** False when the ticker is already on the list (add) or not on it (remove). */
  changes: boolean;
  /** The change in one line, as the person approves it. */
  summary: string;
  /** Names this exact change: action, list and saved listing. */
  confirmKey: string;
  listing: ResolvedListing;
}

type WatchlistChangeOutcome = "added" | "removed" | "already-listed" | "not-listed" | "declined";

export interface WatchlistChangeResult {
  changed: boolean;
  outcome: WatchlistChangeOutcome;
  message: string;
  watchlist: Pick<Watchlist, "id" | "name">;
  symbol: string;
  exchange: string | null;
  name: string | null;
}

function isTeamWatchlist(watchlist: Watchlist): boolean {
  return !!watchlist.teamId || watchlist.id.startsWith("team:");
}

function personalWatchlists(config: AppConfig): Watchlist[] {
  return config.watchlists.filter((watchlist) => !isTeamWatchlist(watchlist));
}

function listNames(watchlists: readonly Watchlist[]): string {
  return watchlists.map((watchlist) => `"${watchlist.name}" (id ${watchlist.id})`).join(", ");
}

/**
 * The personal watchlist a call names by id or name, or else the default
 * one: the first personal watchlist, which a new profile calls Watchlist and
 * onboarding fills. The confirmation names it, so a wrong guess is declined.
 * Team watchlists are shared with everyone on the team and portfolios are
 * not watchlists, so both are refused, as the list's own remove key does.
 */
function resolveWatchlistTarget(config: AppConfig, requested: string | undefined): Watchlist {
  const personal = personalWatchlists(config);
  const raw = requested?.trim() ?? "";
  if (!raw) {
    if (personal[0]) return personal[0];
    throw new WatchlistRefusal("There is no personal watchlist to change. Create one with New Watchlist first.");
  }
  const lower = raw.toLowerCase();
  const matches = (entry: { id: string; name: string }) => entry.id.toLowerCase() === lower || entry.name.toLowerCase() === lower;
  const watchlist = config.watchlists.find((entry) => entry.id === raw) ?? config.watchlists.find(matches);
  if (watchlist) {
    if (isTeamWatchlist(watchlist)) {
      throw new WatchlistRefusal(`Refused: "${watchlist.name}" is a team watchlist, shared with everyone on the team. Only personal watchlists can be changed this way.`);
    }
    return watchlist;
  }
  const portfolio = config.portfolios.find((entry) => entry.id === raw) ?? config.portfolios.find(matches);
  if (portfolio) {
    const kind = portfolio.brokerId || portfolio.brokerInstanceId
      ? "a broker portfolio, whose positions come from the broker"
      : portfolio.teamId ? "a team portfolio" : "a portfolio";
    throw new WatchlistRefusal(`Refused: "${portfolio.name}" is ${kind}, not a watchlist.`);
  }
  throw new WatchlistRefusal(personal.length > 0
    ? `There is no watchlist "${raw}". Personal watchlists: ${listNames(personal)}.`
    : `There is no watchlist "${raw}", and no personal watchlist at all.`);
}

function listingExchange(result: InstrumentSearchResult): string {
  return result.exchange === "SMART" ? result.primaryExchange || result.exchange
    : result.exchange || result.primaryExchange || "";
}

function listingLabel(symbol: string, exchange: string): string {
  return exchange ? `${symbol} (${exchange})` : symbol;
}

async function resolveListing(
  input: WatchlistChangeInput,
  deps: SharedWorkflowDeps,
): Promise<ResolvedTickerSearch | null> {
  const symbol = input.symbol.trim().toUpperCase();
  const exchange = input.exchange?.trim().toUpperCase();
  if (!symbol) throw new WatchlistRefusal("symbol is required.");
  const query = exchange ? `${parsePublicTickerKey(symbol).symbol}:${exchange}` : symbol;
  try {
    return await resolveTickerSearch({
      query,
      activeTicker: null,
      tickers: deps.getState().tickers,
      dataProvider: deps.dataProvider,
      searchContext: { preferBroker: true, interactive: true },
    });
  } catch (error) {
    if (error instanceof AmbiguousTickerError) {
      throw new WatchlistRefusal(error.listings.length > 0
        ? `${query} matches more than one listing: ${error.listings.slice(0, 6).join(", ")}. Pass exchange to pick one.`
        : error.message);
    }
    throw error;
  }
}

/** The saved record that owns this listing on the list, as the AW command picks it. */
function savedOwner(ticker: TickerRecord, deps: SharedWorkflowDeps, watchlistId: string): TickerRecord {
  try {
    return resolveCollectionTicker(ticker, deps.getState().tickers, "watchlist", watchlistId);
  } catch (error) {
    if (error instanceof AmbiguousCollectionTickerError) throw new WatchlistRefusal(error.message);
    throw error;
  }
}

/** What the call would change, resolved without writing anything. */
export async function planWatchlistChange(
  action: WatchlistAction,
  input: WatchlistChangeInput,
  deps: SharedWorkflowDeps,
): Promise<WatchlistChangePlan> {
  const watchlist = resolveWatchlistTarget(deps.getState().config, input.watchlist);
  const resolved = await resolveListing(input, deps);
  let listing: ResolvedListing;
  let symbol: string;
  let exchange: string;
  let name: string | null;
  let key: string;
  let member: boolean;
  if (resolved?.kind === "local") {
    const ticker = savedOwner(resolved.ticker, deps, watchlist.id);
    listing = { kind: "saved", ticker };
    symbol = parsePublicTickerKey(ticker.metadata.ticker).symbol;
    exchange = canonicalExchange(ticker.metadata.exchange);
    name = ticker.metadata.name && ticker.metadata.name !== ticker.metadata.ticker ? ticker.metadata.name : null;
    key = ticker.metadata.ticker;
    member = ticker.metadata.watchlists.includes(watchlist.id);
  } else if (resolved?.kind === "provider") {
    if (action === "add") {
      listing = { kind: "listing", resolved };
    } else {
      listing = { kind: "absent" };
    }
    symbol = parsePublicTickerKey(resolved.symbol).symbol;
    exchange = canonicalExchange(listingExchange(resolved.result));
    name = resolved.result.name?.trim() || null;
    key = publicTickerKey(resolved.symbol, listingExchange(resolved.result));
    member = false;
  } else {
    if (action === "add") throw new WatchlistRefusal(`No listing found for ${input.symbol.trim().toUpperCase()}.`);
    listing = { kind: "absent" };
    symbol = parsePublicTickerKey(input.symbol.trim().toUpperCase()).symbol;
    exchange = canonicalExchange(input.exchange);
    name = null;
    key = symbol;
    member = false;
  }
  const label = listingLabel(symbol, exchange);
  return {
    action,
    watchlist: { id: watchlist.id, name: watchlist.name },
    symbol,
    exchange,
    name,
    changes: action === "add" ? !member : member,
    summary: action === "add" ? `Add ${label} to ${watchlist.name}` : `Remove ${label} from ${watchlist.name}`,
    confirmKey: `${action}|${watchlist.id}|${key}`,
    listing,
  };
}

/** The dialog the app shows before it applies a plan. */
export function watchlistChangePrompt(plan: WatchlistChangePlan): RemoteChangePrompt {
  return {
    title: plan.action === "add"
      ? `Add ${plan.symbol} to ${plan.watchlist.name}?`
      : `Remove ${plan.symbol} from ${plan.watchlist.name}?`,
    lines: watchlistChangeLines(plan),
    confirmLabel: plan.action === "add" ? "Add" : "Remove",
    destructive: plan.action === "remove",
  };
}

function watchlistChangeLines(plan: WatchlistChangePlan): RemoteChangePrompt["lines"] {
  return [
    { label: "Watchlist", value: plan.watchlist.name },
    { label: "Ticker", value: plan.symbol },
    { label: "Exchange", value: plan.exchange || "not known" },
    ...(plan.name ? [{ label: "Name", value: plan.name }] : []),
  ];
}

/** What a dry run reports: the plan a caller can show, and the key it passes back once approved. */
export function describeWatchlistPlan(plan: WatchlistChangePlan) {
  return {
    dryRun: true,
    action: plan.action,
    watchlist: plan.watchlist,
    symbol: plan.symbol,
    exchange: plan.exchange || null,
    name: plan.name,
    changes: plan.changes,
    summary: plan.changes ? plan.summary : unchangedMessage(plan),
    lines: watchlistChangeLines(plan),
    confirmKey: plan.confirmKey,
  };
}

function result(plan: WatchlistChangePlan, outcome: WatchlistChangeOutcome, message: string, ticker?: TickerRecord): WatchlistChangeResult {
  return {
    changed: outcome === "added" || outcome === "removed",
    outcome,
    message,
    watchlist: plan.watchlist,
    symbol: ticker ? parsePublicTickerKey(ticker.metadata.ticker).symbol : plan.symbol,
    exchange: (ticker ? canonicalExchange(ticker.metadata.exchange) : plan.exchange) || null,
    name: plan.name,
  };
}

function unchangedMessage(plan: WatchlistChangePlan): string {
  const label = listingLabel(plan.symbol, plan.exchange);
  return plan.action === "add"
    ? `${label} is already on ${plan.watchlist.name}; nothing changed.`
    : `${label} is not on ${plan.watchlist.name}; nothing changed.`;
}

export function unchangedWatchlistResult(plan: WatchlistChangePlan): WatchlistChangeResult {
  return result(plan, plan.action === "add" ? "already-listed" : "not-listed", unchangedMessage(plan));
}

export function declinedWatchlistResult(plan: WatchlistChangePlan): WatchlistChangeResult {
  return result(plan, "declined", `Declined in the app: ${plan.watchlist.name} is unchanged.`);
}

/**
 * Writes an approved plan through the AW command's membership change. The
 * list is checked again first: it may have been deleted or shared with a
 * team while the person decided.
 */
export async function applyWatchlistChange(
  plan: WatchlistChangePlan,
  deps: SharedWorkflowDeps,
): Promise<WatchlistChangeResult> {
  const watchlist = resolveWatchlistTarget(deps.getState().config, plan.watchlist.id);
  if (watchlist.id !== plan.watchlist.id) throw new WatchlistRefusal(`${plan.watchlist.name} changed while the app asked; nothing changed.`);
  if (plan.listing.kind === "absent") return unchangedWatchlistResult(plan);
  const ticker = plan.listing.kind === "saved"
    ? deps.getState().tickers.get(plan.listing.ticker.metadata.ticker) ?? plan.listing.ticker
    : (await materializeResolvedTicker(plan.listing.resolved, deps)).ticker;
  const owner = savedOwner(ticker, deps, watchlist.id);
  const { changed, ticker: saved } = await applyCollectionMembershipChange(owner, "watchlist", plan.action, watchlist.id, deps);
  if (!changed) return result(plan, plan.action === "add" ? "already-listed" : "not-listed", unchangedMessage(plan), saved);
  const label = listingLabel(parsePublicTickerKey(saved.metadata.ticker).symbol, canonicalExchange(saved.metadata.exchange));
  return plan.action === "add"
    ? result(plan, "added", `Added ${label} to ${watchlist.name}.`, saved)
    : result(plan, "removed", `Removed ${label} from ${watchlist.name}.`, saved);
}
