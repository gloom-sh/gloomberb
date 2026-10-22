/**
 * `gloomberb fn ALRT`: the Alerts pane's three tabs as reports. Prices lists
 * the price alerts as the pane's table does, Events the event alerts (earnings,
 * CPI and FOMC with their dates, filings, news, market moves), History the
 * alerts delivered to the account over the last 90 days.
 */
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneRow, HeadlessRowsResult } from "../../../types/headless";
import type { PaneLock } from "../../../types/plugin";
import { newYorkToday } from "../earnings/board-model";
import { explainRefusal } from "../shared/cloud-denied";
import { ALERT_TABS, ALERTS_PLUGIN_ID } from "./constants";
import { ruleState } from "./event-rows";
import { eventAlertTarget, type EventAlertRule } from "./events";
import {
  conditionLabel,
  formatAlertDistance,
  formatAlertTargetPrice,
  formatCurrentPrice,
  formatQuoteChecked,
  relativeTime,
} from "./format";
import { alertKindLabel, validateAlertHistory, type AlertHistory, type AlertHistoryItem } from "./history";
import { readScheduledRule, scheduledEventName } from "./scheduled";
import { readAlertStores } from "./storage";
import type { AlertRule } from "./types";

type AlertsTab = "prices" | "events" | "history";

/** Pages of history one report reads; the pane reads more as it is scrolled. */
const HISTORY_PAGES = 5;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const asAlert = (row: HeadlessPaneRow) => row as unknown as AlertRule;
const text = (value: unknown) => (typeof value === "string" && value ? value : "");

/** The text report words each cell as the pane does; CSV and JSON keep the stored numbers and times. */
const PRICE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "status", header: "State", format: (value) => (value === "triggered" ? "Triggered" : "Active") },
  { key: "symbol", header: "Symbol", format: (value, row) => (row.exchange ? `${text(value)}:${text(row.exchange)}` : text(value)) },
  { key: "lastCheckedPrice", header: "Current", align: "right", textFormat: (_value, row) => formatCurrentPrice(asAlert(row), 14) },
  { key: "targetPrice", header: "Target", align: "right", textFormat: (_value, row) => formatAlertTargetPrice(asAlert(row), 14) },
  { key: "awayPercent", header: "Away", align: "right", textFormat: (_value, row) => formatAlertDistance(asAlert(row)) },
  { key: "condition", header: "Trigger", format: (value) => conditionLabel(value as AlertRule["condition"]) },
  { key: "lastCheckedAt", header: "Quote", textFormat: (_value, row) => formatQuoteChecked(asAlert(row)) },
  { key: "triggeredAt", header: "Alerted", textFormat: (value) => (typeof value === "number" ? relativeTime(value) : "-") },
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

const HISTORY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "deliveredAt", header: "Sent (UTC)", format: (value) => text(value).slice(0, 16).replace("T", " ") },
  { key: "event", header: "Event" },
  { key: "title", header: "Alert" },
  { key: "body", header: "Detail" },
];

/** A price alert as the Prices table lists it: the stored fields, without the quote's provider id, and the distance to target. */
function priceRow(alert: AlertRule): HeadlessPaneRow {
  const { lastQuoteProviderId: _provider, ...stored } = alert;
  const price = alert.lastCheckError ? null : alert.lastCheckedPrice;
  const away = price == null || !Number.isFinite(price) || price === 0 ? null : ((alert.targetPrice - price) / price) * 100;
  return { ...stored, awayPercent: away != null && Number.isFinite(away) ? away : null };
}

/** Active alerts first, then the ones that went off, latest first, as the pane orders them. */
function pricesResult(alerts: readonly AlertRule[], error: string | null, events: number): HeadlessRowsResult {
  const active = alerts.filter((alert) => alert.status === "active");
  const triggered = alerts.filter((alert) => alert.status === "triggered").sort((a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0));
  return {
    columns: PRICE_COLUMNS,
    rows: [...active, ...triggered].map(priceRow),
    empty: "No price alerts. Add one with gloomberb alerts add AAPL above 250.",
    ...(error ? { errors: [error], complete: false } : {}),
    ...(events > 0 ? { notes: [`${plural(events, "event alert")} not listed here: gloomberb fn ALRT --tab events`] } : {}),
  };
}

/** An event alert as the Events table lists it: a scheduled one with its event date and lead time apart. */
function eventRow(rule: EventAlertRule, today: string): HeadlessPaneRow {
  const scheduled = readScheduledRule(rule);
  return {
    id: rule.id,
    kind: rule.kind,
    event: alertKindLabel(rule.kind),
    following: scheduled ? scheduledEventName(scheduled.target) : eventAlertTarget(rule),
    eventDate: scheduled ? rule.eventDate ?? null : null,
    leadDays: scheduled?.leadDays ?? null,
    ...(scheduled?.trigger === "results" ? { when: "results" } : {}),
    state: ruleState(rule, today),
    since: new Date(rule.createdAt).toISOString().slice(0, 10),
  };
}

function eventsResult(rules: readonly EventAlertRule[], error: string | null): HeadlessRowsResult {
  const today = newYorkToday();
  return {
    columns: EVENT_COLUMNS,
    rows: [...rules].sort((a, b) => b.createdAt - a.createdAt).map((rule) => eventRow(rule, today)),
    empty: "No event alerts. Add one with gloomberb alerts add CRWV earnings --days 3 or gloomberb alerts add CPI --days 1.",
    ...(error ? { errors: [error], complete: false } : {}),
  };
}

function historyRow(item: AlertHistoryItem): HeadlessPaneRow {
  return { id: item.id, deliveredAt: item.deliveredAt, kind: item.kind, event: alertKindLabel(item.kind), title: item.title, body: item.body };
}

/** What a signed-out read of History says: the tab is the account's own list of delivered alerts. */
export function alertHistoryLockNote({ verifyEmail }: PaneLock): string {
  const account = verifyEmail
    ? "verify your email (Ctrl+P, Resend Verification Email)"
    : "log in or sign up free from the command bar (Ctrl+P, Log In or Sign Up)";
  return [
    `ALRT History needs a free Gloom sign-in: it lists the alerts Gloom delivered to your account over the last 90 days. ${verifyEmail ? "Until the email is verified" : "Signed out"} it shows none of them.`,
    `To read it, open the app (gloomberb), ${account}; gloomberb fn ALRT --tab history then reads with that session.`,
  ].join("\n");
}

async function historyResult(ctx: HeadlessPaneContext): Promise<HeadlessRowsResult> {
  const items: AlertHistoryItem[] = [];
  let first: AlertHistory | null = null;
  let more = false;
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
    throw await explainRefusal(error, alertHistoryLockNote, { symbol: null, token: "ALRT" });
  }
  const unavailable = first?.status === "unavailable";
  return {
    columns: HISTORY_COLUMNS,
    rows: items.map(historyRow),
    empty: "No alerts delivered in the last 90 days.",
    freshness: { source: "Gloom Cloud", status: "not-a-feed", basis: "delivered alerts", ...(first ? { asOf: first.asOf } : {}) },
    ...(unavailable ? { errors: [first?.warning ?? "Alert history is unavailable."], complete: false } : {}),
    ...(more ? { notes: [`Showing the latest ${items.length} delivered alerts; the pane loads older ones as you scroll.`] } : {}),
    metadata: { deviceEnabled: first?.deviceEnabled ?? null },
  };
}

export const alertsHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  description: "Your alerts: price alerts with current price and distance to target, event alerts (earnings, CPI and FOMC dates, filings, news, market moves) or the alerts delivered to your account.",
  freshness: { source: "Your alerts", status: "not-a-feed", basis: "your alert rules" },
  argument: { kind: "none" },
  options: [{
    key: "tab",
    description: "Alerts tab: prices, events or history (delivered alerts, signed in).",
    type: "enum",
    values: ALERT_TABS.map(({ value }) => ({ value })),
    defaultValue: "prices",
    example: "--tab events",
    pluginState: { pluginId: ALERTS_PLUGIN_ID, key: "tab" },
  }],
  discovery: {
    screenshotReadiness: "live-dom",
    dataRequirements: ["Your saved alerts; the History tab needs a Gloom sign-in"],
    limitations: ["Current price and quote time are what the app saved at its last check, blank until it has checked the alert."],
  },
  describe: (args) => `Alerts | ${String(args.options.tab ?? "prices")}`,
  async load(args, ctx) {
    const tab = (args.options.tab ?? "prices") as AlertsTab;
    if (tab === "history") return historyResult(ctx);
    const { alerts, alertsError, events } = readAlertStores(ctx.config);
    return tab === "events" ? eventsResult(events.rules, events.error) : pricesResult(alerts, alertsError, events.rules.length);
  },
};
