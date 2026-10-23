import type { PluginModule } from "../plugin-module";
import { SHORT_INTEREST_SERIES } from "./series";
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
import { withCommandTab } from "../shared/command-tab";
import { followsWithoutFinraOverride, shortVolumeSettings } from "../short-volume";
import { shortVolumeHeadless } from "../short-volume/headless";
import { publicationCache } from "./publications-client";
import { publicationHeadless } from "./publications-headless";
import { isKnownNonUsListing } from "../../../utils/sec";


let disposeConnection: (() => void) | null = null;

export const shortInterestModule: PluginModule = {
  series: SHORT_INTEREST_SERIES,
  setup(ctx) {
    publicationCache.attach(ctx.persistence);
    attachShortInterestHealth(ctx.connectionHealth);
    disposeConnection = ctx.connectionHealth.registerSource({
      id: SHORT_INTEREST_CONNECTION_ID,
      name: "Gloom Short Interest",
      kind: "api",
      ownerId: "ownership",
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
    publicationCache.reset();
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
      ...withCommandTab(createTickerSurfacePaneTemplate({
        id: "short-interest-pane",
        paneId: "short-interest",
        label: "Short Interest",
        // The current snapshot only carries the current and prior settlement dates.
        description: "Bi-monthly short interest settlements from FINRA with days to cover and average daily volume. Daily volume is the other tab.",
        keywords: ["short", "interest", "si", "shorts", "days", "cover"],
        shortcut: "SI",
      }), "interest"),
      headless: shortInterestHeadless,
    },
    {
      // The same pane on Daily volume. The template id stays, so an older share still restores.
      ...withCommandTab(createTickerSurfacePaneTemplate({
        id: "short-volume-pane",
        paneId: "short-interest",
        label: "Daily Short Volume",
        description: "The short interest pane on Daily volume: FINRA daily off-exchange short-volume ratios, historical percentile and reported share quantities.",
        keywords: ["daily", "short", "volume", "finra", "siv"],
        shortcut: "SIV",
        publicShare: true,
      }), "volume"),
      headless: shortVolumeHeadless,
    },
    {
      ...withCommandTab(createTickerSurfacePaneTemplate({
        id: "fails-to-deliver-pane", paneId: "short-interest", label: "Fails to Deliver",
        description: "The short interest pane on Fails to deliver: outstanding fail shares by settlement date and CUSIP from SEC publications.",
        keywords: ["fails to deliver", "fails-to-deliver", "ftd", "settlement", "failures", "sec"],
        shortcut: "FTD", publicShare: true,
      }), "ftd"),
      headless: publicationHeadless("ftd"),
    },
    {
      ...withCommandTab(createTickerSurfacePaneTemplate({
        id: "otc-volume-pane", paneId: "short-interest", label: "Weekly ATS / OTC Volume",
        description: "The short interest pane on Weekly ATS/OTC: FINRA weekly ATS and non-ATS shares and trades, including dark-pool volume.",
        keywords: ["dark pool", "dark pools", "ats", "non-ats", "otc", "off-exchange", "weekly", "volume", "finra"],
        shortcut: "ATS", publicShare: true,
      }), "ats"),
      headless: publicationHeadless("ats"),
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
