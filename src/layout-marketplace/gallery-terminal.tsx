import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Input, Text, TextAttributes, type InputRenderable } from "../ui";
import { Button } from "../components/ui/button";
import { ListView, type ListViewItem } from "../components/ui/list-view";
import { useShortcut, useViewport } from "../react/input";
import { useAppInputCapture } from "../state/app/input-capture";
import { useThemeColors } from "../theme/theme-context";
import { truncateToDisplayWidth } from "../utils/format";
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
}: {
  controller: LayoutGalleryController;
  dialogOpen: boolean;
}) {
  const colors = useThemeColors();
  const viewport = useViewport();
  const inputRef = useRef<InputRenderable | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  useAppInputCapture(searchFocused && !dialogOpen);
  const { community, owned, select } = controller;
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

  // The details panel is always on screen here, so Enter runs the action it shows
  // instead of stepping through a separate detail state.
  const activate = useCallback((row: GalleryRow | null) => {
    if (!row) return;
    if (row.action) {
      row.action();
      return;
    }
    if (!row.entry) return;
    if (row.entry.kind === "community") controller.install(row.entry);
    else controller.activate(row.entry);
  }, [controller]);

  useShortcut((event) => {
    if (dialogOpen) return;
    const editable = event.targetEditable === true;
    // Leaving the search field is the first Escape; the gallery closes on the next.
    if (event.name === "escape" && searchFocused) {
      event.preventDefault();
      event.stopPropagation();
      setSearchFocused(false);
      return;
    }
    if (event.name === "down" || (!editable && event.name === "j")) {
      event.preventDefault();
      event.stopPropagation();
      move(1);
      return;
    }
    if (event.name === "up" || (!editable && event.name === "k")) {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
      return;
    }
    if (event.name === "enter" || event.name === "return") {
      event.preventDefault();
      event.stopPropagation();
      activate(selectedRow);
      return;
    }
    if (!editable && (event.name === "/" || event.sequence === "/")) {
      event.preventDefault();
      event.stopPropagation();
      setSearchFocused(true);
      inputRef.current?.focus?.();
    }
  }, { allowEditable: true, enabled: !dialogOpen, phase: "before", scope: "layout-gallery" });

  const bodyHeight = Math.max(4, viewport.height - 6);
  const status = controller.publishing ? t("Publishing…") : null;

  return (
    <Box flexGrow={1} flexDirection="column" backgroundColor={colors.bg}>
      <Box height={1} flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("LAYOUTS")}</Text>
        {status && <Text fg={colors.textMuted}>{status}</Text>}
      </Box>

      <Box height={1} flexDirection="row" paddingX={1} backgroundColor={colors.panel}>
        <Text fg={searchFocused ? colors.textBright : colors.textDim}>{"/ "}</Text>
        <Input
          ref={inputRef}
          value={controller.query}
          focused={searchFocused && !dialogOpen}
          placeholder={t("Search layouts and panes")}
          placeholderColor={colors.textDim}
          textColor={colors.text}
          backgroundColor={colors.panel}
          focusedBackgroundColor={colors.panel}
          cursorColor={colors.textBright}
          flexGrow={1}
          onInput={controller.setQuery}
          onChange={controller.setQuery}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onSubmit={() => setSearchFocused(false)}
        />
      </Box>

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
          width={DETAILS_WIDTH}
          flexDirection="column"
          paddingX={1}
          border
          borderStyle="single"
          borderColor={colors.border}
        >
          {selectedEntry ? (
            <LayoutDetails controller={controller} entry={selectedEntry} />
          ) : selectedRow?.action ? (
            <Box flexDirection="column" gap={1}>
              <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{selectedRow.label}</Text>
              {selectedRow.detail && <Text fg={colors.textMuted}>{selectedRow.detail}</Text>}
              <Button
                label={selectedRow.id === "discover:login" ? "Log in" : "Retry"}
                variant="primary"
                onPress={selectedRow.action}
              />
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
}: {
  controller: LayoutGalleryController;
  entry: GalleryEntry;
}) {
  const colors = useThemeColors();
  const viewport = useViewport();
  const allPanes = summarizeLayoutPanes(entry.layout, controller.panes);
  const missing = allPanes.filter((pane) => pane.missing);
  // Leave room for the title block, the warning line, and both action rows.
  const paneBudget = Math.max(3, viewport.height - 14);
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
              {truncateToDisplayWidth(label, Math.max(4, DETAILS_WIDTH - 5 - trailing.length))}
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
      <Box height={1} />
      <Box flexDirection="row" gap={1}>
        <Button
          label={entry.kind === "community" ? "Add Layout" : "Open"}
          variant="primary"
          onPress={() => (entry.kind === "community"
            ? controller.install(entry)
            : controller.activate(entry))}
        />
        {entry.kind === "owned" && (
          <>
            <Button label="Rename" variant="secondary" onPress={() => controller.renameLayout(entry)} />
            <Button label="Copy" variant="secondary" onPress={() => controller.duplicateLayout(entry)} />
            <Button
              label="Delete"
              variant="secondary"
              disabled={!controller.canDelete}
              onPress={() => controller.deleteLayout(entry)}
            />
          </>
        )}
      </Box>
      <Box height={1} />
      <Box flexDirection="row" gap={1}>
        <Button label="New" variant="ghost" onPress={controller.newLayout} />
        <Button
          label={controller.publishing ? "Publishing" : "Publish"}
          variant="ghost"
          disabled={controller.publishing}
          onPress={controller.publishCurrent}
        />
        <Button label="Close" variant="ghost" onPress={controller.close} />
      </Box>
    </Box>
  );
}
