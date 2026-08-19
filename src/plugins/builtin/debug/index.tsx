import { Box, Text } from "../../../ui";
import { useState, useEffect, useCallback, useRef } from "react";
import { useShortcut } from "../../../react/input";
import { TextAttributes } from "../../../ui";
import type { GloomPlugin, PaneProps } from "../../../types/plugin";
import { usePaneFooter } from "../../../components";
import { usePluginAppActions } from "../../runtime";
import { colors, hoverBg } from "../../../theme/colors";
import { debugLog, type LogEntry, type LogLevel } from "../../../utils/debug-log";
import { isPlainKey } from "../../../utils/keyboard";
import { wrapTextLines } from "../../../utils/text-wrap";
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

const ALL_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23);
}

function DebugPane({ focused, width, height }: PaneProps) {
  const { notify } = usePluginAppActions();
  const [entries, setEntries] = useState<LogEntry[]>(() => debugLog.getEntries());
  const [filterLevel, setFilterLevel] = useState<LogLevel | null>(null);
  const [filterSource, setFilterSource] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [showDetail, setShowDetail] = useState(false);
  const sourcesRef = useRef<string[]>(debugLog.getSources());

  useEffect(() => {
    const unsub = debugLog.subscribe(() => {
      const filtered = debugLog.getEntries(
        filterLevel || filterSource
          ? { level: filterLevel ?? undefined, source: filterSource ?? undefined }
          : undefined,
      );
      setEntries(filtered);
      sourcesRef.current = debugLog.getSources();
    });
    return unsub;
  }, [filterLevel, filterSource, autoScroll]);

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
  }, []);
  const cycleLevelFilter = useCallback(() => {
    const currentIdx = filterLevel ? ALL_LEVELS.indexOf(filterLevel) : -1;
    const nextIdx = currentIdx + 1;
    setFilterLevel(nextIdx >= ALL_LEVELS.length ? null : ALL_LEVELS[nextIdx] ?? null);
  }, [filterLevel]);
  const cycleSourceFilter = useCallback(() => {
    const sources = sourcesRef.current;
    if (sources.length === 0) return;
    const currentIdx = filterSource ? sources.indexOf(filterSource) : -1;
    const nextIdx = currentIdx + 1;
    setFilterSource(nextIdx >= sources.length ? null : sources[nextIdx] ?? null);
  }, [filterSource]);
  const jumpTop = useCallback(() => {
    setSelectedIdx(0);
    setAutoScroll(false);
  }, []);
  const jumpBottom = useCallback(() => {
    setSelectedIdx(entries.length - 1);
    setAutoScroll(true);
  }, [entries.length]);

  useShortcut((event) => {
    if (!focused) return;

    // Level filter cycling
    if (event.name === "l") {
      cycleLevelFilter();
      return;
    }

    // Source filter cycling
    if (event.name === "s") {
      cycleSourceFilter();
      return;
    }

    // Export
    if (event.name === "e") {
      exportLogs();
      return;
    }

    // Clear
    if (event.name === "c") {
      clearLogs();
      return;
    }

    // Auto-scroll toggle
    if (event.name === "a") {
      setAutoScroll((prev) => !prev);
      return;
    }

    // Detail toggle
    if (event.name === "return" && selectedIdx >= 0) {
      setShowDetail((prev) => !prev);
      return;
    }

    // Navigation
    if (isPlainKey(event, "j", "down")) {
      setAutoScroll(false);
      setSelectedIdx((prev) => Math.min(prev + 1, entries.length - 1));
      return;
    }
    if (isPlainKey(event, "k", "up")) {
      setAutoScroll(false);
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
      return;
    }

    if (event.name === "g" && !event.shift) {
      jumpTop();
      return;
    }
    if (event.name === "g" && event.shift) {
      jumpBottom();
      return;
    }

    if (event.name === "escape" && showDetail) {
      setShowDetail(false);
      return;
    }
  });

  const contentWidth = Math.max(1, width - 2);
  const messageAreaHeight = Math.max(1, height);

  // Compute visible window
  const visibleCount = showDetail ? Math.max(1, messageAreaHeight - 4) : messageAreaHeight;
  const totalEntries = entries.length;

  // Keep selected entry visible
  let viewStart: number;
  if (autoScroll) {
    viewStart = Math.max(0, totalEntries - visibleCount);
    // In auto-scroll, selected follows bottom
  } else {
    if (selectedIdx < 0) {
      viewStart = Math.max(0, totalEntries - visibleCount);
    } else {
      viewStart = Math.max(0, Math.min(selectedIdx - Math.floor(visibleCount / 2), totalEntries - visibleCount));
    }
  }
  const visibleEntries = entries.slice(viewStart, viewStart + visibleCount);

  const selectedEntry = selectedIdx >= 0 && selectedIdx < entries.length ? entries[selectedIdx] : null;
  const detailTextWidth = Math.max(1, contentWidth - 2);
  const detailMessageLines = selectedEntry
    ? wrapTextLines(
        selectedEntry.message,
        detailTextWidth,
        selectedEntry.data === undefined ? 3 : 2,
      )
    : [];
  const detailDataLines = selectedEntry?.data === undefined
    ? []
    : wrapTextLines(
        JSON.stringify(selectedEntry.data, null, 2),
        detailTextWidth,
        Math.max(1, 3 - detailMessageLines.length),
      );

  usePaneFooter("debug-log", () => ({
    info: [
      ...(filterLevel ? [{ id: "level", parts: [{ text: filterLevel.toUpperCase(), tone: "value" as const, color: levelColor(filterLevel), bold: true }] }] : []),
      ...(filterSource ? [{ id: "source", parts: [{ text: filterSource, tone: "positive" as const }] }] : []),
      ...(autoScroll ? [{ id: "auto", parts: [{ text: "AUTO", tone: "muted" as const }] }] : []),
    ],
    hints: [
      // Every label is the mnemonic suffix of its key, so the footer reads
      // "[l]evel [s]ource [e]xport [x] clear ..." consistently.
      { id: "level", key: "l", label: "evel", onPress: cycleLevelFilter },
      { id: "source", key: "s", label: "ource", onPress: cycleSourceFilter },
      { id: "export", key: "e", label: "xport", onPress: exportLogs },
      { id: "clear", key: "c", label: "lear", onPress: clearLogs },
      { id: "auto", key: "a", label: "uto", onPress: () => setAutoScroll((prev) => !prev) },
      { id: "jump-top", key: "g", label: "o to top", onPress: jumpTop },
      { id: "jump-end", key: "G", label: "o to end", onPress: jumpBottom },
    ],
  }), [autoScroll, clearLogs, cycleLevelFilter, cycleSourceFilter, exportLogs, filterLevel, filterSource, jumpBottom, jumpTop]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Log entries */}
      <Box
        height={visibleCount}
        flexDirection="column"
        onMouseScroll={(event: any) => {
          const dir = event.scroll?.direction;
          if (!dir) return;
          if (dir === "up" || dir === "down") {
            setAutoScroll(false);
            setSelectedIdx((prev) => {
              const next = dir === "up" ? prev - 3 : prev + 3;
              return Math.max(0, Math.min(next, entries.length - 1));
            });
          }
        }}
      >
        {visibleEntries.length === 0 && (
          <Box alignItems="center" justifyContent="center" flexGrow={1}>
            <Text fg={colors.textDim}>No log entries{filterLevel || filterSource ? " matching filter" : ""}</Text>
          </Box>
        )}
        {visibleEntries.map((entry, i) => {
          const globalIdx = viewStart + i;
          const isSelected = globalIdx === selectedIdx;
          const bgColor = isSelected ? colors.selected : undefined;
          const rowHoverBg = isSelected ? undefined : hoverBg();
          const ts = formatTimestamp(entry.timestamp);
          const lvl = LEVEL_LABELS[entry.level];
          const sourceTag = entry.source;
          // Floor of 1: at maxMsg 0 the old slice(0, -1) kept almost the whole
          // message and only appended an ellipsis.
          const maxMsg = Math.max(1, contentWidth - ts.length - lvl.length - sourceTag.length - 8);
          const msg = entry.message.length > maxMsg
            ? `${entry.message.slice(0, Math.max(0, maxMsg - 1))}…`
            : entry.message;

          return (
            <Box
              key={entry.id}
              height={1}
              width={contentWidth}
              flexDirection="row"
              backgroundColor={bgColor}
              hoverBackgroundColor={rowHoverBg}
              onMouseDown={() => { setSelectedIdx(globalIdx); setAutoScroll(false); }}
            >
              <Text fg={colors.textMuted}> {ts} </Text>
              <Text fg={levelColor(entry.level)} attributes={TextAttributes.BOLD}>{lvl}</Text>
              <Text fg={colors.textDim}> [{sourceTag}] </Text>
              <Text fg={isSelected ? colors.selectedText ?? colors.textBright : colors.text}>
                {msg}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Detail panel */}
      {showDetail && selectedEntry && (
        <Box flexDirection="column" height={4} width={contentWidth}>
          <Box height={1} width={contentWidth}>
            <Text fg={colors.border}>{"-".repeat(contentWidth)}</Text>
          </Box>
          <Box paddingLeft={1} flexDirection="column">
            {detailMessageLines.map((line, index) => (
              <Box key={`message:${index}`} height={1}>
                <Text fg={colors.text}>{line || " "}</Text>
              </Box>
            ))}
            {detailDataLines.map((line, index) => (
              <Box key={`data:${index}`} height={1}>
                <Text fg={colors.textDim}>{line || " "}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
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
      id: "debug",
      name: "Debug Log",
      icon: "D",
      component: DebugPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 120, height: 30 },
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
