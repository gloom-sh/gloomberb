import { describe, expect, test } from "bun:test";

import * as capabilities from "../capabilities";
import * as components from "../components";
import * as theme from "../theme/colors";
import * as ui from "../ui";
import * as pluginReact from "./react";
import * as testSupport from "./test-support";
import * as utils from "./utils";

/**
 * The public plugin API is a compatibility boundary: plugins in other
 * repositories (gloom-sh/gloomberb-substack, -ibkr, -hackernews, and any
 * community plugin) import these subpaths, and a rename here breaks them
 * silently at their next install rather than in this repo's CI.
 *
 * Adding an export is deliberate — update the list below in the same commit.
 * Removing or renaming one is a breaking change for every installed plugin and
 * needs a major version plus a migration note in PLUGINS.md.
 */
const PUBLIC_API: Record<string, readonly string[]> = {
  "ui": [
    "AsciiText",
    "Box",
    "ChartSurface",
    "ContextMenuProvider",
    "ImageSurface",
    "Input",
    "MediaSurface",
    "RGBA",
    "ScrollBox",
    "Span",
    "SpinnerMark",
    "Strong",
    "StyledText",
    "Text",
    "TextAttributes",
    "Textarea",
    "UiHostProvider",
    "Underline",
    "compactContextMenuItems",
    "contextMenuDivider",
    "editableTextContextMenuItems",
    "linkContextMenuItems",
    "tickerContextMenuItems",
    "useCommandBarShortcut",
    "useContextMenu",
    "useNativeRenderer",
    "useRendererHost",
    "useSyntaxStyleFactory",
    "useTickerContextMenu",
    "useUiCapabilities",
    "useUiHost",
  ],
  "components": [
    "Button",
    "Checkbox",
    "ChoiceDialog",
    "ConfirmDialog",
    "DataTableStackView",
    "DataTableView",
    "EmptyState",
    "FeedDataTableStackView",
    "InputSearchBar",
    "MessageComposer",
    "MetricTreemapSurface",
    "NumberField",
    "PaneFooterScope",
    "PaneSidebar",
    "PaneSidebarAction",
    "PaneSidebarRow",
    "PaneStatusBody",
    "PriceSelectorDialog",
    "RemoteImage",
    "SegmentedControl",
    "SelectButton",
    "SpeedometerGauge",
    "Spinner",
    "StaticChartSurface",
    "Tabs",
    "TextField",
    "TickerBadgeList",
    "TickerBadgeText",
    "TickerListTableView",
    "activeStackIndex",
    "buildMetricTreemapNavigationTiles",
    "findMetricTreemapNeighbor",
    "getMessageComposerBlockHeight",
    "getPaneSidebarWidth",
    "isTableScrollNearEnd",
    "loadingText",
    "shouldShowPaneSidebar",
    "sortStackItems",
    "unavailableText",
    "useExternalLinkFooter",
    "usePaneFooter",
    "usePaneTicker",
    "useTableLoadMore",
  ],
  "theme": [
    "applyTheme",
    "blendHex",
    "clearTransientThemePreview",
    "colors",
    "commandBarAccentText",
    "commandBarBadgeText",
    "commandBarBg",
    "commandBarHeadingText",
    "commandBarHoverBg",
    "commandBarInputBg",
    "commandBarMatchText",
    "commandBarPanelBg",
    "commandBarSelectedBg",
    "commandBarSelectedText",
    "commandBarSubtleText",
    "commandBarText",
    "floatingPaneBg",
    "floatingPaneTitleBg",
    "getChartIndicatorColor",
    "getCurrentThemeId",
    "getThemeColors",
    "hoverBg",
    "paneBg",
    "paneTitleBg",
    "paneTitleText",
    "previewTheme",
    "priceColor",
    "syncTheme",
  ],
  "capabilities": [
    "AI_RUNNER_CAPABILITY_ID",
    "BROKER_CAPABILITY_ID",
    "CHART_SERIES_CAPABILITY_KIND",
    "CapabilityRegistry",
    "MAX_CHART_SERIES_CATALOG_ITEMS",
    "MAX_CHART_SERIES_POINTS",
    "NOTES_FILES_CAPABILITY_ID",
    "assetDataProvider",
    "chartSeriesCapabilityManifests",
    "chartSeriesCatalogOutputSchema",
    "chartSeriesCatalogRequestSchema",
    "chartSeriesProvider",
    "chartSeriesResolveOutputSchema",
    "chartSeriesResolveRequestSchema",
    "chartSeriesSourceKey",
    "createChartSeriesResolver",
    "isValidChartCapabilityId",
    "isValidChartSeriesId",
    "newsProvider",
    "recordSchema",
    "searchChartSeriesCapabilities",
  ],
  "utils": [
    "buildBrokerPortfolioId",
    "canonicalExchange",
    "canonicalTickerKey",
    "createBrokerInstanceId",
    "createThrottledFetch",
    "debugLog",
    "decodeHtmlEntities",
    "displayWidth",
    "fnv1aHashString",
    "formatCompact",
    "formatCompactCurrency",
    "formatCurrency",
    "formatGrowthShort",
    "formatNumber",
    "formatPercent",
    "formatPercentRaw",
    "formatRelativeAge",
    "formatTimeAgo",
    "formatWithDivisor",
    "getBrokerInstance",
    "getBrokerInstancesByType",
    "hasLikelyQuoteUnitMismatch",
    "httpFetch",
    "isBrokerPortfolioId",
    "isPlainKey",
    "isPlainKeyboardEvent",
    "normalizePriceValueByDivisor",
    "normalizeSymbol",
    "normalizedHttpUrl",
    "padTo",
    "parsePublicTickerKey",
    "pickUnit",
    "publicExchange",
    "publicTickerKey",
    "resolveCurrencyUnit",
    "resolveExchangeSubUnitCurrencyUnit",
    "resolveExchangeTimeZone",
    "resolvePriceHistoryCurrencyUnit",
    "setHttpFetchTransport",
    "splitLongTextSegmentByDisplayWidth",
    "truncateToDisplayWidth",
    "truncateWithEllipsis",
    "wrapTextLines",
  ],

  "react": [
    "AppContext",
    "DEFAULT_MAX_READ_IDS",
    "PaneInstanceProvider",
    "deletePluginPaneStateValue",
    "getPluginPaneStateValue",
    "markPersistedReadId",
    "normalizePersistedReadIdState",
    "setPluginPaneStateValue",
    "useAppConfig",
    "useAppDispatch",
    "useAppSelector",
    "useAssetData",
    "useBrokerAccounts",
    "useCapabilityInvoker",
    "useConnectionHealth",
    "useDebouncedPluginPaneState",
    "useInlineTickerOpener",
    "useInlineTickers",
    "useInputCapture",
    "useMarketData",
    "usePaneCollection",
    "usePaneInstanceId",
    "usePaneTicker",
    "usePersistedReadIds",
    "usePluginAppActions",
    "usePluginBrokerActions",
    "usePluginConfigState",
    "usePluginPaneActions",
    "usePluginPaneState",
    "usePluginState",
    "usePluginTickerActions",
    "useSetPluginConfigStates",
    "useShortcut",
    "useTickers",
  ],



  "test-support": [
    "AppContext",
    "AppPersistence",
    "MemoryPluginPersistence",
    "PaneInstanceProvider",
    "TestDialogProvider",
    "clearPersistedBrokerAccounts",
    "createInitialState",
    "getBrokerAccountCacheSourceKey",
    "loadPersistedBrokerAccountMap",
    "loadPersistedBrokerAccounts",
    "persistBrokerAccounts",
    "testRender",
  ],

};

const MODULES: Record<string, Record<string, unknown>> = {
  ui,
  components,
  theme,
  capabilities,
  utils,
  react: pluginReact,
  "test-support": testSupport,
};

describe("public plugin API", () => {
  for (const [name, expected] of Object.entries(PUBLIC_API)) {
    test(`gloomberb/${name} exports exactly its documented surface`, () => {
      const actual = Object.keys(MODULES[name]!)
        .filter((key) => key !== "default")
        .sort();
      expect(actual).toEqual([...expected]);
    });
  }

  test("every exports subpath in package.json resolves", async () => {
    const pkg = JSON.parse(await Bun.file(new URL("../../package.json", import.meta.url)).text());
    const subpaths = Object.entries(pkg.exports as Record<string, string>);
    expect(subpaths.length).toBeGreaterThan(0);
    for (const [subpath, target] of subpaths) {
      if (subpath === "./package.json") continue;
      const file = Bun.file(new URL(`../../${target.replace(/^\.\//, "")}`, import.meta.url));
      expect(await file.exists(), `${subpath} -> ${target}`).toBe(true);
    }
  });
});
