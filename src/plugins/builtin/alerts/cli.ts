import { isDailyMetric, metricDescription, metricName } from "./metric-model";
import { logFailure } from "../../../utils/log-failure";
import { parseMetricAlert, type MetricAlertInput } from "./metric-command";
import { firstDailyCheck, metricAvailabilityError, metricReadings } from "./metric-data";
import { ALERT_ADD_FORMS, ALERT_KINDS_TEXT, parseRuleAddArgs, RULE_US_DATA, ruleDelivery, type RuleAddRequest } from "./cli-forms";
import { alertChangeEntry, appendAlertLog, type AlertLogAction } from "./fired-log";
import { alertLogRule } from "./alert-log";
import { alertListing, alertReadingAt, alertReadingText, isoUtc, listingWithCurrency, NOT_CHECKED_YET } from "./format";
import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import { quoteAlertFields } from "./quotes";
import { createEventAlert } from "./events";
import { isResearchAlertKind, readResearchRule } from "./research-rules";
import { withConfigData, withMarketData } from "../../../cli/scoped-context";
import { CLI_COMMAND_GROUPS } from "../../../cli/help";
import { dryRunNote } from "../../../cli/helpers";
import { requireArg, takeOption } from "../../../cli/commands/command-utils";
import { requireQuotedListing } from "../../../cli/quote-answer";
import { coinListingNotes, EXCHANGE_OPTION, listingReadNotes, requireListingArg, usListingsOnlyMessage } from "../../../cli/listing-arg";
import { saveConfig } from "../../../data/config/store";
import { resumeStateKey } from "../../registry/plugin-state";
import type { CliCommandDef } from "../../../types/plugin";
import type { Quote } from "../../../types/financials";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import { cliStyles } from "../../../utils/cli-output";
import { canonicalExchange, isUsListingExchange } from "../../../utils/exchanges";
import { meantThousandsDot, parsePastedNumber, thousandsDotReadings, type ThousandsDotReadings } from "../../../utils/decimal-comma";
import { newYorkToday } from "../earnings/board-model";
import { fetchEconCalendarFrom } from "../econ/calendar-source";
import { COUNTRY_FILTER_HINT, dateKey, loadCalendar, parseCountryFilter, type CountryFilter } from "../econ/calendar-model";
import { isAllDayEvent, type EconEvent } from "../econ/types";
import {
  calendarEventLabel,
  calendarNameWords,
  expectsFigures,
  macroEventNamed,
  matchCalendarEvent,
  releaseInstant,
  releaseRenameNote,
  releaseRowOn,
  type CalendarEventChoice,
  type ReleaseRename,
} from "./calendar-events";
import { createAlert, rearmAlert, sameLevelRule } from "./alert-engine";
import { ALERTS_PLUGIN_ID } from "./constants";
import { MAX_EVENT_ALERTS, eventAlertTarget, toggleEventAlert, writeEventAlertStores, type EventAlertRule } from "./events";
import { alertKindLabel, fetchAlertHistory, ruleStateText, type AlertRuleState } from "./history";
import { apiClient } from "../../../api-client";
import { IV_LEVEL_CHECKS_KEY, ivLevelCheckText, readIvLevelChecks, rearmIvLevelAlert, type IvLevelCheck } from "./iv-level";
import { parseAlertPrice, readAlertPrice } from "./price";
import { farTargetMessage } from "./quotes";
import { MACRO_EVENT_NAMES, createResearchAlert, formatPremium, ivLevelUnitError, parseAmount, parseIvLevel } from "./research-builder";
import { IV_LEVEL_RANGES, MAX_LEAD_DAYS, type IvLevelMetric, type MacroAlertEvent } from "./research-rules";
import {
  createScheduledAlert,
  eventDateUnavailableMessage,
  followsRelease,
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
  scheduledToday,
  scheduledTriggerText,
  type ScheduledDateLookup,
  type ScheduledEventSources,
  type ScheduledEventTarget,
} from "./scheduled";
import { scheduledEventSources } from "./scheduled-sources";
import { readAlertStores, writeLevelAlertStores } from "./storage";
import type { AlertCondition, AlertRule } from "./types";

/**
 * What delivers a price alert, as docs/usage.md states it: the app checks it on
 * every tick while it runs. Signed in with Cloud sync on, Gloom Cloud also
 * pushes the trigger to a registered phone, and emails it once no app has
 * synced the account for a while, so a rule the app has synced reaches you
 * with the app closed. Signed out, only the running app does.
 */
const PRICE_DELIVERY = "the app alerts while it is running; sign in with Cloud sync for email or phone alerts when it is closed";

const ADD_USAGE = `Usage: gloom alerts add <symbol> <above|below|crosses> <price>, or another kind. ${ALERT_KINDS_TEXT}`;
const DAYS_RULE = `--days takes a whole number of days from 1 to ${MAX_LEAD_DAYS}; without it the alert goes off 1 day before.`;
/** How a release in the economic calendar is named, CPI and FOMC among them. */
const CALENDAR_EXAMPLES = `alerts add "NBS Manufacturing PMI" --country CN, alerts add CN PMI, alerts add CPI --days 1`;
const COUNTRY_RULE = "--country is for an alert on a calendar event, such as alerts add PMI --country CN.";

/** What `alerts add` was asked for, before any listing or date is looked up. */
export type AlertAddRequest =
  | ({ kind: "metric" } & MetricAlertInput)
  | {
    kind: "price"; symbol: string; condition: AlertCondition; price: number;
    /** A price typed as 81.000, which the last price may show was 81000 with a dot between thousands. */
    thousandsDot?: ThousandsDotReadings & { text: string };
  }
  /** `results`: once the report's actual EPS is out, rather than `leadDays` before the date. */
  | { kind: "earnings"; symbol: string; leadDays: number; results?: true }
  | { kind: "macro"; event: MacroAlertEvent; leadDays: number }
  /** A release in the economic calendar by name, matched against the calendar once it is read; `country` narrows it. */
  | { kind: "release"; query: string; country: CountryFilter | null; leadDays: number }
  /** Gloom Cloud's research rules, as Add Event Alert makes them; a news or flow rule without a symbol follows every name (news) or your lists (flow). */
  | { kind: "news"; symbol: string | null; keyword: string }
  | { kind: "flow"; symbol: string | null; premium: number; side: "any" | "calls" | "puts"; print: "any" | "sweep" | "block" }
  /** The symbol's 30-day ATM IV (`atm`, in %) or 25-delta risk reversal (`rr`, in vol points) above or below a level, checked by the running app. */
  | { kind: "iv_level"; symbol: string; metric: IvLevelMetric; direction: "above" | "below"; level: number }
  /** One OCC contract's IV rising by `points`. */
  | { kind: "iv_spike"; contract: string; points: number }
  /** The rest of what Add Event Alert offers: 52-week range, unusual volume, filings, insiders, short interest and more. */
  | RuleAddRequest;

/** The `alerts add` forms Gloom Cloud's research rules take: they follow US listings. */
type ResearchAddRequest = Extract<AlertAddRequest, { kind: "news" | "flow" | "iv_level" | "iv_spike" }>;

const CONDITIONS: readonly AlertCondition[] = ["above", "below", "crosses"];

/** The first word of a price typed with a space between thousands and no quotes (`81 000`): one to three digits. */
const LEADING_GROUP = /^[+-]?\d{1,3}$/;

/** `--country` as typed: a country code or the calendar's regions (`CN`, `uk`, `EU`); null when not given. Throws when it names none. */
function readCountryOption(country: string | null | undefined): CountryFilter | null {
  if (country === undefined) return null;
  if (country === null) throw new Error(`--country takes a two-letter country code, such as --country CN. ${COUNTRY_FILTER_HINT}`);
  const parsed = parseCountryFilter(country);
  if ("error" in parsed) throw new Error(`${parsed.error} ${COUNTRY_FILTER_HINT}`);
  return parsed.filter === "all" ? null : parsed.filter;
}

/**
 * A release named by its words (`NBS PMI`, `Industrial Profits`), a country
 * code first standing for `--country` (`CN PMI`). CPI and FOMC, in the US or
 * with no country, are the macro alerts whose dates come from their own
 * calendars.
 */
function releaseRequest(args: readonly string[], country: CountryFilter | null, leadDays: number): AlertAddRequest {
  const words = args.join(" ").trim().split(/\s+/);
  let query = words.join(" ");
  if (!country && words.length >= 2 && /^[a-z]{2}$/i.test(words[0]!)) {
    const parsed = parseCountryFilter(words[0]!);
    if (!("error" in parsed) && parsed.filter !== "all") {
      country = parsed.filter;
      query = words.slice(1).join(" ");
    }
  }
  const event = parseMacroEventName(query);
  if (event && (!country || country === "US")) return { kind: "macro", event, leadDays };
  return { kind: "release", query, country, leadDays };
}

/**
 * Reads `alerts add` arguments: `<symbol> above 250`, `<symbol> earnings`,
 * `<symbol> earnings results`, or a release in the economic calendar by name
 * (`CPI`, `FOMC`, `NBS PMI`, `CN PMI`), with `--days` (already taken out of
 * `args`, `null` when the flag came without a value) and `--country` for the
 * event forms only, and `--exchange`, which a command to type again keeps.
 * Throws a message that names what the command takes.
 */
export function parseAlertAddArgs(
  args: readonly string[],
  days: string | null | undefined,
  exchange?: string | null,
  country?: string | null,
): AlertAddRequest {
  const [first, second, third, ...rest] = args;
  if (!first) throw new Error(ADD_USAGE);
  const countryFilter = readCountryOption(country);
  const metric = parseMetricAlert(args.join(" "));
  if (metric) {
    if (days !== undefined || country !== undefined) throw new Error("Valuation and daily technical alerts take neither --days nor --country.");
    return { kind: "metric", ...metric };
  }
  const research = parseResearchAddArgs(args) ?? parseRuleAddArgs(args);
  if (research) {
    if (days !== undefined) throw new Error("--days is for earnings and calendar event alerts, not this kind of alert.");
    if (country !== undefined) throw new Error(COUNTRY_RULE);
    return research;
  }
  const leadDays = () => {
    const parsed = days === null ? null : parseLeadDays(days);
    if (parsed == null) throw new Error(DAYS_RULE);
    return parsed;
  };
  if (second === undefined) {
    if (first.toLowerCase() === "earnings") {
      throw new Error("Name the company: gloom alerts add <symbol> earnings, such as alerts add CRWV earnings --days 3.");
    }
    return releaseRequest(args, countryFilter, leadDays());
  }
  if (second.toLowerCase() === "earnings" && country !== undefined) throw new Error(COUNTRY_RULE);
  if (second.toLowerCase() === "earnings") {
    if (third?.toLowerCase() === "results" && rest.length === 0) {
      if (days !== undefined) throw new Error("An alert for results goes off once they are out and takes no --days.");
      return { kind: "earnings", symbol: first, leadDays: 0, results: true };
    }
    if (third !== undefined) throw new Error(`Earnings alerts take a symbol and --days or results, not "${[third, ...rest].join(" ")}". ${ADD_USAGE}`);
    return { kind: "earnings", symbol: first, leadDays: leadDays() };
  }
  const condition = second.toLowerCase() as AlertCondition;
  if (!CONDITIONS.includes(condition)) {
    // Words with no price after them name a release (CN PMI, Industrial Profits); a price ends a mistyped price alert.
    if (parseAlertPrice(args.at(-1)!).kind === "invalid") return releaseRequest(args, countryFilter, leadDays());
    throw new Error(`Unknown alert "${second}". ${ALERT_KINDS_TEXT}`);
  }
  if (country !== undefined) throw new Error(COUNTRY_RULE);
  if (days !== undefined) throw new Error("--days is for earnings and calendar event alerts, not price alerts.");
  if (third === undefined) throw new Error(ADD_USAGE);
  const retype = (price: number) => retypeCommand(first, condition, price, exchange);
  // `81 000` without quotes arrives as 81 and a stray 000; neither reading is taken for granted.
  const spaced = rest.length > 0 && LEADING_GROUP.test(third) ? parsePastedNumber([third, ...rest].join(" ")) : null;
  if (spaced?.kind === "number") {
    const typed = Number(third);
    throw new Error(`${[third, ...rest].join(" ")} could be ${spaced.value} (thousands) or ${typed} and a stray ${rest.join(" ")}; type ${retype(spaced.value)} or ${retype(typed)}`);
  }
  // A price pasted from a sheet (1.350,5, 1,350.5, 1 350,5) reads as it is written; `1,350` could be either, so it asks.
  const price = readAlertPrice(third);
  if (rest.length > 0) throw new Error(`A price alert takes one price, not "${rest.join(" ")}" after ${third}; type ${retype(price)}`);
  const thousandsDot = thousandsDotReadings(third);
  return { kind: "price", symbol: first, condition, price, ...(thousandsDot ? { thousandsDot: { ...thousandsDot, text: third.trim() } } : {}) };
}

const OCC_CONTRACT = /^(?:O:)?[A-Z.]{1,6}\d{6}[CP]\d{8}$/i;
const LEVEL_DIRECTIONS = ["above", "below"] as const;

/** A level typed for an IV level rule, with its unit or without (`50`, `50%`, `-5.5 pts`), refused with its unit and range when it does not read. */
function readLevel(metric: IvLevelMetric, typed: string | undefined, symbol: string): number {
  const word = metric === "atm" ? "iv" : "rr";
  const example = metric === "atm" ? `alerts add ${symbol} iv above 50` : `alerts add ${symbol} rr below -5`;
  if (!typed) throw new Error(`Name the level: gloom ${example}.`);
  const unitError = ivLevelUnitError(metric, typed);
  if (unitError) throw new Error(`${unitError}: gloom ${example}.`);
  const level = parseIvLevel(typed);
  const { min, max } = IV_LEVEL_RANGES[metric];
  if (!Number.isFinite(level) || level < min || level > max) {
    throw new Error(metric === "atm"
      ? `An ${word} level is the 30-day ATM IV in percent, ${min} to ${max}, not "${typed}": gloom ${example}.`
      : `An ${word} level is the 30-day 25-delta risk reversal in vol points, ${min} to ${max}, not "${typed}": gloom ${example}.`);
  }
  return level;
}

/**
 * The research forms of `alerts add`, the ones Add Event Alert makes: `[symbol] news <keyword>`,
 * `[symbol] flow [premium] [calls|puts] [sweeps|blocks]`, `<symbol> iv|rr <above|below> <level>` and
 * `<OCC contract> iv spike <points>`. Null for any other form. A bare `news` or `flow` with no symbol
 * follows every name or your lists; `NEWS above 10` is still a price alert on a symbol.
 */
function parseResearchAddArgs(args: readonly string[]): ResearchAddRequest | null {
  const [first = "", second, third, ...rest] = args;
  const word = (value: string | undefined) => value?.toLowerCase() ?? "";
  const isCondition = (value: string | undefined) => (CONDITIONS as readonly string[]).includes(word(value)) || word(value) === "earnings";
  const lead = word(first);
  const [symbol, kind, tail] = (lead === "news" || lead === "flow") && !isCondition(second)
    ? [null, lead, args.slice(1)] as const
    : [first, word(second), args.slice(2)] as const;
  if (kind === "news") {
    const keyword = tail.join(" ").trim();
    if (!keyword) throw new Error(`Name a keyword or phrase: gloom alerts add ${symbol ?? "AAPL"} news buyback, or alerts add news "rate cut" for any company.`);
    return { kind: "news", symbol, keyword };
  }
  if (kind === "flow") {
    let premium = 1_000_000;
    let side: "any" | "calls" | "puts" = "any";
    let print: "any" | "sweep" | "block" = "any";
    for (const token of tail) {
      const lower = token.toLowerCase();
      if (lower === "calls" || lower === "call") side = "calls";
      else if (lower === "puts" || lower === "put") side = "puts";
      else if (lower === "sweeps" || lower === "sweep") print = "sweep";
      else if (lower === "blocks" || lower === "block") print = "block";
      else if (Number.isFinite(parseAmount(token))) premium = parseAmount(token);
      else throw new Error(`A flow alert takes a minimum premium (1m, $250k), calls or puts, and sweeps or blocks, not "${token}".`);
    }
    if (premium < 50_000) throw new Error(`The minimum premium is $50,000, not ${formatPremium(premium)}: Gloom Cloud records no smaller print.`);
    return { kind: "flow", symbol, premium, side, print };
  }
  if (!symbol || (kind !== "iv" && kind !== "rr")) return null;
  if (OCC_CONTRACT.test(symbol)) {
    if (kind !== "iv" || word(third) !== "spike") {
      throw new Error(`An option contract takes an IV spike in vol points: gloom alerts add ${symbol.toUpperCase()} iv spike 5. For a level, name the underlying: alerts add ${symbol.replace(/^O:/i, "").match(/^[A-Z.]+/i)![0]!.toUpperCase()} iv above 50.`);
    }
    // Vol points, with the unit or without it: `5`, `5 pts`.
    const typed = rest.join(" ");
    const value = typed && !/%/.test(typed) ? parseIvLevel(typed) : Number.NaN;
    if (!Number.isFinite(value) || value < 0.1 || value > 100) {
      throw new Error(`An IV spike is a rise of 0.1 to 100 vol points: gloom alerts add ${symbol.toUpperCase()} iv spike 5.`);
    }
    return { kind: "iv_spike", contract: symbol.toUpperCase(), points: value };
  }
  const metric: IvLevelMetric = kind === "iv" ? "atm" : "rr";
  const direction = word(third);
  if (!(LEVEL_DIRECTIONS as readonly string[]).includes(direction)) {
    throw new Error(`${kind === "iv" ? "An iv" : "An rr"} alert takes above or below and a level: gloom alerts add ${symbol} ${kind} ${kind === "iv" ? "above 50" : "below -5"}${kind === "iv" ? ", or iv spike on one OCC contract" : ""}.`);
  }
  // The level, with its unit or without it: `50`, `50%`, `-5.5 pts`.
  return { kind: "iv_level", symbol, metric, direction: direction as "above" | "below", level: readLevel(metric, rest.join(" "), symbol) };
}

/** The Add Event Alert form's values for a research request, so the CLI makes the rule the dialog makes. */
function researchFormValues(request: ResearchAddRequest, exchange: string): { kind: string; values: Record<string, string> } {
  switch (request.kind) {
    case "news": return { kind: "news_keyword", values: { "news_keyword:keyword": request.keyword,
      ...request.symbol ? { "news_keyword:symbol": request.symbol, "news_keyword:exchange": exchange } : {} } };
    case "flow": return { kind: "options_flow", values: { "options_flow:threshold": String(request.premium),
      "options_flow:direction": request.side, "options_flow:print": request.print,
      ...request.symbol ? { "options_flow:symbol": request.symbol, "options_flow:exchange": exchange } : {} } };
    case "iv_level": return { kind: "iv_level", values: { "iv_level:symbol": request.symbol, "iv_level:exchange": exchange,
      "iv_level:metric": request.metric, "iv_level:direction": request.direction, "iv_level:threshold": String(request.level) } };
    case "iv_spike": return { kind: "iv_spike", values: { "iv_spike:contract": request.contract, "iv_spike:threshold": String(request.points) } };
  }
}

/**
 * Who checks a research rule and how it reaches you, as docs/usage.md states it: an IV level is read by the
 * running app; the rest by Gloom Cloud for a signed-in account with Cloud sync, IV spikes and flow on Pro.
 */
function researchDelivery(kind: ResearchAddRequest["kind"]): string {
  if (kind === "iv_level") return "the app checks it every 15 minutes while it is running, on the same option fits as OVDV";
  const plan = kind === "news" ? "" : " on Gloom Pro";
  return `Gloom Cloud checks it for a signed-in account with Cloud sync${plan} and sends it to your phone`;
}

/**
 * The rule Add Event Alert saves for a form `alerts add` named by its words,
 * on the listing `quote` read the symbol as: a US research rule keeps its
 * symbol and venue, hiring and a catalyst's company their listing as typed
 * (ADYEN:AMS).
 */
function createFormRule(request: RuleAddRequest, listing: { symbol: string; key: string; exchange: string } | null): EventAlertRule {
  const { event } = request;
  if (!isResearchAlertKind(event)) return createEventAlert(event, listing?.key ?? request.values.value ?? "");
  const values = Object.fromEntries(Object.entries(request.values).map(([key, value]) => [`${event}:${key}`, value]));
  if (listing && request.listing === "any") values[`${event}:symbol`] = listing.key;
  else if (listing) {
    const typed = listing.exchange ? canonicalExchange(listing.exchange) : "";
    values[`${event}:symbol`] = listing.symbol;
    values[`${event}:exchange`] = RESEARCH_EXCHANGES.has(typed) ? typed : "US";
  }
  return createResearchAlert(event, values);
}

const isResearchRequest = (request: AlertAddRequest): request is ResearchAddRequest =>
  request.kind === "news" || request.kind === "flow" || request.kind === "iv_level" || request.kind === "iv_spike";

/** The US venue a research rule keeps: one typed and known to it, else any US venue. */
const RESEARCH_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "OTC"]);

/** `alerts add` as typed, with another price: what an error tells someone to type. */
function retypeCommand(symbol: string, condition: AlertCondition, price: number, exchange: string | null | undefined): string {
  return `gloom alerts add ${symbol} ${condition} ${price}${exchange ? ` --exchange ${exchange}` : ""}`;
}

/**
 * The listing's last price, as the alert will check it, for telling 81.000
 * typed for 81000 from 81; null when there is none, and the price is then
 * read as written.
 */
function lastPrice(quote: Quote): number | null {
  const price = getActiveQuoteDisplay(quote)?.price ?? quote.price;
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

/**
 * What a valuation or daily technical alert read when it was added:
 * "RSI(14) was 61.23 on the 2026-10-26 close", "50-day MA was 186.32 against
 * the 200-day MA at 180.11 on the 2026-10-26 close", "P/E (TTM) is 24.10".
 */
function metricReadingNote(alert: AlertRule): string {
  const metric = alert.metric!;
  const value = (alert.lastCheckedPrice ?? Number.NaN).toFixed(2);
  if (!isDailyMetric(metric)) return `${metricName(metric)} is ${value}`;
  const against = metric.kind === "ma_cross" ? metric.slowPeriod : metric.kind === "close_ma" ? metric.period : null;
  const target = against != null && alert.lastCheckedTarget != null ? ` against the ${against}-day MA at ${alert.lastCheckedTarget.toFixed(2)}` : "";
  return `${metricName(metric)} was ${value}${target} on the ${alert.lastDailyClose} close`;
}

/** An event alert still waiting to go off, as `alerts list` says `active`: not paused, and not alerted for its coming event or level. */
function eventRuleArmed(rule: EventAlertRule, now: number): boolean {
  if (rule.status !== "active") return false;
  const scheduled = readScheduledRule(rule);
  if (!scheduled) return !rule.triggeredAt;
  return scheduledAlertStatus(rule, scheduled.leadDays, scheduledToday(scheduled.target, now), scheduled.trigger) === "active";
}

/** One row of `alerts list`: a price alert as stored, or an event alert with its next date. */
type AlertListRow = Record<string, unknown> & {
  id: string;
  kind: string;
  status: string;
};

function priceRow(alert: AlertRule): AlertListRow {
  return {
    ...alert, kind: alert.metric?.kind ?? "price", rule: alert.metric ? metricDescription(alert) : undefined,
    target: alert.exchange ? `${alert.symbol}:${alert.exchange}` : alert.symbol,
    // The listing it is checked on, in its currency, and its last reading in words with when it is from.
    listing: alertListing(alert), currency: alert.lastQuoteCurrency ?? null,
    lastReading: alertReadingText(alert), lastReadingAt: isoUtc(alertReadingAt(alert)) || null,
  };
}

function eventRow(
  rule: EventAlertRule, now: number, eventDate: string | null | undefined, check?: IvLevelCheck, cloud?: CloudRuleStates,
): AlertListRow {
  const scheduled = readScheduledRule(rule);
  if (!scheduled) {
    const status = rule.status === "active" && rule.triggeredAt ? "triggered" : rule.status;
    // An IV level is read by this app, so its last reading is this device's; Gloom Cloud reads the rest.
    const state = cloud?.states.get(rule.id);
    const reading = rule.kind === "iv_level" ? {
      lastReading: ivLevelCheckText(rule, check),
      lastReadingAt: check?.value != null ? isoUtc(check.quoteAt ? Date.parse(check.quoteAt) : check.checkedAt) || null : null,
    } : state ? {
      lastReading: ruleStateText(state),
      lastReadingAt: state.asOf ? isoUtc(Date.parse(state.asOf)) || null : null,
    } : cloud?.failed ? {} : { lastReading: NOT_CHECKED_YET };
    return { id: rule.id, kind: rule.kind, target: eventAlertTarget(rule), status, createdAt: rule.createdAt,
      listing: eventRuleListing(rule), ...reading,
      ...check ? { lastCheck: check } : {}, ...rule.triggeredAt ? { triggeredAt: rule.triggeredAt } : {} };
  }
  const date = eventDate ?? null;
  return {
    id: rule.id,
    kind: rule.kind,
    target: scheduled.target.kind === "earnings" ? scheduled.target.symbol
      : scheduled.target.kind === "release" ? calendarEventLabel(scheduled.target) : scheduled.target.event.toUpperCase(),
    leadDays: scheduled.leadDays,
    when: scheduled.trigger === "results" ? "results" : "before",
    // CPI, FOMC and calendar releases also alert with their figures once they print.
    ...followsRelease(scheduled.target) ? { onRelease: true } : {},
    eventDate: date,
    status: scheduledAlertStatus({ ...rule, eventDate: date ?? undefined }, scheduled.leadDays, scheduledToday(scheduled.target, now), scheduled.trigger),
    createdAt: rule.createdAt,
    listing: scheduled.target.kind === "earnings" ? scheduled.target.exchange ? `${scheduled.target.symbol}:${scheduled.target.exchange}` : scheduled.target.symbol : "",
  };
}

/** Gloom Cloud's last reading of each rule it checks, as ALRT's Events tab shows them; `failed` when it could not be asked. */
interface CloudRuleStates {
  states: Map<string, AlertRuleState>;
  failed: boolean;
  warning?: string;
}

/**
 * Gloom Cloud checks the event rules this app does not, for a signed-in account. With no session nothing has
 * read them, so they are not checked yet; with one, their readings are Cloud's.
 */
async function cloudRuleStates(rules: readonly EventAlertRule[]): Promise<CloudRuleStates> {
  const empty = { states: new Map<string, AlertRuleState>(), failed: false };
  if (!apiClient.getSessionToken() || !rules.some((rule) => rule.kind !== "iv_level" && !readScheduledRule(rule))) return empty;
  try {
    const history = await fetchAlertHistory(0);
    return { states: new Map(history.states.map((state) => [state.ruleId, state])), failed: false };
  } catch (error) {
    return { ...empty, failed: true, warning: `Gloom Cloud's readings of event alerts could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The listing a research rule follows (AAPL, ADYEN:AMS for a hiring rule); empty for one on no symbol. */
function eventRuleListing(rule: EventAlertRule): string {
  if (rule.target === "ticker") return rule.value;
  if (!isResearchAlertKind(rule.kind)) return "";
  const config = readResearchRule(rule.kind, rule.value);
  if (!config?.symbol) return "";
  return config.symbol.includes(":") || !config.exchange || config.exchange === "US" ? config.symbol : `${config.symbol}:${config.exchange}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One row as text and CSV give it. CSV keeps the columns it has always had in
 * their order, then Created (ISO UTC), the listing, its currency and the last
 * reading, in words and dated.
 */
function textRow(row: AlertListRow): Record<string, unknown> {
  const price = row.kind === "price";
  return {
    id: row.id,
    kind: price ? "Price" : alertKindLabel(row.kind),
    target: row.target,
    trigger: row.rule ?? (price
      ? `${row.condition} ${row.targetPrice}`
      : typeof row.leadDays === "number"
        ? scheduledTriggerText({ leadDays: row.leadDays, trigger: row.when === "results" ? "results" : "date", prints: row.onRelease === true })
        : ""),
    eventDate: typeof row.leadDays === "number" ? row.eventDate ?? "not known" : "",
    status: row.status,
    lastCheckedPrice: row.lastCheckedPrice,
    triggeredAt: row.triggeredAt,
    createdAt: isoUtc(typeof row.createdAt === "number" ? row.createdAt : null),
    listing: row.listing ?? "",
    currency: row.currency ?? "",
    lastReading: row.lastReading ?? "",
    lastReadingAt: row.lastReadingAt ?? "",
  };
}

/** The next event date of each scheduled rule: the saved one while it is still ahead, otherwise looked up. */
async function listEventDates(
  rules: readonly EventAlertRule[],
  now: number,
  lookup: (targets: ScheduledEventTarget[]) => Promise<Map<string, ScheduledDateLookup>>,
): Promise<{ dates: Map<string, string | null>; warnings: string[] }> {
  const dates = new Map<string, string | null>();
  const stale: Array<{ rule: EventAlertRule; target: ScheduledEventTarget }> = [];
  for (const rule of rules) {
    const scheduled = readScheduledRule(rule);
    if (!scheduled) continue;
    if (rule.eventDate && rule.eventDate >= scheduledToday(scheduled.target, now)) dates.set(rule.id, rule.eventDate);
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

/** How far back a release is looked for: a monthly one is named in the calendar a month back before its next date is listed. */
const CALENDAR_LOOKBACK_DAYS = 40;

/**
 * The calendar a release is named from: the stored past five weeks and the
 * listing ahead, or the listing alone from a server that keeps no past.
 */
async function loadAlertCalendar(now: number): Promise<readonly EconEvent[]> {
  const from = new Date(now - CALENDAR_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const stored = await fetchEconCalendarFrom(from);
  if (stored.events) return stored.events;
  return (await loadCalendar()).data;
}

const quoted = (text: string) => (/\s/.test(text) ? `"${text}"` : text);
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

/** "on Sat 2026-10-31 01:30 UTC", "on Mon 2026-10-26, all day": when a release is next listed. */
function releaseWhen(event: EconEvent): string {
  const day = `on ${weekday.format(event.date)} ${dateKey(event.date)}`;
  if (isAllDayEvent(event)) return `${day}, all day`;
  return event.timeNote ? day : `${day} ${event.date.toISOString().slice(11, 16)} UTC`;
}

/** The release an alert was added for, as `--json` gives it. */
function releaseData(choice: CalendarEventChoice) {
  return {
    name: choice.name,
    country: choice.country,
    publisher: choice.publisher,
    impact: choice.impact,
    next: choice.next ? { at: choice.next.date.toISOString(), allDay: isAllDayEvent(choice.next) } : null,
  };
}

const choiceList = (choices: readonly CalendarEventChoice[]) => choices.map((choice) => calendarEventLabel({ event: choice.name, country: choice.country }));

/** What a name read as, and what else it names in that country: said beside the alert added. */
function releaseReadNotes(
  query: string,
  choice: CalendarEventChoice,
  others: readonly CalendarEventChoice[],
  renamed?: ReleaseRename,
): string[] {
  const notes: string[] = [];
  if (calendarNameWords(query).join(" ") !== calendarNameWords(choice.name).join(" ")) {
    notes.push(`Read "${query}" as ${calendarEventLabel({ event: choice.name, country: choice.country })}, ${choice.impact} impact.`
      + (renamed ? ` ${releaseRenameNote(renamed)}` : ""));
  }
  if (others.length > 0) {
    const shown = choiceList(others.slice(0, 4));
    const more = others.length > 4 ? ` and ${others.length - 4} more` : "";
    notes.push(`Also matching: ${shown.join(", ")}${more}. To follow one of them instead: alerts add ${quoted(others[0]!.name)} --country ${others[0]!.country}.`);
  }
  return notes;
}

/** Every kind `alerts add` takes, as a refusal of words none of them reads ends. */
const ADD_FORMS = ALERT_KINDS_TEXT;

/**
 * Why a name could not be looked up. A single word (alerts add AAPL) may be
 * a slip of another form as much as a release, so it also says what each
 * form takes.
 */
function calendarUnavailableMessage(query: string, country: CountryFilter | null, error: string): string {
  if (country || /\s/.test(query.trim())) return eventDateUnavailableMessage({ kind: "release", event: query, country: country ?? "" }, error);
  return `Unknown event "${query}": the economic calendar could not be loaded to look it up (${error}). ${ADD_FORMS}`;
}

/** The refusal of a name nothing in the calendar matches: the nearest names, and every form `alerts add` takes. */
function noReleaseMessage(
  query: string,
  country: CountryFilter | null,
  suggestions: readonly CalendarEventChoice[],
  renamed?: ReleaseRename,
): string {
  const near = suggestions.length > 0 ? ` Did you mean ${choiceList(suggestions).join(", ")}?` : "";
  // Words with a country are a release named; anything else may as well be a kind of alert mistyped.
  if (country) {
    return `No release in the economic calendar matches "${query}" in ${country.split(",").join(", ")}.`
      + `${renamed ? ` ${releaseRenameNote(renamed)}` : ""}${near} gloom econ --country <code> lists the calendar.`;
  }
  return `No kind of alert and no release in the economic calendar matches "${query}".`
    + `${renamed ? ` ${releaseRenameNote(renamed)}` : ""}${near} `
    + `${ADD_FORMS} Calendar releases go by name (${CALENDAR_EXAMPLES}); gloom econ --country <code> lists the calendar.`;
}

/** The refusal of a name listed in several countries, with the best of each. */
function severalCountriesMessage(query: string, choices: readonly CalendarEventChoice[]): string {
  const shown = choiceList(choices.slice(0, 6));
  const more = choices.length > 6 ? ` and ${choices.length - 6} more` : "";
  return `"${query}" is listed for several countries: ${shown.join(", ")}${more}. Name the country: alerts add ${quoted(query)} --country ${choices[0]!.country}.`;
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

export const alertsCliCommand: CliCommandDef = {
  name: "alerts",
  aliases: ["alert"],
  description: "List, add, re-arm and remove price, valuation and daily technical alerts, alerts before earnings and any economic calendar release (CPI, FOMC, NBS PMI), and every event alert ALRT offers: news, options flow, IV, 52-week range, unusual volume, filings, insiders, short interest, analysts, hiring, perpetuals, catalysts, Congress and 13F",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    // Every form `alerts add` takes, as the refusal of an unknown phrase names them and the CLI docs page lists them.
    usage: [
      "alerts list",
      ...ALERT_ADD_FORMS.map((form) => `alerts add ${form.usage}`),
      "alerts delete <id>",
      "alerts rearm <id>",
    ],
    options: [
      EXCHANGE_OPTION,
      { flags: "--days <n>", description: `Days before the event the alert goes off, 1 to ${MAX_LEAD_DAYS} (default 1); earnings and calendar event alerts` },
      { flags: "--country <code>", description: "The country of a calendar event, as econ --country takes it (CN, US, DE); a code before the name does the same (alerts add CN PMI)" },
    ],
    examples: [
      "alerts",
      "alerts add AAPL above 250",
      "alerts add AAPL pe below 25",
      "alerts add AAPL ps above 8",
      'alerts add NVDA "rsi(14)" under 30',
      'alerts add SPY "ma(50)" crosses above "ma(200)"',
      'alerts add TSLA closes below "ma(200)"',
      "alerts add SAN:EPA below 70",
      "alerts add CRWV earnings --days 3",
      "alerts add CRWV earnings results",
      "alerts add CPI --days 1",
      "alerts add \"NBS PMI\"",
      "alerts add \"Industrial Profits\" --country CN --days 2",
      "alerts add AAPL news buyback",
      "alerts add NVDA flow 5m calls sweeps",
      "alerts add IBIT iv above 50",
      "alerts add SPY rr below -6",
      "alerts add XLE 52-week high",
      "alerts add NVDA unusual volume 3x",
      "alerts add AAPL filing 8-K",
      "alerts add TSLA insider sell",
      "alerts add GME short interest increase 20%",
      "alerts add AAPL analyst downgrade",
      "alerts add RIVN hiring slowing",
      "alerts add perps hyperliquid:default:BTC funding above 0.05%",
      "alerts add catalyst type clinical",
      "alerts add congress \"Nancy Pelosi\"",
      "alerts add 13f 1067983",
    ],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const daysFlag = rawArgs.some((arg) => arg === "--days" || arg.startsWith("--days="));
    const daysValue = takeOption(args, "--days");
    const days = daysFlag && daysValue === undefined ? null : daysValue;
    const exchangeOption = takeOption(args, "--exchange");
    const countryFlag = rawArgs.some((arg) => arg === "--country" || arg.startsWith("--country="));
    const countryValue = takeOption(args, "--country");
    const country = countryFlag && countryValue === undefined ? null : countryValue;
    const action = args[0] ?? "list";
    const now = Date.now();
    const today = newYorkToday(new Date(now));

    const parseAdd = (): AlertAddRequest => {
      try {
        return parseAlertAddArgs(args.slice(1), days, exchangeOption, country);
      } catch (error) {
        return ctx.fail(error instanceof Error ? error.message : String(error));
      }
    };
    const request = action === "add" ? parseAdd() : null;
    const research = request && isResearchRequest(request) ? request : null;
    const formRule = request?.kind === "rule" ? request : null;
    const listedSymbol = (request?.kind === "price" || request?.kind === "metric") ? request.symbol
      : research && research.kind !== "iv_spike" ? research.symbol : formRule?.symbol ?? null;
    // Gloom Cloud's research rules follow US listings; hiring and a catalyst's company may list anywhere.
    const usOnly = research ? research.kind === "news" ? "News alerting" : research.kind === "flow" ? "Options flow" : "Options data"
      : formRule?.listing === "us" ? RULE_US_DATA[formRule.event] ?? "This alert" : null;
    // A price alert is kept for the listing `quote` prints for the symbol, and for no symbol that quotes nothing;
    // a news, flow or IV rule on a symbol follows that listing too, and only in the US, where their data is.
    const priced = listedSymbol
      ? await withMarketData(ctx, async (market) => {
        const quoted = await requireQuotedListing(listedSymbol, exchangeOption, market, ctx, "alerts add");
        if (usOnly) {
          const venue = quoted.listing.exchange || canonicalExchange(quoted.quote.listingExchangeName || quoted.quote.exchangeName);
          if (!isUsListingExchange(venue)) {
            const { message, details } = await usListingsOnlyMessage(usOnly, quoted.listing, market,
              (key) => `gloom alerts add ${key} ${args.slice(2).join(" ")}`);
            ctx.fail(message, details);
          }
        }
        return quoted;
      })
      : null;
    const priceListing = priced?.listing ?? null;
    // A bare coin ticker read as another listing (SOL, a stale company; BTC, the Grayscale trust) gets `quote`'s note
    // naming the coin's pair, before a metric alert names the venue it was read on.
    const coinNote = priced ? coinListingNotes(priced.listing, priced.quote)[0] ?? null : null;
    // What the alert reads now, which it is saved with, so lists and ALRT show it before the app has run.
    let reading: Partial<AlertRule> = {};
    // A daily rule whose close could not be read yet: why, which the add says beside when it is first checked.
    let unread: string | null = null;
    if (request?.kind === "metric" && priced) {
      const exchange = canonicalExchange(priced.listing.exchange || priced.quote.listingExchangeName || priced.quote.exchangeName);
      const preview = { ...createAlert(priced.listing.symbol, request.condition, request.price, exchange), metric: request.metric };
      // A listing without a published close calendar can never be checked; anything else is saved and checked as it can be.
      const unavailable = metricAvailabilityError(preview);
      if (unavailable) ctx.fail(unavailable);
      try {
        const value = await withMarketData(ctx, market => metricReadings(market.dataProvider, now)(preview));
        reading = { lastCheckedPrice: value.value, lastCheckedTarget: value.target, lastQuoteUpdatedAt: value.at, lastCheckedAt: now,
          ...value.day ? { lastDailyClose: value.day } : {} };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A valuation the inputs cannot give is refused; a daily close not yet final, or history not there yet, is read once it is.
        if (!isDailyMetric(request.metric)) ctx.fail(message);
        unread = message;
      }
      if (priced.quote.currency) reading.lastQuoteCurrency = priced.quote.currency;
      priced.listing.exchange = exchange;
    }
    if (request?.kind === "price" && priced && !isQuoteStaleForCurrentSession(priced.quote)) {
      // The price it is added at is its first reading and the baseline a crossing is measured from, as Add Alert keeps it.
      const price = lastPrice(priced.quote);
      if (price != null) reading = quoteAlertFields({ ...priced.quote, price }, now);
    }
    if (request?.kind === "price" && request.thousandsDot && priced) {
      const question = thousandsDotMessage(request, priced.listing.key, lastPrice(priced.quote), exchangeOption);
      if (question) ctx.fail(question);
    }
    if (request?.kind === "price" && priced) {
      // A target ten times away is a slip or another instrument's price, such as bitcoin's on the BTC fund.
      // Against the price the alert is checked on, as Add Alert measures it.
      const far = farTargetMessage(priced.listing.key, request.price, priced.quote.price, coinNote);
      if (far) ctx.fail(far);
    }
    // What a typed listing was read as (7203:TSE as 7203:JPX, MXN as MXN:FWB2), said beside what was added.
    let read = [...priced?.notes ?? [], ...coinNote ? [coinNote] : []];
    let newEventRule: EventAlertRule | null = null;
    let newResearchRule: EventAlertRule | null = null;
    if (research) {
      const typed = priceListing?.exchange ? canonicalExchange(priceListing.exchange) : "";
      const { kind, values } = researchFormValues(
        research.kind === "iv_spike" ? research : { ...research, symbol: priceListing?.symbol ?? null } as ResearchAddRequest,
        RESEARCH_EXCHANGES.has(typed) ? typed : "US",
      );
      try {
        newResearchRule = createResearchAlert(kind, values);
      } catch (error) {
        ctx.fail(error instanceof Error ? error.message : String(error));
      }
    }
    if (formRule) {
      try {
        newResearchRule = createFormRule(formRule, priceListing);
      } catch (error) {
        ctx.fail(error instanceof Error ? error.message : String(error));
      }
    }
    // A release named from the calendar, with what the words were read as and what else they name.
    let newRelease: CalendarEventChoice | null = null;
    // CPI and FOMC, typed so or named by one of their calendar rows (CPI y/y, Fed Interest Rate Decision).
    let macro: { event: MacroAlertEvent; leadDays: number } | null = request?.kind === "macro" ? request : null;
    let calendar: readonly EconEvent[] | null = null;
    if (request?.kind === "release") {
      const events = await loadAlertCalendar(now).catch((error: unknown) =>
        ctx.fail(calendarUnavailableMessage(request.query, request.country, error instanceof Error ? error.message : String(error))));
      calendar = events;
      const match = matchCalendarEvent(request.query, request.country, events, now);
      if (match.kind !== "match") {
        return ctx.fail(match.kind === "none"
          ? noReleaseMessage(request.query, request.country, match.suggestions, match.renamed)
          : severalCountriesMessage(request.query, match.choices));
      }
      const { choice, others } = match;
      const macroEvent = macroEventNamed(choice);
      if (macroEvent) {
        macro = { event: macroEvent, leadDays: request.leadDays };
        read = [`Read "${request.query}" as the ${MACRO_EVENT_NAMES[macroEvent]} alert, which follows ${calendarEventLabel({ event: choice.name, country: choice.country })}.`];
      } else {
        newRelease = choice;
        read = releaseReadNotes(request.query, choice, others, match.renamed);
        const target: ScheduledEventTarget = { kind: "release", event: choice.name, country: choice.country, ...(choice.publisher ? { publisher: choice.publisher } : {}) };
        try {
          newEventRule = createScheduledAlert(target, request.leadDays, choice.next ? dateKey(choice.next.date) : null);
        } catch (error) {
          ctx.fail(error instanceof Error ? error.message : String(error));
        }
      }
    }
    // When CPI or FOMC came out earlier today: its figures are not sent to an alert set after them.
    let macroOutAt: number | null = null;
    const earnings = request?.kind === "earnings" ? request : null;
    if (macro || earnings) {
      const target: ScheduledEventTarget = macro
        ? { kind: "macro", event: macro.event }
        : await requireListingArg(earnings!.symbol, exchangeOption, ctx)
          .then((listing) => {
            read = listingReadNotes(listing);
            return { kind: "earnings" as const, symbol: listing.symbol, exchange: listing.exchange };
          });
      const lead = earnings?.results ? "results" as const : (macro ?? earnings!).leadDays;
      // A listing the rule cannot follow fails before any request.
      try {
        createScheduledAlert(target, lead, null);
      } catch (error) {
        ctx.fail(error instanceof Error ? error.message : String(error));
      }
      const eventDate = target.kind === "earnings"
        ? await withMarketData(ctx, (market) => requireEventDate(target, scheduledEventSources(market.dataProvider), today, (message) => ctx.fail(message)))
        : await requireEventDate(target, scheduledEventSources(null), today, (message) => ctx.fail(message));
      newEventRule = createScheduledAlert(target, lead, eventDate);
      if (target.kind === "macro" && eventDate === today) {
        const events = calendar ?? await loadAlertCalendar(now).catch(() => {
          // Intentional ignore: without the calendar the alert is added as before, only without saying today's release is out.
          return null;
        });
        const row = events ? releaseRowOn(target, eventDate, events) : null;
        const at = row ? releaseInstant(row) : null;
        if (at != null && at <= now) macroOutAt = at;
      }
    }

    if (action === "list") {
      // An IV level's last reading is this device's, beside the rules.
      const { alerts, alertsError, events, checks } = await withConfigData(ctx, (config) => ({
        ...readAlertStores(config.config),
        checks: readIvLevelChecks(config.persistence?.pluginState?.get(ALERTS_PLUGIN_ID, resumeStateKey(IV_LEVEL_CHECKS_KEY))?.value),
      }));
      // Earnings dates come through market data; CPI, FOMC and calendar dates do not need it.
      const lookup = (targets: ScheduledEventTarget[]) => targets.some((target) => target.kind === "earnings")
        ? withMarketData(ctx, (market) => lookupScheduledDates(targets, scheduledEventSources(market.dataProvider), today, now))
        : lookupScheduledDates(targets, scheduledEventSources(null), today, now);
      const [{ dates, warnings }, cloud] = await Promise.all([listEventDates(events.rules, now, lookup), cloudRuleStates(events.rules)]);
      const rows = [
        ...alerts.map(priceRow),
        ...events.rules.map((rule) => eventRow(rule, now, dates.has(rule.id) ? dates.get(rule.id) : rule.eventDate, checks[rule.id], cloud)),
      ];
      const allWarnings = [...(alertsError ? [alertsError] : []), ...(events.error ? [events.error] : []), ...warnings, ...cloud.warning ? [cloud.warning] : []];
      ctx.printResult({ data: rows, ...(allWarnings.length ? { warnings: allWarnings } : {}) }, {
        rows: (data) => data.map(textRow),
        textColumns: [
          { key: "id", header: "ID", shrink: false },
          { key: "kind", header: "Kind" },
          // A price or technical alert names the listing it is checked on, in its currency.
          { key: "target", header: "Target", format: (value, row) => row.currency ? listingWithCurrency(String(row.listing), String(row.currency)) : String(value ?? "") },
          { key: "trigger", header: "Trigger" },
          { key: "eventDate", header: "Event Date" },
          { key: "status", header: "Status" },
          { key: "lastReading", header: "Last Reading" },
          // ISO 8601 in UTC, as CSV writes it.
          { key: "createdAt", header: "Created", format: (value) => String(value ?? "") },
          { key: "triggeredAt", header: "Triggered", optional: true },
        ],
        empty: "No alerts. Add one with gloom alerts add AAPL above 250, alerts add CRWV earnings --days 3, alerts add CPI --days 1, or alerts add CN PMI.",
      });
      return;
    }

    await withConfigData(ctx, async (config) => {
      const { pluginState, alerts, alertsError, levelErrors, events } = readAlertStores(config.config);
      const save = async (next: { alerts?: AlertRule[]; events?: EventAlertRule[] }) => {
        if (next.alerts) for (const [key, value] of Object.entries(writeLevelAlertStores(next.alerts))) {
          if (levelErrors[key] && value !== "[]") ctx.fail(levelErrors[key]!);
        }
        const nextConfig = {
          ...config.config,
          pluginConfig: {
            ...config.config.pluginConfig,
            [ALERTS_PLUGIN_ID]: {
              ...pluginState,
              ...(next.alerts ? Object.fromEntries(Object.entries(writeLevelAlertStores(next.alerts)).filter(([key]) => !levelErrors[key])) : {}),
              // Each list keeps what it holds of kinds this version does not know; IV levels go in their own.
              ...(next.events ? writeEventAlertStores(events.lists, next.events) : {}),
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
      // Each rule created, re-armed or deleted here goes in this device's alert log, beside the alerts that fired.
      const record = (action: AlertLogAction, rule: AlertRule | EventAlertRule) => {
        const state = config.persistence?.pluginState;
        if (ctx.cliOptions.dryRun || !state) return;
        try {
          appendAlertLog({
            get: (key) => state.get(ALERTS_PLUGIN_ID, resumeStateKey(key))?.value,
            set: (key, value) => state.set(ALERTS_PLUGIN_ID, resumeStateKey(key), value),
          }, [alertChangeEntry(action, alertLogRule(rule), Date.now())]);
        } catch (error) {
          logFailure("alerts.cli", "Record alert change failed")(error);
        }
      };

      if (request?.kind === "price" || request?.kind === "metric") {
        const { condition, price } = request;
        const symbol = requireArg(priceListing?.key, ADD_USAGE, ctx);
        const alert: AlertRule = { ...createAlert(symbol, condition, price, priceListing?.exchange), ...(request.kind === "metric" ? { metric: request.metric } : {}), ...reading };
        // The same rule on the same listing is one alert: a second add names it and adds nothing.
        const existing = alerts.find((entry) => sameLevelRule(entry, alert));
        if (existing) {
          const rearm = existing.status === "triggered" ? `; it went off, so re-arm it with gloom alerts rearm ${existing.id}` : "";
          ctx.fail(`${alertLogRule(alert).rule} already exists as alert ${existing.id}${rearm}. Nothing was added.`);
        }
        await save({ alerts: [...alerts, alert] });
        record("created", alert);
        // A daily rule is first judged on the first close after it was set, once that close has settled.
        const firstCheck = alert.metric && isDailyMetric(alert.metric) ? firstDailyCheck(alert.exchange, now) : null;
        const notes = [
          alert.metric ? unread ? `Not read yet: ${unread.replace(/\.$/, "")}.` : `${metricReadingNote(alert)}.` : null,
          firstCheck ? `First checked on the ${firstCheck.day} close, from ${isoUtc(firstCheck.at).slice(11, 16)} UTC.` : null,
        ].filter(Boolean).join(" ");
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert,
          ...firstCheck ? { firstCheck: { close: firstCheck.day, at: isoUtc(firstCheck.at) } } : {},
          ...unread ? { unread } : {} }, ...(read.length > 0 ? { warnings: read } : {}) }, {
          // The delivery, as docs/usage.md states it, before any full stop, which after the price would read as part of it (below 81.).
          text: (data) => `Added alert ${data.alert.id}: ${data.alert.metric ? metricDescription(data.alert) : `${symbol} ${condition} ${price}`} (${PRICE_DELIVERY}).${notes ? ` ${notes}` : ""}${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      if (newResearchRule) {
        const rule = newResearchRule;
        const rules = requireEvents();
        const existing = rules.find((entry) => entry.kind === rule.kind && entry.target === rule.target && entry.value.toLowerCase() === rule.value.toLowerCase());
        if (existing) ctx.fail(`This alert already exists (ID ${existing.id}). Nothing was added.`);
        if (rules.length >= MAX_EVENT_ALERTS) ctx.fail(`Keep at most ${MAX_EVENT_ALERTS} event alerts. Delete one with gloom alerts delete <id>.`);
        await save({ events: [...rules, rule] });
        record("created", rule);
        const delivery = research ? researchDelivery(research.kind) : ruleDelivery(formRule!.event);
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert: rule }, ...(read.length > 0 ? { warnings: read } : {}) }, {
          text: (data) => `Added alert ${data.alert.id}: ${alertKindLabel(rule.kind)} ${eventAlertTarget(rule)} (${delivery}).${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      if (newEventRule) {
        const rule = newEventRule;
        const rules = requireEvents();
        const scheduled = readScheduledRule(rule)!;
        const name = scheduledEventName(scheduled.target);
        const existing = rules.find((entry) => entry.kind === rule.kind && entry.value.toLowerCase() === rule.value.toLowerCase());
        if (existing) ctx.fail(scheduled.trigger === "results"
          ? `An alert for ${name} results already exists (ID ${existing.id}). Nothing was added.`
          : `An alert ${plural(scheduled.leadDays, "day")} before ${name} already exists (ID ${existing.id}). Nothing was added.`);
        if (rules.length >= MAX_EVENT_ALERTS) ctx.fail(`Keep at most ${MAX_EVENT_ALERTS} event alerts. Delete one with gloom alerts delete <id>.`);
        await save({ events: [...rules, rule] });
        record("created", rule);
        const eventDate = rule.eventDate ?? null;
        const due = !!eventDate && scheduledPhase(eventDate, scheduled.leadDays, undefined, scheduledToday(scheduled.target, now)) === "due";
        const release = followsRelease(scheduled.target);
        // A release that prints no figures (a plenum, a speech) alerts only before it.
        const prints = release && (!newRelease?.next || expectsFigures(newRelease.next));
        const delivery = release ? ", only while it is running" : " while it is running, or on your phone with Cloud sync";
        const when = !eventDate ? null : newRelease?.next ? releaseWhen(newRelease.next) : `on ${eventDate}`;
        const reminder = !eventDate
          ? "the app alerts once the calendar lists its next date, about two weeks ahead"
          : macroOutAt != null ? `it came out today at ${new Date(macroOutAt).toISOString().slice(11, 16)} UTC, so the app alerts before the next one`
          : due ? "already reached, so the app alerts at its next check" : `the app alerts on ${leadStartDate(eventDate, scheduled.leadDays)}`;
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert: rule,
          ...newRelease ? { release: releaseData(newRelease) } : {} }, ...(read.length > 0 ? { warnings: read } : {}) }, {
          // Delivery, as docs/usage.md states it: CPI, FOMC and calendar releases notify in the running app only; earnings also reach the phone,
          // which Gloom Cloud alerts with the same results once the actual EPS is stored for a results alert.
          text: (data) => scheduled.trigger === "results"
            ? `Added alert ${data.alert.id}: ${name} on ${eventDate}, when results are out (the app alerts once the actual EPS is in while it is running, and with Cloud sync your phone gets the same alert).${dryRunNote(data.dryRun)}`
            : `Added alert ${data.alert.id}: ${name}${when ? ` ${when}` : ""}, ${plural(scheduled.leadDays, "day")} before${prints ? " and when it prints" : ""} (${reminder}${
              prints ? ", and with the actual, forecast and prior once out" : ""}${delivery}).${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      if (action === "delete" || action === "rm") {
        const id = requireArg(args[1], "Usage: gloom alerts delete <id>", ctx);
        const level = alerts.find((alert) => alert.id === id) ?? null;
        const rule = level ? null : events.rules.find((entry) => entry.id === id) ?? null;
        if (!level && !rule && alertsError) ctx.fail(alertsError);
        if (level) await save({ alerts: alerts.filter((alert) => alert.id !== id) });
        if (rule) await save({ events: requireEvents().filter((entry) => entry.id !== id) });
        const gone = level ?? rule;
        if (gone) record("deleted", gone);
        const changed = !!gone;
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun && changed, dryRun: ctx.cliOptions.dryRun, id } }, {
          text: (data) => changed
            ? `Deleted alert ${id}.${dryRunNote(data.dryRun)}`
            : cliStyles.muted(`No alert with ID ${id}.`),
        });
        return;
      }
      if (action === "rearm") {
        const id = requireArg(args[1], "Usage: gloom alerts rearm <id>", ctx);
        const level = alerts.find((alert) => alert.id === id) ?? null;
        const rule = level ? null : events.rules.find((entry) => entry.id === id) ?? null;
        if (!level && !rule && alertsError) ctx.fail(alertsError);
        // An alert still waiting to go off has nothing to re-arm, and is left as it is.
        const active = level ? level.status === "active" : rule ? eventRuleArmed(rule, now) : false;
        if (level && !active) await save({ alerts: alerts.map((alert) => alert.id === id ? rearmAlert(alert) : alert) });
        if (rule && !active) {
          // A scheduled alert alerts again for its coming event; any other event alert resumes.
          const next = readScheduledRule(rule) ? rearmScheduledAlert(rule)
            : rule.kind === "iv_level" && rule.triggeredAt ? rearmIvLevelAlert(rule)
            : rule.status === "paused" ? toggleEventAlert(rule) : rule;
          await save({ events: requireEvents().map((entry) => entry.id === id ? next : entry) });
        }
        const found = level ?? rule;
        if (found && !active) record("rearmed", found);
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun && !!found && !active, dryRun: ctx.cliOptions.dryRun, id, ...active ? { active: true } : {} } }, {
          text: (data) => !found ? cliStyles.muted(`No alert with ID ${id}.`)
            : active ? cliStyles.muted(`Alert ${id} is already active; nothing to re-arm.`)
            : `Re-armed alert ${id}.${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      ctx.fail("Usage: gloom alerts list|add|delete|rearm");
    });
  },
};
