import type { AppState } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";
import { splitSymbolArgs, symbolInputKey, uniqueSymbols } from "../../../cli/symbol-args";
import {
  addSymbols,
  NO_MATCH,
  reason,
  summarizeSymbolRows,
  type SymbolRow,
} from "../../../cli/symbol-rows";
import type { DataProvider } from "../../../types/data-provider";
import { AmbiguousContractError, AmbiguousTickerError } from "../../../tickers/search";
import { captureAttentionAction } from "../../../telemetry/attention-counts";
import { publicTickerKey } from "../../../utils/exchanges";
import {
  getCollectionTargetOptions,
  resolvePreferredCollectionTarget,
  resolveSoleCollectionTarget,
  type SharedWorkflowDeps,
} from "../workflow/ops";
import { resolveCollectionTicker } from "../workflow/collection-ticker";
import { withCollectionMembership } from "../workflow/tickers";
import type { CommandBarRoute } from "../workflow/types";
import type { CollectionCommandId } from "../helpers";

type Notify = (body: string, options?: { type?: "info" | "success" | "error"; duration?: number }) => void;

/** Lists longer than this say the add has started, as a lookup of this many symbols takes a moment. */
const SLOW_LIST = 10;
/** How long the report of an add that left symbols out stays up, to be read and copied from. */
const SKIPPED_REPORT_MS = 12_000;

export interface PastedSymbolList {
  /** The symbols, as typed, without repeats. */
  symbols: string[];
  /** Repeats dropped from the text. */
  repeated: number;
  /** Whether the text separates its symbols with commas, semicolons, tabs or lines, rather than spaces alone. */
  separated: boolean;
}

/**
 * The symbols in text typed or pasted after `AW`, split as `gloomberb quote`
 * splits its arguments: on commas, semicolons, tabs and lines when it has
 * them, so an entry can be a company's name, else on spaces. Null for
 * one symbol or none, which keep the single add. Spaces alone also separate a
 * company's name (`Palo Alto Networks`), which is why `separated` says when
 * the text left no doubt it is a list.
 */
export function pastedSymbolList(raw: string | undefined): PastedSymbolList | null {
  if (!raw) return null;
  const list = uniqueSymbols(splitSymbolArgs([raw]));
  if (list.symbols.length < 2) return null;
  return { ...list, separated: /[,;\t\r\n]/.test(raw) };
}

/**
 * Whether the words are one company's name (`palo alto`, for Palo Alto
 * Networks) rather than symbols: some listing's name has every one of them.
 * PALO and ALTO are tickers too, so a name read as a list would add both.
 */
async function namesOneCompany(words: readonly string[], dataProvider: DataProvider): Promise<boolean> {
  const wanted = words.map((word) => word.toLowerCase());
  try {
    const results = await dataProvider.search(wanted.join(" "), { interactive: true });
    return results.some((result) => {
      const named = new Set((result.name ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u));
      return wanted.every((word) => named.has(word));
    });
  } catch {
    return false;
  }
}

/** An ambiguous symbol asks which listing is meant; a list has no room for the choice, so it is left for the single add. */
function ambiguityFailure(error: Error): Error {
  if (error instanceof AmbiguousContractError) return error;
  if (error instanceof AmbiguousTickerError) return new Error(`${error.query}: several listings, add it on its own to choose one.`);
  return error;
}

/** A line for a symbol that was not added and says why, or a coin ticker read as something else; null when the summary names it already. */
function reasonLine(row: SymbolRow): string | null {
  const typed = symbolInputKey(row.input);
  if (row.hint && row.status === "added") return row.hint;
  if (row.readAs && (row.status === "added" || row.status === "already_listed")) return row.readAs;
  if (row.status !== "failed" && !(row.status === "not_found" && row.message && !NO_MATCH.test(row.message))) return null;
  const text = reason(row.message ?? "", typed);
  return text.includes(typed) ? text : `${typed}: ${text}`;
}

/**
 * What a list add says, in the words the CLI's summary uses: the counts, the
 * symbols that found nothing or were not added, and under it the reason for
 * each that has one. Skipped symbols keep the report up longer.
 */
function describeListAdd(
  rows: readonly SymbolRow[],
  watchlistName: string,
  repeated: number,
): { body: string; type: "success" | "info" | "error"; duration?: number } {
  const summary = `Watchlist "${watchlistName}": ${summarizeSymbolRows(rows, "add", repeated)}`;
  const reasons = rows.map(reasonLine).filter((line): line is string => !!line);
  const added = rows.some((row) => row.status === "added");
  const unresolved = rows.some((row) => row.status === "not_found" || row.status === "failed");
  return {
    body: [summary, ...reasons].join("\n"),
    type: added && !unresolved ? "success" : unresolved && !added ? "error" : "info",
    duration: unresolved ? SKIPPED_REPORT_MS : undefined,
  };
}

/**
 * Adds every symbol of a pasted list to a watchlist in one step. Each symbol
 * resolves as `gloomberb watchlist add` resolves it (Gloom Cloud search and
 * quote, the venue its own quote is on), except that a symbol several listings
 * carry is never given the first: it is left out and named, for the single add
 * to ask which. One that is unknown or already listed does not stop the rest.
 * Resolves false when a list split by spaces alone may be a company's name
 * (`palo alto`) rather than symbols, and goes to search instead.
 */
export async function addPastedListToWatchlist(options: {
  commandId: CollectionCommandId;
  rawInput: string;
  list: PastedSymbolList;
  explicitTargetId?: string | null;
  activeCollectionId: string | null;
  getState: () => AppState;
  buildWorkflowDeps: () => SharedWorkflowDeps;
  pushRoute: (route: CommandBarRoute) => void;
  notify: Notify;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
}): Promise<boolean> {
  const { list, notify } = options;
  const deps = options.buildWorkflowDeps();
  // Spaces alone also separate the words of a name, which belongs to search.
  if (!list.separated && await namesOneCompany(list.symbols, deps.dataProvider)) return false;
  const state = options.getState();
  const known = options.explicitTargetId && state.config.watchlists.some((entry) => entry.id === options.explicitTargetId)
    ? options.explicitTargetId
    : null;
  const targetId = known
    ?? resolvePreferredCollectionTarget(state, "watchlist", options.activeCollectionId, "add", null)
    ?? resolveSoleCollectionTarget(state, "watchlist", "add", null);
  if (!targetId) {
    const targets = getCollectionTargetOptions(state, "watchlist", "add", null);
    if (targets.length === 0) {
      notify("No watchlists are available.", { type: "info" });
      return true;
    }
    options.pushRoute({
      kind: "picker",
      pickerId: "collection-target",
      title: `Add ${list.symbols.length} tickers to Watchlist`,
      query: "",
      selectedIdx: 0,
      hoveredIdx: null,
      options: targets.map((option) => ({
        id: option.id,
        label: option.label,
        detail: option.description,
        description: option.description,
      })),
      // The list rides along as typed, and is split again once a watchlist is chosen.
      payload: { commandId: options.commandId, kind: "watchlist", action: "add", symbol: options.rawInput },
    });
    return true;
  }

  const watchlistName = state.config.watchlists.find((entry) => entry.id === targetId)?.name ?? targetId;
  if (list.symbols.length > SLOW_LIST) notify(`Adding ${list.symbols.length} tickers to "${watchlistName}"...`, { type: "info" });

  const recordAttention = captureAttentionAction();
  const before = new Map(deps.getState().tickers);
  const saved: TickerRecord[] = [];
  // The command's changes are written once at the end, each as the single add writes it.
  const store = {
    loadTicker: (symbol: string) => deps.tickerRepository.loadTicker(symbol),
    loadAllTickers: () => deps.tickerRepository.loadAllTickers(),
    saveTicker: async (ticker: TickerRecord) => {
      await deps.tickerRepository.saveTicker(ticker);
      deps.dispatch({ type: "UPDATE_TICKER", ticker });
      saved.push(ticker);
    },
  };
  const rows = await addSymbols({
    symbols: list.symbols,
    exchange: undefined,
    store,
    dataProvider: deps.dataProvider,
    askWhenAmbiguous: true,
    failure: ambiguityFailure,
    onRetry: (count, waitMs) => notify(
      `Gloom Cloud refused some requests; looking ${count} symbol${count === 1 ? "" : "s"} up again in ${Math.round(waitMs / 1000)} s.`,
      { type: "info" },
    ),
    // A saved alias of a holding is the holding's own record, as for the single add.
    add: (ticker) => withCollectionMembership(resolveCollectionTicker(ticker, deps.getState().tickers, "watchlist", targetId), "watchlist", "add", targetId),
  });

  for (const ticker of saved) {
    const previous = before.get(ticker.metadata.ticker);
    if (!previous) deps.pluginRegistry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
    if (ticker.metadata.watchlists.includes(targetId) && !previous?.metadata.watchlists.includes(targetId)) {
      recordAttention(publicTickerKey(ticker.metadata.ticker, ticker.metadata.exchange), "watchlist_add");
    }
  }
  const report = describeListAdd(rows, watchlistName, list.repeated);
  notify(report.body, { type: report.type, duration: report.duration });
  options.closeAll({ revertThemePreview: false });
  return true;
}
