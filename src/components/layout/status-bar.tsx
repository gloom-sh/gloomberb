import {
  Box,
  Text,
  contextMenuDivider,
  useContextMenu,
  useUiCapabilities,
  useUiHost,
} from "../../ui";
import { useDialog } from "../../ui/dialog";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { hoverBg } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { useAppDispatch, useAppSelector } from "../../state/app/context";
import { useAppChromeShown } from "./presentation";
import { useViewport } from "../../react/input";
import {
  advertisedChord,
  formatChordForHost,
  useKeybindings,
  type KeyChord,
} from "../../app/keybindings";
import { getShortcutDisplayMode, type ShortcutDisplayMode } from "../../utils/shortcut-labels";
import { getSharedRegistry } from "../../plugins/registry";
import {
  shouldShowTidyWindows,
  tidyWindows,
} from "../../layout/pane-manager";
import { PluginSlot } from "../../react/plugins/plugin-slot";
import type { ContextMenuItem } from "../../types/context-menu";
import { displayWidth } from "../../utils/format";
import { Button } from "../ui/button";
import { confirmDialog } from "../ui/confirm-dialog";
import { Tabs } from "../ui/tabs";
import { useTransientLayout } from "./transient-layout";
import { linkedLayoutMarker, linkedLayoutStatus, linkedLayoutUpdates } from "../../layout-marketplace/linked";
import { teamAccentHex } from "../../team/model";
import { teamStore } from "../../team/store";
import { buildStatusBarTabGroups, groupIdFromMarkerValue, groupMarkerValue } from "./status-bar-groups";
import { requestFeedbackDialog } from "../feedback-dialog";
import { openFormModal } from "../form-modal";
import { getDesktopWindows, layoutMoveTargets } from "../../state/desktop-windows";
import { fireAndForget } from "../../utils/fire-and-forget";
import { recordFunctionOpen } from "../../telemetry/usage-counts";
import {
  NARROW_STATUS_BAR_COLUMNS,
  STATUS_WIDGET_COLUMNS,
  useClaimedStatusWidgetColumns,
  usePublishStatusWidgetRoom,
} from "./status-widget-space";
import { StarPromptStatusLine } from "../../app/star-prompt/status-line";
import { connectionHealth as sharedConnectionHealth, GLOOM_CLOUD_HTTP_CONNECTION_ID } from "../../core/connection-health";
import { DATA_SERVICE_UNREACHABLE_MESSAGE } from "../../utils/network-failure";

type StatusBarEvent = { stopPropagation?: () => void; preventDefault?: () => void };
type HoveredControl = string | null;
type SetHoveredControl = (updater: (current: HoveredControl) => HoveredControl) => void;

/**
 * The note while the data service gives no answer at all, and its short form
 * for a narrow terminal. Every pane's own failure says why; this says once,
 * for the whole app, that it is the connection, and goes when it answers.
 */
const CONNECTION_NOTE = "Can't reach the data service";
const CONNECTION_NOTE_SHORT = "Offline";

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
  openLayoutContextMenu: (index: number, event: any) => void | Promise<unknown>;
  /** The connection note to show (CONNECTION_NOTE or its short form), or null while the data service answers. */
  connectionNote: string | null;
  openConnections: () => void;
  setHoveredControl: SetHoveredControl;
  showTidyWindows: boolean;
};

/**
 * A chord as short as a tab label allows: `^2`, `^⇧F`, and on a Mac `⌘2` or
 * `⇧⌘F`. A digit chord names the one digit given.
 */
function compactChordLabel(chord: KeyChord, mode: ShortcutDisplayMode, digit?: number): string {
  const named = chord.key === "digit" && digit !== undefined ? { ...chord, key: String(digit) } : chord;
  return formatChordForHost(named, mode, undefined, { compact: true });
}

/** A name cut to `width` keeps its start and ends in an ellipsis: `FX Desk - …`. */
function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1).trimEnd()}…`;
}

/** The longest a layout tab's name runs, and the shortest a narrow bar cuts every name to before its tabs scroll. */
const LAYOUT_NAME_MAX = 14;
const LAYOUT_NAME_MIN = 8;

const openLayoutWorkflow = (actionId: "new-layout" | "rename-layout") => {
  openFormModal({ kind: "builtin", actionId });
};

const openNewLayout = (event?: StatusBarEvent) => {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  openLayoutWorkflow("new-layout");
};

const TERMINAL_NEW_LAYOUT_LABEL = " + ";

export function StatusBar() {
  const { nativePaneChrome, nativeContextMenu } = useUiCapabilities();
  const { showContextMenu } = useContextMenu();
  const dialog = useDialog();
  const registry = getSharedRegistry();
  const dispatch = useAppDispatch();
  const { width: termWidth } = useViewport();
  const layouts = useAppSelector((state) => state.config.layouts);
  const activeLayoutIdx = useAppSelector((state) => state.config.activeLayoutIndex);
  const statusBarVisible = useAppChromeShown().statusBar;
  const layout = useAppSelector((state) => state.config.layout);
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
    switchChord?.key === "digit" && index < 9 ? `${compactChordLabel(switchChord, shortcutMode, index + 1)} ` : ""
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
  /** How the tab in front is cut on a strip too narrow for it: its name's length, and whether its key stays. */
  type ActiveTabCut = { nameWidth: number; key: boolean };
  // Linked tabs show `*` when edited locally and `↓` when the team is ahead: read once a render, whatever the
  // passes below try.
  const layoutMarkers = layouts.map((layout) => (layout.origin && registry
    ? linkedLayoutMarker(linkedLayoutStatus(layout, registry.panes, remoteRevisions.get(layout.origin.layoutId)))
    : ""));
  const layoutTab = (index: number, nameWidth: number, activeCut?: ActiveTabCut) => {
    const layout = layouts[index]!;
    const cut = index === activeLayoutIdx ? activeCut : undefined;
    const key = cut?.key === false ? "" : tabKey(index);
    return {
      label: `${key}${truncate(layout.name, cut?.nameWidth ?? nameWidth)}${layoutMarkers[index] ?? ""}`,
      ...(key ? { keyPrefix: key } : {}),
      value: String(index),
      reorderable: true,
    };
  };
  // Tabs grouped by owner: personal first, then one marker per team in its
  // accent followed by that team's tabs. A collapsed group keeps its marker
  // with the tab count. The digit keys stay positional through the index labels.
  const savedLayoutTabsAt = (nameWidth: number, activeCut?: ActiveTabCut) => tabGroups.length <= 1
    ? layouts.map((_, index) => layoutTab(index, nameWidth, activeCut))
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
        ...(group.collapsed ? [] : group.indexes.map((index) => layoutTab(index, nameWidth, activeCut))),
      ];
    });
  const tidyWindowsKey = actionKey("tidy-windows");
  const controlsWidth = (TERMINAL_NEW_LAYOUT_LABEL.length + 1)
    + (showTidyWindows ? terminalTidyWindowsLabel(tidyWindowsKey).length + 1 : 0);
  const feedbackWidth = displayWidth(t("Feedback")) + 1;
  // In the terminal the tabs get what the row has left once New Layout, Tidy
  // Windows, Feedback and the widgets' columns are counted, and scroll past
  // that, so a long list of layouts never pushes those controls off screen.
  const tabsRoom = Math.max(0, termWidth - 1 - controlsWidth - feedbackWidth - STATUS_WIDGET_COLUMNS);
  const tabsWidthOf = (tabs: readonly { label: string }[]) => tabs.reduce((sum, tab) => sum + tab.label.length + 2, 0);
  // On a narrow terminal the names are cut to fit the strip, each keeping
  // its start, down to a length that still reads; a strip that holds them at
  // none of those scrolls with the names whole, as every strip on a wider
  // terminal does. Only the one in front is cut to the strip's width: its
  // name to a few letters, then without its key. A scrolled strip showed the
  // end of a name (`CIO` of `FX Desk - CIO`).
  const overflowsAt = (width: number) => !nativePaneChrome && tabsWidthOf(savedLayoutTabsAt(width)) > tabsRoom;
  let nameWidth = LAYOUT_NAME_MAX;
  if (termWidth < NARROW_STATUS_BAR_COLUMNS) {
    while (overflowsAt(nameWidth) && nameWidth > LAYOUT_NAME_MIN) nameWidth -= 1;
    if (overflowsAt(nameWidth)) nameWidth = LAYOUT_NAME_MAX;
  }
  const activeCut: ActiveTabCut = { nameWidth, key: true };
  const activeTooWide = () => !nativePaneChrome && !!layouts[activeLayoutIdx]
    && layoutTab(activeLayoutIdx, nameWidth, activeCut).label.length + 2 > tabsRoom;
  while (activeTooWide() && activeCut.nameWidth > 3) activeCut.nameWidth -= 1;
  if (activeTooWide()) Object.assign(activeCut, { key: false, nameWidth });
  while (activeTooWide() && activeCut.nameWidth > 1) activeCut.nameWidth -= 1;
  const savedLayoutTabs = savedLayoutTabsAt(nameWidth, activeCut);
  const transientKey = transientLayout?.shortcutActionId ? actionKey(transientLayout.shortcutActionId) : "";
  const layoutTabs = transientLayout
    ? [
      ...savedLayoutTabs,
      {
        label: [transientKey, transientLayout.label].filter(Boolean).join(" "),
        ...(transientKey ? { keyPrefix: `${transientKey} ` } : {}),
        value: transientLayout.id,
        reorderable: false,
      },
    ]
    : savedLayoutTabs;
  const layoutTabsWidth = tabsWidthOf(layoutTabs);
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
    tidyWindows({
      layout: registry.getLayout(),
      size: registry.getTermSize(),
      paneTypes: registry.panes,
      apply: registry.updateLayout,
      notify: registry.notify,
      onRevert: () => dispatch({ type: "UNDO_LAYOUT" }),
    });
  };

  const requestDeleteLayout = useCallback(async (index: number) => {
    const layout = layouts[index];
    if (!layout || layouts.length <= 1) return;
    const confirmed = await confirmDialog(dialog, {
      title: t("Delete Layout"),
      body: [`Delete layout "${layout.name}"? This cannot be undone.`],
      confirmLabel: t("Delete Layout"),
      cancelLabel: t("Cancel"),
      width: 48,
    });
    if (!confirmed) return;
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
        onSelect: () => {
          switchToLayout();
          openLayoutWorkflow("rename-layout");
        },
      },
      {
        id: "layout:duplicate",
        label: "Duplicate Layout",
        onSelect: () => dispatch({ type: "DUPLICATE_LAYOUT", index }),
      },
      {
        id: "layout:new",
        label: "New Layout...",
        onSelect: () => openLayoutWorkflow("new-layout"),
      },
      {
        id: "layout:add-desk",
        label: "Add a Desk...",
        onSelect: () => registry?.openCommandBar("DESK "),
      },
      {
        id: "layout:delete",
        label: "Delete Layout...",
        enabled: layouts.length > 1,
        onSelect: () => requestDeleteLayout(index),
      },
    );
    // The desktop app's other windows, where the tab can go.
    const windows = getDesktopWindows();
    const layoutId = layout.id;
    if (windows && layoutId) {
      const moves = layoutMoveTargets(windows, layouts.length);
      if (moves.length > 0) items.push(contextMenuDivider("layout:window-divider"));
      for (const move of moves) {
        items.push({
          id: `layout:move-to-window:${move.key}`,
          label: move.label,
          onSelect: () => {
            fireAndForget(windows.moveLayout(layoutId, move.target), "desktop.moveLayoutToWindow");
          },
        });
      }
    }
    items.push(
      contextMenuDivider("layout:actions-divider"),
      {
        id: "layout:gallery",
        label: "Browse Layouts...",
        onSelect: () => {
          recordFunctionOpen({ shortcut: "LAY", externalPluginId: null });
          registry?.showPane("layout-marketplace");
        },
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

  // Unreachable from the first request that got no answer until anything answers again.
  const health = registry?.connectionHealth ?? sharedConnectionHealth;
  const subscribeHealth = useCallback((onChange: () => void) => health.subscribe(onChange), [health]);
  const dataServiceUnreachable = useSyncExternalStore(
    subscribeHealth,
    () => health.unreachableSince(GLOOM_CLOUD_HTTP_CONNECTION_ID) != null,
  );
  const openConnections = () => {
    registry?.showPane("connections");
  };

  const claimedWidgetColumns = useClaimedStatusWidgetColumns();
  const tabsWidth = nativePaneChrome ? layoutTabsWidth : Math.min(layoutTabsWidth, tabsRoom);
  const leftWidth = 1 + (hasMultipleLayouts ? tabsWidth : 0) + controlsWidth;
  usePublishStatusWidgetRoom(statusBarVisible ? Math.max(0, termWidth - leftWidth - feedbackWidth) : 0);

  if (!statusBarVisible) return null;

  // Feedback keeps the bottom-right corner; the connection note comes before
  // the widgets and gives way to a widget that claimed more than the usual
  // room. A narrow terminal shortens the note.
  const rightWidth = Math.max(0, termWidth - leftWidth - STATUS_WIDGET_COLUMNS - claimedWidgetColumns - feedbackWidth);
  const connectionNote = !dataServiceUnreachable ? null
    : nativePaneChrome || rightWidth >= displayWidth(t(CONNECTION_NOTE)) + 1 ? CONNECTION_NOTE
      : rightWidth >= displayWidth(t(CONNECTION_NOTE_SHORT)) + 1 ? CONNECTION_NOTE_SHORT : null;

  const viewProps: StatusBarViewProps = {
    activeLayoutIdx,
    activeLayoutValue,
    handleLayoutReorder,
    handleLayoutSelect,
    handleTidyWindows,
    hasMultipleLayouts,
    hoveredControl,
    layoutTabItems,
    layoutTabsWidth: tabsWidth,
    openLayoutContextMenu,
    connectionNote,
    openConnections,
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
      // The hairline above it and the type are styles.css's, as the pane footer's are.
      style={{ paddingInline: "var(--gloom-inset)" }}
    >
      <StatusBarLayoutControl nativePaneChrome {...props} />
      <NativeNewLayout />
      {showTidyWindows && <NativeTidyWindows {...props} />}
      <Box flexGrow={1} minWidth={0} />
      <StatusBarConnectionNote nativePaneChrome {...props} />
      {/* Widgets keep their width; the layout tabs give way instead. */}
      <Box flexShrink={0} flexDirection="row" alignItems="center" data-gloom-role="status-widgets">
        <PluginSlot name="status:widget" />
      </Box>
      <StatusBarFeedback nativePaneChrome {...props} />
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
      <TerminalNewLayout {...props} />
      {showTidyWindows && <TerminalTidyWindows {...props} />}
      <Box flexGrow={1} minWidth={0} />
      <StatusBarConnectionNote nativePaneChrome={false} {...props} />
      <StarPromptStatusLine />
      <PluginSlot name="status:widget" />
      <StatusBarFeedback nativePaneChrome={false} {...props} />
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
  const colors = useThemeColors();
  if (!hasMultipleLayouts) return null;
  // On the desktop and the web the strip is as wide as its tabs, gives way
  // first when the bar runs out of room and scrolls inside, like the
  // terminal's sized strip.
  const shrink = nativePaneChrome ? { flexShrink: 1, minWidth: 0 } : { flexShrink: 0 };
  return (
    <Box
      paddingLeft={1}
      flexDirection="row"
      {...shrink}
      {...(nativePaneChrome ? { alignItems: "center", gap: 1 } : {})}
    >
      <Box height={1} {...(nativePaneChrome ? shrink : { width: layoutTabsWidth })}>
        <Tabs
          tabs={layoutTabItems}
          activeValue={activeLayoutValue}
          onSelect={handleLayoutSelect}
          onReorder={handleLayoutReorder}
          compact
          variant="pill"
          background={colors.panel}
        />
      </Box>
    </Box>
  );
}

/**
 * Says the data service is unreachable while it is, in the warning tone a
 * pane footer gives a failure; it opens Connections, which has the detail.
 */
function StatusBarConnectionNote({
  connectionNote,
  hoveredControl,
  nativePaneChrome,
  openConnections,
  setHoveredControl,
}: Pick<StatusBarViewProps, "connectionNote" | "hoveredControl" | "openConnections" | "setHoveredControl"> & { nativePaneChrome: boolean }) {
  if (!connectionNote) return null;
  return (
    <StatusBarChip
      hoveredControl={hoveredControl}
      id="connection"
      label={t(connectionNote)}
      nativePaneChrome={nativePaneChrome}
      onPress={openConnections}
      role="button"
      setHoveredControl={setHoveredControl}
      title={`${t(DATA_SERVICE_UNREACHABLE_MESSAGE)}. ${t("Open Connections")} (CONN)`}
      tone="warning"
    />
  );
}

/** Opens Send Feedback from the bottom-right corner, on every renderer. */
function StatusBarFeedback({
  hoveredControl,
  nativePaneChrome,
  setHoveredControl,
}: Pick<StatusBarViewProps, "hoveredControl" | "setHoveredControl"> & { nativePaneChrome: boolean }) {
  return (
    <StatusBarChip
      hoveredControl={hoveredControl}
      id="feedback"
      label={t("Feedback")}
      nativePaneChrome={nativePaneChrome}
      onPress={() => { requestFeedbackDialog(); }}
      role="button"
      setHoveredControl={setHoveredControl}
      title={t("Send Feedback")}
    />
  );
}

/**
 * Dim text at the row's right edge that lights up when it can be pressed; a
 * `warning` one keeps the warning tone, as a footer's failure does.
 */
function StatusBarChip({
  hoveredControl,
  id,
  label,
  nativePaneChrome,
  onPress,
  role,
  setHoveredControl,
  title,
  tone,
}: Pick<StatusBarViewProps, "hoveredControl" | "setHoveredControl"> & {
  id: string;
  label: string;
  nativePaneChrome: boolean;
  onPress?: (event?: StatusBarEvent) => void;
  role: "button";
  title?: string;
  tone?: "warning";
}) {
  const colors = useThemeColors();
  const hovered = hoveredControl === id;
  if (nativePaneChrome && onPress) {
    return (
      <Box paddingRight={1} flexShrink={0}>
        <Button variant="plain" compact label={title ?? label} displayLabel={tone ? undefined : label} title={title} onPress={() => onPress()}>
          {tone ? <Text fg={colors[tone]}>{label}</Text> : undefined}
        </Button>
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
        fg={tone ? colors[tone] : hovered && press ? colors.text : colors.textDim}
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

const NativeNewLayout = () => (
  <Box paddingLeft={1} flexShrink={0} flexDirection="row" alignItems="center">
    <Button
      variant="plain"
      compact
      label={t("New Layout")}
      displayLabel="+"
      title={t("New Layout")}
      onPress={() => openNewLayout()}
    />
  </Box>
);

/** A pressable pill on the terminal row, lit while the pointer is over it. */
function TerminalStatusPill({
  hoveredControl,
  id,
  label,
  onPress,
  setHoveredControl,
}: Pick<StatusBarViewProps, "hoveredControl" | "setHoveredControl"> & {
  id: string;
  label: string;
  onPress: (event?: StatusBarEvent) => void;
}) {
  const colors = useThemeColors();
  const hovered = hoveredControl === id;
  return (
    <Box paddingLeft={1} flexShrink={0} flexDirection="row">
      <Box
        backgroundColor={hovered ? hoverBg(colors) : colors.header}
        onMouseOver={() => setHoveredControl((current) => (current === id ? current : id))}
        onMouseOut={() => setHoveredControl((current) => (current === id ? null : current))}
        onMouseDown={onPress}
      >
        <Text fg={colors.headerText}>{label}</Text>
      </Box>
    </Box>
  );
}

const TerminalNewLayout = (props: Pick<StatusBarViewProps, "hoveredControl" | "setHoveredControl">) => (
  <TerminalStatusPill {...props} id="new-layout" label={TERMINAL_NEW_LAYOUT_LABEL} onPress={openNewLayout} />
);

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
  tidyWindowsKey,
  ...props
}: Pick<StatusBarViewProps, "handleTidyWindows" | "hoveredControl" | "setHoveredControl" | "tidyWindowsKey">) {
  return (
    <TerminalStatusPill {...props} id="tidy-windows" label={terminalTidyWindowsLabel(tidyWindowsKey)} onPress={handleTidyWindows} />
  );
}
