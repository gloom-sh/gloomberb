import type { ReactNode } from "react";
import { tf } from "../../../i18n";
import { useQuoteEntry } from "../../../market-data/hooks";
import { resolveEntryData } from "../../../market-data/selectors";
import { getSharedRegistry } from "../../../plugins/registry/shared";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { knownInstrumentOfTicker, uncoveredInstrumentKind, uncoveredInstrumentMessage, type InstrumentOfKind } from "../../../tickers/instrument-coverage";
import { classifyInstrumentType } from "../../../tickers/instrument-kind";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { Button } from "../../ui/button";
import { PaneStatusBody } from "../../ui/status";

/**
 * What the pane's ticker is, as `fn` reads it (`listingInstrument`): an index,
 * pair, future or coin by its symbol, a fund by its saved type, anything else
 * by its quote's. Null until something says.
 */
function usePaneInstrument(symbol: string | null, ticker: TickerRecord | null): InstrumentOfKind | null {
  const known = symbol ? knownInstrumentOfTicker(symbol, ticker) : null;
  // Only a symbol nothing else names asks for its quote.
  const quote = resolveEntryData(useQuoteEntry(symbol && !known ? symbol : null, ticker));
  if (!symbol || known) return known;
  const kind = classifyInstrumentType(quote?.instrumentType);
  return kind ? { symbol, kind, type: quote?.instrumentType } : null;
}

/** The pane as its function is typed: its one code (HIRE), else its name. */
function paneFunctionName(pane: PaneDef): string {
  const codes = [...(getSharedRegistry()?.paneTemplates.values() ?? [])]
    .filter((template) => template.paneId === pane.id && template.shortcut?.prefix)
    .map((template) => template.shortcut!.prefix);
  return codes.length === 1 ? codes[0]! : pane.name;
}

/**
 * A pane with data for some instruments only (`PaneDef.instruments`, company
 * filings and hiring) bound to a ticker it has none for, an index or an ETF,
 * says what the ticker is and offers to open it, as `fn` answers, in place of
 * its source's error or an empty capture. Any other ticker renders the pane.
 */
export function InstrumentCoverageGate({ pane, children }: { pane: PaneDef; children: ReactNode }) {
  const { symbol, ticker } = usePaneTickerIdentity();
  const instrument = usePaneInstrument(symbol, ticker);
  const covered = pane.instruments ?? [];
  if (!instrument || !uncoveredInstrumentKind(covered, instrument.kind)) return children;
  // The ticker's own research, beside this pane: retargeting this pane would only ask it again.
  const open = () => getSharedRegistry()?.pinTicker(instrument.symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  return (
    <PaneStatusBody
      empty
      emptyTitle={uncoveredInstrumentMessage(paneFunctionName(pane), covered, instrument)}
      actions={<Button label={tf("Open {ticker}", { ticker: instrument.symbol })} onPress={open} />}
    />
  );
}
