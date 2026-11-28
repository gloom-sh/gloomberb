import { usePaneMenuItems } from "../../../../components";
import { t } from "../../../../i18n";
import type { Portfolio, Watchlist } from "../../../../types/ticker";
import { getSharedRegistry } from "../../../registry";
import { usePluginAppActions } from "../../../runtime";
import { COLLECTION_SETTING, collectionScope } from "../../earnings/scope";

/** ERN, which opens the earnings board without tickers. */
const EARNINGS_CALENDAR_TEMPLATE = "earnings-calendar-pane";

/**
 * "Earnings Calendar" in the pane menu: the earnings board in a window of its own, its Names filter on the list on
 * screen, by id. Only for a list with tickers, once setup is done, and while Earnings is on; never in the empty
 * state or a row's menu. The board reads the list's names on this device, so no ticker goes into its settings.
 */
export function useCollectionEarningsMenu({ portfolio, watchlist, tickerCount, setupDone, disabledPlugins }: {
  portfolio: Portfolio | null;
  watchlist: Watchlist | null;
  tickerCount: number;
  setupDone: boolean;
  disabledPlugins: readonly string[];
}): void {
  const { createPaneFromTemplate } = usePluginAppActions();
  const list = portfolio ? collectionScope("portfolio", portfolio.id)
    : watchlist ? collectionScope("watchlist", watchlist.id) : null;
  usePaneMenuItems("portfolio-list-earnings", () => {
    const registry = getSharedRegistry();
    if (!list || tickerCount === 0 || !setupDone || !registry?.paneTemplates.has(EARNINGS_CALENDAR_TEMPLATE)
      || registry.getDisabledPaneTemplateOwner(EARNINGS_CALENDAR_TEMPLATE, disabledPlugins)) return null;
    return [{
      id: "earnings-calendar",
      label: t("Earnings Calendar"),
      onSelect: () => createPaneFromTemplate(EARNINGS_CALENDAR_TEMPLATE, { preset: { [COLLECTION_SETTING]: list } }),
    }];
  }, [createPaneFromTemplate, disabledPlugins, list, setupDone, tickerCount]);
}
