import { useCallback, useEffect, useMemo, useRef } from "react";
import { CompanyLogoMark } from "../../../components/company-logo";
import { PaneStatusBody } from "../../../components";
import { ClippedText } from "../../../components/ui/display";
import { FILL_REST } from "../../../components/ui/fill";
import { afterLayout, revealInScrollBox } from "../../../components/ui/reveal-in-scroll-box";
import { useDoubleClickActivation } from "../../../components/use-double-click-activation";
import { useShortcut } from "../../../react/input";
import { useRegisterPaneScrollBox } from "../../../state/pane-scroll-registry";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, ScrollBox, Text, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import type { BoardReport } from "./board-model";
import { calendarGroupKey, type CalendarDay, type CalendarGroup } from "./calendar-model";
import { epsText, signedPercent, TIMING_LABEL } from "./format";

/** Cells a logo and its ticker take side by side: a five-letter ticker and a cell between. A day fits as many as its width holds. */
const CALENDAR_SLOT_CELLS = 6;
/** Rows of logos a session shows before its last slot counts the rest. */
export const CALENDAR_GROUP_ROWS = 5;
/** The columns between two days. */
const DAY_GAP_CELLS = 1;

/** Logos per row in each day column of a calendar `width` cells wide. */
export function calendarSlotsPerRow(width: number): number {
  const day = Math.floor((Math.max(0, width - 2) - DAY_GAP_CELLS * 4) / 5);
  return Math.max(1, Math.floor(day / CALENDAR_SLOT_CELLS));
}

/** One spot in the week: a day, a row of its logos, and a slot in that row. */
interface Position { day: number; row: number; slot: number }

/** A group's last slot when it has more reports than it draws: "+N more", which expands it. */
interface MoreSlot { kind: "more"; key: string; day: CalendarDay; group: CalendarGroup }
type Slot = BoardReport | MoreSlot;

const isMore = (slot: Slot): slot is MoreSlot => "kind" in slot && slot.kind === "more";

/** A group's logos as the rows it draws them in, its "+N more" slot last. */
function groupRows(day: CalendarDay, group: CalendarGroup, perRow: number): Slot[][] {
  const more: MoreSlot[] = group.more > 0
    ? [{ kind: "more", key: `more:${calendarGroupKey(day.date, group.session)}`, day, group }]
    : [];
  return chunk<Slot>([...group.reports, ...more], perRow);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

/**
 * Where an arrow key moves from `from`: up and down by a row of the same
 * day, left and right along the row and on into the next day at the same
 * depth. Null when there is nowhere to go.
 */
export function moveInWeek<T>(grid: readonly (readonly (readonly T[])[])[], from: Position, direction: "up" | "down" | "left" | "right"): Position | null {
  const rows = grid[from.day] ?? [];
  if (direction === "up" || direction === "down") {
    const row = from.row + (direction === "down" ? 1 : -1);
    const target = rows[row];
    return target ? { day: from.day, row, slot: Math.min(from.slot, target.length - 1) } : null;
  }
  const step = direction === "right" ? 1 : -1;
  const slot = from.slot + step;
  if (rows[from.row]?.[slot]) return { ...from, slot };
  for (let day = from.day + step; day >= 0 && day < grid.length; day += step) {
    const next = grid[day]!;
    if (next.length === 0) continue;
    const row = Math.min(from.row, next.length - 1);
    return { day, row, slot: step > 0 ? 0 : next[row]!.length - 1 };
  }
  return null;
}

function locate(grid: readonly Slot[][][], key: string | null): Position | null {
  if (!key) return null;
  for (const [day, rows] of grid.entries()) {
    for (const [row, reports] of rows.entries()) {
      const slot = reports.findIndex((entry) => entry.key === key);
      if (slot >= 0) return { day, row, slot };
    }
  }
  return null;
}

/** What hovering a logo says: the company, when it reports and, once out, how it did. */
function reportTitle(report: BoardReport): string {
  const when = report.timing ? TIMING_LABEL[report.timing] : "time not set";
  const figures = report.epsActual != null
    ? `EPS ${epsText(report.epsActual)} vs ${epsText(report.epsEstimate)} est${report.epsSurprise != null ? `, ${signedPercent(report.epsSurprise)}` : ""}`
    : report.epsEstimate != null ? `EPS est ${epsText(report.epsEstimate)}` : null;
  return [`${report.symbol} · ${report.name}`, when, figures].filter(Boolean).join(" · ");
}

interface CalendarViewProps {
  days: readonly CalendarDay[];
  width: number;
  focused: boolean;
  /** A report's key, or the key of a "+N more" slot. */
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Enter, or a second click: the company's reports, as a table row opens them. */
  onOpen: (report: BoardReport) => void;
  /** A click on a "+N more" slot, or Enter on it: draw the whole group. */
  onMore: (day: CalendarDay, group: CalendarGroup) => void;
  /** The week is not read yet; `days` are empty until it is. */
  loading?: boolean;
  /** The week could not be read. */
  error?: string | null;
  emptyTitle: string;
}

/**
 * ERN's week on the desktop and the web: a column per day, and in each the
 * companies reporting before the open and after the close as their logos,
 * largest first, each with its ticker under it. A reported company's ticker
 * takes the colour of its surprise.
 */
export function EarningsCalendarView({
  days, width, focused, selectedKey, onSelect, onOpen, onMore, loading = false, error = null, emptyTitle,
}: CalendarViewProps) {
  const colors = useThemeColors();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  // The page keys scroll the week.
  useRegisterPaneScrollBox(scrollRef, { enabled: true });
  const tiles = useRef(new Map<string, BoxRenderable>());
  const perRow = calendarSlotsPerRow(width);
  // Each day's groups as rows of slots; the keys walk the day's rows, groups one after another.
  const layout = useMemo(() => days.map((day) => day.groups.map((group) => groupRows(day, group, perRow))), [days, perRow]);
  const grid = useMemo(() => layout.map((groups) => groups.flat()), [layout]);
  const position = locate(grid, selectedKey);
  const empty = days.every((day) => day.groups.length === 0);
  const ready = !loading && !error;

  // The cursor starts on the first company of the week.
  useEffect(() => {
    if (position || empty) return;
    const first = grid.flat(2).find((slot) => !isMore(slot));
    if (first) onSelect(first.key);
  }, [empty, grid, onSelect, position]);

  // Keeps the cursor in view, after a key moves it or a "+N more" slot draws the rest of its group.
  useEffect(() => {
    if (!selectedKey) return;
    afterLayout(() => revealInScrollBox(scrollRef.current, tiles.current.get(selectedKey) ?? null));
  }, [selectedKey]);
  const tileRef = useCallback((key: string) => (node: BoxRenderable | null) => {
    if (node) tiles.current.set(key, node);
    else tiles.current.delete(key);
  }, []);
  const press = useDoubleClickActivation<BoardReport>({ onSelect: (report) => onSelect(report.key), onActivate: onOpen });

  useShortcut((event) => {
    if (!focused || !position) return;
    const direction = isPlainKey(event, "down", "j") ? "down" : isPlainKey(event, "up", "k") ? "up"
      : isPlainKey(event, "left") ? "left" : isPlainKey(event, "right") ? "right" : null;
    if (direction) {
      const next = moveInWeek(grid, position, direction);
      event.preventDefault();
      event.stopPropagation();
      if (next) onSelect(grid[next.day]![next.row]![next.slot]!.key);
      return;
    }
    if (isPlainKey(event, "return", "enter")) {
      const slot = grid[position.day]?.[position.row]?.[position.slot];
      if (!slot) return;
      event.preventDefault();
      event.stopPropagation();
      if (isMore(slot)) onMore(slot.day, slot.group);
      else onOpen(slot);
    }
  });

  // The days are the week's columns, headed as a table's are: bold and dim on the panel, today bright.
  const header = (
    <Box
      flexDirection="row"
      paddingX={1}
      columnGap={DAY_GAP_CELLS}
      flexShrink={0}
      alignItems="center"
      backgroundColor={colors.panel}
      style={HEADER_STYLE}
      data-gloom-role="earnings-calendar-days"
    >
      {days.map((day) => (
        <Box key={day.date} flexGrow={1} flexBasis={0} minWidth={0} flexDirection="row" columnGap={1} overflow="hidden">
          <ClippedText
            text={`${day.weekday} ${day.label}`}
            width={20}
            fg={day.today ? colors.textBright : colors.textDim}
            attributes={TextAttributes.BOLD}
          />
          {/* A holiday says so, unless companies report on it anyway; no count before the week is read. */}
          {day.closed && day.total === 0 ? <Text fg={colors.textMuted}>closed</Text>
            : ready ? <Text fg={colors.textMuted}>{String(day.total)}</Text> : null}
        </Box>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" {...FILL_REST}>
      {header}
      <PaneStatusBody loading={loading} error={error} empty={ready && empty} emptyTitle={emptyTitle} subject="the earnings calendar">
        <ScrollBox ref={scrollRef} {...FILL_REST} scrollY focusable={false}>
          <Box flexDirection="row" alignItems="flex-start" paddingX={1} columnGap={DAY_GAP_CELLS} data-gloom-role="earnings-calendar-week">
            {days.map((day, dayIndex) => (
              <Box
                key={day.date}
                flexGrow={1}
                flexBasis={0}
                minWidth={0}
                flexDirection="column"
                data-gloom-role="earnings-calendar-day"
                data-date={day.date}
              >
                {day.groups.map((group, groupIndex) => (
                  <Box key={group.session ?? "unset"} flexDirection="column" style={{ paddingTop: "var(--gloom-space-sm)" }}>
                    <Box flexDirection="row" columnGap={1} height={1} overflow="hidden">
                      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{group.label}</Text>
                      <Text fg={colors.textMuted}>{String(group.reports.length + group.more)}</Text>
                    </Box>
                    {layout[dayIndex]![groupIndex]!.map((slots, rowIndex) => (
                      <Box key={rowIndex} flexDirection="row">
                        {Array.from({ length: perRow }, (_, index) => {
                          const slot = slots[index];
                          // The last row's room past its logos.
                          if (!slot) return <Box key={index} flexGrow={1} flexBasis={0} minWidth={0} />;
                          if (isMore(slot)) {
                            return (
                              <MoreTile key={slot.key} count={group.more} selected={slot.key === selectedKey}
                                onPress={() => onMore(day, group)} tileRef={tileRef(slot.key)} />
                            );
                          }
                          return (
                            <ReportTile
                              key={slot.key}
                              report={slot}
                              selected={slot.key === selectedKey}
                              onPress={(event) => press(slot.key, slot, event)}
                              tileRef={tileRef(slot.key)}
                            />
                          );
                        })}
                      </Box>
                    ))}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        </ScrollBox>
      </PaneStatusBody>
    </Box>
  );
}

/** A table header's height, the chrome row. */
const HEADER_STYLE = { height: "var(--chrome-h)" } as const;
const TILE_STYLE = {
  padding: "var(--gloom-space-xs) 0",
  borderRadius: "var(--gloom-radius-sm)",
  rowGap: "var(--gloom-space-xs)",
} as const;
/** The logo of a calendar tile: a square near two cells tall, most of the slot's width. */
const LOGO_STYLE = { width: "calc(var(--cell-h) * 1.75)", height: "calc(var(--cell-h) * 1.75)", flexShrink: 0 } as const;

function ReportTile({ report, selected, onPress, tileRef }: {
  report: BoardReport;
  selected: boolean;
  onPress: (event: { detail?: number }) => void;
  tileRef: (node: BoxRenderable | null) => void;
}) {
  const colors = useThemeColors();
  const surprise = report.epsSurprise;
  const ink = selected ? colors.selectedText
    : surprise == null || surprise === 0 ? colors.text : surprise > 0 ? colors.positive : colors.negative;
  return (
    <Box
      ref={tileRef}
      flexGrow={1}
      flexBasis={0}
      minWidth={0}
      flexDirection="column"
      alignItems="center"
      backgroundColor={selected ? colors.selected : undefined}
      hoverBackgroundColor={selected ? undefined : "var(--gloom-hover-fill)"}
      onMouseDown={onPress}
      title={reportTitle(report)}
      data-gloom-interactive="true"
      data-gloom-role="earnings-calendar-report"
      data-selected={selected ? "true" : undefined}
      data-symbol={report.symbol}
      style={TILE_STYLE}
    >
      <Box style={LOGO_STYLE}>
        <CompanyLogoMark symbol={report.symbol} name={report.name} size="lead" />
      </Box>
      <ClippedText text={report.symbol} width={CALENDAR_SLOT_CELLS - 1} fg={ink} attributes={TextAttributes.BOLD} />
    </Box>
  );
}

function MoreTile({ count, selected, onPress, tileRef }: {
  count: number;
  selected: boolean;
  onPress: () => void;
  tileRef: (node: BoxRenderable | null) => void;
}) {
  const colors = useThemeColors();
  return (
    <Box
      ref={tileRef}
      flexGrow={1}
      flexBasis={0}
      minWidth={0}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={selected ? colors.selected : undefined}
      hoverBackgroundColor={selected ? undefined : "var(--gloom-hover-fill)"}
      onMouseDown={onPress}
      title={`Show the other ${count}`}
      data-gloom-interactive="true"
      data-gloom-role="earnings-calendar-more"
      data-selected={selected ? "true" : undefined}
      style={TILE_STYLE}
    >
      <Box style={LOGO_STYLE} alignItems="center" justifyContent="center">
        <Text fg={selected ? colors.selectedText : colors.textDim} attributes={TextAttributes.BOLD}>{`+${count}`}</Text>
      </Box>
      <Text fg={selected ? colors.selectedText : colors.textMuted}>more</Text>
    </Box>
  );
}
