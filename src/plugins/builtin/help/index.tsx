import { useEffect, useMemo } from "react";
import { formatActionChords, hasKeybindingCaptureRequest, subscribeKeybindingCapture, useKeybindings } from "../../../app/keybindings";
import { Button, Section, SectionHeading, Tabs, usePaneHeaderTabs, type TableSection } from "../../../components";
import { ExternalLinkText } from "../../../components/ui";
import { t } from "../../../i18n";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes, useUiHost } from "../../../ui";
import { detectShortcutPlatform, formatPrimaryShortcut, getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import { getSharedRegistry } from "../../registry";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import { FunctionsTable } from "./functions-table";
import { KeybindingsEditor } from "./keybindings-editor";
import { ShortcutTable, type ShortcutTableEntry } from "./shortcut-table";
import { resolveCommandShortcuts, resolveWindowTemplates } from "./shortcut-model";

const HELP_TABS = [
  { label: "Basics", value: "basics" },
  { label: "Functions", value: "functions" },
  { label: "Shortcuts", value: "shortcuts" },
  { label: "Reference", value: "reference" },
  { label: "Issues", value: "issues" },
] as const;

type HelpTabId = typeof HELP_TABS[number]["value"];
/** Tabs that are one full-height table and do their own scrolling. */
const TABLE_TABS = new Set<HelpTabId>(["functions", "shortcuts"]);
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
  useEffect(() => subscribeKeybindingCapture(() => setActiveTabId("shortcuts")), []);
  const copyBadges = shortcutDisplayMode === "terminal" ? ["Ctrl+Shift+C"] : [platformShortcut("C")];
  const pasteBadges = shortcutDisplayMode === "terminal" ? ["Ctrl+Shift+V"] : [platformShortcut("V")];
  const selectTab = (value: string) => setActiveTabId(value as HelpTabId);
  const tabsInHeader = usePaneHeaderTabs({ tabs: [...HELP_TABS], activeValue: activeTabId, onSelect: selectTab, focused });
  const tabRows = tabsInHeader ? 0 : 1;
  const contentHeight = Math.max(0, height - tabRows);
  // The scrolling tab bodies pad by one cell, so their tables get the rest.
  const bodyWidth = Math.max(1, width - 2);

  const openDebugLog = () => {
    showPane("debug");
  };

  const openLayoutActions = () => {
    openCommandBar("LMA ");
  };

  const openPluginManager = () => {
    openCommandBar("PL ");
  };

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
      entry("run", ["Enter", "Shift+Enter"], "Run the selected result or its secondary action."),
      entry("accept-arg", ["Tab"], "Accept a suggested command argument when one is available."),
      entry("close", ["Esc", ...tickerSearchBadges.filter((badge) => badge === "`" || badge.includes("+"))], "Close the command bar."),
      entry("clear", ["Ctrl+U"], "Clear command text."),
      entry("delete-word", ["Ctrl+W"], "Delete the previous word in command text."),
      entry("back", ["Backspace"], "Go back from a nested command screen when the query is empty."),
      entry("toggle", ["Space"], "Toggle command-bar plugin rows, toggles, and multi-select choices."),
      entry("reorder", ["[", "]"], "Reorder ordered multi-select choices."),
      entry("submit", ["Ctrl+S"], "Submit multiline command forms."),
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
      ],
    },
    {
      label: "Scrolling",
      items: [
        entry("page", ["PageUp/PageDown"], "Scroll focused pane content by page."),
        entry("ends", ["Home/End"], "Scroll focused pane content to the start or end."),
      ],
    },
    {
      label: "Charts",
      items: [
        entry("pan", ["Drag", "Scroll"], "Pan the chart through time."),
        entry("zoom-tool", ["Shift+Z", "Shift+Drag"], "Pick the zoom tool, then drag a time range."),
        entry("ruler", ["Shift+M", "Alt+Drag"], "Pick the ruler, then drag to measure a move."),
        entry("draw", ["Shift+D", "Shift+P"], "Draw a trend line or a freehand shape."),
        entry("colour", ["c", "Backspace"], "Cycle the drawing colour, or delete the selection."),
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
        entry("mode", ["m", "r"], "Switch between move and resize."),
        entry("dock", ["d"], "Dock or float the selected window."),
        entry("move", ["Arrows", "h/j/k/l"], "Move, resize, or choose a dock target."),
        entry("step", ["Shift"], "Use larger move and resize steps with direction keys."),
        entry("cycle", ["Tab", "w"], "Cycle windows or resize handles."),
        entry("commit", ["Enter", "Esc"], "Commit pending changes or exit window mode."),
      ],
    },
  ], [copyBadges, pasteBadges]);

  const renderContent = () => {
    switch (activeTabId) {
      case "reference":
        return (
          <>
            <ShortcutTable sections={referenceSections} width={bodyWidth} />
            <Box marginTop={1}>
              <Text fg={colors.textDim} wrapText>
                {t("The chart tool icons sit over its top-left corner. Most terminals keep shift-drag and option-drag for their own text selection, so pick the tool there instead.")}
              </Text>
            </Box>
          </>
        );

      case "functions":
      case "shortcuts":
        // Rendered outside the scroll box; these tabs are their own table.
        return null;

      case "issues":
        return (
          <>
            <Box flexDirection="row" gap={1}>
              <Button label="Open Debug Log" onPress={openDebugLog} />
              <ExternalLinkText
                url={GLOOMBERB_ISSUES_URL}
                label={t("GitHub Issues")}
              />
            </Box>

            <Section title="If There Is A Bug">
              <Text fg={colors.text} wrapText>{t("Open Debug Log, then run Export Debug Log from the command bar.")}</Text>
              <Text fg={colors.text} wrapText>{t("The file lands in ~/Downloads. Include steps, ticker or layout, plugin, and a screenshot if it is visual.")}</Text>
            </Section>
          </>
        );

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

            <Box flexDirection="row" gap={1} marginTop={1}>
              <Button label="Layout Actions" onPress={openLayoutActions} />
            </Box>

            <Box marginTop={1}>
              <ShortcutTable sections={commandBarSections} width={bodyWidth} />
            </Box>

            <Section title="Layout Basics">
              <Text fg={colors.text}>{t("Docked panes stay in the saved layout.")}</Text>
              <Text fg={colors.text} wrapText>{t("Floating panes can be dragged by the title bar and resized from the lower-right corner.")}</Text>
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
          header={(
            <Box flexDirection="row" gap={1} paddingX={1} flexShrink={0}>
              <Button label="Manage Plugins" onPress={openPluginManager} />
            </Box>
          )}
          onRunPrefix={openCommandBar}
        />
      ) : (
        <ScrollBox key={activeTabId} width={width} height={contentHeight} scrollY>
          <Box flexDirection="column" padding={1}>
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
