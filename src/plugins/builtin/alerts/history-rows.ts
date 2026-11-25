import type { FiredAlert } from "./fired-log";
import type { AlertHistoryItem } from "./history";

/** Where a line of History comes from: this app's log, Gloom Cloud's deliveries, or both for the one alert. */
export type AlertHistoryVia = "app" | "cloud" | "both";

export const ALERT_HISTORY_VIA: Record<AlertHistoryVia, string> = {
  app: "This app",
  cloud: "Gloom Cloud",
  both: "This app and Gloom Cloud",
};

/** One alert that went off, as History lists it. */
export interface AlertHistoryRow {
  id: string;
  /** When it went off: the app's own time when it fired it, otherwise Gloom Cloud's delivery. */
  time: string;
  via: AlertHistoryVia;
  kind: string;
  /** The rule as the app read it, or the notification's title. */
  alert: string;
  value: number | null;
  unit: string | null;
  quoteAt: string | null;
  source: string | null;
  /** What the notification said beside the figure. */
  detail: string;
  fired?: FiredAlert;
  delivered?: AlertHistoryItem;
}

/**
 * How far apart the app and Gloom Cloud send the same alert: a price alert is
 * checked minutes apart by each; an earnings alert goes off once on its day.
 */
const PRICE_MATCH_MS = 60 * 60_000;
const EVENT_MATCH_MS = 24 * 3_600_000;

const upper = (value: unknown) => (typeof value === "string" && value ? value.toUpperCase() : null);

/** The valuation and technical rules, each checked on a reading of its listing. */
const METRIC_KINDS = ["pe", "ps", "rsi", "ma_cross", "close_ma", "rs_ratio", "rrg"];

/**
 * The kinds this app fires only on a figure it has just read, so their log
 * entry always states one: the price or the move of the quote that set it
 * off, a valuation or technical reading, an implied volatility level.
 */
const FIGURE_KINDS = new Set(["price", "move", "iv_level", ...METRIC_KINDS]);

/**
 * Whether a line owes History the figure that set it off: an alert this app
 * fired on one. With no figure its Value is a gap, never a blank that fits.
 *
 * Nothing else owes one. A rule change and a dated event have no figure; a
 * live scan logs its first condition's reading, which a match can come
 * without; and a delivery carries a figure only from a server that sends one,
 * which the line cannot tell from one that lost it.
 */
export function owesAlertFigure(row: Pick<AlertHistoryRow, "fired">): boolean {
  return !!row.fired && !row.fired.action && FIGURE_KINDS.has(row.fired.kind);
}

/**
 * Whether a Cloud delivery is the same alert the app fired: the same price
 * alert (Gloom Cloud names its id), or the same kind of alert on the same
 * symbol, within the time the two take to send it.
 */
function sameAlert(entry: FiredAlert, item: AlertHistoryItem): boolean {
  // A rule created, re-armed or deleted here is no delivery.
  if (entry.action || item.kind !== entry.kind) return false;
  const apart = Math.abs(Date.parse(item.deliveredAt) - Date.parse(entry.firedAt));
  if (!Number.isFinite(apart)) return false;
  if (entry.kind === "price" || METRIC_KINDS.includes(entry.kind)) return item.data?.alertId === entry.ruleId && apart <= PRICE_MATCH_MS;
  const symbol = upper(item.data?.symbol);
  return !!symbol && symbol === upper(entry.symbol) && apart <= EVENT_MATCH_MS;
}

function firedRow(entry: FiredAlert, delivered: AlertHistoryItem | undefined): AlertHistoryRow {
  return {
    id: `app:${entry.id}`, time: entry.firedAt, via: delivered ? "both" : "app", kind: entry.kind, alert: entry.rule,
    value: entry.value, unit: entry.unit ?? null, quoteAt: entry.quoteAt, source: entry.source,
    detail: entry.detail ?? delivered?.body ?? "", fired: entry, ...delivered ? { delivered } : {},
  };
}

function deliveredRow(item: AlertHistoryItem): AlertHistoryRow {
  return {
    id: `cloud:${item.id}`, time: item.deliveredAt, via: "cloud", kind: item.kind, alert: item.title,
    value: typeof item.data?.value === "number" ? item.data.value : null,
    unit: typeof item.data?.unit === "string" ? item.data.unit : null,
    quoteAt: typeof item.data?.quoteAt === "string" ? item.data.quoteAt : null,
    source: item.data?.dailyClose ? "daily close" : null, detail: item.body, delivered: item,
  };
}

/**
 * The alerts this app fired and the ones Gloom Cloud delivered, newest first,
 * one line per alert: a delivery of an alert the app fired too is that line,
 * with the app's figure and quote and `both` as where it came from.
 */
export function mergeAlertHistory(fired: readonly FiredAlert[], delivered: readonly AlertHistoryItem[]): AlertHistoryRow[] {
  const matched = new Set<AlertHistoryItem>();
  const rows = [...fired]
    .sort((a, b) => Date.parse(b.firedAt) - Date.parse(a.firedAt))
    .map((entry) => {
      // The nearest delivery in time, each matched once.
      const candidates = delivered.filter((item) => !matched.has(item) && sameAlert(entry, item));
      const nearest = candidates.sort((a, b) => Math.abs(Date.parse(a.deliveredAt) - Date.parse(entry.firedAt))
        - Math.abs(Date.parse(b.deliveredAt) - Date.parse(entry.firedAt)))[0];
      if (nearest) matched.add(nearest);
      return firedRow(entry, nearest);
    });
  rows.push(...delivered.filter((item) => !matched.has(item)).map(deliveredRow));
  return rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}
