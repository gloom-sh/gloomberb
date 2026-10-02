import type {
  CloudSessionMoverItem,
  CloudSessionMoversCategory,
  CloudSessionMoversSide,
  CloudSessionPhase,
} from "../../../api-client/market-movers";
import { activeUsMarketSession } from "../../../market-data/market/freshness";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";
import type { Quote } from "../../../types/financials";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { zonedDateKey, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";
import type { SessionTabId } from "./model";

const NEW_YORK = "America/New_York";
const HOUR_MS = 60 * 60_000;
const SESSION_TABS = new Set<string>(["premarket", "afterhours", "gaps"]);
/** Lists that belong to the regular session, where the day's own lists are the default. */
const REGULAR_TABS = new Set<string>(["gainers", "losers", "actives", "trending", "gaps"]);

export function isSessionTab(tab: string): tab is SessionTabId {
  return SESSION_TABS.has(tab);
}

export interface UsSession {
  /** New York trading date. */
  date: string;
  phase: CloudSessionPhase;
  /** Date and phase, e.g. "2026-09-29:pre": a list picked in one session is not carried into the next. */
  key: string;
}

/**
 * What is trading in New York at `now`: the pre-market from 04:00, the regular
 * session on the published calendar's hours (13:00 closes included), and four
 * hours after the close. Holidays and weekends are closed. Past the published
 * years it falls back to weekday hours.
 */
export function usSessionAt(now: number): UsSession {
  const date = zonedDateKey(now, NEW_YORK);
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const at = (hour: number) => zonedWallClockToUtcMs(NEW_YORK, year, month, day, hour, 0, 0);
  const published = getPublishedUsEquitySession("NYSE", date);
  let phase: CloudSessionPhase;
  if (!published) {
    const active = activeUsMarketSession(now);
    phase = active === "PRE" ? "pre" : active === "REGULAR" ? "regular" : active === "POST" ? "post" : "closed";
  } else if (published.kind === "closed" || now < at(4)) {
    phase = "closed";
  } else if (now < published.open) {
    phase = "pre";
  } else if (now < published.close) {
    phase = "regular";
  } else if (now < Math.min(published.close + 4 * HOUR_MS, at(20))) {
    phase = "post";
  } else {
    phase = "closed";
  }
  return { date, phase, key: `${date}:${phase}` };
}

/**
 * The list MOST opens on. A list asked for with `--list` (the CLI or a
 * screenshot) is kept until the user picks another. A list the user picked
 * stays while the session it was picked in lasts; otherwise the pane follows
 * the session that is trading: Pre-market before 09:30, the day's lists during
 * the regular session, After hours after the close. Overnight and on closed
 * days the last pick stands. An account that cannot open the session lists
 * (signed out, unverified, free) keeps the day's lists instead of being moved
 * onto a wall.
 */
export function resolveActiveTab<T extends string>(args: {
  tabs: readonly T[];
  saved: string;
  pickedIn: string | null | undefined;
  session: UsSession;
  requested?: string | null;
  sessionListsOpen: boolean;
}): T {
  const { tabs, session } = args;
  const requested = tabs.find((tab) => tab === args.requested);
  if (requested) return requested;
  const saved = tabs.find((tab) => tab === args.saved) ?? tabs[0]!;
  if (session.phase === "closed" || args.pickedIn === session.key) return saved;
  if (session.phase === "regular" || !args.sessionListsOpen) {
    return REGULAR_TABS.has(saved) ? saved : tabs.find((tab) => REGULAR_TABS.has(tab)) ?? saved;
  }
  const sessionTab = session.phase === "pre" ? "premarket" : "afterhours";
  return tabs.find((tab) => tab === sessionTab) ?? saved;
}

export interface SideOption {
  value: CloudSessionMoversSide;
  label: string;
}

const MOVER_SIDES: SideOption[] = [
  { value: "up", label: "Gainers" },
  { value: "down", label: "Losers" },
  { value: "active", label: "Active" },
];
const GAP_SIDES: SideOption[] = [
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];

export function sessionSides(view: CloudSessionMoversCategory): SideOption[] {
  return view === "gaps" ? GAP_SIDES : MOVER_SIDES;
}

/** The persisted side, or the first one the view has. */
export function resolveSide(view: CloudSessionMoversCategory, saved: string | undefined): CloudSessionMoversSide {
  const sides = sessionSides(view);
  return sides.find((side) => side.value === saved)?.value ?? sides[0]!.value;
}

/**
 * Whether live quotes can update a list: only while its session segment is
 * trading. A finished pre-market list or last evening's after-hours list keeps
 * the prices it closed at.
 */
export function sessionListIsLive(
  view: CloudSessionMoversCategory,
  listSession: string | null,
  session: UsSession,
): boolean {
  if (!listSession || listSession !== session.date) return false;
  if (view === "premarket") return session.phase === "pre";
  if (view === "afterhours") return session.phase === "post";
  return session.phase !== "closed";
}

export type SessionMoverRow = CloudSessionMoverItem;

function percentFrom(value: number, reference: number | null | undefined): number | null {
  return reference != null && Number.isFinite(reference) && reference > 0 ? (value / reference - 1) * 100 : null;
}

const overlays = new WeakMap<CloudSessionMoverItem, { quote: Quote; row: SessionMoverRow }>();

/**
 * Live prices on a live list. The change is measured from the row's own
 * reference close (after hours: the day's close, not the prior one) and the
 * VWAP distance from the session VWAP; volume, relative volume and the gap stay
 * the list's, which the next list refresh brings forward.
 */
export function overlaySessionMovers(
  rows: readonly CloudSessionMoverItem[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): SessionMoverRow[] {
  return rows.map((row) => {
    const quote = resolveEntryData(entries.get(buildQuoteKey({ symbol: row.symbol, exchange: row.exchange })));
    const price = getActiveQuoteDisplay(quote)?.price;
    if (!quote || price == null || !Number.isFinite(price) || price <= 0 || quote.lastUpdated < row.lastUpdated) {
      return row;
    }
    const cached = overlays.get(row);
    if (cached?.quote === quote) return cached.row;
    const changePercent = percentFrom(price, row.referenceClose);
    const overlaid: SessionMoverRow = {
      ...row,
      price,
      change: price - row.referenceClose,
      changePercent: changePercent ?? row.changePercent,
      vwapPercent: row.vwap != null ? percentFrom(price, row.vwap) : row.vwapPercent,
      lastUpdated: quote.lastUpdated,
    };
    overlays.set(row, { quote, row: overlaid });
    return overlaid;
  });
}

export type SessionMoverColumnId =
  | "rank"
  | "symbol"
  | "name"
  | "price"
  | "gapPercent"
  | "changePercent"
  | "volume"
  | "relativeVolume"
  | "vwapPercent"
  | "floatShares"
  | "catalyst";

export interface SessionMoverSortPreference {
  columnId: SessionMoverColumnId | null;
  direction: SortDirection;
}

const CATALYST_ORDER = { halt: 3, filing: 2, news: 1 } as const;

/** The strongest catalyst first: a halt, then an 8-K, then news. */
export function leadCatalyst(row: Pick<CloudSessionMoverItem, "catalysts">): CloudSessionMoverItem["catalysts"][number] | null {
  return [...row.catalysts].sort((a, b) => CATALYST_ORDER[b] - CATALYST_ORDER[a])[0] ?? null;
}

function sortValue(columnId: SessionMoverColumnId, row: SessionMoverRow): string | number | null {
  switch (columnId) {
    case "catalyst": {
      const lead = leadCatalyst(row);
      return lead ? CATALYST_ORDER[lead] : null;
    }
    case "rank":
    case "symbol":
    case "name":
    case "price":
    case "gapPercent":
    case "changePercent":
    case "volume":
    case "relativeVolume":
    case "vwapPercent":
    case "floatShares":
      return row[columnId];
  }
}

export function sortSessionRows(rows: SessionMoverRow[], preference: SessionMoverSortPreference): SessionMoverRow[] {
  const columnId = preference.columnId;
  if (!columnId) return rows;
  return [...rows].sort((left, right) => compareSortValues(sortValue(columnId, left), sortValue(columnId, right), preference.direction));
}

/** The session date when it is not today's, e.g. last evening's after-hours list. */
export function earlierSessionLabel(listSession: string | null, session: UsSession): string | null {
  if (!listSession || listSession === session.date) return null;
  const date = new Date(`${listSession}T12:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : null;
}
