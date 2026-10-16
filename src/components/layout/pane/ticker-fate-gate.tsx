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

const NO_PANES: ReadonlyMap<string, PaneDef> = new Map();

/**
 * A pane that shows one ticker (`PaneDef.tickerFollower`, Ticker Research)
 * renders only once its symbol is known to have data of its own. A symbol
 * whose company moved, with nothing new listed under it (HFC became DINO),
 * has none: whatever comes back under it is another security's, so the pane
 * is never mounted, asks for nothing, and says where the company went with
 * the app's open-ticker action. Every other pane, and every ticker that
 * trades, renders as it always has.
 */
export function PaneTickerFateGate({ paneId, children }: { paneId: string; children: ReactNode }) {
  const instance = usePaneInstance();
  const scoped = !!instance && isTickerLinkPeer(instance, getSharedRegistry()?.panes ?? NO_PANES);
  return scoped ? <TickerFateGate paneId={paneId}>{children}</TickerFateGate> : children;
}

function TickerFateGate({ paneId, children }: { paneId: string; children: ReactNode }) {
  const { symbol, ticker, contract } = usePaneTickerIdentity();
  // Only a plain listing: a broker's contract, or a symbol whose contract is still to choose, is not one.
  const plain = contract === null;
  const gate = useListingFateGate(plain ? symbol : null, plain ? ticker : null);
  if (gate.kind === "serve") return children;
  if (gate.kind === "wait") return <PaneStatusBody loading />;
  return <MovedTickerState change={gate.change} paneId={paneId} />;
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
