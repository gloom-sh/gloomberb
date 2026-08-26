import { Box, Span, Text, TextAttributes, contextMenuDivider, useContextMenu, useUiCapabilities } from "../../ui";
import { useDialog, useDialogKeyboard, type PromptContext } from "../../ui/dialog";
import { useCallback, useMemo, useState } from "react";
import { blendHex, hoverBg } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { useAppDispatch, useAppSelector } from "../../state/app/context";
import {
  selectActiveLayoutIndex,
  selectFocusedPaneId,
  selectLayout,
  selectSavedLayouts,
  selectStatusBarVisible,
} from "../../state/selectors-ui";
import { getSharedRegistry } from "../../plugins/registry";
import {
  getDockedPaneIds,
  gridlockAllPanes,
  gridlockFloatingPanes,
  planTidyWindows,
  type TidyWindowsPlan,
} from "../../plugins/pane-manager";
import { notifyGridlockComplete } from "../../plugins/gridlock-notification";
import { PluginSlot } from "../../react/plugins/plugin-slot";
import type { ContextMenuItem } from "../../types/context-menu";
import type { LayoutConfig } from "../../types/config";
import { isPlainKey } from "../../utils/keyboard";
import { Button, DialogFrame } from "../ui";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Tabs } from "../ui/tabs";
import { ToggleList } from "../toggle-list";
import { useTransientLayout } from "./transient-layout";

type StatusBarEvent = { stopPropagation?: () => void; preventDefault?: () => void };
type HoveredControl = string | null;
type SetHoveredControl = (updater: (current: HoveredControl) => HoveredControl) => void;

type LayoutTabItem = {
  label: string;
  value: string;
  reorderable?: boolean;
  onContextMenu: (value: string, event: any) => void;
};

type StatusBarViewProps = {
  activeLayoutIdx: number;
  activeLayoutValue: string;
  handleLayoutReorder: (fromValue: string, toValue: string) => void;
  handleLayoutSelect: (value: string) => void;
  handleTidyWindows: (event?: StatusBarEvent) => void;
  hasMultipleLayouts: boolean;
  hoveredControl: HoveredControl;
  layoutTabItems: LayoutTabItem[];
  layoutTabsWidth: number;
  openCommandBar: (event?: StatusBarEvent) => void;
  openLayoutContextMenu: (index: number, event: any) => void | Promise<unknown>;
  setHoveredControl: SetHoveredControl;
  showTidyWindows: boolean;
};

type TidyWindowsChoice =
  | { mode: "selected"; paneIds: string[] }
  | { mode: "all" }
  | null;

type TidyWindowOption = {
  id: string;
  label: string;
};

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 2) return ".".repeat(width);
  return `${text.slice(0, width - 2)}..`;
}

export function StatusBar() {
  const { nativePaneChrome, nativeContextMenu } = useUiCapabilities();
  const { showContextMenu } = useContextMenu();
  const dialog = useDialog();
  const registry = getSharedRegistry();
  const dispatch = useAppDispatch();
  const layouts = useAppSelector(selectSavedLayouts);
  const activeLayoutIdx = useAppSelector(selectActiveLayoutIndex);
  const statusBarVisible = useAppSelector(selectStatusBarVisible);
  const layout = useAppSelector(selectLayout);
  const focusedPaneId = useAppSelector(selectFocusedPaneId);
  const { transientLayout } = useTransientLayout();
  const [hoveredControl, setHoveredControl] = useState<string | null>(null);

  const hasMultipleLayouts = layouts.length > 1 || !!transientLayout;
  const tidyPlan = useMemo(() => planTidyWindows(layout, focusedPaneId), [focusedPaneId, layout]);
  const showTidyWindows = tidyPlan.show && !transientLayout?.active && !!registry;
  const savedLayoutTabs = layouts.map((layout, index) => ({
    label: `^${index + 1} ${truncate(layout.name, 14)}`,
    value: String(index),
    reorderable: true,
  }));
  const layoutTabs = transientLayout
    ? [
      ...savedLayoutTabs,
      {
        label: transientLayout.label,
        value: transientLayout.id,
        reorderable: false,
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
  const handleLayoutReorder = (fromValue: string, toValue: string) => {
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

  const applyTidyWindows = (choice: Exclude<TidyWindowsChoice, null>) => {
    if (!registry) return;
    const currentLayout = registry.getLayoutFn();
    const { width, height } = registry.getTermSizeFn();
    const bounds = { x: 0, y: 0, width, height };
    const nextLayout = choice.mode === "all"
      ? gridlockAllPanes(currentLayout, bounds, registry.panes)
      : gridlockFloatingPanes(currentLayout, choice.paneIds, bounds, registry.panes);
    if (nextLayout === currentLayout) return;

    registry.updateLayoutFn(nextLayout);
    const tiledCount = getDockedPaneIds(nextLayout).length;
    const remainingCount = nextLayout.floating.length;
    const body = remainingCount > 0
      ? `Tiled ${tiledCount} window${tiledCount === 1 ? "" : "s"}; ${remainingCount} left floating`
      : "Tiled all windows";
    notifyGridlockComplete(registry.notify.bind(registry), () => {
      dispatch({ type: "UNDO_LAYOUT" });
    }, body);
  };

  const handleTidyWindows = (event?: StatusBarEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!registry) return;

    const currentLayout = registry.getLayoutFn();
    const currentPlan = planTidyWindows(currentLayout, focusedPaneId);
    if (!currentPlan.requiresChoice) {
      applyTidyWindows({ mode: "selected", paneIds: currentPlan.selectedFloatingPaneIds });
      return;
    }

    const options = currentPlan.floatingPanes.map((pane): TidyWindowOption => {
      const instance = currentLayout.instances.find((entry) => entry.instanceId === pane.instanceId);
      const name = instance?.title ?? (instance ? registry.panes.get(instance.paneId)?.name : undefined) ?? instance?.paneId ?? "Window";
      return {
        id: pane.instanceId,
        label: `${name} · ${t(pane.buried ? "Covered" : "Visible")}`,
      };
    });

    void dialog.prompt<TidyWindowsChoice>({
      closeOnClickOutside: true,
      content: (context: PromptContext<TidyWindowsChoice>) => (
        <TidyWindowsDialog
          {...context}
          plan={currentPlan}
          options={options}
        />
      ),
    }).then((choice) => {
      if (choice) applyTidyWindows(choice);
    }).catch(() => {});
  };

  const openCommandBar = (event?: StatusBarEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" });
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
        id: "layout:actions",
        label: "Layout Actions...",
        onSelect: () => registry?.openCommandBar("LAY "),
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
    openCommandBar,
    openLayoutContextMenu,
    setHoveredControl,
    showTidyWindows,
  };

  if (nativePaneChrome) {
    return <NativeStatusBar {...viewProps} />;
  }

  return <TerminalStatusBar {...viewProps} />;
}

function TidyWindowsDialog({
  dialogId,
  resolve,
  plan,
  options,
}: PromptContext<TidyWindowsChoice> & {
  plan: TidyWindowsPlan;
  options: TidyWindowOption[];
}) {
  const colors = useThemeColors();
  const [selectedPaneIds, setSelectedPaneIds] = useState(plan.selectedFloatingPaneIds);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedPaneIdSet = new Set(selectedPaneIds);
  const togglePane = (paneId: string) => {
    setSelectedPaneIds((current) => {
      if (current.includes(paneId)) return current.filter((id) => id !== paneId);
      if (current.length >= plan.capacity) return current;
      return [...current, paneId];
    });
  };
  const tidySelected = () => {
    if (selectedPaneIds.length > 0) {
      resolve({ mode: "selected", paneIds: selectedPaneIds });
    }
  };

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (isPlainKey(event, "up", "k")) {
      setSelectedIndex((current) => Math.max(0, current - 1));
    } else if (isPlainKey(event, "down", "j")) {
      setSelectedIndex((current) => Math.min(options.length - 1, current + 1));
    } else if (event.name === "space" || event.name === " " || event.sequence === " ") {
      const paneId = options[selectedIndex]?.id;
      if (paneId) togglePane(paneId);
    } else if (event.name === "enter" || event.name === "return") {
      tidySelected();
    } else if (event.name === "escape") {
      resolve(null);
    }
  }, dialogId);

  return (
    <DialogFrame
      title={t("Tidy Windows")}
      footer={t("↑↓ choose · Space toggle · Enter tidy · Esc cancel")}
    >
      <Box flexDirection="column" width={56} gap={1}>
        <Text fg={colors.textDim}>
          {tf("{visible} visible, {covered} covered. Choose up to {capacity} more.", {
            visible: plan.visibleCount,
            covered: plan.buriedCount,
            capacity: plan.capacity,
          })}
        </Text>
        <ToggleList
          items={options.map((option) => ({
            id: option.id,
            label: option.label,
            enabled: selectedPaneIdSet.has(option.id),
            disabled: !selectedPaneIdSet.has(option.id) && selectedPaneIds.length >= plan.capacity,
          }))}
          selectedIdx={selectedIndex}
          height={Math.min(10, Math.max(4, options.length))}
          scrollable
          showSelectedDescription={false}
          rowIdPrefix="tidy-windows"
          onSelect={setSelectedIndex}
          onToggle={togglePane}
        />
        <Box flexDirection="row" gap={1}>
          <Button
            label={tf("Tidy {count} Selected", { count: selectedPaneIds.length })}
            variant="primary"
            disabled={selectedPaneIds.length === 0}
            onPress={tidySelected}
          />
          <Button
            label={tf("Tile All {count}", { count: options.length })}
            onPress={() => resolve({ mode: "all" })}
          />
          <Button label={t("Cancel")} variant="ghost" onPress={() => resolve(null)} />
        </Box>
      </Box>
    </DialogFrame>
  );
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
      <StatusBarWidgets />
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
      <StatusBarWidgets />
    </Box>
  );
}

function StatusBarLayoutControl({
  activeLayoutValue,
  handleLayoutSelect,
  handleLayoutReorder,
  hasMultipleLayouts,
  hoveredControl,
  layoutTabItems,
  layoutTabsWidth,
  nativePaneChrome,
  openCommandBar,
  setHoveredControl,
}: Pick<
  StatusBarViewProps,
  | "activeLayoutValue"
  | "handleLayoutSelect"
  | "handleLayoutReorder"
  | "hasMultipleLayouts"
  | "hoveredControl"
  | "layoutTabItems"
  | "layoutTabsWidth"
  | "openCommandBar"
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
            onReorder={handleLayoutReorder}
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
  const colors = useThemeColors();
  const hovered = hoveredControl === "command-bar";
  return (
    <Text
      fg={hovered ? colors.text : colors.textDim}
      {...(!nativePaneChrome ? { bg: hovered ? hoverBg(colors) : undefined } : {})}
      onMouseOver={() => setHoveredControl((current) => (current === "command-bar" ? current : "command-bar"))}
      onMouseDown={openCommandBar}
      {...(nativePaneChrome ? { "data-gloom-interactive": "true" } : {})}
    >
      <Span fg={colors.text}>Ctrl+P</Span> {t("command bar")}
    </Text>
  );
}

function NativeTidyWindows({
  handleTidyWindows,
  hoveredControl,
  setHoveredControl,
}: Pick<StatusBarViewProps, "handleTidyWindows" | "hoveredControl" | "setHoveredControl">) {
  const colors = useThemeColors();
  const hovered = hoveredControl === "tidy-windows";
  return (
    <Box paddingLeft={2} flexShrink={0} flexDirection="row" alignItems="center">
      <Text
        fg={hovered ? colors.textBright : colors.borderFocused}
        attributes={TextAttributes.BOLD}
        title={t("Arrange visible windows. Covered windows stay floating.")}
        onMouseOver={() => setHoveredControl((current) => (current === "tidy-windows" ? current : "tidy-windows"))}
        onMouseDown={handleTidyWindows}
        data-gloom-interactive="true"
      >
        {t("Tidy Windows")}
      </Text>
    </Box>
  );
}

function TerminalTidyWindows({
  handleTidyWindows,
  hoveredControl,
  setHoveredControl,
}: Pick<StatusBarViewProps, "handleTidyWindows" | "hoveredControl" | "setHoveredControl">) {
  const colors = useThemeColors();
  const hovered = hoveredControl === "tidy-windows";
  return (
    <Box paddingLeft={1} flexShrink={0} flexDirection="row">
      <Box
        backgroundColor={hovered ? hoverBg(colors) : colors.header}
        onMouseOver={() => setHoveredControl((current) => (current === "tidy-windows" ? current : "tidy-windows"))}
        onMouseDown={handleTidyWindows}
      >
        <Text fg={colors.headerText}> {t("Tidy Windows")} </Text>
      </Box>
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
