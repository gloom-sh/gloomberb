import { closeBasis, metricName, metricReadingText } from "./metric-model";
/**
 * `gloom fn ALRT`: the Alerts pane's three tabs as reports. Prices lists
 * the price alerts as the pane's table does, Events the event alerts (earnings,
 * CPI, FOMC and other calendar releases with their dates, filings, news, IV levels, market moves),
 * History the alerts this device's app fired, with the ones Gloom Cloud
 * delivered to the account over the last 90 days when signed in.
 */
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneRow, HeadlessRowsResult } from "../../../types/headless";
import type { PaneLock } from "../../../types/plugin";
import { refusedLock } from "../shared/cloud-denied";
import { ALERT_TABS, ALERTS_PLUGIN_ID } from "./constants";
import { ruleState } from "./event-rows";
import { eventAlertTarget, type EventAlertRule } from "./events";
import {
  alertListing,
  isoUtc,
  conditionLabel,
  formatAlertDistance,
  formatAlertTargetPrice,
  formatCurrentPrice,
  formatQuoteChecked,
  relativeTime,
} from "./format";
import { FIRED_LOG_KEY, firedAlertTime, quoteSourceWords, readFiredAlerts } from "./fired-log";
import { alertKindLabel, validateAlertHistory, type AlertHistory, type AlertHistoryItem } from "./history";
import { ALERT_HISTORY_VIA, mergeAlertHistory, type AlertHistoryRow } from "./history-rows";
import { IV_LEVEL_CHECKS_KEY, ivLevelCheckText, readIvLevelChecks, type IvLevelCheck } from "./iv-level";
import { readScheduledRule, scheduledEventName } from "./scheduled";
import { readAlertStores } from "./storage";
import type { AlertRule } from "./types";

type AlertsTab = "prices" | "events" | "history";

/** Pages of history one report reads; the pane reads more as it is scrolled. */
const HISTORY_PAGES = 5;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const asAlert = (row: HeadlessPaneRow) => row as unknown as AlertRule;
const text = (value: unknown) => (typeof value === "string" && value ? value : "");

const percent = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "");
const instant = (value: unknown) => (typeof value === "number" ? firedAlertTime(value) ?? "" : "");

/**
 * The text report words each cell as the pane does: the quote's age and feed, the distance signed.
 * CSV and JSON keep the stored numbers, with Away in %, and the quote's own time and feed in Quote
 * and Quote source, apart from when the app last checked the alert.
 */
const PRICE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "status", header: "State", format: (value) => (value === "triggered" ? "Triggered" : "Active") },
  { key: "symbol", header: "Symbol", format: (value, row) => (row.exchange ? `${text(value)}:${text(row.exchange)}` : text(value)) },
  { key: "metric", header: "Measure", format: (_value, row) => asAlert(row).metric ? metricName(asAlert(row).metric!) : "Price" },
  { key: "lastCheckedPrice", header: "Current", align: "right", textFormat: (_value, row) => formatCurrentPrice(asAlert(row), 14) },
  { key: "targetPrice", header: "Target", align: "right", textFormat: (_value, row) => formatAlertTargetPrice(asAlert(row), 14) },
  { key: "awayPercent", header: "Away", align: "right", format: percent, textFormat: (_value, row) => formatAlertDistance(asAlert(row)) },
  { key: "condition", header: "Trigger", format: (value, row) => {
    const metric = asAlert(row).metric;
    return metric?.kind === "ma_cross" ? `Cross ${metric.direction}` : metric?.kind === "rrg" ? "Enters" : conditionLabel(value as AlertRule["condition"]);
  } },
  { key: "quoteAt", header: "Quote", textFormat: (_value, row) => formatQuoteChecked(asAlert(row)) },
  { key: "quoteSource", header: "Quote source" },
  { key: "lastCheckedAt", header: "Checked", format: instant },
  { key: "triggeredAt", header: "Alerted", format: instant, textFormat: (value) => (typeof value === "number" ? relativeTime(value) : "-") },
  // After the columns exports have always had: when the rule was made, and the currency of its listing.
  // To the second, as `alerts list` and the pane's detail write it: exports draw a stored millisecond time to the millisecond.
  { key: "created", header: "Created" },
  { key: "listing", header: "Listing" },
  { key: "currency", header: "Currency" },
  // A measure's last reading in words, last so the columns before it keep their places: an RRG quadrant with the strength and momentum that place it.
  { key: "reading", header: "Reading" },
];
/** The terminal table keeps the pane's columns: the Quote cell already says the quote's age and feed. */
const PRICE_TEXT_COLUMNS: HeadlessPaneColumn[] = [
  ...PRICE_COLUMNS.filter((column) => !["quoteSource", "lastCheckedAt", "created", "listing", "currency", "reading"].includes(column.key)),
  // The day it was made, as the Events table lists its rules.
  { key: "createdAt", header: "Since", textFormat: (value) => (typeof value === "number" ? isoUtc(value).slice(0, 10) : "") },
];

const EVENT_COLUMNS: HeadlessPaneColumn[] = [
  { key: "event", header: "Event" },
  { key: "following", header: "Following" },
  { key: "eventDate", header: "Event date", textFormat: (value, row) => text(value) || (row.leadDays == null ? "" : "not known yet") },
  // A results alert waits for the report instead of a lead time.
  { key: "leadDays", header: "Days before", align: "right", textFormat: (value, row) => (row.when === "results" ? "results" : value == null ? "-" : String(value)) },
  { key: "state", header: "State" },
  { key: "since", header: "Since" },
];

const minute = (value: unknown) => text(value).slice(0, 16).replace("T", " ");
const valueText = (value: unknown, row: HeadlessPaneRow) => (typeof value === "number" && Number.isFinite(value)
  ? `${Number(value.toFixed(4))}${row.unit === "%" ? "%" : row.unit ? ` ${text(row.unit)}` : ""}` : "");

/**
 * One line per alert, the app's and Gloom Cloud's together, newest first: when it went off, what
 * sent it, the rule, the figure in its unit, and the quote behind it with its own time and feed.
 */
const HISTORY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "time", header: "Time (UTC)", format: minute },
  { key: "via", header: "Via" },
  { key: "event", header: "Event" },
  { key: "alert", header: "Alert" },
  { key: "value", header: "Value", align: "right", unitKey: "unit", textFormat: valueText },
  { key: "quoteAt", header: "Quote time (UTC)", format: minute },
  { key: "quoteSource", header: "Quote source" },
  { key: "detail", header: "Detail", shrink: true },
];
const HISTORY_TEXT_COLUMNS = HISTORY_COLUMNS.filter((column) => column.key !== "via");

/** A price alert as the Prices table lists it: the stored fields, without the quote's provider id, the distance to target, and its quote's own time and feed. */
function priceRow(alert: AlertRule): HeadlessPaneRow {
  const { lastQuoteProviderId: _provider, ...stored } = alert;
  const price = alert.lastCheckError ? null : alert.lastCheckedPrice;
  const away = price == null || !Number.isFinite(price) || price === 0 || alert.metric?.kind === "rrg" ? null : (((alert.lastCheckedTarget ?? alert.targetPrice) - price) / price) * 100;
  const quoted = !alert.lastCheckError;
  const target = alert.lastCheckedTarget ?? alert.targetPrice;
  return {
    ...stored,
    awayPercent: away != null && Number.isFinite(away) ? Number(away.toFixed(2)) : null,
    quoteAt: quoted ? firedAlertTime(alert.lastQuoteUpdatedAt) : null,
    quoteSource: quoted ? alert.metric && closeBasis(alert.metric) || quoteSourceWords(alert.lastQuoteSource) : null,
    created: isoUtc(alert.createdAt) || null,
    listing: alertListing(alert),
    currency: alert.lastQuoteCurrency ?? null,
    reading: alert.metric && price != null && Number.isFinite(price) && Number.isFinite(target) ? metricReadingText(alert.metric, { value: price, target }) : null,
  };
}

/** Active alerts first, then the ones that went off, latest first, as the pane orders them. */
function pricesResult(alerts: readonly AlertRule[], error: string | null, events: number): HeadlessRowsResult {
  const active = alerts.filter((alert) => alert.status === "active");
  const triggered = alerts.filter((alert) => alert.status === "triggered").sort((a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0));
  return {
    columns: PRICE_COLUMNS,
    textColumns: PRICE_TEXT_COLUMNS,
    rows: [...active, ...triggered].map(priceRow),
    empty: "No level alerts. Add one with gloom alerts add AAPL above 250.",
    ...(error ? { errors: [error], complete: false } : {}),
    ...(events > 0 ? { notes: [`${plural(events, "event alert")} not listed here: gloom fn ALRT --tab events`] } : {}),
  };
}

/** An event alert as the Events table lists it: a scheduled one with its event date and lead time apart. */
function eventRow(rule: EventAlertRule, now: number, checks: Record<string, IvLevelCheck>): HeadlessPaneRow {
  const scheduled = readScheduledRule(rule);
  return {
    id: rule.id,
    kind: rule.kind,
    event: alertKindLabel(rule.kind),
    following: scheduled ? scheduledEventName(scheduled.target) : eventAlertTarget(rule),
    eventDate: scheduled ? rule.eventDate ?? null : null,
    leadDays: scheduled?.leadDays ?? null,
    ...(scheduled?.trigger === "results" ? { when: "results" } : {}),
    state: ruleState(rule, now),
    since: new Date(rule.createdAt).toISOString().slice(0, 10),
    // An IV level's last reading, or why there was none, on its own row.
    ...rule.kind === "iv_level" ? { lastCheck: ivLevelCheckText(rule, checks[rule.id]) } : {},
  };
}

function eventsResult(rules: readonly EventAlertRule[], error: string | null, checks: Record<string, IvLevelCheck>): HeadlessRowsResult {
  const now = Date.now();
  const checked = rules.some((rule) => rule.kind === "iv_level");
  return {
    // A Last check column only when an IV level rule has a reading to show.
    columns: checked ? [...EVENT_COLUMNS.slice(0, -2), { key: "lastCheck", header: "Last check" }, ...EVENT_COLUMNS.slice(-2)] : EVENT_COLUMNS,
    rows: [...rules].sort((a, b) => b.createdAt - a.createdAt).map((rule) => eventRow(rule, now, checks)),
    empty: "No event alerts. Add one with gloom alerts add CRWV earnings --days 3, gloom alerts add CPI --days 1 or gloom alerts add CN PMI.",
    ...(error ? { errors: [error], complete: false } : {}),
  };
}

/** One alert that went off: fired by this app, delivered by Gloom Cloud, or both, on one line. */
function historyRow(row: AlertHistoryRow): HeadlessPaneRow {
  return {
    id: row.fired?.id ?? row.delivered?.id ?? row.id, time: row.time, via: ALERT_HISTORY_VIA[row.via], kind: row.kind,
    event: alertKindLabel(row.kind), alert: row.alert, value: row.value, unit: row.unit, quoteAt: row.quoteAt,
    quoteSource: row.source, detail: row.detail,
  };
}

/** What a signed-out read of History adds: only this device's own alerts are listed. */
export function alertHistoryLockNote({ verifyEmail }: PaneLock): string {
  const account = verifyEmail
    ? "verify your email (Ctrl+P, Resend Verification Email)"
    : "log in or sign up free from the command bar (Ctrl+P, Log In or Sign Up)";
  return [
    `Only the alerts this app fired are listed: the ones Gloom Cloud delivered to your phone or email over the last 90 days need a free Gloom sign-in${verifyEmail ? " with a verified email" : ""}.`,
    `To add them, open the app (gloom), ${account}; gloom fn ALRT --tab history then reads with that session.`,
  ].join("\n");
}

/** The app's own fired alerts, newest first, with Gloom Cloud's deliveries merged in when the session can read them. */
async function historyResult(ctx: HeadlessPaneContext): Promise<HeadlessRowsResult> {
  const fired = readFiredAlerts(ctx.readDeviceState?.(ALERTS_PLUGIN_ID, FIRED_LOG_KEY));
  const items: AlertHistoryItem[] = [];
  let first: AlertHistory | null = null;
  let more = false;
  let refused: string | null = null;
  let failed: string | null = null;
  try {
    for (let offset: number | null = 0, page = 0; offset != null; page += 1) {
      if (page === HISTORY_PAGES) {
        more = true;
        break;
      }
      const history: AlertHistory = validateAlertHistory(await ctx.apiClient.getMobileAlertHistory<unknown>(offset));
      first ??= history;
      if (history.status === "unavailable") break;
      items.push(...history.items);
      offset = history.hasMore ? history.nextOffset : null;
    }
  } catch (error) {
    // Signed out, the app's own log is the history; any other failure is said beside it.
    const lock = refusedLock(error);
    if (lock?.gate === "sign-in") refused = alertHistoryLockNote({ ...lock, symbol: null, token: "ALRT" });
    else failed = error instanceof Error ? error.message : String(error);
  }
  const unavailable = first?.status === "unavailable";
  const rows = mergeAlertHistory(fired, items).map(historyRow);
  const errors = [...unavailable ? [first?.warning ?? "Delivered alerts are unavailable."] : [], ...failed ? [`Delivered alerts: ${failed}`] : []];
  const notes = [
    ...refused ? [refused] : [],
    ...more ? [`Showing the latest ${items.length} delivered alerts; the pane loads older ones as you scroll.`] : [],
  ];
  return {
    columns: HISTORY_COLUMNS,
    textColumns: HISTORY_TEXT_COLUMNS,
    rows,
    empty: refused ? "This app has fired no alerts yet." : "No alerts fired by this app or delivered in the last 90 days.",
    freshness: { source: first ? "This app and Gloom Cloud" : "This app", status: "not-a-feed", basis: "fired and delivered alerts", ...(first ? { asOf: first.asOf } : {}) },
    ...(errors.length ? { errors, complete: false } : {}),
    ...(notes.length ? { notes } : {}),
    metadata: { deviceEnabled: first?.deviceEnabled ?? null },
  };
}

export const alertsHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  description: "Your alerts: price, valuation and daily technical alerts with current price and distance to target, event alerts (earnings, CPI, FOMC and other economic calendar releases, filings, news, IV levels, market moves) or the alerts that went off, from this app and, signed in, Gloom Cloud.",
  freshness: { source: "Your alerts", status: "not-a-feed", basis: "your alert rules" },
  argument: { kind: "none" },
  options: [{
    key: "tab",
    description: "Alerts tab: prices, events or history (alerts that went off; Gloom Cloud's deliveries when signed in).",
    type: "enum",
    values: ALERT_TABS.map(({ value }) => ({ value })),
    defaultValue: "prices",
    example: "--tab events",
    pluginState: { pluginId: ALERTS_PLUGIN_ID, key: "tab" },
  }],
  discovery: {
    screenshotReadiness: "live-dom",
    dataRequirements: ["Your saved alerts and this device's log of fired alerts; History adds Gloom Cloud's deliveries when signed in"],
    limitations: ["Current price and quote time are what the app or `gloom alerts add` saved at the last check; an alert neither has read says not checked yet."],
  },
  describe: (args) => `Alerts | ${String(args.options.tab ?? "prices")}`,
  async load(args, ctx) {
    const tab = (args.options.tab ?? "prices") as AlertsTab;
    if (tab === "history") return historyResult(ctx);
    const { alerts, alertsError, events } = readAlertStores(ctx.config);
    return tab === "events"
      ? eventsResult(events.rules, events.error, readIvLevelChecks(ctx.readDeviceState?.(ALERTS_PLUGIN_ID, IV_LEVEL_CHECKS_KEY)))
      : pricesResult(alerts, alertsError, events.rules.length);
  },
};
