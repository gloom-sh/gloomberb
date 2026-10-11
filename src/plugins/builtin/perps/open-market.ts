import { useCallback } from "react";
import type { PerpBoardRow } from "../../../api-client/perps";
import { tf } from "../../../i18n";
import { usePluginAppActions } from "../../../public/react";
import { venueLabel } from "./model";

/** Opens PERP on one market: where a stock's perpetual links from DES, QQ and the watchlist and portfolio columns. */
export function useOpenPerpMarket(): (marketId: string) => void {
  const { createPaneFromTemplate } = usePluginAppActions();
  return useCallback((marketId: string) => createPaneFromTemplate("perps-pane", { arg: marketId }), [createPaneFromTemplate]);
}

/** The pane menu's entry for a link to one market. */
export const openPerpLabel = (row: Pick<PerpBoardRow, "baseAsset" | "venue">) =>
  tf("Open {label}", { label: `PERP ${row.baseAsset} · ${venueLabel(row)}` });
