import { useCallback, useEffect, useMemo, useState } from "react";
import { formatActionChords, hasKeybindingCaptureRequest, subscribeKeybindingCapture, useKeybindings } from "../../../app/keybindings";
import { Notice, usePaneFooter, usePaneMenuItems, usePaneTabs, type PaneHint, type TableSection } from "../../../components";
import { t, tf } from "../../../i18n";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, useRendererHost, useUiHost } from "../../../ui";
import { detectShortcutPlatform, formatPrimaryShortcut, getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import { getSharedRegistry } from "../../registry";
import { apiClient, type CloudPricing } from "../../../api-client";
import { trialDaysOf } from "../../../account/billing";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import { requestFeedbackDialog } from "../../../components/feedback-dialog";
import { DOCS_PANE_TEMPLATE_ID } from "../../../docs/content";
import { FeedbackTab } from "./feedback-tab";
import { FunctionsTable } from "./functions-table";
import { KeybindingsEditor } from "./keybindings-editor";
import { ShortcutTable, type ShortcutTableEntry } from "./shortcut-table";
import { resolveCommandShortcuts, resolveWindowTemplates } from "./shortcut-model";
import { badgeColumnWidth } from "./table-cells";

const HELP_TABS = [
  { label: "Basics", value: "basics" },
  { label: "Functions", value: "functions" },
  { label: "Shortcuts", value: "shortcuts" },
  { label: "Reference", value: "reference" },
  // The value stays "issues" so panes saved on this tab still open on it.
  { label: "Feedback", value: "issues" },
] as const;

type HelpTabId = typeof HELP_TABS[number]["value"];
const GLOOMBERB_ISSUES_URL = "https://github.com/gloom-sh/gloomberb/issues";

function entry(id: string, badges: string[], description: string): ShortcutTableEntry {
  return { id, badges, description };
}

/**
 * Real functions on real tickers, one click each, for someone who has not
 * learned a code yet. Each row runs its text as if typed into the bar.
 */
const TRY_THESE = [
  { query: "DES AAPL", description: "Apple at a glance" },
  { query: "GP NVDA", description: "Nvidia's price chart" },
  { query: "FA MSFT", description: "Microsoft's financials" },
  { query: "CMP AAPL MSFT", description: "Apple and Microsoft side by side" },
  { query: "EE TSLA", description: "What analysts expect from Tesla" },
] as const;

/** The most of a table its key column takes, however many chips a row carries. */
const KEY_COLUMN_MAX_SHARE = 0.4;

function HelpPane({ focused, width, height }: PaneProps) {
  const registry = getSharedRegistry();
  const { openCommandBar, showPane, createPaneFromTemplate } = usePluginAppActions();
  // A key capture requested from the command bar belongs to the Shortcuts
  // tab, whether the pane is already open or is being opened for it.
  const [activeTabId, setActiveTabId] = usePluginPaneState<HelpTabId>("activeTab", "basics");
  useEffect(() => {
    if (hasKeybindingCaptureRequest()) setActiveTabId("shortcuts");
  }, []);
  const commandShortcuts = resolveCommandShortcuts(registry);
  const windowTemplates = resolveWindowTemplates(registry);
  // The codes this app has: the web, a plugin switched off or one never
  // installed leaves some out, and Basics only points at codes that run. A
  // string, so the rows built from it keep their identity between renders.
  const knownCodesKey = registry
    ? [...new Set([...commandShortcuts, ...windowTemplates].map((shortcut) => shortcut.badges[0] ?? ""))].sort().join(" ")
    : null;
  const uiHost = useUiHost();
  const shortcutPlatform = detectShortcutPlatform();
  const shortcutDisplayMode = getShortcutDisplayMode(uiHost.kind);
  const platformShortcut = (keys: string | readonly string[]) => formatPrimaryShortcut(keys, shortcutPlatform, shortcutDisplayMode);
  const keybindings = useKeybindings();
  const actionBadges = (actionId: string) => formatActionChords(keybindings, actionId, shortcutDisplayMode, shortcutPlatform);
  const commandBarBadges = actionBadges("command-bar");
  const tickerSearchBadges = actionBadges("ticker-search");
  const windowMoveBadges = actionBadges("window-move-mode");
  const windowResizeBadges = actionBadges("window-resize-mode");
  const functionHelpBadges = actionBadges("function-help");
  const askBadges = actionBadges("pane-ask");
  useEffect(() => subscribeKeybindingCapture(() => setActiveTabId("shortcuts")), []);
  const copyBadges = shortcutDisplayMode === "terminal" ? ["Ctrl+Shift+C"] : [platformShortcut("C")];
  const pasteBadges = shortcutDisplayMode === "terminal" ? ["Ctrl+Shift+V"] : [platformShortcut("V")];
  const [functionsSearching, setFunctionsSearching] = useState(false);
  // The UPGRADE line says how long the trial is; the length comes from /pricing.
  const [pricing, setPricing] = useState<CloudPricing | null>(null);
  useEffect(() => {
    if (activeTabId !== "reference" || pricing) return;
    let live = true;
    void apiClient.getCloudPricing()
      .then((next) => {
        if (live) setPricing(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [activeTabId, pricing]);
  const trialDays = trialDaysOf(pricing);
  // The Functions search only owns the keyboard while its tab is showing.
  const selectTab = (value: string) => {
    setFunctionsSearching(false);
    setActiveTabId(value as HelpTabId);
  };
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: [...HELP_TABS], activeValue: activeTabId, onSelect: selectTab, focused, compact: true, scrollable: false,
  });
  const contentHeight = Math.max(0, height - tabRows);
  // The scrolling tab bodies pad by one cell, so their tables get the rest.
  const bodyWidth = Math.max(1, width - 2);
  const rendererHost = useRendererHost();

  const openDebugLog = useCallback(() => {
    showPane("debug");
  }, [showPane]);

  const openLayoutActions = useCallback(() => {
    openCommandBar("LMA ");
  }, [openCommandBar]);

  const openPluginManager = useCallback(() => {
    openCommandBar("PL ");
  }, [openCommandBar]);

  const openDocs = useCallback(() => {
    createPaneFromTemplate(DOCS_PANE_TEMPLATE_ID);
  }, [createPaneFromTemplate]);

  const openIssues = useCallback(() => {
    void rendererHost.openExternal(GLOOMBERB_ISSUES_URL);
  }, [rendererHost]);

  // Each tab's actions. `l` moves between tabs, so layout actions take `a`.
  const tabHints = useMemo<PaneHint[]>(() => {
    if (activeTabId === "basics") {
      return [{ id: "docs", key: "d", label: "ocs", title: "Open Docs", onPress: openDocs }];
    }
    // The layout rows are here, so their action is.
    if (activeTabId === "reference") {
      return [{ id: "layout-actions", key: "a", label: " layout actions", title: "Layout Actions", onPress: openLayoutActions }];
    }
    if (activeTabId === "functions") {
      return [{ id: "plugins", key: "p", label: "lugins", title: "Manage Plugins", onPress: openPluginManager }];
    }
    if (activeTabId === "issues") {
      return [
        { id: "send-feedback", key: "s", label: "end feedback", title: "Send Feedback", onPress: () => { requestFeedbackDialog(); } },
        { id: "debug-log", key: "d", label: "ebug log", title: "Open Debug Log", onPress: openDebugLog },
        { id: "issues", key: "o", label: "pen GitHub issues", title: "Open GitHub Issues", onPress: openIssues },
      ];
    }
    return [];
  }, [activeTabId, openDebugLog, openDocs, openIssues, openLayoutActions, openPluginManager]);

  // The footer binds each hint's key; a search field keeps its typing.
  usePaneFooter("help:tab", () => tabHints.length > 0 ? { hints: tabHints } : null, [tabHints]);

  const runQuery = useCallback((query: string) => {
    registry?.runCommandBarQuery(query);
  }, [registry]);
  const hasCode = useMemo(() => {
    const known = knownCodesKey === null ? null : new Set(knownCodesKey.split(" "));
    return (code: string) => !known || known.has(code);
  }, [knownCodesKey]);
  const tryRows = useMemo(() => TRY_THESE.filter((row) => hasCode(row.query.split(" ")[0]!)), [hasCode]);
  const trySections = useMemo<Array<TableSection<ShortcutTableEntry>>>(() => tryRows.length > 0 ? [{
    label: "Try These",
    items: tryRows.map((row) => ({
      ...entry(`try:${row.query}`, row.query.split(" "), row.description),
      run: () => runQuery(row.query),
    })),
  }] : [], [runQuery, tryRows]);
  // The keyboard reaches the same rows from the pane menu.
  usePaneMenuItems("help:try-these", () => activeTabId === "basics"
    ? tryRows.map((row) => ({
      id: `try:${row.query}`,
      label: `${t(row.description)} (${row.query})`,
      onSelect: () => runQuery(row.query),
    }))
    : null, [activeTabId, runQuery, tryRows]);

  // What to do first, by task rather than by key: new people leave when they
  // do not know any code or what the data is for. DES leads Try These and the
  // command bar list below, so it is not repeated here.
  const startSections = useMemo<Array<TableSection<ShortcutTableEntry>>>(() => [{
    label: "Start Here",
    items: [
      entry("start-ap", ["AP"], "Add what you own. Alerts and emails then follow your portfolio."),
      entry("start-pf", ["PF"], "Your portfolio and watchlists."),
      entry("start-most", ["MOST"], "Today's biggest movers, with pre-market, after-hours and gap lists."),
      entry("start-top", ["TOP"], "The top market stories, ranked."),
      entry("start-ern", ["ERN"], "Upcoming earnings, with the move options imply."),
      entry("start-eco", ["ECO"], "The economic calendar."),
      entry("start-askg", ["ASKG", "<question>"], "Ask Gloom: answers that cite filings, calls and news."),
    ].filter((item) => hasCode(item.badges[0]!)),
  }], [hasCode]);

  const referenceSections = useMemo<Array<TableSection<ShortcutTableEntry>>>(() => [
    {
      label: "Command Bar",
      items: [
        ...(commandBarBadges.length > 0
          ? [entry("cmd-open", commandBarBadges, "Open command mode for actions, pane commands, and typed prefixes.")]
          : []),
        ...(tickerSearchBadges.length > 0
          ? [entry("cmd-ticker-search", tickerSearchBadges, "Open ticker search directly.")]
          : []),
        entry("cmd-des", ["DES", "<ticker>"], "Open security details for a specific ticker."),
        entry("cmd-help-card", ["HELP", "<function>"], "Open a function's help card: what it shows, its keys, how fresh its data is. HELP HELP reaches support."),
        entry("cmd-docs", ["DOCS", "<function>"], "Read the docs and Academy lessons in the app. The ? on a pane opens its entry."),
        entry("cmd-upgrade", ["UPGRADE"], tf("Go Pro for real-time data at gloom.sh/cloud, free for {days} days.", { days: trialDays })),
        entry("cmd-mcp", ["MCP"], "Connect Claude Code, Codex, Cursor or any MCP client to Gloom's research tools."),
        entry("cmd-move", ["Up/Down", "Ctrl+P/N"], "Move through command bar results."),
        entry("cmd-page", ["PageUp/PageDown", "Ctrl+Home/End"], "Jump a page, or to the first or last result."),
        entry("cmd-run", ["Enter", "Shift+Enter"], "Run the selected result or its secondary action."),
        entry("cmd-accept-arg", ["Tab"], "Accept a suggested command argument when one is available."),
        entry("cmd-close", ["Esc", ...tickerSearchBadges.filter((badge) => badge === "`" || badge.includes("+"))], "Close the command bar."),
        entry("cmd-clear", ["Ctrl+U"], "Clear command text."),
        entry("cmd-delete-word", ["Ctrl+W"], "Delete the previous word in command text."),
        entry("cmd-back", ["Backspace"], "Go back from a nested command screen when the query is empty."),
      ],
    },
    {
      label: "Navigation",
      items: [
        entry("rows", ["Up/Down", "j/k"], "Move through focused table and list rows."),
        entry("activate", ["Enter"], "Open or activate the selected row."),
        entry("tabs", ["Left/Right", "h/l"], "Switch tabs when a tab bar is focused."),
        entry("back", ["Esc", "Backspace"], "Go back from a detail view."),
        entry("pane-menu", actionBadges("pane-menu"), "Open the focused pane's menu: every action in the pane with its key, sorting, filters, tabs, toggles and the pane actions."),
        ...(functionHelpBadges.length > 0
          ? [entry("function-help", functionHelpBadges, "Open the focused pane's help card; Enter reads its docs.")]
          : []),
        ...(askBadges.length > 0
          ? [entry("ask-gloom", askBadges, "Ask Gloom about the focused pane, in a new conversation with the pane attached. Also Ask Gloom in the pane menu.")]
          : []),
        entry("search", ["/"], "Search in the focused pane."),
        entry("sidebar", ["<", ">"], "Narrow or widen the list beside the content, as in MAP and ASKG."),
        entry("warnings", ["!"], "Open the focused pane's data warnings."),
        entry("notification", actionBadges("notification-action"), "Run the newest notification."),
        entry("notification-dismiss", actionBadges("notification-dismiss"), "Dismiss the newest notification."),
      ],
    },
    {
      label: "Forms",
      items: [
        entry("toggle", ["Space"], "Toggle a checkbox or a multi-select choice."),
        entry("reorder", ["[", "]"], "Reorder ordered multi-select choices."),
        entry("submit", shortcutDisplayMode === "terminal" ? ["Ctrl+S"] : [platformShortcut("S")], "Submit a form from any field."),
      ],
    },
    {
      label: "Scrolling",
      items: [
        entry("page", ["PageUp/PageDown"], "Move a table or list a page at a time, or scroll the focused pane."),
        entry("ends", ["Home/End"], "Jump to the first or last row, or the start or end of the pane."),
        entry("columns", ["Shift+Left/Right"], "Scroll a wide table's columns."),
      ],
    },
    {
      label: "Charts",
      items: [
        entry("pan", ["Drag", "Scroll"], "Pan the chart through time."),
        entry("pan-keys", ["a/d", "Shift+Left/Right"], "Pan the focused chart through time."),
        entry("cursor", ["Left/Right", "Esc"], "Step the focused chart's cursor through its dates, or clear it."),
        entry("legend", ["[", "]", "Space"], "Pick a legend series and show or hide it."),
        entry("zoom-tool", ["Shift+Z", "Shift+Drag"], "Pick the zoom tool, then drag a time range."),
        entry("ruler", ["Shift+M", "Alt+Drag"], "Pick the ruler, then drag to measure a move."),
        entry("draw", ["Shift+D", "Shift+P"], "Draw a trend line or a freehand shape."),
        entry("shapes", ["Shift+J", "Shift+B", "Shift+F"], "Draw a horizontal ray, a rectangle or a Fib retracement."),
        entry("place", ["Enter", "Arrows"], "With a tool picked, Enter starts it at the cursor, the arrows move its end, and Enter finishes it."),
        entry("drawings", ["[", "]"], "With a drawing tool picked, pick a drawing."),
        entry("colour", ["c", "Backspace"], "Cycle the drawing colour, or delete the picked drawing (the last one while a drawing tool is picked)."),
        entry("zoom-pointer", shortcutDisplayMode === "terminal" ? ["Ctrl+Scroll"] : ["Ctrl+Scroll", "Pinch"], "Zoom time around the pointer."),
        entry("time-axis", ["Drag"], "On the time axis, zoom time: left zooms in, right zooms out. Double-click fits it again."),
        entry("value-axis", ["Drag", "Scroll"], "On a value axis, stretch or squeeze that panel's values. Dragging the plot then moves them too."),
        entry("value-fit", ["Double-click", "Auto"], "Fit a hand-scaled panel's values again, from its axis or the Auto button at its foot."),
        entry("zoom-keys", ["+/-", "0"], "Zoom the focused chart in or out, or reset it, values included."),
        shortcutDisplayMode === "terminal"
          ? entry("panel-height", ["Shift+Up/Down"], "Make the top panel taller or shorter; Reset Panel Heights in the pane menu puts back the split.")
          : entry("panel-height", ["Drag", "Shift+Up/Down"], "Drag the line between two panels to resize them, double-click it for the default split; Shift+Up and Shift+Down resize the top panel."),
        entry("panel-max", ["Double-click"], "Double-click a panel to give it the whole chart, and again to show every panel."),
        entry("tools-hide", ["Shift+T"], "Hide the drawing tools to a single button, or show them again."),
        entry("legend-fold", ["Shift+L"], "Fold the legend to its first series and a count of the rest, or open it again."),
      ],
    },
    {
      label: "Map",
      items: [
        entry("map-pan", ["m", "Arrows"], "Give the arrow keys to the map and pan it; Shift pans further, Esc gives them back to the list."),
        entry("map-zoom", ["+/-", "0"], "Zoom the map in or out, or reset it."),
        entry("map-pointer", ["Scroll", "Pinch"], "Zoom the map around the pointer; drag to pan, double-click to zoom in."),
      ],
    },
    {
      label: "Clipboard",
      items: [
        entry("copy", copyBadges, "Copy the active terminal selection."),
        entry("paste", pasteBadges, "Paste clipboard text into the active input."),
      ],
    },
    {
      label: "Panes",
      items: [
        entry("cancel-drag", ["Esc"], "Cancel an active pane drag."),
        entry("close-pane", ["Esc", "Esc"], "Close the focused pane when nothing is being dragged."),
      ],
    },
    {
      // Docked panes keep the saved layout and floating ones follow the pointer; the keyboard's way is Window Mode below.
      label: "Layout",
      items: [
        entry("layout-drag", ["Drag"], "Floating panes can be dragged by the title bar and resized from the lower-right corner."),
        { ...entry("layout-actions", ["LMA"], "Use Layout Actions for split, move, duplicate, close all floating panes, undo, redo, and layout presets."), run: openLayoutActions },
      ],
    },
    {
      label: "Window Mode",
      items: [
        ...(windowMoveBadges.length > 0
          ? [entry("enter-move", windowMoveBadges, "Enter window mode to move the focused window.")]
          : []),
        ...(windowResizeBadges.length > 0
          ? [entry("enter-resize", windowResizeBadges, "Enter window mode to resize the focused window.")]
          : []),
        entry("mode", ["m", "r"], "Switch between move and resize."),
        entry("dock", ["d"], "Dock or float the selected window."),
        entry("move", ["Arrows", "h/j/k/l"], "Move, resize, or choose a dock target."),
        entry("step", ["Shift"], "Use larger move and resize steps with direction keys."),
        entry("cycle", ["Tab", "w"], "Cycle windows or resize handles."),
        entry("commit", ["Enter", "Esc"], "Commit pending changes or exit window mode."),
      ],
    },
  ], [askBadges, commandBarBadges, copyBadges, functionHelpBadges, openLayoutActions, pasteBadges, tickerSearchBadges, trialDays, windowMoveBadges, windowResizeBadges]);

  // One key column for every key table in Help, wide enough for the longest group of chips, so the descriptions
  // line up from table to table. A narrow pane caps it, and a row past the cap shows the chips that fit whole.
  const keyColumnWidth = useMemo(() => badgeColumnWidth(
    [...trySections, ...startSections, ...referenceSections].flatMap((section) => section.items.map((item) => item.badges)),
    { min: 8, max: Math.max(8, Math.floor(width * KEY_COLUMN_MAX_SHARE)) },
  ), [referenceSections, startSections, trySections, width]);

  const renderContent = () => {
    switch (activeTabId) {
      case "reference":
      case "functions":
      case "shortcuts":
        // Rendered outside the scroll box; these tabs are their own table.
        return null;

      case "issues":
        return <FeedbackTab width={bodyWidth} />;

      case "basics":
      default:
        return (
          <>
            {trySections.length > 0 && (
              <Box marginBottom={1}>
                <ShortcutTable sections={trySections} width={bodyWidth} keyWidth={keyColumnWidth} keyLabel="TYPE" descriptionLabel="OPENS" />
              </Box>
            )}

            <Text fg={colors.textDim} wrapText>
              {commandBarBadges[0]
                ? tf("Not sure of a code? Click the search bar at the top, or press {key}, and type what you want in plain words, like \"top news\". The Functions tab lists everything.", { key: commandBarBadges[0] })
                : t("Not sure of a code? Click the search bar at the top and type what you want in plain words, like \"top news\". The Functions tab lists everything.")}
            </Text>

            <Box marginTop={1}>
              <ShortcutTable sections={startSections} width={bodyWidth} keyWidth={keyColumnWidth} />
            </Box>
          </>
        );
    }
  };

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabStrip && <Box width={width} height={1} flexShrink={0}>{tabStrip}</Box>}
      {activeTabId === "shortcuts" ? (
        <KeybindingsEditor focused={focused} width={width} height={contentHeight} />
      ) : activeTabId === "functions" ? (
        <FunctionsTable
          commandShortcuts={commandShortcuts}
          windowTemplates={windowTemplates}
          focused={focused}
          width={width}
          height={contentHeight}
          searching={functionsSearching}
          onSearchingChange={setFunctionsSearching}
          onRunPrefix={openCommandBar}
        />
      ) : activeTabId === "reference" ? (
        <ShortcutTable
          sections={referenceSections}
          width={width}
          keyWidth={keyColumnWidth}
          height={contentHeight}
          after={(
            <Box paddingX={1} flexShrink={0}>
              <Notice tone="muted">
                {t("The chart tool icons sit over its top-left corner. Most terminals keep shift-drag and option-drag for their own text selection, so pick the tool there instead.")}
              </Notice>
            </Box>
          )}
        />
      ) : (
        <ScrollBox key={activeTabId} width={width} height={contentHeight} scrollY>
          <Box flexDirection="column" paddingX={1}>
            {renderContent()}
          </Box>
        </ScrollBox>
      )}
    </Box>
  );
}

export const helpModule: PluginModule = {
  panes: [
    {
      id: "help",
      name: "Help",
      icon: "?",
      component: HelpPane,
      reportFreshness: { status: "not-a-feed", basis: "documentation", local: true },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 88, height: 32 },
    },
  ],
};
