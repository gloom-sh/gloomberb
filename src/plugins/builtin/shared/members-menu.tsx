import { ChoiceDialog, TextPromptDialog, usePaneMenuItems } from "../../../components";
import { createFormCollectionActions } from "../../../components/form-modal/deps";
import { t, tf } from "../../../i18n";
import { usePluginAppActions } from "../../../public/react";
import { useAppDispatch, useAppGetState, useAppSelector } from "../../../state/app/context";
import { formatTickerListInput, MAX_TICKER_LIST_SIZE } from "../../../tickers/list";
import type { TickerMetadata, TickerRecord } from "../../../types/ticker";
import { useOptionalDialog, type PromptContext } from "../../../ui/dialog";
import { canonicalExchange, publicTickerKey } from "../../../utils/exchanges";
import { slugifyName } from "../../../utils/slugify";
import { getSharedRegistry } from "../../registry";
import { MAX_CORRELATION_TICKERS } from "../correlation/settings";
import { ROTATION_LIMIT } from "../relative-rotation/model";
import { SHORT_WATCH_LIMIT } from "../short-interest/watch-model";

/** One US-listed member of a theme or fund, in the order its list shows it. */
export interface MemberListing {
  symbol: string;
  name?: string | null;
  exchange?: string | null;
}

/** The members a pane shows, and what to call them. */
export interface MemberList {
  /** Names the members in dialog titles: a theme's name or a fund's ticker. */
  title: string;
  /** The name the save dialog suggests. */
  watchlistName: string;
  members: readonly MemberListing[];
  /** A search narrowing the list: what was typed and how many members the whole list has. */
  search?: { query: string; total: number } | null;
}

interface MemberDestination {
  templateId: string;
  label: string;
  /** The most symbols the destination takes; more would be refused or cut off there. */
  limit: number;
  minimum: number;
}

/**
 * Functions that take a list of tickers through `options.symbols`. CORR and
 * RIPL resolve the list the way the command bar does, which takes ten
 * tickers; RIPL's own setting takes more, but not through a new pane.
 */
export const MEMBER_DESTINATIONS: readonly MemberDestination[] = [
  { templateId: "relative-rotation-rrg", label: "Relative Rotation (RRG)", limit: ROTATION_LIMIT, minimum: 1 },
  { templateId: "correlation-pane", label: "Correlation Matrix (CORR)", limit: MAX_CORRELATION_TICKERS, minimum: 2 },
  { templateId: "short-watch-pane", label: "Short Squeeze Watch (SIW)", limit: SHORT_WATCH_LIMIT, minimum: 1 },
  { templateId: "earnings-ripple-pane", label: "Earnings Ripple (RIPL)", limit: MAX_TICKER_LIST_SIZE, minimum: 1 },
];

/**
 * A watchlist is a list to read and follow; a whole Russell 2000 stays in
 * MEMB. Larger lists save their first 100 as listed.
 */
export const MEMBER_WATCHLIST_LIMIT = 100;

/**
 * Distinct members in list order, as `SYMBOL:EXCHANGE` when the list names the
 * listing: CORR and RIPL resolve each one, and a bare CCJ also matches Xetra.
 */
export function memberSymbols(members: readonly MemberListing[]): string[] {
  const seen = new Set<string>();
  return members.flatMap((member) => {
    const symbol = member.symbol.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) return [];
    seen.add(symbol);
    const exchange = member.exchange?.trim().toUpperCase();
    return [exchange ? `${symbol}:${exchange}` : symbol];
  });
}

/**
 * What each destination would open: the first `limit` symbols as listed, or
 * disabled below its minimum. A disabled row cannot be selected, so its reason
 * sits beside the label rather than in the description under the list.
 */
export function memberDestinationChoices(symbols: readonly string[], destinations: readonly MemberDestination[]) {
  return destinations.map((destination) => {
    const taken = symbols.slice(0, destination.limit);
    const tooFew = taken.length < destination.minimum;
    return {
      id: destination.templateId,
      label: destination.label,
      symbols: taken,
      disabled: tooFew,
      detail: tooFew ? tf("needs {count}", { count: destination.minimum }) : undefined,
      description: tooFew ? undefined
        : taken.length < symbols.length ? tf("First {count} of {total} as listed", { count: taken.length, total: symbols.length })
        : tf("All {count}", { count: taken.length }),
    };
  });
}

/**
 * The dialog text for `count` distinct members. A search says what it matched
 * and how many members the whole list has, so a saved or opened subset never
 * reads as the whole fund.
 */
function memberListText(list: Pick<MemberList, "title" | "search">, count: number) {
  const query = list.search?.query.trim();
  const search = query ? { query, total: list.search!.total } : null;
  const saved = Math.min(count, MEMBER_WATCHLIST_LIMIT);
  return {
    openTitle: search ? tf("Open {title} members matching \"{query}\" in", { title: list.title, query: search.query })
      : tf("Open {title} members in", { title: list.title }),
    saveBody: count > MEMBER_WATCHLIST_LIMIT
      ? search ? tf("The first {count} of the {matching} members matching \"{query}\", as listed.", { count: saved, matching: count, query: search.query })
        : tf("The first {count} of {total} members, as listed.", { count: saved, total: count })
      : search ? tf("{count} of {total} members match \"{query}\".", { count, total: search.total, query: search.query })
      : tf("All {count} members.", { count }),
  };
}

/** The requested name, numbered when a watchlist already has that name or id. */
export function uniqueWatchlistName(requested: string, watchlists: readonly { id: string; name: string }[]): string {
  const base = requested.trim();
  const taken = (name: string) => watchlists.some((list) =>
    list.name.toLowerCase() === name.toLowerCase() || list.id === slugifyName(name, "watchlist"));
  let name = base;
  for (let suffix = 2; taken(name); suffix += 1) name = `${base} ${suffix}`;
  return name;
}

/**
 * Tickers to create on the watchlist and existing ones to add to it, first
 * `MEMBER_WATCHLIST_LIMIT` members as listed. A saved record of the same
 * symbol on another venue (CCJ on Xetra) stays as it is: the member's listing
 * gets its own `SYMBOL:EXCHANGE` record, the way search opens a second listing.
 */
export function planMemberWatchlist(
  tickers: ReadonlyMap<string, TickerRecord>,
  watchlistId: string,
  members: readonly MemberListing[],
): { create: TickerMetadata[]; update: TickerRecord[]; count: number } {
  const seen = new Set<string>();
  const create: TickerMetadata[] = [];
  const update: TickerRecord[] = [];
  for (const member of members) {
    const symbol = member.symbol.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    if (seen.size >= MEMBER_WATCHLIST_LIMIT) break;
    seen.add(symbol);
    const exchange = member.exchange?.trim() ?? "";
    let key = symbol;
    let existing = tickers.get(symbol);
    if (existing && exchange && existing.metadata.exchange
      && canonicalExchange(existing.metadata.exchange) !== canonicalExchange(exchange)) {
      key = publicTickerKey(symbol, exchange);
      existing = tickers.get(key);
    }
    if (existing) {
      if (!existing.metadata.watchlists.includes(watchlistId)) {
        update.push({ ...existing, metadata: { ...existing.metadata, watchlists: [...existing.metadata.watchlists, watchlistId] } });
      }
      continue;
    }
    // Theme and fund members are US listings quoted in dollars. The sector is
    // left to the ticker's profile, so a list never mixes two sector schemes.
    create.push({ ticker: key, name: member.name || symbol, exchange, currency: "USD",
      portfolios: [], watchlists: [watchlistId], positions: [], custom: {}, tags: [] });
  }
  return { create, update, count: seen.size };
}

/**
 * Pane menu entries for a list of members (a theme's, a fund's): open them in
 * RRG, CORR, SIW or RIPL, or save them as a watchlist. Functions of disabled
 * plugins are left out; each destination gets as many as it takes.
 */
export function useMembersMenu(registrationId: string, list: MemberList | null) {
  const dialog = useOptionalDialog();
  const { createPaneFromTemplate, notify } = usePluginAppActions();
  const dispatch = useAppDispatch();
  const getState = useAppGetState();
  const disabledPlugins = useAppSelector((state) => state.config.disabledPlugins);
  usePaneMenuItems(registrationId, () => {
    const registry = getSharedRegistry();
    const symbols = list ? memberSymbols(list.members) : [];
    if (!list || !symbols.length || !dialog || !registry) return null;
    const destinations = MEMBER_DESTINATIONS.filter((destination) => {
      const owner = registry.getPaneTemplatePluginId?.(destination.templateId);
      return registry.paneTemplates.has(destination.templateId) && (!owner || !disabledPlugins.includes(owner));
    });
    const choices = memberDestinationChoices(symbols, destinations);
    const text = memberListText(list, symbols.length);
    const openIn = () => {
      void dialog.prompt<string>({
        closeOnClickOutside: true,
        content: (context: PromptContext<string>) => <ChoiceDialog {...context} title={text.openTitle}
          choices={choices.map(({ id, label, description, detail, disabled }) => ({ id, label: t(label), description, detail, disabled }))} />,
      }).then((templateId) => {
        const choice = choices.find((item) => item.id === templateId && !item.disabled);
        // CORR and RIPL resolve `arg` like the command bar; RRG and SIW read `symbols`.
        if (choice) createPaneFromTemplate(choice.id, { symbols: choice.symbols, arg: formatTickerListInput(choice.symbols) });
      }).catch(() => {});
    };
    const saveAsWatchlist = async (requested: string) => {
      // The writes hold the app for about a second with a hundred names; let the dialog close on screen first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const name = uniqueWatchlistName(requested, getState().config.watchlists);
      await createFormCollectionActions({ dataProvider: registry.marketData, dispatch, getState, pluginRegistry: registry,
        tickerRepository: registry.tickerRepository }, (body, options) => {
        if (options?.type === "error") notify({ body, type: "error" });
      }).createWatchlist(name);
      const watchlist = getState().config.watchlists.find((entry) => entry.name === name);
      if (!watchlist) throw new Error(t("The watchlist was not created."));
      const plan = planMemberWatchlist(getState().tickers, watchlist.id, list.members);
      // One ticker that fails to save leaves the others on the list; the toast says how many made it.
      let failed = 0;
      const created: TickerRecord[] = [];
      const saved: TickerRecord[] = [];
      for (const metadata of plan.create) {
        try {
          const ticker = await registry.tickerRepository.createTicker(metadata);
          created.push(ticker);
          saved.push(ticker);
        } catch {
          failed += 1;
        }
      }
      for (const ticker of plan.update) {
        try {
          await registry.tickerRepository.saveTicker(ticker);
          saved.push(ticker);
        } catch {
          failed += 1;
        }
      }
      // One state update for the whole list: an update per ticker redraws every pane a hundred times.
      if (saved.length) {
        const tickers = new Map(getState().tickers);
        for (const ticker of saved) tickers.set(ticker.metadata.ticker, ticker);
        dispatch({ type: "SET_TICKERS", tickers });
      }
      for (const ticker of created) registry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
      notify(failed
        ? { type: "error", body: tf("Saved {saved} of {count} members to {name}. {failed} could not be added.", { saved: plan.count - failed, count: plan.count, name, failed }) }
        : { type: "success", body: tf("Saved {count} members to {name}.", { count: plan.count, name }) });
    };
    return [
      ...(choices.length ? [{ id: "members-open-in", label: t("Open Members In…"), onSelect: openIn }] : []),
      { id: "members-save-watchlist", label: t("Save as Watchlist…"), onSelect: () => {
        // 54 columns fill the dialog; the prompt's default field is wider and runs past its frame.
        void dialog.prompt<string>({
          closeOnClickOutside: true,
          content: (context: PromptContext<string>) => <TextPromptDialog {...context} title={t("Save as Watchlist")}
            body={[text.saveBody]} label={t("Name")} initialValue={list.watchlistName} confirmLabel={t("Save")} width={54} />,
        }).then((name) => {
          if (!name?.trim()) return;
          saveAsWatchlist(name).catch((error: unknown) => {
            notify({ type: "error", body: error instanceof Error ? error.message : t("The watchlist was not saved.") });
          });
        }).catch(() => {});
      } },
    ];
  }, [createPaneFromTemplate, dialog, disabledPlugins, dispatch, getState, list, notify]);
}
