import { Box, ScrollBox, Text, useUiHost } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { useState } from "react";
import { Button, Tabs } from "../../../components";
import { ExternalLinkText } from "../../../components/ui";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import { getSharedRegistry } from "../../registry";
import { usePluginAppActions } from "../../runtime";
import { detectShortcutPlatform, formatPrimaryShortcut, getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import {
  HelpSection,
  ShortcutGroup,
  ShortcutRow,
} from "./components";
import {
  groupShortcutEntries,
  resolveCommandShortcuts,
  resolvePluginShortcuts,
  resolveWindowTemplates,
} from "./shortcut-model";

const HELP_TABS = [
  { label: "Basics", value: "basics" },
  { label: "Functions", value: "functions" },
  { label: "Shortcuts", value: "shortcuts" },
  { label: "Issues", value: "issues" },
] as const;

type HelpTabId = typeof HELP_TABS[number]["value"];
const GLOOMBERB_ISSUES_URL = "https://github.com/gloom-sh/gloomberb/issues";

function HelpPane({ focused, width, height }: PaneProps) {
  const registry = getSharedRegistry();
  const { openCommandBar, showPane } = usePluginAppActions();
  const [activeTabId, setActiveTabId] = useState<HelpTabId>("basics");
  const commandShortcuts = resolveCommandShortcuts(registry);
  const pluginShortcuts = resolvePluginShortcuts(registry);
  const windowTemplates = resolveWindowTemplates(registry);
  const uiHost = useUiHost();
  const isDesktopWeb = uiHost.kind === "desktop-web";
  const shortcutPlatform = detectShortcutPlatform();
  const shortcutDisplayMode = getShortcutDisplayMode(uiHost.kind);
  const platformShortcut = (keys: string | readonly string[]) => formatPrimaryShortcut(keys, shortcutPlatform, shortcutDisplayMode);
  const commandBarBadges = shortcutDisplayMode === "terminal"
    ? ["Ctrl+P"]
    : ["Ctrl+P", platformShortcut("K")];
  const copyBadges = shortcutDisplayMode === "terminal"
    ? ["Ctrl+Shift+C"]
    : [platformShortcut("C")];
  const pasteBadges = shortcutDisplayMode === "terminal"
    ? ["Ctrl+Shift+V"]
    : [platformShortcut("V")];
  const contentHeight = Math.max(0, height - 1);

  const openDebugLog = () => {
    showPane("debug");
  };

  const openLayoutActions = () => {
    openCommandBar("LMA ");
  };

  const openPluginManager = () => {
    openCommandBar("PL ");
  };

  const renderContent = () => {
    switch (activeTabId) {
      case "functions":
        return (
          <>
            <Box flexDirection="row" gap={1}>
              <Button label="Manage Plugins" onPress={openPluginManager} />
            </Box>

            <HelpSection title="Command Prefixes">
              {groupShortcutEntries(commandShortcuts).map((group) => (
                <ShortcutGroup
                  key={group.title}
                  title={group.title}
                  entries={group.entries}
                />
              ))}
            </HelpSection>

            <HelpSection title="Window Templates">
              {windowTemplates.length > 0 ? groupShortcutEntries(windowTemplates).map((group) => (
                <ShortcutGroup
                  key={group.title}
                  title={group.title}
                  entries={group.entries}
                />
              )) : (
                <Text fg={colors.textDim}>{t("No shortcut window templates are currently registered.")}</Text>
              )}
            </HelpSection>

            {pluginShortcuts.length > 0 && (
              <HelpSection title="Plugin Shortcuts">
                {groupShortcutEntries(pluginShortcuts).map((group) => (
                  <ShortcutGroup
                    key={group.title}
                    title={group.title}
                    entries={group.entries}
                  />
                ))}
              </HelpSection>
            )}
          </>
        );

      case "shortcuts":
        return (
          <>
            <HelpSection title="Navigation">
              <ShortcutRow
                badges={["Up/Down", "j/k"]}
                description="Move through focused table and list rows."
              />
              <ShortcutRow
                badges={["Enter"]}
                description="Open or activate the selected row."
              />
              <ShortcutRow
                badges={["Left/Right", "h/l"]}
                description="Switch tabs when a tab bar is focused."
              />
              <ShortcutRow
                badges={["Esc", "Backspace"]}
                description="Go back from detail views that support back navigation."
              />
            </HelpSection>

            <HelpSection title="Scrolling">
              <ShortcutRow
                badges={["PageUp/PageDown"]}
                description="Scroll focused pane content by page."
              />
              <ShortcutRow
                badges={["Home/End"]}
                description="Scroll focused pane content to the start or end."
              />
            </HelpSection>

            <HelpSection title="Charts">
              <ShortcutRow
                badges={["Drag", "Scroll"]}
                description="Pan the chart through time."
              />
              <ShortcutRow
                badges={["Shift+Z", "Shift+Drag"]}
                description="Pick the zoom tool, then drag a time range to zoom into."
              />
              <ShortcutRow
                badges={["Shift+M", "Alt+Drag"]}
                description="Pick the ruler, then drag to measure change, percent, bars, and elapsed time."
              />
              <ShortcutRow
                badges={["Shift+D", "Shift+P"]}
                description="Draw a trend line or a freehand shape. Grab a line's end to reshape it, drag its middle to move it."
              />
              <ShortcutRow
                badges={["c", "Backspace"]}
                description="Cycle the drawing colour, or delete the selected drawing."
              />
              <ShortcutRow
                badges={["Ctrl+Scroll"]}
                description="Zoom around the pointer."
              />
              <ShortcutRow
                badges={["+/-", "0"]}
                description="Zoom the focused chart in or out, or reset it."
              />
              <Text fg={colors.textDim} wrapText>
                {t("The tool icons sit over the top-left corner of the chart. Most terminals keep shift-drag and option-drag for their own text selection, so pick the tool there instead.")}
              </Text>
            </HelpSection>

            <HelpSection title="Global Keys">
              <ShortcutRow
                badges={["Tab", "Shift+Tab"]}
                description="Move focus between panes and floating windows."
              />
              <ShortcutRow
                badges={["Ctrl+1-9"]}
                description="Switch saved layouts by number."
              />
              <ShortcutRow
                badges={["r", "Shift+R"]}
                description="Refresh the focused ticker or refresh everything."
              />
              <ShortcutRow
                badges={["q"]}
                description="Quit the terminal app."
              />
              <ShortcutRow
                badges={copyBadges}
                description="Copy the active terminal selection."
              />
              <ShortcutRow
                badges={pasteBadges}
                description="Paste clipboard text into the active input."
              />
              <ShortcutRow
                badges={["u"]}
                description="Install an available app update when one is shown."
              />
            </HelpSection>

            <HelpSection title="Pane Management">
              <ShortcutRow
                badges={[platformShortcut("W")]}
                description="Close the focused pane, docked or floating."
              />
              <ShortcutRow
                badges={[platformShortcut(["Alt", "W"])]}
                description="Close all floating panes."
              />
              <ShortcutRow
                badges={[platformShortcut(",")]}
                description="Edit settings for the focused pane."
              />
              <ShortcutRow
                badges={[platformShortcut(["Shift", "D"])]}
                description="Dock or float the focused pane."
              />
              {isDesktopWeb && (
                <ShortcutRow
                  badges={[platformShortcut(["Shift", "O"])]}
                  description="Pop the focused pane out to a desktop window."
                />
              )}
              {isDesktopWeb && (
                <ShortcutRow
                  badges={[platformShortcut(["Shift", "C"])]}
                  description="Copy a screenshot of the focused pane."
                />
              )}
              <ShortcutRow
                badges={[platformShortcut(["Shift", "E"])]}
                description="Export the focused pane's table as CSV."
              />
              <ShortcutRow
                badges={[platformShortcut(["Shift", "L"])]}
                description="Open layout actions."
              />
              <ShortcutRow
                badges={[platformShortcut(["Shift", "G"])]}
                description="Tidy Windows"
              />
              <ShortcutRow
                badges={[platformShortcut(["Shift", "M"])]}
                description="Enter window move mode."
              />
              <ShortcutRow
                badges={[platformShortcut(["Shift", "R"])]}
                description="Enter window resize mode."
              />
              <ShortcutRow
                badges={["Esc"]}
                description="Cancel an active pane drag."
              />
              <ShortcutRow
                badges={["Esc", "Esc"]}
                description="Close the focused pane when nothing is being dragged."
              />
            </HelpSection>

            <HelpSection title="Window Mode">
              <ShortcutRow
                badges={["m", "r"]}
                description="Switch between move and resize."
              />
              <ShortcutRow
                badges={["d"]}
                description="Dock or float the selected window."
              />
              <ShortcutRow
                badges={["Arrows", "h/j/k/l"]}
                description="Move, resize, or choose a dock target."
              />
              <ShortcutRow
                badges={["Shift"]}
                description="Use larger move and resize steps with direction keys."
              />
              <ShortcutRow
                badges={["Tab", "w"]}
                description="Cycle windows or resize handles."
              />
              <ShortcutRow
                badges={["Enter", "Esc"]}
                description="Commit pending changes or exit window mode."
              />
            </HelpSection>
          </>
        );

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

            <HelpSection title="If There Is A Bug">
              <Text fg={colors.text} wrapText>{t("Open Debug Log, then run Export Debug Log from the command bar.")}</Text>
              <Text fg={colors.text} wrapText>{t("The file lands in ~/Downloads. Include steps, ticker or layout, plugin, and a screenshot if it is visual.")}</Text>
            </HelpSection>
          </>
        );

      case "basics":
      default:
        return (
          <>
            <Box flexDirection="column" gap={1}>
              <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("How To Use Gloomberb")}</Text>
              <Box flexDirection="column">
                <Text fg={colors.textDim}>{t("Gloomberb is command-bar first.")}</Text>
                <Text fg={colors.textDim}>{t("Use the keyboard for speed, and the mouse for windows.")}</Text>
              </Box>
            </Box>

            <Box flexDirection="row" gap={1}>
              <Button label="Layout Actions" onPress={openLayoutActions} />
            </Box>

            <HelpSection title="Command Bar">
              <ShortcutRow
                badges={commandBarBadges}
                description="Open command mode for actions, pane commands, and typed prefixes."
              />
              <ShortcutRow
                badges={["`"]}
                description="Open ticker search directly."
              />
              <ShortcutRow
                badges={["DES", "<ticker>"]}
                description="Open security details for a specific ticker."
              />
              <ShortcutRow
                badges={["UPGRADE"]}
                description="Go Pro for real-time data at gloom.sh/cloud, free for 7 days."
              />
              <ShortcutRow
                badges={["Up/Down", "Ctrl+P/N"]}
                description="Move through command bar results."
              />
              <ShortcutRow
                badges={["Enter", "Shift+Enter"]}
                description="Run the selected result or its secondary action."
              />
              <ShortcutRow
                badges={["Tab"]}
                description="Accept a suggested command argument when one is available."
              />
              <ShortcutRow
                badges={["Esc", "`"]}
                description="Close the command bar."
              />
              <ShortcutRow
                badges={["Ctrl+U"]}
                description="Clear command text."
              />
              <ShortcutRow
                badges={["Ctrl+W"]}
                description="Delete the previous word in command text."
              />
              <ShortcutRow
                badges={["Backspace"]}
                description="Go back from a nested command screen when the query is empty."
              />
              <ShortcutRow
                badges={["Space"]}
                description="Toggle command-bar plugin rows, toggles, and multi-select choices."
              />
              <ShortcutRow
                badges={["[", "]"]}
                description="Reorder ordered multi-select choices."
              />
              <ShortcutRow
                badges={["Ctrl+S"]}
                description="Submit multiline command forms."
              />
            </HelpSection>

            <HelpSection title="Layout Basics">
              <Text fg={colors.text}>{t("Docked panes stay in the saved layout.")}</Text>
              <Text fg={colors.text} wrapText>{t("Floating panes can be dragged by the title bar and resized from the lower-right corner.")}</Text>
              <Text fg={colors.text} wrapText>{t("Use Layout Actions for split, move, duplicate, close all floating panes, undo, redo, and layout presets.")}</Text>
            </HelpSection>
          </>
        );
    }
  };

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box width={width} height={1} flexShrink={0}>
        <Tabs
          tabs={[...HELP_TABS]}
          activeValue={activeTabId}
          onSelect={(value) => setActiveTabId(value as HelpTabId)}
          focused={focused}
          compact
          scrollable={false}
        />
      </Box>
      <ScrollBox key={activeTabId} width={width} height={contentHeight} scrollY>
        <Box flexDirection="column" padding={1}>
          {renderContent()}
        </Box>
      </ScrollBox>
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
