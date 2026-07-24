import { Box, Span, Text, TextAttributes, contextMenuDivider, useContextMenu, useUiCapabilities } from "../../ui";
import { useCallback, useEffect, useState } from "react";
import { blendHex, colors, hoverBg } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { useAppDispatch, useAppSelector } from "../../state/app/context";
import {
  selectActiveLayoutIndex,
  selectGridlockTipSequence,
  selectGridlockTipVisible,
  selectSavedLayouts,
  selectStatusBarVisible,
} from "../../state/selectors-ui";
import { getSharedRegistry } from "../../plugins/registry";
import { gridlockAllPanes } from "../../plugins/pane-manager";
import { notifyGridlockComplete } from "../../plugins/gridlock-notification";
import { PluginSlot } from "../../react/plugins/plugin-slot";
import type { ContextMenuItem } from "../../types/context-menu";
import { Tabs } from "../ui/tabs";
import { useTransientLayout } from "./transient-layout";

const GRIDLOCK_TIP_DURATION_MS = 60_000;

type StatusBarEvent = { stopPropagation?: () => void; preventDefault?: () => void };
type HoveredControl = string | null;
type SetHoveredControl = (updater: (current: HoveredControl) => HoveredControl) => void;

type LayoutTabItem = {
  label: string;
  value: string;
  onContextMenu: (value: string, event: any) => void;
};

type StatusBarViewProps = {
  activeLayoutIdx: number;
  activeLayoutValue: string;
  dismissGridlockTip: (event?: StatusBarEvent) => void;
  handleGridlockTip: (event?: StatusBarEvent) => void;
  handleLayoutSelect: (value: string) => void;
  hasMultipleLayouts: boolean;
  hoveredControl: HoveredControl;
  layoutTabItems: LayoutTabItem[];
  layoutTabsWidth: number;
  openCommandBar: (event?: StatusBarEvent) => void;
  openLayouts: (event?: StatusBarEvent) => void;
  openLayoutContextMenu: (index: number, event: any) => void | Promise<unknown>;
  setHoveredControl: SetHoveredControl;
  showGridlockTip: boolean;
};

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 2) return ".".repeat(width);
  return `${text.slice(0, width - 2)}..`;
}

export function StatusBar() {
  useThemeColors();
  const { nativePaneChrome, nativeContextMenu } = useUiCapabilities();
  const { showContextMenu } = useContextMenu();
  const registry = getSharedRegistry();
  const dispatch = useAppDispatch();
  const layouts = useAppSelector(selectSavedLayouts);
  const activeLayoutIdx = useAppSelector(selectActiveLayoutIndex);
  const statusBarVisible = useAppSelector(selectStatusBarVisible);
  const gridlockTipVisible = useAppSelector(selectGridlockTipVisible);
  const gridlockTipSequence = useAppSelector(selectGridlockTipSequence);
  const { transientLayout } = useTransientLayout();
  const [hoveredControl, setHoveredControl] = useState<string | null>(null);

  const hasMultipleLayouts = layouts.length > 1 || !!transientLayout;
  const showGridlockTip = gridlockTipVisible && !!registry;
  const savedLayoutTabs = layouts.map((layout, index) => ({
    label: `^${index + 1} ${truncate(layout.name, 14)}`,
    value: String(index),
  }));
  const layoutTabs = transientLayout
    ? [
      ...savedLayoutTabs,
      {
        label: transientLayout.label,
        value: transientLayout.id,
      },
    ]
    : savedLayoutTabs;
  const layoutTabsWidth = layoutTabs.reduce((sum, tab) => sum + tab.label.length + 2, 0);
  const activeLayoutValue = transientLayout?.active ? transientLayout.id : String(activeLayoutIdx);
  const handleLayoutSelect = (value: string) => {
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

  useEffect(() => {
    if (!gridlockTipVisible) return;
    const timer = setTimeout(() => {
      dispatch({ type: "DISMISS_GRIDLOCK_TIP" });
    }, GRIDLOCK_TIP_DURATION_MS);
    return () => clearTimeout(timer);
  }, [dispatch, gridlockTipSequence, gridlockTipVisible]);

  const handleGridlockTip = (event?: StatusBarEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!registry) return;
    const { width, height } = registry.getTermSizeFn();
    registry.updateLayoutFn(gridlockAllPanes(
      registry.getLayoutFn(),
      { x: 0, y: 0, width, height },
      registry.panes,
    ));
    notifyGridlockComplete(registry.notify.bind(registry), () => {
      dispatch({ type: "UNDO_LAYOUT" });
    });
    dispatch({ type: "DISMISS_GRIDLOCK_TIP" });
  };

  const dismissGridlockTip = (event?: StatusBarEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    dispatch({ type: "DISMISS_GRIDLOCK_TIP" });
  };

  const openCommandBar = (event?: StatusBarEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" });
  };

  const openLayouts = (event?: StatusBarEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    dispatch({ type: "SET_COMMAND_BAR", open: true, query: "LAY " });
  };

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
        onSelect: () => openWorkflowForLayout("delete-layout"),
      },
      contextMenuDivider("layout:actions-divider"),
      {
        id: "layout:actions",
        label: "Layout Actions...",
        onSelect: () => registry?.openCommandBar("LAY "),
      },
    );

    return items;
  }, [activeLayoutIdx, dispatch, layouts, registry]);

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

  const viewProps: StatusBarViewProps = {
    activeLayoutIdx,
    activeLayoutValue,
    dismissGridlockTip,
    handleGridlockTip,
    handleLayoutSelect,
    hasMultipleLayouts,
    hoveredControl,
    layoutTabItems,
    layoutTabsWidth,
    openCommandBar,
    openLayouts,
    openLayoutContextMenu,
    setHoveredControl,
    showGridlockTip,
  };

  if (nativePaneChrome) {
    return <NativeStatusBar {...viewProps} />;
  }

  return <TerminalStatusBar {...viewProps} />;
}

function NativeStatusBar({
  activeLayoutIdx,
  activeLayoutValue,
  dismissGridlockTip,
  handleGridlockTip,
  handleLayoutSelect,
  hasMultipleLayouts,
  hoveredControl,
  layoutTabItems,
  layoutTabsWidth,
  openCommandBar,
  openLayouts,
  openLayoutContextMenu,
  setHoveredControl,
  showGridlockTip,
}: StatusBarViewProps) {
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
      <StatusBarLayoutControl
        activeLayoutValue={activeLayoutValue}
        handleLayoutSelect={handleLayoutSelect}
        hasMultipleLayouts={hasMultipleLayouts}
        hoveredControl={hoveredControl}
        layoutTabItems={layoutTabItems}
        layoutTabsWidth={layoutTabsWidth}
        nativePaneChrome
        openCommandBar={openCommandBar}
        openLayouts={openLayouts}
        setHoveredControl={setHoveredControl}
      />
      {showGridlockTip && (
        <NativeGridlockTip
          dismissGridlockTip={dismissGridlockTip}
          handleGridlockTip={handleGridlockTip}
          hoveredControl={hoveredControl}
          setHoveredControl={setHoveredControl}
        />
      )}
      <StatusBarWidgets />
    </Box>
  );
}

function TerminalStatusBar({
  activeLayoutIdx,
  activeLayoutValue,
  dismissGridlockTip,
  handleGridlockTip,
  handleLayoutSelect,
  hasMultipleLayouts,
  hoveredControl,
  layoutTabItems,
  layoutTabsWidth,
  openCommandBar,
  openLayouts,
  openLayoutContextMenu,
  setHoveredControl,
  showGridlockTip,
}: StatusBarViewProps) {
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
      <StatusBarLayoutControl
        activeLayoutValue={activeLayoutValue}
        handleLayoutSelect={handleLayoutSelect}
        hasMultipleLayouts={hasMultipleLayouts}
        hoveredControl={hoveredControl}
        layoutTabItems={layoutTabItems}
        layoutTabsWidth={layoutTabsWidth}
        nativePaneChrome={false}
        openCommandBar={openCommandBar}
        openLayouts={openLayouts}
        setHoveredControl={setHoveredControl}
      />
      {showGridlockTip && (
        <TerminalGridlockTip
          dismissGridlockTip={dismissGridlockTip}
          handleGridlockTip={handleGridlockTip}
          hoveredControl={hoveredControl}
          setHoveredControl={setHoveredControl}
        />
      )}
      <StatusBarWidgets />
    </Box>
  );
}

function StatusBarLayoutControl({
  activeLayoutValue,
  handleLayoutSelect,
  hasMultipleLayouts,
  hoveredControl,
  layoutTabItems,
  layoutTabsWidth,
  nativePaneChrome,
  openCommandBar,
  openLayouts,
  setHoveredControl,
}: Pick<
  StatusBarViewProps,
  | "activeLayoutValue"
  | "handleLayoutSelect"
  | "hasMultipleLayouts"
  | "hoveredControl"
  | "layoutTabItems"
  | "layoutTabsWidth"
  | "openCommandBar"
  | "openLayouts"
  | "setHoveredControl"
> & { nativePaneChrome: boolean }) {
  return (
    <Box
      paddingLeft={1}
      flexShrink={0}
      flexDirection="row"
      {...(nativePaneChrome ? { alignItems: "center", gap: 1 } : {})}
    >
      {hasMultipleLayouts ? (
        <Box width={layoutTabsWidth} height={1}>
          <Tabs
            tabs={layoutTabItems}
            activeValue={activeLayoutValue}
            onSelect={handleLayoutSelect}
            compact
            variant="pill"
          />
        </Box>
      ) : (
        <CommandBarHint
          hoveredControl={hoveredControl}
          nativePaneChrome={nativePaneChrome}
          openCommandBar={openCommandBar}
          setHoveredControl={setHoveredControl}
        />
      )}
      <LayoutsButton
        hoveredControl={hoveredControl}
        nativePaneChrome={nativePaneChrome}
        openLayouts={openLayouts}
        setHoveredControl={setHoveredControl}
      />
    </Box>
  );
}

function LayoutsButton({
  hoveredControl,
  nativePaneChrome,
  openLayouts,
  setHoveredControl,
}: Pick<StatusBarViewProps, "hoveredControl" | "openLayouts" | "setHoveredControl"> & {
  nativePaneChrome: boolean;
}) {
  const hovered = hoveredControl === "layouts";
  return (
    <Box
      marginLeft={1}
      height={1}
      alignItems="center"
      onMouseOver={() => setHoveredControl((current) => (current === "layouts" ? current : "layouts"))}
      onMouseDown={openLayouts}
      data-gloom-role="layout-presets-button"
      data-gloom-interactive="true"
      aria-label="Open layout presets"
      title="Layouts and presets"
      {...(nativePaneChrome ? {
        style: {
          cursor: "pointer",
          borderRadius: 4,
          paddingInline: 6,
          backgroundColor: hovered ? hoverBg() : blendHex(colors.panel, colors.header, 0.18),
        },
      } : {
        backgroundColor: hovered ? hoverBg() : colors.header,
      })}
    >
      <Text fg={nativePaneChrome ? (hovered ? colors.textBright : colors.text) : colors.headerText}>
        {nativePaneChrome ? "Layouts" : " Layouts "}
      </Text>
    </Box>
  );
}

function CommandBarHint({
  hoveredControl,
  nativePaneChrome,
  openCommandBar,
  setHoveredControl,
}: Pick<StatusBarViewProps, "hoveredControl" | "openCommandBar" | "setHoveredControl"> & {
  nativePaneChrome: boolean;
}) {
  const hovered = hoveredControl === "command-bar";
  return (
    <Text
      fg={hovered ? colors.text : colors.textDim}
      {...(!nativePaneChrome ? { bg: hovered ? hoverBg() : undefined } : {})}
      onMouseOver={() => setHoveredControl((current) => (current === "command-bar" ? current : "command-bar"))}
      onMouseDown={openCommandBar}
      {...(nativePaneChrome ? { "data-gloom-interactive": "true" } : {})}
    >
      <Span fg={colors.text}>Ctrl+P</Span> {t("command bar")}
    </Text>
  );
}

function NativeGridlockTip({
  dismissGridlockTip,
  handleGridlockTip,
  hoveredControl,
  setHoveredControl,
}: Pick<StatusBarViewProps, "dismissGridlockTip" | "handleGridlockTip" | "hoveredControl" | "setHoveredControl">) {
  return (
    <Box paddingLeft={2} flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
      <Text fg={colors.textDim}>{t("Snapped a window?")}</Text>
      <Text
        fg={hoveredControl === "gridlock-tip" ? colors.textBright : colors.borderFocused}
        attributes={TextAttributes.BOLD}
        onMouseOver={() => setHoveredControl((current) => (current === "gridlock-tip" ? current : "gridlock-tip"))}
        onMouseDown={handleGridlockTip}
        data-gloom-interactive="true"
      >
        {t("Gridlock All")}
      </Text>
      <Text
        fg={hoveredControl === "gridlock-tip-dismiss" ? colors.text : colors.textDim}
        onMouseOver={() => setHoveredControl((current) => (current === "gridlock-tip-dismiss" ? current : "gridlock-tip-dismiss"))}
        onMouseDown={dismissGridlockTip}
        data-gloom-interactive="true"
      >
        {t("Dismiss")}
      </Text>
    </Box>
  );
}

function TerminalGridlockTip({
  dismissGridlockTip,
  handleGridlockTip,
  hoveredControl,
  setHoveredControl,
}: Pick<StatusBarViewProps, "dismissGridlockTip" | "handleGridlockTip" | "hoveredControl" | "setHoveredControl">) {
  return (
    <Box paddingLeft={1} flexShrink={0} flexDirection="row">
      <Text fg={colors.textDim}>{t("Snapped a window?")}</Text>
      <Box width={1} />
      <Box
        backgroundColor={hoveredControl === "gridlock-tip" ? hoverBg() : colors.header}
        onMouseOver={() => setHoveredControl((current) => (current === "gridlock-tip" ? current : "gridlock-tip"))}
        onMouseDown={handleGridlockTip}
      >
        <Text fg={colors.headerText}> {t("Gridlock All")} </Text>
      </Box>
      <Text
        fg={hoveredControl === "gridlock-tip-dismiss" ? colors.text : colors.textDim}
        onMouseOver={() => setHoveredControl((current) => (current === "gridlock-tip-dismiss" ? current : "gridlock-tip-dismiss"))}
        onMouseDown={dismissGridlockTip}
      >
        {" x"}
      </Text>
    </Box>
  );
}

function StatusBarWidgets() {
  return (
    <>
      <Box flexGrow={1} />
      <PluginSlot name="status:widget" />
    </>
  );
}
