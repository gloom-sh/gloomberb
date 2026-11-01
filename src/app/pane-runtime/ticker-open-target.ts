import type { Dispatch } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction } from "../../state/app/context";
import type { TickerRecord } from "../../types/ticker";
import type { TickerOpenTarget } from "../../tickers/open-target";
import { AmbiguousTickerError } from "../../tickers/search";
import { isDialogOpen } from "../../ui/dialog-stack";
import { SECURITY_DESCRIPTION_SEARCH } from "../../core/state/app/command-bar-launch";

/**
 * A resolved open joins the app's tickers: the store takes the record when it
 * is not the one it holds, and a ticker new to the app is announced once.
 * Every open, from the command bar, a link or a pane, publishes it this way.
 */
export function publishTickerOpenTarget(target: TickerOpenTarget, { tickers, dispatch, events }: {
  tickers: ReadonlyMap<string, TickerRecord>;
  dispatch: Dispatch<AppAction>;
  events: Pick<PluginRegistry["events"], "emit">;
}): void {
  if (tickers.get(target.symbol) !== target.ticker) {
    dispatch({ type: "UPDATE_TICKER", ticker: target.ticker });
  }
  if (target.created) {
    events.emit("ticker:added", { symbol: target.symbol, ticker: target.ticker });
  }
}

/**
 * An open whose symbol names several listings offers them in ticker search, unless a dialog would
 * sit over the bar. The pick opens the listing, as the open would have, rather than changing the
 * focused pane's ticker.
 */
export function offerTickerListings(error: unknown, rawSymbol: string, dispatch: Dispatch<AppAction>): void {
  if (!(error instanceof AmbiguousTickerError) || isDialogOpen()) return;
  dispatch({
    type: "SET_COMMAND_BAR",
    open: true,
    query: rawSymbol,
    launch: { kind: "ticker-search", query: rawSymbol, payload: SECURITY_DESCRIPTION_SEARCH },
  });
}
