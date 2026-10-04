import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachShortInterestHealth,
  resetShortInterestHealth,
  SHORT_INTEREST_CONNECTION_ID,
} from "./client";
import { shortInterestHeadless } from "./headless";
import { ShortInterestResearchTab, ShortInterestSurface } from "./surface";
import { shortWatchHeadless } from "./watch-headless";
import { SHORT_WATCH_SCOPE_OPTIONS, ShortWatchPane } from "./watch-pane";
import { followsWithoutFinraOverride, shortVolumeSettings } from "../short-volume";
import { isKnownNonUsListing } from "../../../utils/sec";


let disposeConnection: (() => void) | null = null;

export const shortInterestModule: PluginModule = {
  setup(ctx) {
    attachShortInterestHealth(ctx.connectionHealth);
    disposeConnection = ctx.connectionHealth.registerSource({
      id: SHORT_INTEREST_CONNECTION_ID,
      name: "Gloom Short Interest",
      kind: "api",
      ownerId: "ticker-research",
      detail: "api.gloom.sh",
      priority: 300,
    });

    ctx.registerTickerResearchTab({
      id: "short-interest",
      name: "Short Interest",
      order: 36,
      component: ShortInterestResearchTab,
      instruments: ["equity"],
      isVisible: ({ ticker }) => !isKnownNonUsListing(ticker),
    });
  },

  dispose() {
    disposeConnection?.();
    disposeConnection = null;
    resetShortInterestHealth();
  },

  panes: [
    {
      id: "short-interest",
      name: "Short Interest",
      icon: "S",
      component: ShortInterestSurface,
      defaultPosition: "right",
      tickerFollower: followsWithoutFinraOverride,
      defaultMode: "floating",
      defaultFloatingSize: { width: 90, height: 25 },
      tableExport: true,
      settings: { title: "Short Interest", fields: shortVolumeSettings },
    },
    {
      id: "short-watch",
      name: "Short Squeeze Watch",
      icon: "S",
      component: ShortWatchPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 92, height: 28 },
      tableExport: true,
      headless: shortWatchHeadless,
      settings: { title: "Short Squeeze Watch", fields: [
        { key: "scope", label: "Names", type: "select", options: [...SHORT_WATCH_SCOPE_OPTIONS] },
        { key: "symbols", label: "Custom symbols", type: "text", placeholder: "GME, AMC, CVNA" },
      ] },
    },
  ],

  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "short-interest-pane",
        paneId: "short-interest",
        label: "Short Interest",
        // The current snapshot only carries the current and prior settlement dates.
        description: "Bi-monthly short interest settlements from FINRA with days to cover and average daily volume.",
        keywords: ["short", "interest", "si", "shorts", "borrow", "days", "cover"],
        shortcut: "SI",
      }),
      headless: shortInterestHeadless,
    },
    {
      id: "short-watch-pane",
      paneId: "short-watch",
      label: "Short Squeeze Watch",
      description: "Short interest as a share of float, days to cover, the change since the prior settlement and the month's price move across your names.",
      keywords: ["siw", "short", "squeeze", "crowded", "float", "days to cover", "watchlist", "portfolio"],
      shortcut: { prefix: "SIW", argKind: "ticker-list" as const, argOptional: true },
      headless: shortWatchHeadless,
      createInstance: (_context, options) => ({
        title: "Short Squeeze Watch",
        placement: "floating" as const,
        settings: options?.symbols?.length ? { scope: "custom", symbols: options.symbols.join(",") } : { scope: "mine" },
      }),
    },
  ],
};
