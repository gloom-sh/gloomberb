import type { DataTableColumn } from "../../../components";
import { colors } from "../../../theme/colors";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";
import { zonedDateTimeParts, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";

export const MARKET_HALTS_PANE_ID = "market-halts";

/** Nasdaq publishes every field of this feed as America/New_York wall-clock time. */
const EXCHANGE_TIME_ZONE = "America/New_York";

export type HaltStatus = "halted" | "quote" | "resumed";

export interface HaltRecord {
  id: string;
  symbol: string;
  company: string;
  market: string;
  reasonCode: string;
  /** Plain-English expansion of `reasonCode`. */
  reason: string;
  haltedAt: number;
  quoteResumeAt: number | null;
  tradeResumeAt: number | null;
}

/**
 * Concise renderings of Nasdaq's trade halt codes
 * (nasdaqtrader.com/trader.aspx?id=TradeHaltCodes), shortened to fit a column
 * while keeping the meaning intact.
 */
const HALT_REASONS: Readonly<Record<string, string>> = {
  T1: "News pending",
  T2: "News released",
  T3: "News released, resumption times set",
  T5: "Single-stock pause, 10% move",
  T6: "Extraordinary market activity",
  T7: "Quotation-only period",
  T8: "ETF halt",
  T12: "Additional info requested by Nasdaq",
  H4: "Listing non-compliance",
  H9: "Filings not current",
  H10: "SEC trading suspension",
  H11: "Regulatory concern",
  O1: "Operations halt",
  IPO1: "IPO not yet trading",
  IPOQ: "IPO released for quotation",
  IPOE: "IPO positioning window extended",
  M: "Volatility pause, listed issue",
  M1: "Corporate action",
  M2: "Quotation not available",
  LUDP: "Volatility pause",
  LUDS: "Volatility pause, straddle",
  MWC0: "Circuit breaker carried over",
  MWC1: "Market-wide circuit breaker, level 1",
  MWC2: "Market-wide circuit breaker, level 2",
  MWC3: "Market-wide circuit breaker, level 3",
  MWCQ: "Market-wide circuit breaker resumption",
  R1: "New issue available",
  R2: "Issue available",
  R4: "Qualification issues resolved",
  R9: "Filing requirements satisfied",
  C3: "Issuer news not forthcoming",
  C4: "Qualifications halt ended",
  C9: "Qualifications halt concluded",
  C11: "Halt concluded by other regulator",
  D: "Security deleted from Nasdaq/CQS",
};

export function describeHaltReason(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return "Reason not available";
  return HALT_REASONS[normalized] ?? `Reason code ${normalized}`;
}

function etParts(utcMs: number) {
  return zonedDateTimeParts(utcMs, EXCHANGE_TIME_ZONE);
}

export function etWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond = 0,
): number {
  return zonedWallClockToUtcMs(
    EXCHANGE_TIME_ZONE,
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
}

/** Parse Nasdaq's "MM/DD/YYYY" date and "HH:MM:SS[.mmm]" time pair. */
export function parseEtDateTime(date: string, time: string): number | null {
  const dateMatch = date.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const timeMatch = time.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[3]);
  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? "0");
  const millisecond = Number((timeMatch[4] ?? "0").padEnd(3, "0"));
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  return etWallClockToUtcMs(year, month, day, hour, minute, second, millisecond);
}

function formatEtClock(utcMs: number): string {
  const parts = etParts(utcMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/** "MM/DD/YY" in ET, because the feed carries halts that are years apart. */
export function formatEtDate(utcMs: number): string {
  const parts = etParts(utcMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(parts.month)}/${pad(parts.day)}/${String(parts.year).slice(2)}`;
}

export function formatEtTime(utcMs: number | null): string {
  return utcMs == null ? "—" : formatEtClock(utcMs);
}

/**
 * Resumption times usually share the halt's session, so the time alone reads
 * cleanly; an overnight halt gets its ET date back rather than looking like it
 * reopened before it stopped.
 */
export function formatEtResumption(utcMs: number | null, haltedAt: number): string {
  if (utcMs == null) return "—";
  const sameDay = formatEtDate(utcMs) === formatEtDate(haltedAt);
  return sameDay ? formatEtClock(utcMs) : `${formatEtDate(utcMs).slice(0, 5)} ${formatEtClock(utcMs).slice(0, 5)}`;
}

export function resolveHaltStatus(record: HaltRecord, now: number): HaltStatus {
  if (record.tradeResumeAt != null && now >= record.tradeResumeAt) return "resumed";
  if (record.quoteResumeAt != null && now >= record.quoteResumeAt) return "quote";
  return "halted";
}

export function haltStatusLabel(status: HaltStatus): string {
  switch (status) {
    case "halted":
      return "HALTED";
    case "quote":
      return "QUOTE";
    case "resumed":
      return "RESUMED";
  }
}

export function haltStatusColor(status: HaltStatus): string {
  switch (status) {
    case "halted":
      return colors.negative;
    case "quote":
      return colors.warning;
    case "resumed":
      return colors.positive;
  }
}

export type HaltFilter = "all" | "active" | "resumed";

export const HALT_FILTERS: ReadonlyArray<{ label: string; value: HaltFilter }> = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Resumed", value: "resumed" },
];

export function nextHaltFilter(current: HaltFilter): HaltFilter {
  const index = HALT_FILTERS.findIndex((entry) => entry.value === current);
  return HALT_FILTERS[(index + 1) % HALT_FILTERS.length]!.value;
}

export function filterHalts(records: HaltRecord[], filter: HaltFilter, now: number): HaltRecord[] {
  if (filter === "all") return records;
  return records.filter((record) => {
    const status = resolveHaltStatus(record, now);
    return filter === "resumed" ? status === "resumed" : status !== "resumed";
  });
}

export type HaltColumnId =
  | "symbol"
  | "market"
  | "company"
  | "code"
  | "reason"
  | "date"
  | "halted"
  | "quote"
  | "trade"
  | "status";

export type HaltColumn = DataTableColumn & { id: HaltColumnId };

export const HALT_SORT_COLUMN_IDS: readonly HaltColumnId[] = [
  "symbol",
  "market",
  "company",
  "code",
  "reason",
  "halted",
  "quote",
  "trade",
  "status",
];

export type HaltSortPreference = SortPreference<HaltColumnId>;

/** Newest halt first: the reason anyone opens this pane. */
export const DEFAULT_HALT_SORT: HaltSortPreference = { columnId: "halted", direction: "desc" };

const COMPANY_MIN_WIDTH = 12;
const REASON_MIN_WIDTH = 14;

/**
 * Every column at its narrowest. CODE is six cells because the table never
 * draws a column narrower than its header plus the sort arrow.
 */
const HALT_COLUMNS: readonly HaltColumn[] = [
  { id: "symbol", label: "SYMBOL", width: 8, align: "left" },
  // "Non NASDAQ" and "NYSE Arca" are real feed values, so MKT holds all ten cells.
  { id: "market", label: "MKT", width: 10, align: "left" },
  { id: "company", label: "COMPANY", width: COMPANY_MIN_WIDTH, align: "left", flexGrow: 1 },
  { id: "code", label: "CODE", width: 6, align: "left" },
  { id: "reason", label: "REASON", width: REASON_MIN_WIDTH, align: "left", flexGrow: 1 },
  { id: "date", label: "DATE ET", width: 9, align: "left" },
  { id: "halted", label: "HALT ET", width: 9, align: "left" },
  { id: "quote", label: "QUOTE ET", width: 11, align: "left" },
  { id: "trade", label: "TRADE ET", width: 11, align: "left" },
  { id: "status", label: "STATUS", width: 8, align: "left" },
];

/**
 * What a narrow pane gives up first, so STATUS never scrolls out of view. MKT
 * is only the venue, STATUS already reads QUOTE once quoting resumes, and
 * REASON spells out CODE. Symbol, reason, halt date and time, trade
 * resumption and status always stay.
 */
const NARROW_DROP_ORDER: readonly HaltColumnId[] = ["market", "quote", "code", "company"];

/** One gap after every column, a pad cell at each edge, and a cell for the scrollbar. */
function haltTableWidth(columns: readonly HaltColumn[]): number {
  return columns.reduce((total, column) => total + column.width + 1, 3);
}

export function buildHaltColumns(width: number): HaltColumn[] {
  let columns = HALT_COLUMNS;
  for (const id of NARROW_DROP_ORDER) {
    if (haltTableWidth(columns) <= width) break;
    columns = columns.filter((column) => column.id !== id);
  }
  // The two text columns share what is left, the company a little under half.
  const spare = Math.max(0, width - haltTableWidth(columns));
  const hasCompany = columns.some((column) => column.id === "company");
  const text = (hasCompany ? COMPANY_MIN_WIDTH : 0) + REASON_MIN_WIDTH + spare;
  const companyWidth = hasCompany ? Math.max(COMPANY_MIN_WIDTH, Math.floor(text * 0.45)) : 0;
  const reasonWidth = text - companyWidth;
  return columns.map((column) => {
    if (column.id === "company") return { ...column, width: companyWidth };
    if (column.id === "reason") return { ...column, width: reasonWidth };
    return { ...column };
  });
}

function haltSortValue(columnId: HaltColumnId, record: HaltRecord, now: number): string | number | null {
  switch (columnId) {
    case "symbol":
      return record.symbol;
    case "market":
      return record.market;
    case "company":
      return record.company;
    case "code":
      return record.reasonCode;
    case "reason":
      return record.reason;
    case "date":
    case "halted":
      return record.haltedAt;
    case "quote":
      return record.quoteResumeAt;
    case "trade":
      return record.tradeResumeAt;
    case "status":
      return resolveHaltStatus(record, now);
  }
}

export function sortHalts(records: HaltRecord[], sort: HaltSortPreference, now: number): HaltRecord[] {
  const columnId = sort.columnId;
  if (!columnId) return records;
  return [...records].sort((a, b) => {
    const compared = compareSortValues(
      haltSortValue(columnId, a, now),
      haltSortValue(columnId, b, now),
      sort.direction,
    );
    // A stable secondary key keeps rows from shuffling between refreshes.
    return compared !== 0 ? compared : b.haltedAt - a.haltedAt;
  });
}

export function nextHaltSort(current: HaltSortPreference, columnId: string): HaltSortPreference {
  const typed = columnId as HaltColumnId;
  if (current.columnId !== typed) return { columnId: typed, direction: "asc" };
  if (current.direction === "asc") return { columnId: typed, direction: "desc" };
  return DEFAULT_HALT_SORT;
}
