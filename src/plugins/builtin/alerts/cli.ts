import { withConfigData, withMarketData } from "../../../cli/scoped-context";
import { CLI_COMMAND_GROUPS } from "../../../cli/help";
import { dryRunNote } from "../../../cli/helpers";
import { requireArg, takeOption } from "../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, listingReadNotes, requireListingArg, type ListingArg } from "../../../cli/listing-arg";
import { saveConfig } from "../../../data/config/store";
import type { AppConfig } from "../../../types/config";
import type { CliCommandContext, CliCommandDef } from "../../../types/plugin";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import { settleWithin } from "../../../utils/async-deadline";
import { cliStyles } from "../../../utils/cli-output";
import { ambiguousNumberMessage, meantThousandsDot, parsePastedNumber, thousandsDotReadings, type ThousandsDotReadings } from "../../../utils/decimal-comma";
import { newYorkToday } from "../earnings/board-model";
import { createAlert, deserializeAlerts, rearmAlert, serializeAlerts } from "./alert-engine";
import { ALERTS_KEY } from "./constants";
import { EVENT_ALERTS_KEY, MAX_EVENT_ALERTS, eventAlertTarget, readEventAlerts, toggleEventAlert, type EventAlertRule } from "./events";
import { alertKindLabel } from "./history";
import { MAX_LEAD_DAYS, type MacroAlertEvent } from "./research-rules";
import {
  MACRO_EVENT_CLI_NAMES,
  createScheduledAlert,
  eventDateUnavailableMessage,
  leadStartDate,
  lookupScheduledDates,
  noUpcomingEventMessage,
  parseLeadDays,
  parseMacroEventName,
  readScheduledRule,
  rearmScheduledAlert,
  scheduledAlertStatus,
  scheduledEventName,
  scheduledPhase,
  scheduledTargetKey,
  type ScheduledDateLookup,
  type ScheduledEventSources,
  type ScheduledEventTarget,
} from "./scheduled";
import { scheduledEventSources } from "./scheduled-sources";
import type { AlertCondition, AlertRule } from "./types";

const ALERTS_PLUGIN_ID = "alerts";

const ADD_USAGE = "Usage: gloomberb alerts add <symbol> <above|below|crosses> <price>, alerts add <symbol> earnings [--days <n>], or alerts add <CPI|FOMC> [--days <n>]";
const DAYS_RULE = `--days takes a whole number of days from 1 to ${MAX_LEAD_DAYS}; without it the alert goes off 1 day before.`;

/** What `alerts add` was asked for, before any listing or date is looked up. */
export type AlertAddRequest =
  | {
    kind: "price"; symbol: string; condition: AlertCondition; price: number;
    /** A price typed as 81.000, which the last price may show was 81000 with a dot between thousands. */
    thousandsDot?: ThousandsDotReadings & { text: string };
  }
  | { kind: "earnings"; symbol: string; leadDays: number }
  | { kind: "macro"; event: MacroAlertEvent; leadDays: number };

const CONDITIONS: readonly AlertCondition[] = ["above", "below", "crosses"];

/** The first word of a price typed with a space between thousands and no quotes (`81 000`): one to three digits. */
const LEADING_GROUP = /^[+-]?\d{1,3}$/;

/**
 * Reads `alerts add` arguments: `<symbol> above 250`, `<symbol> earnings`, or
 * `CPI` / `FOMC`, with `--days` (already taken out of `args`, `null` when the
 * flag came without a value) for the event forms only, and `--exchange`, which
 * a command to type again keeps. Throws a message that names what the command
 * takes.
 */
export function parseAlertAddArgs(args: readonly string[], days: string | null | undefined, exchange?: string | null): AlertAddRequest {
  const [first, second, third, ...rest] = args;
  if (!first) throw new Error(ADD_USAGE);
  const leadDays = () => {
    const parsed = days === null ? null : parseLeadDays(days);
    if (parsed == null) throw new Error(DAYS_RULE);
    return parsed;
  };
  if (second === undefined) {
    const event = parseMacroEventName(first);
    if (event) return { kind: "macro", event, leadDays: leadDays() };
    if (first.toLowerCase() === "earnings") {
      throw new Error("Name the company: gloomberb alerts add <symbol> earnings, such as alerts add CRWV earnings --days 3.");
    }
    throw new Error(
      `Unknown event "${first}". Event alerts take ${MACRO_EVENT_CLI_NAMES} (alerts add CPI --days 1) or a symbol with earnings (alerts add CRWV earnings --days 3); price alerts take a condition and a price (alerts add AAPL above 250).`,
    );
  }
  if (second.toLowerCase() === "earnings") {
    if (third !== undefined) throw new Error(`Earnings alerts take a symbol and --days, not "${third}". ${ADD_USAGE}`);
    return { kind: "earnings", symbol: first, leadDays: leadDays() };
  }
  const condition = second.toLowerCase() as AlertCondition;
  if (!CONDITIONS.includes(condition)) {
    throw new Error(`Unknown alert "${second}". Use above, below or crosses with a price, or earnings with --days.`);
  }
  if (days !== undefined) throw new Error("--days is for earnings and CPI or FOMC alerts, not price alerts.");
  if (third === undefined) throw new Error(ADD_USAGE);
  const retype = (price: number) => retypeCommand(first, condition, price, exchange);
  // `81 000` without quotes arrives as 81 and a stray 000; neither reading is taken for granted.
  const spaced = rest.length > 0 && LEADING_GROUP.test(third) ? parsePastedNumber([third, ...rest].join(" ")) : null;
  if (spaced?.kind === "number") {
    const typed = Number(third);
    throw new Error(`${[third, ...rest].join(" ")} could be ${spaced.value} (thousands) or ${typed} and a stray ${rest.join(" ")}; type ${retype(spaced.value)} or ${retype(typed)}`);
  }
  // A price pasted from a sheet (1.350,5, 1,350.5, 1 350,5) reads as it is written; `1,350` could be either, so it asks.
  const pasted = parsePastedNumber(third);
  if (pasted.kind === "ambiguous") throw new Error(ambiguousNumberMessage(third, pasted));
  if (pasted.kind === "invalid") throw new Error("Alert price must be a finite number.");
  if (rest.length > 0) throw new Error(`A price alert takes one price, not "${rest.join(" ")}" after ${third}; type ${retype(pasted.value)}`);
  const thousandsDot = thousandsDotReadings(third);
  return { kind: "price", symbol: first, condition, price: pasted.value, ...(thousandsDot ? { thousandsDot: { ...thousandsDot, text: third.trim() } } : {}) };
}

/** `alerts add` as typed, with another price: what an error tells someone to type. */
function retypeCommand(symbol: string, condition: AlertCondition, price: number, exchange: string | null | undefined): string {
  return `gloomberb alerts add ${symbol} ${condition} ${price}${exchange ? ` --exchange ${exchange}` : ""}`;
}

const LAST_PRICE_TIMEOUT_MS = 10_000;

/**
 * The listing's last price, as the alert will check it, for telling 81.000
 * typed for 81000 from 81; null when there is none, and the price is then
 * read as written.
 */
async function lastPrice(listing: ListingArg, ctx: Pick<CliCommandContext, "initMarketData">): Promise<number | null> {
  const quote = await settleWithin(
    withMarketData(ctx, (market) => market.dataProvider.getQuote(listing.key.toUpperCase(), listing.exchange)),
    LAST_PRICE_TIMEOUT_MS,
  );
  const price = quote ? getActiveQuoteDisplay(quote)?.price ?? quote.price : null;
  return price != null && Number.isFinite(price) && price !== 0 ? price : null;
}

/**
 * Asks which price `81.000` meant when the last price shows it was a dot
 * between thousands: both readings, and the command to type for each.
 */
export function thousandsDotMessage(
  request: Extract<AlertAddRequest, { kind: "price" }>,
  listing: string,
  last: number | null,
  exchange?: string | null,
): string | null {
  const dot = request.thousandsDot;
  if (!dot || !meantThousandsDot(dot, last)) return null;
  const retype = (price: number) => retypeCommand(request.symbol, request.condition, price, exchange);
  return `${dot.text} could be ${dot.thousands} (thousands) or ${dot.decimal} (decimal point), and ${listing.toUpperCase()} last traded at ${Number(last!.toFixed(2))}; type ${retype(dot.thousands)} or ${retype(dot.decimal)}`;
}

/** One row of `alerts list`: a price alert as stored, or an event alert with its next date. */
type AlertListRow = Record<string, unknown> & {
  id: string;
  kind: string;
  status: string;
};

function priceRow(alert: AlertRule): AlertListRow {
  return { ...alert, kind: "price", target: alert.exchange ? `${alert.symbol}:${alert.exchange}` : alert.symbol };
}

function eventRow(rule: EventAlertRule, today: string, eventDate: string | null | undefined): AlertListRow {
  const scheduled = readScheduledRule(rule);
  if (!scheduled) {
    return { id: rule.id, kind: rule.kind, target: eventAlertTarget(rule), status: rule.status, createdAt: rule.createdAt };
  }
  const date = eventDate ?? null;
  return {
    id: rule.id,
    kind: rule.kind,
    target: scheduled.target.kind === "earnings" ? scheduled.target.symbol : scheduled.target.event.toUpperCase(),
    leadDays: scheduled.leadDays,
    eventDate: date,
    status: scheduledAlertStatus({ ...rule, eventDate: date ?? undefined }, scheduled.leadDays, today),
    createdAt: rule.createdAt,
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function textRow(row: AlertListRow): Record<string, unknown> {
  const price = row.kind === "price";
  return {
    id: row.id,
    kind: price ? "Price" : alertKindLabel(row.kind),
    target: row.target,
    trigger: price
      ? `${row.condition} ${row.targetPrice}`
      : typeof row.leadDays === "number" ? `${plural(row.leadDays, "day")} before` : "",
    eventDate: typeof row.leadDays === "number" ? row.eventDate ?? "not known" : "",
    status: row.status,
    lastCheckedPrice: row.lastCheckedPrice,
    triggeredAt: row.triggeredAt,
  };
}

/** The next event date of each scheduled rule: the saved one while it is still ahead, otherwise looked up. */
async function listEventDates(
  rules: readonly EventAlertRule[],
  today: string,
  lookup: (targets: ScheduledEventTarget[]) => Promise<Map<string, ScheduledDateLookup>>,
): Promise<{ dates: Map<string, string | null>; warnings: string[] }> {
  const dates = new Map<string, string | null>();
  const stale: Array<{ rule: EventAlertRule; target: ScheduledEventTarget }> = [];
  for (const rule of rules) {
    const scheduled = readScheduledRule(rule);
    if (!scheduled) continue;
    if (rule.eventDate && rule.eventDate >= today) dates.set(rule.id, rule.eventDate);
    else stale.push({ rule, target: scheduled.target });
  }
  if (stale.length === 0) return { dates, warnings: [] };
  const lookups = await lookup(stale.map((entry) => entry.target));
  const warnings = new Set<string>();
  for (const { rule, target } of stale) {
    const lookup = lookups.get(scheduledTargetKey(target));
    if (lookup && "date" in lookup) dates.set(rule.id, lookup.date);
    else if (lookup) warnings.add(`Next ${scheduledEventName(target)} date unavailable: ${lookup.error}`);
  }
  return { dates, warnings: [...warnings] };
}

/** Looks up the next date for a new event alert, or fails saying why there is none. */
async function requireEventDate(
  target: ScheduledEventTarget,
  sources: ScheduledEventSources,
  today: string,
  fail: (message: string) => never,
): Promise<string> {
  const lookup = (await lookupScheduledDates([target], sources, today)).get(scheduledTargetKey(target));
  if (!lookup || "error" in lookup) fail(eventDateUnavailableMessage(target, lookup?.error ?? "no answer"));
  if (!lookup.date) fail(noUpcomingEventMessage(target));
  return lookup.date;
}

function readAlertStores(config: AppConfig) {
  const pluginState = config.pluginConfig[ALERTS_PLUGIN_ID] ?? {};
  const rawPrice = pluginState[ALERTS_KEY];
  const rawEvents = pluginState[EVENT_ALERTS_KEY];
  return {
    pluginState,
    alerts: deserializeAlerts(typeof rawPrice === "string" ? rawPrice : "[]"),
    events: readEventAlerts(typeof rawEvents === "string" ? rawEvents : "[]"),
  };
}

export const alertsCliCommand: CliCommandDef = {
  name: "alerts",
  aliases: ["alert"],
  description: "List, add, and remove price alerts and alerts before earnings, CPI and FOMC",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    usage: [
      "alerts list",
      "alerts add <symbol> <above|below|crosses> <price>",
      "alerts add <symbol> earnings [--days <n>]",
      "alerts add <CPI|FOMC> [--days <n>]",
      "alerts delete <id>",
      "alerts rearm <id>",
    ],
    options: [
      EXCHANGE_OPTION,
      { flags: "--days <n>", description: `Days before the event the alert goes off, 1 to ${MAX_LEAD_DAYS} (default 1); earnings, CPI and FOMC alerts` },
    ],
    examples: [
      "alerts",
      "alerts add AAPL above 250",
      "alerts add SAN:EPA below 70",
      "alerts add CRWV earnings --days 3",
      "alerts add CPI --days 1",
    ],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const daysFlag = rawArgs.some((arg) => arg === "--days" || arg.startsWith("--days="));
    const daysValue = takeOption(args, "--days");
    const days = daysFlag && daysValue === undefined ? null : daysValue;
    const exchangeOption = takeOption(args, "--exchange");
    const action = args[0] ?? "list";
    const today = newYorkToday();

    const parseAdd = (): AlertAddRequest => {
      try {
        return parseAlertAddArgs(args.slice(1), days, exchangeOption);
      } catch (error) {
        return ctx.fail(error instanceof Error ? error.message : String(error));
      }
    };
    const request = action === "add" ? parseAdd() : null;
    const priceListing = request?.kind === "price" ? await requireListingArg(request.symbol, exchangeOption, ctx) : null;
    if (request?.kind === "price" && request.thousandsDot && priceListing) {
      const question = thousandsDotMessage(request, priceListing.key, await lastPrice(priceListing, ctx), exchangeOption);
      if (question) ctx.fail(question);
    }
    // What a typed listing was read as (7203:TSE as 7203:JPX), said beside what was added.
    let read = priceListing ? listingReadNotes(priceListing) : [];
    let newEventRule: EventAlertRule | null = null;
    if (request && request.kind !== "price") {
      const target: ScheduledEventTarget = request.kind === "macro"
        ? { kind: "macro", event: request.event }
        : await requireListingArg(request.symbol, exchangeOption, ctx)
          .then((listing) => {
            read = listingReadNotes(listing);
            return { kind: "earnings" as const, symbol: listing.symbol, exchange: listing.exchange };
          });
      // A listing the rule cannot follow fails before any request.
      try {
        createScheduledAlert(target, request.leadDays, null);
      } catch (error) {
        ctx.fail(error instanceof Error ? error.message : String(error));
      }
      const eventDate = target.kind === "earnings"
        ? await withMarketData(ctx, (market) => requireEventDate(target, scheduledEventSources(market.dataProvider), today, (message) => ctx.fail(message)))
        : await requireEventDate(target, scheduledEventSources(null), today, (message) => ctx.fail(message));
      newEventRule = createScheduledAlert(target, request.leadDays, eventDate);
    }

    if (action === "list") {
      const { alerts, events } = await withConfigData(ctx, (config) => readAlertStores(config.config));
      // Earnings dates come through market data; CPI and FOMC dates do not need it.
      const lookup = (targets: ScheduledEventTarget[]) => targets.some((target) => target.kind === "earnings")
        ? withMarketData(ctx, (market) => lookupScheduledDates(targets, scheduledEventSources(market.dataProvider), today))
        : lookupScheduledDates(targets, scheduledEventSources(null), today);
      const { dates, warnings } = await listEventDates(events.rules, today, lookup);
      const rows = [
        ...alerts.map(priceRow),
        ...events.rules.map((rule) => eventRow(rule, today, dates.has(rule.id) ? dates.get(rule.id) : rule.eventDate)),
      ];
      const allWarnings = [...(events.error ? [events.error] : []), ...warnings];
      ctx.printResult({ data: rows, ...(allWarnings.length ? { warnings: allWarnings } : {}) }, {
        rows: (data) => data.map(textRow),
        textColumns: [
          { key: "id", header: "ID", shrink: false },
          { key: "kind", header: "Kind" },
          { key: "target", header: "Target" },
          { key: "trigger", header: "Trigger" },
          { key: "eventDate", header: "Event Date" },
          { key: "status", header: "Status" },
          { key: "lastCheckedPrice", header: "Last Price", align: "right", optional: true },
          { key: "triggeredAt", header: "Triggered", optional: true },
        ],
        empty: "No alerts. Add one with gloomberb alerts add AAPL above 250, alerts add CRWV earnings --days 3, or alerts add CPI --days 1.",
      });
      return;
    }

    await withConfigData(ctx, async (config) => {
      const { pluginState, alerts, events } = readAlertStores(config.config);
      const save = async (next: { alerts?: AlertRule[]; events?: EventAlertRule[] }) => {
        const nextConfig = {
          ...config.config,
          pluginConfig: {
            ...config.config.pluginConfig,
            [ALERTS_PLUGIN_ID]: {
              ...pluginState,
              ...(next.alerts ? { [ALERTS_KEY]: serializeAlerts(next.alerts) } : {}),
              ...(next.events ? { [EVENT_ALERTS_KEY]: JSON.stringify(next.events) } : {}),
            },
          },
        };
        if (!ctx.cliOptions.dryRun) await saveConfig(nextConfig);
      };
      // Saved event alerts that do not read are never written over.
      const requireEvents = () => {
        if (events.error) ctx.fail(events.error);
        return events.rules;
      };

      if (request?.kind === "price") {
        const { condition, price } = request;
        const symbol = requireArg(priceListing?.key, ADD_USAGE, ctx);
        const alert = createAlert(symbol, condition, price, priceListing?.exchange);
        await save({ alerts: [...alerts, alert] });
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert }, ...(read.length > 0 ? { warnings: read } : {}) }, {
          // No full stop after the price, which would read as part of it (below 81.).
          text: (data) => `Added alert ${data.alert.id}: ${symbol} ${condition} ${price}${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      if (newEventRule) {
        const rule = newEventRule;
        const rules = requireEvents();
        const scheduled = readScheduledRule(rule)!;
        const name = scheduledEventName(scheduled.target);
        const existing = rules.find((entry) => entry.kind === rule.kind && entry.value.toLowerCase() === rule.value.toLowerCase());
        if (existing) ctx.fail(`An alert ${plural(scheduled.leadDays, "day")} before ${name} already exists (ID ${existing.id}).`);
        if (rules.length >= MAX_EVENT_ALERTS) ctx.fail(`Keep at most ${MAX_EVENT_ALERTS} event alerts. Delete one with gloomberb alerts delete <id>.`);
        await save({ events: [...rules, rule] });
        const eventDate = rule.eventDate!;
        const due = scheduledPhase(eventDate, scheduled.leadDays, undefined, today) === "due";
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert: rule }, ...(read.length > 0 ? { warnings: read } : {}) }, {
          text: (data) => `Added alert ${data.alert.id}: ${name} on ${eventDate}, ${plural(scheduled.leadDays, "day")} before (${due
            ? "already reached, so the app alerts at its next check"
            : `the app alerts on ${leadStartDate(eventDate, scheduled.leadDays)}`}).${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      if (action === "delete" || action === "rm") {
        const id = requireArg(args[1], "Usage: gloomberb alerts delete <id>", ctx);
        const isPrice = alerts.some((alert) => alert.id === id);
        const isEvent = !isPrice && events.rules.some((rule) => rule.id === id);
        if (isPrice) await save({ alerts: alerts.filter((alert) => alert.id !== id) });
        if (isEvent) await save({ events: requireEvents().filter((rule) => rule.id !== id) });
        const changed = isPrice || isEvent;
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun && changed, dryRun: ctx.cliOptions.dryRun, id } }, {
          text: (data) => changed
            ? `Deleted alert ${id}.${dryRunNote(data.dryRun)}`
            : cliStyles.muted(`No alert with ID ${id}.`),
        });
        return;
      }
      if (action === "rearm") {
        const id = requireArg(args[1], "Usage: gloomberb alerts rearm <id>", ctx);
        const isPrice = alerts.some((alert) => alert.id === id);
        const rule = isPrice ? null : events.rules.find((entry) => entry.id === id) ?? null;
        if (isPrice) await save({ alerts: alerts.map((alert) => alert.id === id ? rearmAlert(alert) : alert) });
        if (rule) {
          // A scheduled alert alerts again for its coming event; any other event alert resumes.
          const next = readScheduledRule(rule) ? rearmScheduledAlert(rule) : rule.status === "paused" ? toggleEventAlert(rule) : rule;
          await save({ events: requireEvents().map((entry) => entry.id === id ? next : entry) });
        }
        const found = isPrice || !!rule;
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun && found, dryRun: ctx.cliOptions.dryRun, id } }, {
          text: (data) => found
            ? `Re-armed alert ${id}.${dryRunNote(data.dryRun)}`
            : cliStyles.muted(`No alert with ID ${id}.`),
        });
        return;
      }
      ctx.fail("Usage: gloomberb alerts list|add|delete|rearm");
    });
  },
};
