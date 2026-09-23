import { useCallback, useEffect, useMemo, useState } from "react";
import { formatActionChords, hasKeybindingCaptureRequest, subscribeKeybindingCapture, useKeybindings } from "../../../app/keybindings";
import { Notice, Section, SectionHeading, Tabs, usePaneFooter, usePaneHeaderTabs, type PaneHint, type TableSection } from "../../../components";
import { t, tf } from "../../../i18n";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, useRendererHost, useUiHost } from "../../../ui";
import { detectShortcutPlatform, formatPrimaryShortcut, getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import { getSharedRegistry } from "../../registry";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import { requestFeedbackDialog } from "../../../components/feedback-dialog";
import { FeedbackTab } from "./feedback-tab";
import { FunctionsTable } from "./functions-table";
import { KeybindingsEditor } from "./keybindings-editor";
import { ShortcutTable, type ShortcutTableEntry } from "./shortcut-table";
import { resolveCommandShortcuts, resolveWindowTemplates } from "./shortcut-model";

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

function HelpPane({ focused, width, height }: PaneProps) {
  const registry = getSharedRegistry();
  const { openCommandBar, showPane } = usePluginAppActions();
  // A key capture requested from the command bar belongs to the Shortcuts
  // tab, whether the pane is already open or is being opened for it.
  const [activeTabId, setActiveTabId] = usePluginPaneState<HelpTabId>("activeTab", "basics");
  useEffect(() => {
    if (hasKeybindingCaptureRequest()) setActiveTabId("shortcuts");
  }, []);
  const commandShortcuts = resolveCommandShortcuts(registry);
  const windowTemplates = resolveWindowTemplates(registry);
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
  useEffect(() => subscribeKeybindingCapture(() => setActiveTabId("shortcuts")), []);
  const copyBadges = shortcutDisplayMode === "terminal" ? ["Ctrl+Shift+C"] : [platformShortcut("C")];
  const pasteBadges = shortcutDisplayMode === "terminal" ? ["Ctrl+Shift+V"] : [platformShortcut("V")];
  const [functionsSearching, setFunctionsSearching] = useState(false);
  // The Functions search only owns the keyboard while its tab is showing.
  const selectTab = (value: string) => {
    setFunctionsSearching(false);
    setActiveTabId(value as HelpTabId);
  };
  const tabsInHeader = usePaneHeaderTabs({ tabs: [...HELP_TABS], activeValue: activeTabId, onSelect: selectTab, focused });
  const tabRows = tabsInHeader ? 0 : 1;
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

  const openIssues = useCallback(() => {
    void rendererHost.openExternal(GLOOMBERB_ISSUES_URL);
  }, [rendererHost]);

  // Each tab's actions. `l` moves between tabs, so layout actions take `a`.
  const tabHints = useMemo<PaneHint[]>(() => {
    if (activeTabId === "basics") {
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
  }, [activeTabId, openDebugLog, openIssues, openLayoutActions, openPluginManager]);

  usePaneFooter("help:tab", () => tabHints.length > 0 ? { hints: tabHints } : null, [tabHints]);

  useShortcut((event) => {
    if (!focused || event.targetEditable || event.ctrl || event.meta || event.shift) return;
    if (activeTabId === "functions" && functionsSearching) return;
    const hint = tabHints.find((candidate) => candidate.key === event.name);
    if (!hint) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    hint.onPress?.();
  });

  const commandBarSections = useMemo<Array<TableSection<ShortcutTableEntry>>>(() => [{
    label: "Command Bar",
    items: [
      ...(commandBarBadges.length > 0
        ? [entry("open", commandBarBadges, "Open command mode for actions, pane commands, and typed prefixes.")]
        : []),
      ...(tickerSearchBadges.length > 0
        ? [entry("ticker-search", tickerSearchBadges, "Open ticker search directly.")]
        : []),
      entry("des", ["DES", "<ticker>"], "Open security details for a specific ticker."),
      entry("upgrade", ["UPGRADE"], "Go Pro for real-time data at gloom.sh/cloud, free for 7 days."),
      entry("move", ["Up/Down", "Ctrl+P/N"], "Move through command bar results."),
      entry("page", ["PageUp/PageDown", "Ctrl+Home/End"], "Jump a page, or to the first or last result."),
      entry("run", ["Enter", "Shift+Enter"], "Run the selected result or its secondary action."),
      entry("accept-arg", ["Tab"], "Accept a suggested command argument when one is available."),
      entry("close", ["Esc", ...tickerSearchBadges.filter((badge) => badge === "`" || badge.includes("+"))], "Close the command bar."),
      entry("clear", ["Ctrl+U"], "Clear command text."),
      entry("delete-word", ["Ctrl+W"], "Delete the previous word in command text."),
      entry("back", ["Backspace"], "Go back from a nested command screen when the query is empty."),
      entry("toggle", ["Space"], "Toggle command-bar plugin rows, toggles, and multi-select choices."),
      entry("reorder", ["[", "]"], "Reorder ordered multi-select choices."),
      entry("submit", shortcutDisplayMode === "terminal" ? ["Ctrl+S"] : [platformShortcut("S")], "Submit command bar forms from any field."),
    ],
  }], [commandBarBadges, tickerSearchBadges]);

  const referenceSections = useMemo<Array<TableSection<ShortcutTableEntry>>>(() => [
    {
      label: "Navigation",
      items: [
        entry("rows", ["Up/Down", "j/k"], "Move through focused table and list rows."),
        entry("activate", ["Enter"], "Open or activate the selected row."),
        entry("tabs", ["Left/Right", "h/l"], "Switch tabs when a tab bar is focused."),
        entry("back", ["Esc", "Backspace"], "Go back from a detail view."),
        entry("pane-menu", actionBadges("pane-menu"), "Open the focused pane's menu: every action in the pane with its key, sorting, filters, tabs, toggles and the pane actions."),
        entry("search", ["/"], "Search in the focused pane."),
        entry("warnings", ["!"], "Open the focused pane's data warnings."),
        entry("notification", [...actionBadges("notification-action"), ...actionBadges("notification-dismiss")], "Run or dismiss the newest notification."),
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
        entry("place", ["Enter", "Arrows"], "With a tool picked, Enter starts it at the cursor, the arrows move its end, and Enter finishes it."),
        entry("drawings", ["[", "]"], "With a drawing tool picked, pick a drawing."),
        entry("colour", ["c", "Backspace"], "Cycle the drawing colour, or delete the picked drawing (the last one while a drawing tool is picked)."),
        entry("zoom-pointer", ["Ctrl+Scroll"], "Zoom around the pointer."),
        entry("zoom-keys", ["+/-", "0"], "Zoom the focused chart in or out, or reset it."),
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
  ], [copyBadges, pasteBadges, windowMoveBadges, windowResizeBadges]);

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
            <Box flexDirection="column" gap={1}>
              <SectionHeading title="How To Use Gloomberb" />
              <Box flexDirection="column">
                <Text fg={colors.textDim}>{t("Gloomberb is command-bar first.")}</Text>
                <Text fg={colors.textDim}>{t("Use the keyboard for speed, and the mouse for windows.")}</Text>
              </Box>
            </Box>

            <Box marginTop={1}>
              <ShortcutTable sections={commandBarSections} width={bodyWidth} />
            </Box>

            <Section title="Layout Basics">
              <Text fg={colors.text}>{t("Docked panes stay in the saved layout.")}</Text>
              <Text fg={colors.text} wrapText>{t("Floating panes can be dragged by the title bar and resized from the lower-right corner.")}</Text>
              {windowMoveBadges[0] && windowResizeBadges[0] && (
                <Text fg={colors.text} wrapText>{tf("From the keyboard, {move} moves the focused window and {resize} resizes it.", { move: windowMoveBadges[0], resize: windowResizeBadges[0] })}</Text>
              )}
              <Text fg={colors.text} wrapText>{t("Use Layout Actions for split, move, duplicate, close all floating panes, undo, redo, and layout presets.")}</Text>
            </Section>
          </>
        );
    }
  };

  return (
    <Box flexDirection="column" width={width} height={height}>
      {!tabsInHeader && (
        <Box width={width} height={1} flexShrink={0}>
          <Tabs
            tabs={[...HELP_TABS]}
            activeValue={activeTabId}
            onSelect={selectTab}
            focused={focused}
            compact
            scrollable={false}
          />
        </Box>
      )}
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
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 88, height: 32 },
    },
  ],
};
