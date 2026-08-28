import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, TextAttributes, type InputRenderable } from "../ui";
import { InputSearchBar, usePaneFooter } from "../components";
import { ListView, type ListViewItem } from "../components/ui/list-view";
import { useShortcut, useViewport } from "../react/input";
import { useThemeColors } from "../theme/theme-context";
import { truncateToDisplayWidth } from "../utils/format";
import { isPlainKey } from "../utils/keyboard";
import { t, tf } from "../i18n";
import type { LayoutGalleryController } from "./gallery";
import {
  describeArrangement,
  formatPublishedAt,
  summarizeLayoutPanes,
  type GalleryEntry,
} from "./model";

const DETAILS_WIDTH = 42;

interface GalleryRow extends ListViewItem {
  entry: GalleryEntry | null;
  action?: () => void;
}

function discoverStatusRow(controller: LayoutGalleryController): GalleryRow | null {
  if (!controller.signedIn) {
    return {
      id: "discover:login",
      label: "Log in to browse community layouts",
      detail: "Open login",
      entry: null,
      action: controller.requestSignIn,
    };
  }
  switch (controller.discover.state.status) {
    case "idle":
    case "loading":
      return { id: "discover:loading", label: "Loading community layouts…", disabled: true, entry: null };
    case "error":
      return {
        id: "discover:retry",
        label: "Retry Discover",
        detail: controller.discover.state.error,
        entry: null,
        action: controller.discover.refresh,
      };
    default:
      return controller.community.length === 0
        ? { id: "discover:empty", label: "No community layouts yet", disabled: true, entry: null }
        : null;
  }
}

export function LayoutGalleryTerminal({
  controller,
  dialogOpen,
  focused,
  width,
  height,
}: {
  controller: LayoutGalleryController;
  dialogOpen: boolean;
  focused: boolean;
  width?: number;
  height?: number;
}) {
  const colors = useThemeColors();
  const viewport = useViewport();
  const paneWidth = width ?? viewport.width;
  const paneHeight = height ?? viewport.height;
  const detailsWidth = Math.min(DETAILS_WIDTH, Math.max(28, Math.floor(paneWidth * 0.42)));
  const inputRef = useRef<InputRenderable | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const {
    activate: activateLayout,
    canDelete,
    community,
    copyLink,
    deleteLayout,
    duplicateLayout,
    install: installLayout,
    newLayout,
    owned,
    publishCurrent,
    publishing,
    renameLayout,
    select,
  } = controller;
  const discoverStatus = discoverStatusRow(controller);

  const rows = useMemo<GalleryRow[]>(() => {
    const built: GalleryRow[] = [
      {
        id: "heading:owned",
        label: tf("YOUR LAYOUTS ({count})", { count: String(owned.length) }),
        disabled: true,
        entry: null,
      },
      ...owned.map((entry): GalleryRow => ({
        id: entry.id,
        label: entry.active ? `${entry.name} ●` : entry.name,
        right: describeArrangement(entry.layout),
        current: entry.active,
        entry,
      })),
      {
        id: "heading:discover",
        label: tf("DISCOVER ({count})", { count: String(community.length) }),
        disabled: true,
        entry: null,
      },
    ];
    if (discoverStatus) built.push(discoverStatus);
    for (const entry of community) {
      built.push({
        id: entry.id,
        label: entry.name,
        detail: entry.author ?? "",
        right: describeArrangement(entry.layout),
        entry,
      });
    }
    return built;
  }, [community, discoverStatus, owned]);

  const selectableIndexes = useMemo(
    () => rows.map((row, index) => (row.entry || row.action ? index : -1)).filter((index) => index >= 0),
    [rows],
  );

  useEffect(() => {
    if (selectableIndexes.length === 0) return;
    if (!rows[selectedIndex]?.entry && !rows[selectedIndex]?.action) {
      setSelectedIndex(selectableIndexes[0]!);
    }
  }, [rows, selectableIndexes, selectedIndex]);

  const selectedRow = rows[selectedIndex] ?? null;
  const selectedEntry = selectedRow?.entry ?? null;
  useEffect(() => {
    select(selectedEntry?.id ?? null);
  }, [select, selectedEntry?.id]);

  const move = useCallback((delta: number) => {
    if (selectableIndexes.length === 0) return;
    const position = selectableIndexes.indexOf(selectedIndex);
    const nextPosition = position < 0
      ? 0
      : Math.min(selectableIndexes.length - 1, Math.max(0, position + delta));
    setSelectedIndex(selectableIndexes[nextPosition]!);
  }, [selectableIndexes, selectedIndex]);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  // The details panel is always on screen here, so Enter runs the action it shows
  // instead of stepping through a separate detail state.
  const activate = useCallback((row: GalleryRow | null) => {
    if (!row) return;
    if (row.action) {
      row.action();
      return;
    }
    if (!row.entry) return;
    if (row.entry.kind === "community") installLayout(row.entry);
    else activateLayout(row.entry);
  }, [activateLayout, installLayout]);

  const selectedRowRef = useRef<GalleryRow | null>(selectedRow);
  selectedRowRef.current = selectedRow;
  const activateSelected = useCallback(() => activate(selectedRowRef.current), [activate]);
  const renameSelected = useCallback(() => {
    const entry = selectedRowRef.current?.entry;
    if (entry?.kind === "owned") renameLayout(entry);
  }, [renameLayout]);
  const copySelected = useCallback(() => {
    const entry = selectedRowRef.current?.entry;
    if (entry?.kind === "community") copyLink(entry);
    else if (entry?.kind === "owned") duplicateLayout(entry);
  }, [copyLink, duplicateLayout]);
  const deleteSelected = useCallback(() => {
    const entry = selectedRowRef.current?.entry;
    if (entry?.kind === "owned") deleteLayout(entry);
  }, [deleteLayout]);

  usePaneFooter("layout-marketplace", () => ({
    info: publishing
      ? [{ id: "publishing", parts: [{ text: "publishing", tone: "muted" as const }] }]
      : [],
    hints: [
      { id: "search", key: "/", label: "search", onPress: focusSearch },
      { id: "new", key: "n", label: "ew", onPress: newLayout },
      ...(selectedEntry?.kind === "owned"
        ? [
            { id: "open", key: "o", label: "pen", onPress: activateSelected },
            { id: "rename", key: "r", label: "ename", onPress: renameSelected },
            { id: "copy", key: "c", label: "opy", onPress: copySelected },
            { id: "delete", key: "d", label: "elete", onPress: deleteSelected, disabled: !canDelete },
          ]
        : selectedEntry?.kind === "community"
          ? [
              { id: "add", key: "a", label: "dd layout", onPress: activateSelected },
              { id: "copy-link", key: "c", label: "opy link", onPress: copySelected },
            ]
          : selectedRow?.id === "discover:retry"
            ? [{ id: "retry", key: "r", label: "etry", onPress: activateSelected }]
            : selectedRow?.action
              ? [{ id: "open", key: "o", label: "pen", onPress: activateSelected }]
              : []),
      { id: "publish", key: "p", label: "ublish", onPress: publishCurrent, disabled: publishing },
    ],
  }), [
    activateSelected,
    canDelete,
    copySelected,
    deleteSelected,
    focusSearch,
    newLayout,
    publishCurrent,
    publishing,
    renameSelected,
    selectedEntry?.kind,
    selectedRow?.action,
    selectedRow?.id,
  ]);

  useShortcut((event) => {
    if (dialogOpen) return;
    // Leaving the search field is the first Escape; the gallery closes on the next.
    if (isPlainKey(event, "escape", "esc") && searchFocused) {
      event.preventDefault();
      event.stopPropagation();
      blurSearch();
      return;
    }
    if (event.targetEditable) return;

    const run = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    if (isPlainKey(event, "down", "j")) run(() => move(1));
    else if (isPlainKey(event, "up", "k")) {
      run(() => {
        if (event.name === "up" && selectedIndex === selectableIndexes[0]) focusSearch();
        else move(-1);
      });
    } else if (isPlainKey(event, "enter", "return")) run(activateSelected);
    else if (isPlainKey(event, "/")) run(focusSearch);
    else if (isPlainKey(event, "n")) run(newLayout);
    else if (isPlainKey(event, "p")) run(publishCurrent);
    else if (isPlainKey(event, "o") && (selectedEntry?.kind === "owned" || selectedRow?.action)) run(activateSelected);
    else if (isPlainKey(event, "a") && selectedEntry?.kind === "community") run(activateSelected);
    else if (isPlainKey(event, "r") && selectedRow?.id === "discover:retry") run(activateSelected);
    else if (isPlainKey(event, "r") && selectedEntry?.kind === "owned") run(renameSelected);
    else if (isPlainKey(event, "c") && selectedEntry) run(copySelected);
    else if (isPlainKey(event, "d") && selectedEntry?.kind === "owned" && canDelete) run(deleteSelected);
  }, { allowEditable: true, enabled: focused && !dialogOpen, phase: "before", scope: "layout-gallery" });

  const bodyHeight = Math.max(4, paneHeight - 1);

  return (
    <Box flexGrow={1} flexDirection="column" backgroundColor={colors.bg}>
      <InputSearchBar
        value={controller.query}
        focused={focused && !dialogOpen}
        active={searchFocused}
        width={paneWidth}
        focusToken={searchFocusToken}
        inputRef={inputRef}
        placeholder={t("Search layouts and panes")}
        debounceMs={80}
        onFocus={focusSearch}
        onBlur={blurSearch}
        onNavigateDown={blurSearch}
        onQueryChange={controller.setQuery}
      />

      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={1} flexDirection="column" paddingX={1}>
          <ListView
            items={rows}
            selectedIndex={selectedIndex}
            height={bodyHeight}
            scrollable
            onSelect={(index) => {
              if (rows[index]?.entry || rows[index]?.action) setSelectedIndex(index);
            }}
            onActivate={(_item, index) => activate(rows[index] ?? null)}
            renderRow={(item, state) => {
              const row = item as GalleryRow;
              if (!row.entry && !row.action) {
                return (
                  <Text fg={colors.textMuted} attributes={TextAttributes.BOLD}>{item.label}</Text>
                );
              }
              return (
                <Box flexDirection="row" justifyContent="space-between" width="100%">
                  <Text fg={state.selected ? colors.selectedText : colors.text}>
                    {`${state.selected ? "\u25b8 " : "  "}${item.label}`}
                  </Text>
                  <Text fg={colors.textMuted}>{item.right ?? item.detail ?? ""}</Text>
                </Box>
              );
            }}
            remoteRole="layout-gallery-list"
            remoteLabel={t("Layouts")}
          />
        </Box>

        <Box
          width={detailsWidth}
          flexDirection="column"
          paddingX={1}
          border
          borderStyle="single"
          borderColor={colors.border}
        >
          {selectedEntry ? (
            <LayoutDetails
              controller={controller}
              entry={selectedEntry}
              width={detailsWidth}
              height={bodyHeight}
            />
          ) : selectedRow?.action ? (
            <Box flexDirection="column" gap={1}>
              <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{selectedRow.label}</Text>
              {selectedRow.detail && <Text fg={colors.textMuted}>{selectedRow.detail}</Text>}
            </Box>
          ) : (
            <Text fg={colors.textDim}>{t("No layout selected.")}</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function LayoutDetails({
  controller,
  entry,
  width,
  height,
}: {
  controller: LayoutGalleryController;
  entry: GalleryEntry;
  width: number;
  height: number;
}) {
  const colors = useThemeColors();
  const allPanes = summarizeLayoutPanes(entry.layout, controller.panes);
  const missing = allPanes.filter((pane) => pane.missing);
  // Leave room for the title block and the optional warning.
  const paneBudget = Math.max(3, height - 8);
  const overflow = Math.max(0, allPanes.length - paneBudget);
  const panes = overflow > 0 ? allPanes.slice(0, paneBudget - 1) : allPanes;

  return (
    <Box flexDirection="column">
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{entry.name}</Text>
      {entry.author && (
        <Text fg={colors.textMuted}>
          {entry.publishedAt
            ? `${entry.author} · ${formatPublishedAt(entry.publishedAt)}`
            : entry.author}
        </Text>
      )}
      <Text fg={colors.textDim}>{describeArrangement(entry.layout)}</Text>
      <Box height={1} />
      {panes.map((pane) => {
        const trailing = pane.missing ? t("unavailable") : pane.paneId;
        const label = pane.symbol ? `${pane.name} · ${pane.symbol}` : pane.name;
        return (
          <Box key={pane.instanceId} height={1} flexDirection="row" justifyContent="space-between">
            <Text fg={pane.missing ? colors.textMuted : colors.text}>
              {truncateToDisplayWidth(label, Math.max(4, width - 5 - trailing.length))}
            </Text>
            <Text fg={colors.textMuted}>{trailing}</Text>
          </Box>
        );
      })}
      {overflow > 0 && (
        <Text fg={colors.textMuted}>
          {tf("+{count} more panes", { count: String(allPanes.length - panes.length) })}
        </Text>
      )}
      {missing.length > 0 && (
        <>
          <Box height={1} />
          <Text fg={colors.warning}>
            {missing.length === 1
              ? t("1 pane type is not installed here.")
              : tf("{count} pane types are not installed here.", { count: String(missing.length) })}
          </Text>
        </>
      )}
    </Box>
  );
}
