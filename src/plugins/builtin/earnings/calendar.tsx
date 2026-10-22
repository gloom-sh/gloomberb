import { useCallback, useEffect, useMemo, useRef } from "react";
import { CompanyLogoMark } from "../../../components/company-logo";
import { EmptyState } from "../../../components";
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
import type { CalendarDay, CalendarGroup } from "./calendar-model";
import { epsText, signedPercent, TIMING_LABEL } from "./format";

/** Cells a logo and its ticker take side by side; a day fits as many as its width holds. */
const CALENDAR_SLOT_CELLS = 7;
/** Rows of logos a session shows before the rest is left to the table. */
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

/** A day's logos as the rows it draws them in, groups one after another. */
function dayRows(day: CalendarDay, perRow: number): BoardReport[][] {
  return day.groups.flatMap((group) => chunk(group.reports, perRow));
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
export function moveInWeek(grid: readonly BoardReport[][][], from: Position, direction: "up" | "down" | "left" | "right"): Position | null {
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

function locate(grid: readonly BoardReport[][][], key: string | null): Position | null {
  if (!key) return null;
  for (const [day, rows] of grid.entries()) {
    for (const [row, reports] of rows.entries()) {
      const slot = reports.findIndex((report) => report.key === key);
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
  selectedKey: string | null;
  onSelect: (report: BoardReport) => void;
  /** Enter, or a second click: the company's reports, as a table row opens them. */
  onOpen: (report: BoardReport) => void;
  /** A day's group has more reports than it draws: the table lists them all. */
  onMore: (day: CalendarDay, group: CalendarGroup) => void;
  emptyTitle: string;
}

/**
 * ERN's week on the desktop and the web: a column per day, and in each the
 * companies reporting before the open and after the close as their logos,
 * largest first, each with its ticker under it. A reported company's ticker
 * takes the colour of its surprise.
 */
export function EarningsCalendarView({ days, width, focused, selectedKey, onSelect, onOpen, onMore, emptyTitle }: CalendarViewProps) {
  const colors = useThemeColors();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  // The page keys scroll the week.
  useRegisterPaneScrollBox(scrollRef, { enabled: true });
  const tiles = useRef(new Map<string, BoxRenderable>());
  const perRow = calendarSlotsPerRow(width);
  const grid = useMemo(() => days.map((day) => dayRows(day, perRow)), [days, perRow]);
  const position = locate(grid, selectedKey);
  const empty = days.every((day) => day.groups.length === 0);

  // The cursor starts on the first company of the week.
  useEffect(() => {
    if (position || empty) return;
    const first = grid.find((rows) => rows.length > 0)?.[0]?.[0];
    if (first) onSelect(first);
  }, [empty, grid, onSelect, position]);

  const reveal = useCallback((key: string) => afterLayout(() => revealInScrollBox(scrollRef.current, tiles.current.get(key) ?? null)), [scrollRef]);
  const press = useDoubleClickActivation<BoardReport>({ onSelect, onActivate: onOpen });

  useShortcut((event) => {
    if (!focused || !position) return;
    const direction = isPlainKey(event, "down", "j") ? "down" : isPlainKey(event, "up", "k") ? "up"
      : isPlainKey(event, "left") ? "left" : isPlainKey(event, "right") ? "right" : null;
    if (direction) {
      const next = moveInWeek(grid, position, direction);
      event.preventDefault();
      event.stopPropagation();
      if (!next) return;
      const report = grid[next.day]![next.row]![next.slot]!;
      onSelect(report);
      reveal(report.key);
      return;
    }
    if (isPlainKey(event, "return", "enter")) {
      const report = grid[position.day]?.[position.row]?.[position.slot];
      if (!report) return;
      event.preventDefault();
      event.stopPropagation();
      onOpen(report);
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
          <Text fg={colors.textMuted}>{day.closed ? "closed" : String(day.total)}</Text>
        </Box>
      ))}
    </Box>
  );

  if (empty) {
    return (
      <Box flexDirection="column" {...FILL_REST}>
        {header}
        <EmptyState title={emptyTitle} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" {...FILL_REST}>
      {header}
      <ScrollBox ref={scrollRef} {...FILL_REST} scrollY focusable={false}>
        <Box flexDirection="row" alignItems="flex-start" paddingX={1} columnGap={DAY_GAP_CELLS} data-gloom-role="earnings-calendar-week">
          {days.map((day) => (
            <Box
              key={day.date}
              flexGrow={1}
              flexBasis={0}
              minWidth={0}
              flexDirection="column"
              data-gloom-role="earnings-calendar-day"
              data-date={day.date}
            >
              {day.groups.map((group) => (
                <Box key={group.session ?? "unset"} flexDirection="column" style={{ paddingTop: "var(--gloom-space-sm)" }}>
                  <Box flexDirection="row" columnGap={1} height={1} overflow="hidden">
                    <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{group.label}</Text>
                    <Text fg={colors.textMuted}>{String(group.reports.length + group.more)}</Text>
                  </Box>
                  {chunk<BoardReport | "more">([...group.reports, ...(group.more > 0 ? ["more" as const] : [])], perRow).map((slots, rowIndex) => (
                    <Box key={rowIndex} flexDirection="row">
                      {Array.from({ length: perRow }, (_, slot) => {
                        const report = slots[slot];
                        if (report === "more") return <MoreTile key="more" count={group.more} onPress={() => onMore(day, group)} />;
                        // The last row's room past its logos.
                        if (!report) return <Box key={slot} flexGrow={1} flexBasis={0} minWidth={0} />;
                        return (
                          <ReportTile
                            key={report.key}
                            report={report}
                            selected={report.key === selectedKey}
                            onPress={(event) => press(report.key, report, event)}
                            tileRef={(node) => {
                              if (node) tiles.current.set(report.key, node);
                              else tiles.current.delete(report.key);
                            }}
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
/** The logo of a calendar tile: a square a cell and a half tall. */
const LOGO_STYLE = { width: "calc(var(--cell-h) * 1.5)", height: "calc(var(--cell-h) * 1.5)", flexShrink: 0 } as const;

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

function MoreTile({ count, onPress }: { count: number; onPress: () => void }) {
  const colors = useThemeColors();
  return (
    <Box
      flexGrow={1}
      flexBasis={0}
      minWidth={0}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      hoverBackgroundColor="var(--gloom-hover-fill)"
      onMouseDown={onPress}
      title="See them all in the table"
      data-gloom-interactive="true"
      data-gloom-role="earnings-calendar-more"
      style={TILE_STYLE}
    >
      <Box style={LOGO_STYLE} alignItems="center" justifyContent="center">
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>{`+${count}`}</Text>
      </Box>
      <Text fg={colors.textMuted}>more</Text>
    </Box>
  );
}
