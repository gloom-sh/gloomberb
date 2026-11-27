import { COUNTRY_FLAG_CELLS } from "../../../components/ui/country-flag";
import { markHiddenTableColumns, tableColumnWidth } from "../../../components/ui/table-layout";
import { timeZoneCity, zonedClock } from "../../../utils/utc-time";
import {
  CALENDAR_TIME_ZONE_LABEL,
  figuresBesideNames,
  keptFigureColumns,
  longestEventName,
  valueColumnWidth,
  type CountryFilter,
  type EconCalendarColumn,
  type ImpactFilter,
} from "./calendar-model";
import { hasNoReleaseTime, isAllDayEvent, type EconEvent } from "./types";

const SPELLED_IMPACT = "IMPACT";
const SPELLED_COUNTRY = "COUNTRY";
/** Event names this wide still read; past it the headers spell themselves out. */
const SPELLED_HEADER_MIN_EVENT_WIDTH = 24;

/** Whether the list has a country column: not where a filter names one country (the euro area's are several). */
export function countryColumnShown(countryFilter: CountryFilter): boolean {
  return !/^[A-Z]{2}$/.test(countryFilter) || countryFilter === "EU";
}

/**
 * The calendar's columns at `width` cells for the events listed (`events`):
 * `columns` the table draws, `exportColumns` all of them, as Export CSV
 * writes them. `flagged` leads each country's code with its flag (the
 * desktop and the web), and `readerZone` is the reader's own time zone.
 * `actualNote` is the widest word a row says under ACTUAL in place of its
 * figure (actualNoteWidth), which the column keeps whole.
 * Every width comes from the whole list, never the rows in view, so no
 * column moves as the reader scrolls.
 */
export function econCalendarColumns({ width, events, countryFilter, impactFilter, flagged, readerZone, actualNote = 0 }: {
  width: number;
  events: readonly EconEvent[];
  countryFilter: CountryFilter;
  impactFilter: ImpactFilter;
  flagged: boolean;
  readerZone: string | null;
  actualNote?: number;
}): { columns: EconCalendarColumn[]; exportColumns: EconCalendarColumn[] } {
  // Named by its zone, as the reader's column is by its city: "TIME (UTC)" took 13
  // cells over "07:00" while EVENT read "GDP Growth Ra…" (review, 12 Nov 2026).
  const timeLabelText = CALENDAR_TIME_ZONE_LABEL;
  const timeWidth = tableColumnWidth({ width: events.some(isAllDayEvent) ? "All day".length : 5, label: timeLabelText });
  const compact = width < 58;
  // One country, or one impact level, is the filter's: no column repeats it on each row.
  const showCountry = countryColumnShown(countryFilter);
  const showImpact = impactFilter === "all";
  const actualLabel = compact ? "ACT" : "ACTUAL";
  const forecastLabel = compact ? "EST" : "FORECAST";
  // ACTUAL as wide as its widest figure and `note`, the word a row may say in its place.
  const actualWidth = (note: number) => tableColumnWidth({ width: Math.max(valueColumnWidth(events, "actual", compact ? 3 : 9), note), label: actualLabel });
  const forecastWidth = tableColumnWidth({ width: valueColumnWidth(events, "forecast", compact ? 3 : 10), label: forecastLabel });
  const priorWidth = tableColumnWidth({ width: valueColumnWidth(events, "prior", compact ? 5 : 9), label: "PRIOR" });
  const minEventWidth = tableColumnWidth({ width: compact ? 5 : 12, label: "EVENT" });
  // The reader's clock, with the weekday on rows where it is another day than the UTC one they are listed under.
  const readerLabel = readerZone ? timeZoneCity(readerZone).toUpperCase() : null;
  const readerWidth = !readerZone || !readerLabel ? 0 : tableColumnWidth({ label: readerLabel,
    width: events.some((ev) => !hasNoReleaseTime(ev) && zonedClock(ev.date.getTime(), readerZone).label.length > 5) ? 9 : 5 });
  const figureColumnsFor = (note: number): EconCalendarColumn[] => [
    { id: "actual", label: actualLabel, title: "Actual", width: actualWidth(note), align: "right" },
    { id: "forecast", label: forecastLabel, title: "Forecast", width: forecastWidth, align: "right" },
    { id: "prior", label: "PRIOR", width: priorWidth, align: "right" },
  ];
  // Padding, one gap per column boundary, and the vertical scrollbar lane;
  // one column short of that clipped the PRIOR values at the right edge.
  // `times` is the time columns (UTC, and the reader's clock); impact, country and event are the other three.
  const roomBeside = (figures: readonly EconCalendarColumn[], times: number, timesWidth: number) => (impactWidth: number, countryWidth: number) => (
    width - 3 - (times + 3 + figures.length) + (showCountry ? 0 : 1) + (showImpact ? 0 : 1)
      - (timesWidth + (showImpact ? impactWidth : 0) + (showCountry ? countryWidth : 0) + figures.reduce((sum, column) => sum + column.width, 0))
  );
  const codeWidth = 2 + (flagged ? COUNTRY_FLAG_CELLS : 0);
  const underShortHeaders = (room: (impactWidth: number, countryWidth: number) => number) => room(4, Math.max(3, codeWidth));
  const spelledImpactWidth = tableColumnWidth({ width: 1, label: SPELLED_IMPACT });
  const spelledCountryWidth = Math.max(codeWidth, tableColumnWidth({ width: 1, label: SPELLED_COUNTRY }));

  // The columns before the figures, and the figures kept, beside figure columns as wide as `figureColumns` and names
  // of up to `longestName` cells, with `note` the word ACTUAL keeps whole.
  const layout = (figureColumns: readonly EconCalendarColumn[], longestName: number, note: number) => {
    // The reader's column only where the event names keep room to read beside it, under the short headers.
    const withReader = readerWidth > 0 && underShortHeaders(roomBeside(figureColumns, 2, timeWidth + readerWidth)) >= minEventWidth;
    const times = withReader ? 2 : 1;
    const timesWidth = withReader ? timeWidth + readerWidth : timeWidth;
    // The names come first, as in every narrow table: where three figure columns leave "GDP Growt…", PRIOR goes, and
    // in a narrower pane still the forecast; the table says which it left out. The event's detail has all three.
    const kept = keptFigureColumns(figureColumns, (columns) => underShortHeaders(roomBeside(columns, times, timesWidth)), longestName, minEventWidth,
      note);
    // IMPACT and COUNTRY in words while event names keep room to read; the
    // short labels otherwise, with the word on hover where there is one.
    const spelled = roomBeside(kept, times, timesWidth)(spelledImpactWidth, spelledCountryWidth) >= SPELLED_HEADER_MIN_EVENT_WIDTH;
    const impactColumn = spelled
      ? { label: SPELLED_IMPACT, width: spelledImpactWidth }
      : { label: "IMP", width: 4, title: "Impact" };
    const countryColumn = spelled
      ? { label: SPELLED_COUNTRY, width: spelledCountryWidth }
      : { label: "CTY", width: Math.max(3, codeWidth), title: "Country" };
    const eventRoom = (columns: readonly EconCalendarColumn[]) =>
      roomBeside(columns, times, timesWidth)(tableColumnWidth(impactColumn), tableColumnWidth(countryColumn));
    const leading = (eventWidth: number): EconCalendarColumn[] => [
      { id: "time", label: timeLabelText, width: timeWidth, align: "left" },
      ...withReader ? [{ id: "readerTime" as const, label: readerLabel!, width: readerWidth, align: "left" as const, title: readerZone! }] : [],
      ...showImpact ? [{ id: "impact" as const, ...impactColumn, align: "left" as const }] : [],
      ...showCountry ? [{ id: "country" as const, ...countryColumn, align: "left" as const }] : [],
      // The names take any room the pane has past these widths too: the desktop and the web otherwise spread it over
      // every column, figures among them, while the names stay cut.
      { id: "event", label: "EVENT", width: eventWidth, align: "left", flexGrow: 1 },
    ];
    return { kept, eventRoom, leading };
  };

  const figureColumns = figureColumnsFor(actualNote);
  const longestName = longestEventName(events, showCountry);
  const shown = layout(figureColumns, longestName, actualNote);
  // Then the names have what a long figure weeks out took, up to the longest of them: the figure is cut, not every name.
  const figures = figuresBesideNames(shown.kept, shown.eventRoom, longestName, minEventWidth, actualNote);
  const leading = shown.leading(Math.max(minEventWidth, shown.eventRoom(figures)));
  // Export CSV writes the columns it always did, decided at the figures' own widths and the names as the source
  // writes them: a row awaiting its figure, which widens ACT in the table, never takes the reader's clock from the file.
  const filedFigures = figureColumnsFor(0);
  const filed = layout(filedFigures, longestEventName(events), 0);
  return {
    columns: markHiddenTableColumns([...leading, ...figureColumns], [...leading, ...figures]),
    exportColumns: [...filed.leading(Math.max(minEventWidth, filed.eventRoom(filed.kept))), ...filedFigures],
  };
}
