import { Box, ScrollBox, Text, type InputRenderable, type ScrollBoxRenderable } from "../../../ui";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useShortcut } from "../../../react/input";
import { TextAttributes } from "../../../ui";
import type { GloomPlugin, PaneProps } from "../../../types/plugin";
import {
  DataTableStackView,
  isTableScrollNearEnd,
  QueryBar,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type SelectControl,
} from "../../../components";
import { usePaneSettingValue } from "../../../state/app/context";
import { usePluginAppActions } from "../../runtime";
import { DEBUG_LOG_TEMPLATE_ID, DEBUG_PANE_ID, DEBUG_SOURCE_SETTING } from "./template";
import { colors } from "../../../theme/colors";
import { debugLog, type LogEntry, type LogLevel } from "../../../utils/debug-log";
import { isPlainKey } from "../../../utils/keyboard";
import { writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function exportDebugLogFile(options: {
  filterLevel?: LogLevel | null;
  filterSource?: string | null;
}): { ok: true; filename: string } | { ok: false } {
  const text = debugLog.exportAsText(
    options.filterLevel || options.filterSource
      ? { level: options.filterLevel ?? undefined, source: options.filterSource ?? undefined }
      : undefined,
  );
  const downloadsDir = join(homedir(), "Downloads");
  const filename = `gloomberb-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`;
  const filepath = join(downloadsDir, filename);

  try {
    writeFileSync(filepath, text);
    return { ok: true, filename };
  } catch {
    return { ok: false };
  }
}

function levelColor(level: LogLevel): string {
  switch (level) {
    case "debug": return colors.textDim;
    case "info": return colors.positive;
    case "warn": return colors.warning;
    case "error": return colors.negative;
  }
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

const ALL_FILTER = "all";

const LEVEL_OPTIONS: { value: LogLevel | typeof ALL_FILTER; label: string }[] = [
  { value: ALL_FILTER, label: "All" },
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

type DebugColumn = DataTableColumn & { id: "time" | "level" | "source" | "message" };

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23);
}

function debugColumns(entries: LogEntry[]): DebugColumn[] {
  const sourceWidth = Math.max(8, Math.min(18, entries.reduce((max, entry) => Math.max(max, entry.source.length), 0)));
  return [
    { id: "time", label: "TIME", width: 12, align: "left" },
    { id: "level", label: "LEVEL", width: 5, align: "left" },
    { id: "source", label: "SOURCE", width: sourceWidth, align: "left" },
    { id: "message", label: "MESSAGE", width: 20, align: "left", flexGrow: 1 },
  ];
}

function renderDebugCell(entry: LogEntry, column: DebugColumn, _index: number, state: { selected: boolean }): DataTableCell {
  if (column.id === "time") return { text: formatTimestamp(entry.timestamp), color: colors.textMuted };
  if (column.id === "level") return { text: LEVEL_LABELS[entry.level], color: levelColor(entry.level), attributes: TextAttributes.BOLD };
  if (column.id === "source") return { text: entry.source, color: colors.textDim };
  // A log line is one row; the detail shows the rest.
  return { text: entry.message.replace(/\s+/g, " "), color: state.selected ? colors.selectedText : colors.text };
}

function DebugEntryDetail({ entry }: { entry: LogEntry }) {
  return (
    <ScrollBox flexGrow={1} scrollY focusable={false}>
      <Box flexDirection="column" paddingX={1}>
        <Text fg={colors.text} wrapText>{entry.message}</Text>
        {entry.data !== undefined && (
          <Box marginTop={1}>
            <Text fg={colors.textDim} wrapText>{JSON.stringify(entry.data, null, 2)}</Text>
          </Box>
        )}
      </Box>
    </ScrollBox>
  );
}

function DebugPane({ focused, width, height }: PaneProps) {
  const { notify } = usePluginAppActions();
  const [entries, setEntries] = useState<LogEntry[]>(() => debugLog.getEntries());
  const [sources, setSources] = useState<string[]>(() => debugLog.getSources());
  const [filterLevel, setFilterLevel] = useState<LogLevel | null>(null);
  // Persisted with the pane so a log opened for one plugin stays on that plugin.
  const [filterSource, setFilterSource] = usePaneSettingValue<string | null>(DEBUG_SOURCE_SETTING, null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const searchInput = useRef<InputRenderable | null>(null);
  const levelControl = useRef<SelectControl>(null);
  const sourceControl = useRef<SelectControl>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  // While on, the cursor rides the newest entry, which keeps the list pinned
  // to the bottom as entries arrive.
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      const filtered = debugLog.getEntries(
        filterLevel || filterSource
          ? { level: filterLevel ?? undefined, source: filterSource ?? undefined }
          : undefined,
      );
      setEntries(filtered);
      setSources(debugLog.getSources());
    };
    read();
    return debugLog.subscribe(read);
  }, [filterLevel, filterSource]);

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? entries.filter((entry) => entry.message.toLowerCase().includes(needle)) : entries;
  }, [entries, query]);
  const columns = useMemo(() => debugColumns(visibleEntries), [visibleEntries]);
  const newestId = visibleEntries.length > 0 ? String(visibleEntries[visibleEntries.length - 1]!.id) : null;
  const effectiveSelectedId = autoScroll ? newestId : selectedId;
  const openEntry = openId ? entries.find((entry) => String(entry.id) === openId) ?? null : null;

  useEffect(() => {
    if (openId && !openEntry) setOpenId(null);
  }, [openEntry, openId]);

  const exportLogs = useCallback(() => {
    const result = exportDebugLogFile({ filterLevel, filterSource });
    if (result.ok) {
      notify({ body: `Exported to ~/Downloads/${result.filename}`, type: "success" });
      return;
    }
    notify({ body: "Failed to export logs", type: "error" });
  }, [filterLevel, filterSource, notify]);

  const clearLogs = useCallback(() => {
    debugLog.clear();
    setEntries([]);
    setOpenId(null);
  }, []);
  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      if (prev) setSelectedId(newestId);
      return !prev;
    });
  }, [newestId]);
  const jumpTop = useCallback(() => {
    setAutoScroll(false);
    setSelectedId(visibleEntries[0] ? String(visibleEntries[0].id) : null);
  }, [visibleEntries]);
  const focusSearch = useCallback(() => {
    setSearching(true);
    setSearchFocus((value) => value + 1);
  }, []);

  useShortcut((event) => {
    if (!focused || openId || searching || event.targetEditable || event.ctrl || event.meta) return;
    if (event.name === "l") { event.preventDefault?.(); levelControl.current?.open(); return; }
    if (event.name === "s") { event.preventDefault?.(); sourceControl.current?.open(); return; }
    // Plain `/` only: Shift+/ is `?`, which opens Help.
    if (isPlainKey(event, "/")) { event.preventDefault?.(); focusSearch(); return; }
    if (event.name === "e") { exportLogs(); return; }
    if (event.name === "c") { clearLogs(); return; }
    if (event.name === "a") { toggleAutoScroll(); return; }
    // Top and end of the log; G also resumes following new entries.
    if (event.name === "g" && !event.shift) { jumpTop(); return; }
    if (event.name === "g" && event.shift) { setAutoScroll(true); return; }
  });

  usePaneFooter("debug-log", () => ({
    info: autoScroll && !openId ? [{ id: "auto", parts: [{ text: "following", tone: "muted" as const }] }] : [],
    hints: openId ? [] : [
      { id: "export", key: "e", label: "xport", onPress: exportLogs },
      { id: "clear", key: "c", label: "lear", onPress: clearLogs },
      { id: "auto", key: "a", label: "uto-scroll", onPress: toggleAutoScroll },
    ],
  }), [autoScroll, clearLogs, exportLogs, openId, toggleAutoScroll]);

  const sourceOptions = useMemo(() => {
    const names = filterSource && !sources.includes(filterSource) ? [...sources, filterSource] : sources;
    return [{ value: ALL_FILTER, label: "All" }, ...names.map((name) => ({ value: name, label: name }))];
  }, [filterSource, sources]);

  const filtered = !!(filterLevel || filterSource || query.trim());

  return (
    <Box flexDirection="column" width={width} height={height}>
      <DataTableStackView<LogEntry, DebugColumn>
        focused={focused && !searching}
        rootWidth={width}
        rootHeight={height}
        rootBefore={(
          <QueryBar
            width={width}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "message",
              focused,
              active: searching,
              onActiveChange: setSearching,
              focusToken: searchFocus,
              inputRef: searchInput,
              onNavigateDown: () => setSearching(false),
            }}
            filters={[
              {
                id: "level",
                label: "Level",
                value: filterLevel ?? ALL_FILTER,
                defaultValue: ALL_FILTER,
                options: LEVEL_OPTIONS,
                onChange: (value: string) => setFilterLevel(value === ALL_FILTER ? null : value as LogLevel),
                controlRef: levelControl,
              },
              {
                id: "source",
                label: "Source",
                value: filterSource ?? ALL_FILTER,
                defaultValue: ALL_FILTER,
                options: sourceOptions,
                onChange: (value: string) => setFilterSource(value === ALL_FILTER ? null : value),
                controlRef: sourceControl,
              },
            ]}
          />
        )}
        columns={columns}
        items={visibleEntries}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={(entry) => String(entry.id)}
        renderCell={renderDebugCell}
        scrollRef={scrollRef}
        selection={{
          kind: "id",
          selectedId: effectiveSelectedId,
          getId: (entry) => String(entry.id),
          onChange: (id) => {
            setSelectedId(id);
            // Moving off the newest entry stops following; landing on it keeps
            // whatever the user chose.
            if (id !== newestId) setAutoScroll(false);
          },
        }}
        onBodyScrollActivity={(source) => {
          if (source === "programmatic" || !autoScroll) return;
          if (!isTableScrollNearEnd(scrollRef.current, 2)) {
            setSelectedId(newestId);
            setAutoScroll(false);
          }
        }}
        onActivate={(entry) => {
          setSelectedId(String(entry.id));
          setAutoScroll(false);
          setOpenId(String(entry.id));
        }}
        emptyStateTitle={filtered ? "No log entries match the filter." : "No log entries."}
        detailOpen={!!openEntry}
        onBack={() => setOpenId(null)}
        detailTitle={openEntry ? `${formatTimestamp(openEntry.timestamp)} ${LEVEL_LABELS[openEntry.level]} ${openEntry.source}` : undefined}
        detailContent={openEntry ? <DebugEntryDetail entry={openEntry} /> : null}
      />
    </Box>
  );
}

export const debugPlugin: GloomPlugin = {
  id: "debug",
  name: "Debug",
  version: "1.0.0",
  description: "View and export debug logs",
  toggleable: true,

  setup(ctx) {
    ctx.registerPane({
      id: DEBUG_PANE_ID,
      name: "Debug Log",
      icon: "D",
      component: DebugPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 120, height: 30 },
      settings: {
        title: "Debug Log",
        fields: [
          { key: DEBUG_SOURCE_SETTING, label: "Source", type: "text", placeholder: "plugin id" },
        ],
      },
    });

    ctx.registerPaneTemplate({
      id: DEBUG_LOG_TEMPLATE_ID,
      paneId: DEBUG_PANE_ID,
      label: "Debug Log",
      description: "Open the debug log, optionally filtered to one source",
      keywords: ["debug", "log", "errors"],
      createInstance: (_context, options) => ({
        placement: "floating",
        ...(options?.values?.source ? { title: `Log: ${options.values.source}`, settings: { [DEBUG_SOURCE_SETTING]: options.values.source } } : {}),
      }),
    });

    ctx.registerCommand({
      id: "open-debug-log",
      label: "Debug Log",
      description: "Open the debug log viewer",
      keywords: ["debug", "log", "logs", "console", "errors"],
      category: "navigation",
      execute: () => {
        ctx.showPane("debug");
      },
    });

    ctx.registerCommand({
      id: "export-debug-log",
      label: "Export Debug Log",
      description: "Export debug logs to ~/Downloads",
      keywords: ["export", "debug", "log", "download", "save"],
      category: "config",
      execute: () => {
        const result = exportDebugLogFile({});
        if (result.ok) {
          ctx.notify({ body: `Exported to ~/Downloads/${result.filename}`, type: "success" });
        } else {
          ctx.notify({ body: "Failed to export logs", type: "error" });
        }
      },
    });

  },
};
