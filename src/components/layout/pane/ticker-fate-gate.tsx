import type { ReactNode } from "react";
import { tf } from "../../../i18n";
import { isTickerLinkPeer } from "../../../layout/ticker-navigation";
import { useListingFateGate } from "../../../market-data/hooks";
import { getSharedRegistry } from "../../../plugins/registry/shared";
import { usePaneInstance } from "../../../state/app/context";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import type { MovedTickerChange } from "../../../tickers/ticker-changes";
import { Button } from "../../ui/button";
import { PaneStatusBody } from "../../ui/status";
import type { PaneDef } from "../../../types/plugin";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";

const NO_PANES: ReadonlyMap<string, PaneDef> = new Map();

/**
 * A pane that shows one ticker (`PaneDef.tickerFollower`, Ticker Research)
 * shows only its symbol's own data. A symbol whose company moved, with
 * nothing new listed under it (HFC became DINO), has none: whatever comes
 * back under it is another security's, so as soon as that is known the pane
 * gives way to where the company went, with the app's open-ticker action.
 * The pane opens and switches symbols as it always has, at once and without
 * being mounted again; it waits only while what is known says nothing trades
 * under the symbol (`useListingFateGate`). Every other pane renders as it
 * always has.
 */
export function PaneTickerFateGate({ paneId, children }: { paneId: string; children: ReactNode }) {
  const instance = usePaneInstance();
  const panes = getSharedRegistry()?.panes ?? NO_PANES;
  // Whether this kind of pane can show one ticker. A pane's kind does not change while it is open, so the tree
  // under it keeps its shape: a chart that gains a second security stops being gated without being mounted again.
  if (!instance || !(instance.paneId === TICKER_RESEARCH_PANE_ID || panes.get(instance.paneId)?.tickerFollower)) return children;
  return <TickerFateGate paneId={paneId} scoped={isTickerLinkPeer(instance, panes)}>{children}</TickerFateGate>;
}

function TickerFateGate({ paneId, scoped, children }: { paneId: string; scoped: boolean; children: ReactNode }) {
  const { symbol, ticker, contract } = usePaneTickerIdentity();
  // Only a plain listing: a broker's contract, or a symbol whose contract is still to choose, is not one.
  const plain = scoped && contract === null;
  const gate = useListingFateGate(plain ? symbol : null, plain ? ticker : null);
  if (gate.kind === "wait") return <PaneStatusBody loading />;
  if (gate.kind === "moved") return <MovedTickerState change={gate.change} paneId={paneId} />;
  return children;
}

/** "HFC became DINO on 2022-03-15." with the button that opens DINO, as a ticker link does. */
export function MovedTickerState({ change, paneId }: { change: MovedTickerChange; paneId: string }) {
  const open = () => getSharedRegistry()?.navigateTicker(change.tradesAs, { sourcePaneId: paneId });
  return (
    <PaneStatusBody
      empty
      emptyTitle={`${change.note}.`}
      actions={<Button label={tf("Open {symbol}", { symbol: change.tradesAs })} onPress={open} />}
    />
  );
}
