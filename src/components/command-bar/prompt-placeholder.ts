import { resolveInstrumentForPane } from "../../core/state/app/instrument";
import type { AppState } from "../../state/app/context";
import { t } from "../../i18n";
import { LINKED_TICKER_MARK, selectedLayoutTicker } from "../../layout/selected-ticker";
import { tickerInstrumentLabel } from "../../tickers/instrument-label";

/**
 * The layout's selected instrument, in the same words a pane title uses.
 * A linked group wears the link mark and stays visible when the focused pane
 * has no ticker of its own.
 */
export function activeCommandInstrumentLabel(state: AppState): string | null {
  const selection = selectedLayoutTicker(state);
  if (!selection) return null;
  const label = tickerInstrumentLabel(
    selection.symbol,
    resolveInstrumentForPane(state, selection.rootInstanceId)?.instrument,
  );
  return selection.memberCount >= 2 ? `${LINKED_TICKER_MARK} ${label}` : label;
}

/** Root prompt text. A selected instrument stands in for the search hint. */
export function rootCommandPlaceholder(instrumentLabel: string | null): string {
  return instrumentLabel ?? t("Search or run a command");
}
