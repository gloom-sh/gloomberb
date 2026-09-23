import {
  Box,
  Text,
  contextMenuDivider,
  useContextMenu,
  useRendererHost,
  useUiCapabilities,
  useUiHost,
} from "../../ui";
import { useDialog, type PromptContext } from "../../ui/dialog";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { blendHex, hoverBg } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { useAppDispatch, useAppSelector } from "../../state/app/context";
import {
  selectActiveLayoutIndex,
  selectLayout,
  selectSavedLayouts,
  selectStatusBarVisible,
} from "../../state/selectors-ui";
import { useViewport } from "../../react/input";
import {
  advertisedChord,
  formatKeyChord,
  primaryModifierFor,
  useKeybindings,
  type KeyChord,
} from "../../app/keybindings";
import {
  detectShortcutPlatform,
  getShortcutDisplayMode,
  type ShortcutDisplayMode,
  type ShortcutPlatform,
} from "../../utils/shortcut-labels";
import { getCurrentPluginTarget } from "../../plugins/current-target";
import { getSharedRegistry } from "../../plugins/registry";
import {
  gridlockAllPanes,
  shouldShowTidyWindows,
} from "../../plugins/pane-manager";
import { notifyGridlockComplete } from "../../plugins/gridlock-notification";
import { PluginSlot } from "../../react/plugins/plugin-slot";
import type { ContextMenuItem } from "../../types/context-menu";
import type { LayoutConfig } from "../../types/config";
import { VERSION } from "../../version";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Tabs } from "../ui/tabs";
import { useTransientLayout } from "./transient-layout";
import { linkedLayoutMarker, linkedLayoutStatus, linkedLayoutUpdates } from "../../layout-marketplace/linked";
import { teamAccentHex } from "../../plugins/builtin/cloud/team/model";
import { teamStore } from "../../plugins/builtin/cloud/team/store";
import { buildStatusBarTabGroups, groupIdFromMarkerValue, groupMarkerValue } from "./status-bar-groups";

type StatusBarEvent = { stopPropagation?: () => void; preventDefault?: () => void };
type HoveredControl = string | null;
type SetHoveredControl = (updater: (current: HoveredControl) => HoveredControl) => void;

/** Space held back for the `status:widget` plugin slot, which sizes itself. */
const STATUS_WIDGET_COLUMNS = 20;
/**
 * Where term.gloom.sh sends people who want the installed app. The route
 * picks the installer for the visitor's OS, so one link serves every platform.
 */
const DESKTOP_DOWNLOAD_URL = "https://gloom.sh/download/desktop";

type LayoutTabItem = {
  label: string;
  value: string;
  reorderable?: boolean;
  onContextMenu: (value: string, event: any) => void;
};

type StatusBarViewProps = {
  activeLayoutIdx: number;
  /** The tidy-windows key as the bar spells keys, or empty when unbound. */
  tidyWindowsKey: string;
  activeLayoutValue: string;
  handleLayoutReorder: (fromValue: string, toValue: string) => void;
  handleLayoutSelect: (value: string) => void;
  handleTidyWindows: (event?: StatusBarEvent) => void;
  hasMultipleLayouts: boolean;
  hoveredControl: HoveredControl;
  layoutTabItems: LayoutTabItem[];
  layoutTabsWidth: number;
  openChangelog?: (event?: StatusBarEvent) => void;
  openLayoutContextMenu: (index: number, event: any) => void | Promise<unknown>;
  rightAvailableWidth: number;
  setHoveredControl: SetHoveredControl;
  showTidyWindows: boolean;
};

/**
 * A chord as short as a tab label allows: `^2`, `^⇧F`, and on the Mac desktop
 * `⌘2` or `⇧⌘F`, in the order its menus write them. A digit chord names the
 * one digit given.
 */
export function compactChordLabel(
  chord: KeyChord,
  mode: ShortcutDisplayMode,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  digit?: number,
): string {
  const mac = mode === "platform" && platform === "darwin";
  const primaryIsCmd = primaryModifierFor(mode, platform) === "cmd";
  const ctrl = chord.ctrl || (chord.primary && !primaryIsCmd);
  const cmd = chord.cmd || (chord.primary && primaryIsCmd);
  const key = chord.key === "digit" && digit !== undefined
    ? String(digit)
    : formatKeyChord({ key: chord.key, ctrl: false, cmd: false, primary: false, alt: false, shift: false }, { primaryModifier: "ctrl" });
  return [
    ctrl ? "^" : "",
    chord.alt ? (mac ? "⌥" : "Alt+") : "",
    chord.shift ? "⇧" : "",
    cmd ? (mac ? "⌘" : "Super+") : "",
    key,
  ].join("");
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 2) return ".".repeat(width);
  return `${text.slice(0, width - 2)}..`;
}

export function StatusBar({ onOpenChangelog }: { onOpenChangelog?: (version: string) => void } = {}) {
  const { nativePaneChrome, nativeContextMenu } = useUiCapabilities();
  const { showContextMenu } = useContextMenu();
  const dialog = useDialog();
  const registry = getSharedRegistry();
  const dispatch = useAppDispatch();
  const { width: termWidth } = useViewport();
  const layouts = useAppSelector(selectSavedLayouts);
  const activeLayoutIdx = useAppSelector(selectActiveLayoutIndex);
  const statusBarVisible = useAppSelector(selectStatusBarVisible);
  const layout = useAppSelector(selectLayout);
  const { transientLayout } = useTransientLayout();
  const [hoveredControl, setHoveredControl] = useState<string | null>(null);
  const keybindings = useKeybindings();
  const shortcutMode = getShortcutDisplayMode(useUiHost().kind);
  const actionKey = (actionId: string): string => {
    const chord = advertisedChord(keybindings, actionId, shortcutMode);
    return chord ? compactChordLabel(chord, shortcutMode) : "";
  };
  // Tabs name the digit that switches to them, as bound on this host. Past
  // nine there is no digit, and a rebinding off the digits has none either.
  const switchChord = advertisedChord(keybindings, "switch-layout", shortcutMode);
  const tabKey = (index: number): string => (
    switchChord?.key === "digit" && index < 9 ? `${compactChordLabel(switchChord, shortcutMode, undefined, index + 1)} ` : ""
  );

  const hasMultipleLayouts = layouts.length > 1 || !!transientLayout;
  const showTidyWindows = useMemo(() => shouldShowTidyWindows(layout), [layout])
    && !transientLayout?.active
    && !!registry;
  const remoteRevisions = useSyncExternalStore(
    (onChange) => linkedLayoutUpdates.subscribe(onChange),
    () => linkedLayoutUpdates.snapshot(),
  );
  const teamSnapshot = useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  );
  const tabGroups = useMemo(
    () => buildStatusBarTabGroups(layouts, activeLayoutIdx, teamSnapshot.teams, teamSnapshot.focus, teamSnapshot.toggledGroups),
    [activeLayoutIdx, layouts, teamSnapshot.focus, teamSnapshot.teams, teamSnapshot.toggledGroups],
  );
  const layoutTab = (index: number) => {
    const layout = layouts[index]!;
    // Linked tabs show `*` when edited locally and `↓` when the team is ahead.
    const marker = layout.origin && registry
      ? linkedLayoutMarker(linkedLayoutStatus(layout, registry.panes, remoteRevisions.get(layout.origin.layoutId)))
      : "";
    return {
      label: `${tabKey(index)}${truncate(layout.name, 14)}${marker}`,
      value: String(index),
      reorderable: true,
    };
  };
  // Tabs grouped by owner: personal first, then one marker per team in its
  // accent followed by that team's tabs. A collapsed group keeps its marker
  // with the tab count. The digit keys stay positional through the index labels.
  const savedLayoutTabs = tabGroups.length <= 1
    ? layouts.map((_, index) => layoutTab(index))
    : tabGroups.flatMap((group) => {
      const marker = group.team
        ? {
          label: `${group.team.shortName}·${group.collapsed ? `(${group.indexes.length})` : ""}`,
          value: groupMarkerValue(group.id),
          reorderable: false,
          fg: teamAccentHex(group.team.accentColor),
        }
        : group.collapsed
          ? { label: `me·(${group.indexes.length})`, value: groupMarkerValue(group.id), reorderable: false }
          : null;
      return [
        ...(marker ? [marker] : []),
        ...(group.collapsed ? [] : group.indexes.map(layoutTab)),
      ];
    });
  const layoutTabs = transientLayout
    ? [
      ...savedLayoutTabs,
      {
        label: [transientLayout.shortcutActionId ? actionKey(transientLayout.shortcutActionId) : "", transientLayout.label]
          .filter(Boolean)
          .join(" "),
        value: transientLayout.id,
        reorderable: false,
      },
    ]
    : savedLayoutTabs;
  const layoutTabsWidth = layoutTabs.reduce((sum, tab) => sum + tab.label.length + 2, 0);
  const activeLayoutValue = transientLayout?.active ? transientLayout.id : String(activeLayoutIdx);
  const handleLayoutSelect = (value: string) => {
    const groupId = groupIdFromMarkerValue(value);
    if (groupId) {
      teamStore.toggleGroup(groupId);
      return;
    }
    if (value === transientLayout?.id) {
      if (transientLayout.active) {
        transientLayout.onExit?.();
      } else {
        transientLayout.onActivate?.();
      }
      return;
    }
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= layouts.length) return;
    if (transientLayout?.active) {
      transientLayout.onDeactivate?.();
    }
    dispatch({ type: "SWITCH_LAYOUT", index });
  };
  const handleLayoutReorder = (fromValue: string, toValue: string) => {
    if (groupIdFromMarkerValue(fromValue) || groupIdFromMarkerValue(toValue)) return;
    const fromIndex = Number(fromValue);
    const toIndex = Number(toValue);
    if (
      !Number.isInteger(fromIndex)
      || !Number.isInteger(toIndex)
      || fromIndex < 0
      || toIndex < 0
      || fromIndex >= layouts.length
      || toIndex >= layouts.length
      || fromIndex === toIndex
    ) return;
    dispatch({ type: "REORDER_LAYOUT", fromIndex, toIndex });
  };

  const handleTidyWindows = (event?: StatusBarEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!registry) return;

    const currentLayout = registry.getLayoutFn();
    const { width, height } = registry.getTermSizeFn();
    const nextLayout = gridlockAllPanes(
      currentLayout,
      { x: 0, y: 0, width, height },
      registry.panes,
    );
    if (nextLayout === currentLayout) return;

    registry.updateLayoutFn(nextLayout);
    notifyGridlockComplete(registry.notify.bind(registry), () => {
      dispatch({ type: "UNDO_LAYOUT" });
    });
  };

  const openChangelog = (event?: StatusBarEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    onOpenChangelog?.(VERSION);
  };

  const requestDeleteLayout = useCallback(async (index: number) => {
    const layout = layouts[index];
    if (!layout || layouts.length <= 1) return;
    const confirmed = await dialog.prompt<boolean>({
      closeOnClickOutside: true,
      content: (context: PromptContext<boolean>) => (
        <ConfirmDialog
          {...context}
          title={t("Delete Layout")}
          body={[`Delete layout "${layout.name}"? This cannot be undone.`]}
          confirmLabel={t("Delete Layout")}
          cancelLabel={t("Cancel")}
          width={48}
        />
      ),
    }).catch(() => false);
    if (confirmed !== true) return;
    dispatch({ type: "DELETE_LAYOUT", index });
    registry?.notify({ body: `Layout "${layout.name}" deleted`, type: "success" });
  }, [dialog, dispatch, layouts, registry]);

  const layoutContextMenuItems = useCallback((index: number): ContextMenuItem[] => {
    const layout = layouts[index];
    if (!layout) return [];
    const active = index === activeLayoutIdx;
    const switchToLayout = () => {
      if (!active) {
        dispatch({ type: "SWITCH_LAYOUT", index });
      }
    };
    const openWorkflowForLayout = (commandId: string) => {
      switchToLayout();
      registry?.openPluginCommandWorkflow(commandId);
    };
    const items: ContextMenuItem[] = [];

    if (!active) {
      items.push({
        id: "layout:switch",
        label: tf("Switch to {name}", { name: layout.name }),
        onSelect: () => dispatch({ type: "SWITCH_LAYOUT", index }),
      });
      items.push(contextMenuDivider("layout:switch-divider"));
    }

    items.push(
      {
        id: "layout:rename",
        label: "Rename Layout...",
        onSelect: () => openWorkflowForLayout("rename-layout"),
      },
      {
        id: "layout:duplicate",
        label: "Duplicate Layout",
        onSelect: () => dispatch({ type: "DUPLICATE_LAYOUT", index }),
      },
      {
        id: "layout:new",
        label: "New Layout...",
        onSelect: () => registry?.openPluginCommandWorkflow("new-layout"),
      },
      {
        id: "layout:delete",
        label: "Delete Layout...",
        enabled: layouts.length > 1,
        onSelect: () => requestDeleteLayout(index),
      },
      contextMenuDivider("layout:actions-divider"),
      {
        id: "layout:gallery",
        label: "Browse Layouts...",
        onSelect: () => registry?.showPane("layout-marketplace"),
      },
      {
        id: "layout:actions",
        label: "Layout Actions...",
        onSelect: () => registry?.openCommandBar("LMA "),
      },
    );

    return items;
  }, [activeLayoutIdx, dispatch, layouts, registry, requestDeleteLayout]);

  const openLayoutContextMenu = useCallback((
    index: number,
    event: { preventDefault?: () => void; stopPropagation?: () => void },
  ) => {
    const layout = layouts[index];
    if (!layout) return Promise.resolve(false);
    return showContextMenu(
      {
        kind: "layout",
        layoutIndex: index,
        layoutName: layout.name,
        active: index === activeLayoutIdx,
      },
      layoutContextMenuItems(index),
      event,
    );
  }, [activeLayoutIdx, layoutContextMenuItems, layouts, showContextMenu]);
  const handleLayoutTabContextMenu = useCallback((value: string, event: any) => {
    if (value === transientLayout?.id) return;
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= layouts.length) return;
    if (event?.type !== "contextmenu" && event?.button === 2 && nativeContextMenu === true) return;
    void openLayoutContextMenu(index, event);
  }, [layouts.length, nativeContextMenu, openLayoutContextMenu, transientLayout?.id]);
  const layoutTabItems = layoutTabs.map((tab) => ({
    ...tab,
    onContextMenu: handleLayoutTabContextMenu,
  }));

  if (!statusBarVisible) return null;

  const tidyWindowsKey = actionKey("tidy-windows");
  const leftWidth = 1
    + (hasMultipleLayouts ? layoutTabsWidth : 0)
    + (showTidyWindows ? terminalTidyWindowsLabel(tidyWindowsKey).length + 1 : 0);

  const viewProps: StatusBarViewProps = {
    activeLayoutIdx,
    activeLayoutValue,
    handleLayoutReorder,
    handleLayoutSelect,
    handleTidyWindows,
    hasMultipleLayouts,
    hoveredControl,
    layoutTabItems,
    layoutTabsWidth,
    openChangelog: onOpenChangelog ? openChangelog : undefined,
    openLayoutContextMenu,
    rightAvailableWidth: Math.max(0, termWidth - leftWidth - STATUS_WIDGET_COLUMNS),
    setHoveredControl,
    showTidyWindows,
    tidyWindowsKey,
  };

  if (nativePaneChrome) {
    return <NativeStatusBar {...viewProps} />;
  }

  return <TerminalStatusBar {...viewProps} />;
}

function NativeStatusBar({
  activeLayoutIdx,
  openLayoutContextMenu,
  showTidyWindows,
  ...props
}: StatusBarViewProps) {
  const colors = useThemeColors();
  return (
    <Box
      flexDirection="row"
      height={1}
      alignItems="center"
      backgroundColor={colors.panel}
      data-gloom-role="status-bar"
      onContextMenu={(event: any) => {
        void openLayoutContextMenu(activeLayoutIdx, event);
      }}
      style={{
        borderTop: `1px solid ${colors.border}`,
        boxShadow: `inset 0 1px 0 ${blendHex(colors.panel, colors.textBright, 0.03)}`,
        paddingInline: 8,
      }}
    >
      <StatusBarLayoutControl nativePaneChrome {...props} />
      {showTidyWindows && <NativeTidyWindows {...props} />}
      <Box flexGrow={1} minWidth={0} />
      <StatusBarSummary nativePaneChrome {...props} />
      <PluginSlot name="status:widget" />
    </Box>
  );
}

function TerminalStatusBar({
  activeLayoutIdx,
  openLayoutContextMenu,
  showTidyWindows,
  ...props
}: StatusBarViewProps) {
  const colors = useThemeColors();
  return (
    <Box
      flexDirection="row"
      height={1}
      alignItems="center"
      backgroundColor={colors.panel}
      data-gloom-role="status-bar"
      onContextMenu={(event: any) => {
        void openLayoutContextMenu(activeLayoutIdx, event);
      }}
    >
      <StatusBarLayoutControl nativePaneChrome={false} {...props} />
      {showTidyWindows && <TerminalTidyWindows {...props} />}
      <Box flexGrow={1} minWidth={0} />
      <StatusBarSummary nativePaneChrome={false} {...props} />
      <PluginSlot name="status:widget" />
    </Box>
  );
}

function StatusBarLayoutControl({
  activeLayoutValue,
  handleLayoutSelect,
  handleLayoutReorder,
  hasMultipleLayouts,
  layoutTabItems,
  layoutTabsWidth,
  nativePaneChrome,
}: Pick<
  StatusBarViewProps,
  | "activeLayoutValue"
  | "handleLayoutSelect"
  | "handleLayoutReorder"
  | "hasMultipleLayouts"
  | "layoutTabItems"
  | "layoutTabsWidth"
> & { nativePaneChrome: boolean }) {
  if (!hasMultipleLayouts) return null;
  return (
    <Box
      paddingLeft={1}
      flexShrink={0}
      flexDirection="row"
      {...(nativePaneChrome ? { alignItems: "center", gap: 1 } : {})}
    >
      <Box width={layoutTabsWidth} height={1}>
        <Tabs
          tabs={layoutTabItems}
          activeValue={activeLayoutValue}
          onSelect={handleLayoutSelect}
          onReorder={handleLayoutReorder}
          compact
          variant="pill"
        />
      </Box>
    </Box>
  );
}

/**
 * The version chip and, on the hosted web app, a link to the desktop app.
 * The link goes first when the row runs out of room, then the version. Live
 * market status lives at the header's right edge, not here, so nothing in the
 * status bar repeats it.
 */
function StatusBarSummary({
  hoveredControl,
  nativePaneChrome,
  openChangelog,
  rightAvailableWidth,
  setHoveredControl,
}: Pick<
  StatusBarViewProps,
  "hoveredControl" | "openChangelog" | "rightAvailableWidth" | "setHoveredControl"
> & { nativePaneChrome: boolean }) {
  const rendererHost = useRendererHost();
  const versionLabel = `v${VERSION}`;
  const downloadLabel = t("Download desktop app");
  const showVersion = rightAvailableWidth >= versionLabel.length + 1;
  const showDownload = getCurrentPluginTarget() === "web"
    && rightAvailableWidth >= versionLabel.length + 1 + downloadLabel.length + 1;
  if (!showVersion) return null;
  return (
    <>
      <StatusBarChip
        hoveredControl={hoveredControl}
        id="version"
        label={versionLabel}
        nativePaneChrome={nativePaneChrome}
        onPress={openChangelog}
        role="button"
        setHoveredControl={setHoveredControl}
        // CHG opens the same notes from the command bar, where the keyboard can reach them.
        title={openChangelog ? `${tf("Open changelog for {version}", { version: versionLabel })} (CHG)` : undefined}
      />
      {showDownload && (
        <StatusBarChip
          hoveredControl={hoveredControl}
          id="desktop-download"
          label={downloadLabel}
          nativePaneChrome={nativePaneChrome}
          onPress={() => { void rendererHost.openExternal(DESKTOP_DOWNLOAD_URL); }}
          role="link"
          setHoveredControl={setHoveredControl}
          title={t("Get Gloomberb for Mac or Windows")}
        />
      )}
    </>
  );
}

/** Dim text at the row's right edge that lights up when it can be pressed. */
function StatusBarChip({
  hoveredControl,
  id,
  label,
  nativePaneChrome,
  onPress,
  role,
  setHoveredControl,
  title,
}: Pick<StatusBarViewProps, "hoveredControl" | "setHoveredControl"> & {
  id: string;
  label: string;
  nativePaneChrome: boolean;
  onPress?: (event?: StatusBarEvent) => void;
  role: "button" | "link";
  title?: string;
}) {
  const colors = useThemeColors();
  const hovered = hoveredControl === id;
  if (nativePaneChrome && onPress) {
    return (
      <Box paddingRight={1} flexShrink={0}>
        <Button variant="plain" compact label={title ?? label} displayLabel={label} title={title} onPress={() => onPress()} />
      </Box>
    );
  }
  const press = onPress
    ? (event?: StatusBarEvent) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onPress(event);
    }
    : undefined;
  return (
    <Box paddingRight={1} flexShrink={0}>
      <Text
        fg={hovered && press ? colors.text : colors.textDim}
        {...(!nativePaneChrome ? { bg: hovered && press ? hoverBg(colors) : undefined } : {})}
        title={press ? title : undefined}
        aria-label={press ? title : undefined}
        role={press ? role : undefined}
        tabIndex={press ? 0 : undefined}
        onMouseOver={() => setHoveredControl((current) => (current === id ? current : id))}
        onMouseOut={() => setHoveredControl((current) => (current === id ? null : current))}
        onMouseDown={press}
        onKeyDown={press
          ? (event: StatusBarEvent & { key?: string }) => {
            if (event.key === "Enter") press(event);
          }
          : undefined}
        style={press ? { cursor: "pointer" } : undefined}
      >
        {label}
      </Text>
    </Box>
  );
}

function NativeTidyWindows({ handleTidyWindows, tidyWindowsKey }: Pick<StatusBarViewProps, "handleTidyWindows" | "tidyWindowsKey">) {
  return (
    <Box paddingLeft={2} flexShrink={0} flexDirection="row" alignItems="center">
      {/* Active keeps it as prominent as the old accent label beside the layout tabs. */}
      <Button
        variant="plain"
        compact
        active
        label="Tidy Windows"
        shortcut={tidyWindowsKey || undefined}
        onPress={() => handleTidyWindows()}
      />
    </Box>
  );
}

/** The terminal control's text, key first like the layout tabs beside it. */
function terminalTidyWindowsLabel(key: string): string {
  return ` ${key ? `${key} ` : ""}${t("Tidy Windows")} `;
}

function TerminalTidyWindows({
  handleTidyWindows,
  hoveredControl,
  setHoveredControl,
  tidyWindowsKey,
}: Pick<StatusBarViewProps, "handleTidyWindows" | "hoveredControl" | "setHoveredControl" | "tidyWindowsKey">) {
  const colors = useThemeColors();
  const hovered = hoveredControl === "tidy-windows";
  return (
    <Box paddingLeft={1} flexShrink={0} flexDirection="row">
      <Box
        backgroundColor={hovered ? hoverBg(colors) : colors.header}
        onMouseOver={() => setHoveredControl((current) => (current === "tidy-windows" ? current : "tidy-windows"))}
        onMouseDown={handleTidyWindows}
      >
        <Text fg={colors.headerText}>{terminalTidyWindowsLabel(tidyWindowsKey)}</Text>
      </Box>
    </Box>
  );
}
