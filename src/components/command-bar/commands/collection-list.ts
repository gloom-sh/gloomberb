import type { AppState } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";
import { splitSymbolArgs, splitSymbolWords, symbolInputKey, uniqueSymbols } from "../../../cli/symbol-args";
import { protectFigureCommas } from "../../../cli/symbol-cells";
import { readSymbolList } from "../../../cli/symbol-list";
import { readNameEntries } from "../../../cli/name-entries";
import {
  addSymbols,
  NO_MATCH,
  reason,
  summarizeSymbolRows,
  typedSymbolChoice,
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
 * The entries of text typed or pasted after `AW`, split as `gloom quote`
 * splits its arguments (`splitSymbolArgs`): on commas, semicolons, tabs and
 * lines when it has them, where an entry with spaces may be a company's name
 * or several symbols, else on spaces. A decimal comma (`2.582,52`) splits
 * nothing. Null for one word or none, which keep the single add. Spaces alone
 * also separate a company's name (`Palo Alto Networks`), which is why
 * `separated` says when the text left no doubt it is a list.
 */
export function pastedSymbolList(raw: string | undefined): PastedSymbolList | null {
  if (!raw || splitSymbolWords([raw]).length < 2) return null;
  return { ...uniqueSymbols(splitSymbolArgs([raw])), separated: /[,;\t\r\n]/.test(protectFigureCommas(raw)) };
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
  // Another company had the symbol: say which, beside the listing added.
  if (row.changeNote && row.status === "added") return row.changeNote;
  if (row.readAs && (row.status === "added" || row.status === "already_listed")) return row.readAs;
  // Why the match was left out, and the symbol it trades as now when there is one.
  if (row.status === "needs_choice") return row.message ?? typed;
  // Not a symbol, or not looked up: the summary names them, and the notice says what to do about the second.
  if (row.status !== "failed" && !(row.status === "not_found" && row.message && !NO_MATCH.test(row.message))) return null;
  const text = reason(row.message ?? "", typed);
  return text.includes(typed) ? text : `${typed}: ${text}`;
}

/** Rows that did not join the watchlist and say why, which keep the report up longer. */
const UNRESOLVED = new Set<SymbolRow["status"]>(["not_found", "needs_choice", "failed", "not_a_symbol", "not_looked_up"]);

/**
 * What a list add says, in the words the CLI's summary uses: the counts, the
 * symbols that found nothing or were not added, and under it the reason for
 * each that has one, what the reader left out (the prices beside the
 * symbols, in one line), and one line for the symbols Gloom Cloud did not
 * answer for. Skipped symbols keep the report up longer.
 */
function describeListAdd(
  rows: readonly SymbolRow[],
  watchlistName: string,
  repeated: number,
  notes: readonly string[] = [],
): { body: string; type: "success" | "info" | "error"; duration?: number } {
  const summary = `Watchlist "${watchlistName}": ${summarizeSymbolRows(rows, "add", repeated)}`;
  const reasons = rows.map(reasonLine).filter((line): line is string => !!line);
  const unanswered = rows.filter((row) => row.status === "not_looked_up").length;
  const added = rows.some((row) => row.status === "added");
  const unresolved = rows.some((row) => UNRESOLVED.has(row.status));
  return {
    body: [
      summary,
      ...reasons,
      ...notes,
      ...unanswered > 0 ? [`Gloom Cloud did not answer for ${unanswered === 1 ? "one symbol" : `${unanswered} symbols`}; add ${unanswered === 1 ? "it" : "them"} again in a minute.`] : [],
    ].join("\n"),
    type: added && !unresolved ? "success" : unresolved && !added ? "error" : "info",
    duration: unresolved ? SKIPPED_REPORT_MS : undefined,
  };
}

/**
 * A symbol typed to add on its own that a pasted list would leave for a
 * choice (`typedSymbolChoice`: its company moved or merged away, the match is
 * abroad or stopped trading) is not added either. The notice says why, and
 * what to add instead or to keep the match. Resolves true when it said so.
 */
export async function refuseTypedChoice(rawInput: string, deps: SharedWorkflowDeps, notify: Notify): Promise<boolean> {
  const row = await typedSymbolChoice(rawInput, deps.tickerRepository, deps.dataProvider);
  if (!row) return false;
  const message = row.message ?? symbolInputKey(row.input);
  const offers = [
    ...row.tradesAs ? [`${row.tradesAs} for what it trades as now`] : [],
    ...row.listing ? [`${row.listing} to keep the match`] : [],
  ];
  notify([/[.!?]$/.test(message) ? message : `${message}.`, ...offers.length > 0 ? [`Add ${offers.join(", or ")}.`] : []].join("\n"),
    { type: "error", duration: SKIPPED_REPORT_MS });
  return true;
}

/**
 * Adds every symbol of a pasted list to a watchlist in one step. Each symbol
 * resolves as `gloom watchlist add` resolves it (Gloom Cloud search and
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
  // Read as `watchlist add` reads a list: an entry with spaces is a company's name search finds, or the symbols it
  // holds, and a price beside a symbol (`ED 2.582,52`) is left out and named.
  const read = await readSymbolList({
    args: [options.rawInput], stdinPiped: false, readEntries: (entries) => readNameEntries(entries, deps.dataProvider),
  });
  const symbols = read.symbols;
  const repeated = read.repeated;
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
      title: `Add ${symbols.length} tickers to Watchlist`,
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
  if (symbols.length > SLOW_LIST) notify(`Adding ${symbols.length} tickers to "${watchlistName}"...`, { type: "info" });

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
    symbols,
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
  const report = describeListAdd(rows, watchlistName, repeated, read.notes);
  notify(report.body, { type: report.type, duration: report.duration });
  options.closeAll({ revertThemePreview: false });
  return true;
}
