import { closeBasis, isRelativeMetric, metricDescription, metricReadingText, validMetricRule, type MetricReading } from "./metric-model";
import { benchmarkKey, parseMetricAlert, type MetricAlertInput } from "./metric-command";
import { metricReadings } from "./metric-data";
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
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { notATickerSymbol } from "../../../sources/provider-errors";
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
import { createAlert, rearmAlert } from "./alert-engine";
import { ALERTS_PLUGIN_ID } from "./constants";
import { MAX_EVENT_ALERTS, eventAlertTarget, toggleEventAlert, writeEventAlertStores, type EventAlertRule } from "./events";
import { alertKindLabel } from "./history";
import { IV_LEVEL_CHECKS_KEY, readIvLevelChecks, rearmIvLevelAlert, type IvLevelCheck } from "./iv-level";
import { parseAlertPrice, readAlertPrice } from "./price";
import { farTargetMessage } from "./quotes";
import { MACRO_EVENT_NAMES, createResearchAlert, formatPremium, ivLevelUnitError, parseAmount, parseIvLevel, researchAlertDescription } from "./research-builder";
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

const ADD_USAGE = "Usage: gloom alerts add <symbol> <above|below|crosses> <price>, alerts add <symbol>/<benchmark> <above|below|crosses> <ratio>, alerts add <symbol> rrg <quadrant> [--benchmark <symbol>], alerts add <symbol> earnings [--days <n> | results], alerts add <calendar event> [--country <code>] [--days <n>], alerts add [symbol] news <keyword>, alerts add [symbol] flow [premium] [calls|puts] [sweeps|blocks], alerts add <symbol> <iv|rr> <above|below> <level>, or alerts add <OCC contract> iv spike <points>";
const DAYS_RULE = `--days takes a whole number of days from 1 to ${MAX_LEAD_DAYS}; without it the alert goes off 1 day before.`;
/** The event form every refusal of `alerts add` names: any release in the economic calendar, CPI and FOMC among them. */
const EVENT_FORM = `a release in the economic calendar by name (alerts add "NBS Manufacturing PMI" --country CN, alerts add CN PMI, alerts add CPI --days 1)`;
const COUNTRY_RULE = "--country is for an alert on a calendar event, such as alerts add PMI --country CN.";
const BENCHMARK_RULE = "--benchmark takes the listing an RRG alert is measured against (SPY by default, as in RRG),";
/** `XLK/SPY`, `XLK:NYSEARCA/SPY`: two listings, or one written with a slash (BRK/B, EUR/USD). */
const PAIR_SHAPE = /^[^/\s]+\/[^/\s]+$/;
/** A listing check that hands back its refusal instead of ending the command, so a pair can be read as a ratio. */
class ListingRefusal extends Error {
  constructor(message: string, readonly details?: string) { super(message); }
}
const PROBE = { fail: (message: string, details?: string): never => { throw new ListingRefusal(message, details); } };

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
  | { kind: "iv_spike"; contract: string; points: number };

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
  benchmark?: string | null,
): AlertAddRequest {
  const [first, second, third, ...rest] = args;
  if (!first) throw new Error(ADD_USAGE);
  const countryFilter = readCountryOption(country);
  if (benchmark === null) throw new Error(`${BENCHMARK_RULE} such as alerts add XLE rrg leading --benchmark QQQ.`);
  const rrgFlag = benchmark !== undefined && second?.toLowerCase() === "rrg";
  const typedVs = /^(vs\.?|versus|against)$/i.test(args[3] ?? "") ? args[4] : undefined;
  if (rrgFlag && typedVs !== undefined) {
    // `vs QQQ --benchmark SMH` names two benchmarks; the same one twice (SPY and SPY:NYSEARCA) is one.
    const [typed, flag] = [typedVs, benchmark].map((text) => parsePublicTickerKey(text.toUpperCase()));
    if (typed!.symbol !== flag!.symbol || (typed!.exchange && flag!.exchange && typed!.exchange !== flag!.exchange)) {
      throw new Error(`An RRG alert names its benchmark once: vs ${typedVs.toUpperCase()} or --benchmark ${benchmark.toUpperCase()}, not both.`);
    }
  }
  const metric = parseMetricAlert(rrgFlag && typedVs === undefined ? [...args, "vs", benchmark].join(" ") : args.join(" "));
  if (benchmark !== undefined && metric?.metric.kind !== "rrg") throw new Error(`${BENCHMARK_RULE} such as alerts add XLE rrg leading --benchmark QQQ; a ratio names both listings, as in alerts add XLK/SPY above 0.25.`);
  if (metric) {
    if (days !== undefined || country !== undefined) throw new Error(`${isRelativeMetric(metric.metric) ? "Relative strength" : "Valuation and daily technical"} alerts take neither --days nor --country.`);
    return { kind: "metric", ...metric };
  }
  const research = parseResearchAddArgs(args);
  if (research) {
    if (days !== undefined) throw new Error("--days is for earnings and calendar event alerts, not news, flow or IV alerts.");
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
    throw new Error(`Unknown alert "${second}". Use above, below or crosses with a price (or a ratio after XLK/SPY), rrg with a quadrant, earnings with --days, news with a keyword, flow, iv or rr with above or below and a level, iv spike on an OCC contract, or ${EVENT_FORM}.`);
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

/** What a rule saves of a measure's reading, as the app's checks save it. */
function readingFields(reading: MetricReading): Partial<AlertRule> {
  return { lastCheckedPrice: reading.value, lastCheckedTarget: reading.target, lastQuoteUpdatedAt: reading.at,
    lastCheckedAt: Date.now(), ...(reading.day ? { lastDailyClose: reading.day } : {}) };
}

/** "0.2434 at the 2026-10-26 daily close", "Lagging (strength 98.12, momentum 99.40) at the 2026-10-23 weekly close". */
function readingWords(metric: NonNullable<AlertRule["metric"]>, reading: Pick<MetricReading, "value" | "target" | "day">): string {
  const basis = closeBasis(metric);
  return `${metricReadingText(metric, reading)}${basis && reading.day ? ` at the ${reading.day} ${basis}` : ""}`;
}

/** One row of `alerts list`: a price alert as stored, or an event alert with its next date. */
type AlertListRow = Record<string, unknown> & {
  id: string;
  kind: string;
  status: string;
};

function priceRow(alert: AlertRule): AlertListRow {
  // A measure's last reading in words, and the close it is from.
  const read = alert.metric && !alert.lastCheckError && alert.lastCheckedPrice != null;
  return { ...alert, kind: alert.metric?.kind ?? "price", rule: alert.metric ? metricDescription(alert) : undefined, target: alert.exchange ? `${alert.symbol}:${alert.exchange}` : alert.symbol,
    ...(read ? { reading: metricReadingText(alert.metric!, { value: alert.lastCheckedPrice!, target: alert.lastCheckedTarget ?? alert.targetPrice }) } : {}),
    ...(read && alert.lastDailyClose ? { asOf: alert.lastDailyClose } : {}) };
}

function eventRow(rule: EventAlertRule, now: number, eventDate: string | null | undefined, check?: IvLevelCheck): AlertListRow {
  const scheduled = readScheduledRule(rule);
  if (!scheduled) {
    const status = rule.status === "active" && rule.triggeredAt ? "triggered" : rule.status;
    return { id: rule.id, kind: rule.kind, target: eventAlertTarget(rule), status, createdAt: rule.createdAt,
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
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

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
    // The number as stored, as before; an RRG quadrant has no one number, so it reads as words.
    lastCheckedPrice: row.kind === "rrg" ? row.reading : row.lastCheckedPrice,
    triggeredAt: row.triggeredAt,
    // Last, so the CSV columns before it keep their places.
    asOf: row.asOf,
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

/** Every form `alerts add` takes but a price alert's details, as a refusal ends. */
const ADD_FORMS = `Event alerts take ${EVENT_FORM} or a symbol with earnings (alerts add CRWV earnings --days 3); price alerts take a condition and a price (alerts add AAPL above 250).`;

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
  return `No release in the economic calendar matches "${query}"${country ? ` in ${country.split(",").join(", ")}` : ""}.`
    + `${renamed ? ` ${releaseRenameNote(renamed)}` : ""}${near} `
    + `${ADD_FORMS} gloom econ --country <code> lists the calendar.`;
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
  description: "List, add, and remove price, valuation, daily technical and relative strength alerts, alerts before earnings and any economic calendar release (CPI, FOMC, NBS PMI), and news, options flow and IV alerts",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    usage: [
      "alerts list",
      "alerts add <symbol> <above|below|crosses> <price>",
      "alerts add <symbol> <pe|ps|rsi(14)> <above|below> <level>",
      "alerts add <symbol> ma(50) crosses <above|below> ma(200)",
      "alerts add <symbol> closes <above|below> ma(200)",
      "alerts add <symbol>/<benchmark> <above|below|crosses> <ratio>",
      "alerts add <symbol> rrg <leading|weakening|lagging|improving> [--benchmark <symbol>]",
      "alerts add <symbol> earnings [--days <n> | results]",
      "alerts add <calendar event> [--country <code>] [--days <n>]",
      "alerts add [symbol] news <keyword>",
      "alerts add [symbol] flow [premium] [calls|puts] [sweeps|blocks]",
      "alerts add <symbol> <iv|rr> <above|below> <level>",
      "alerts add <OCC contract> iv spike <points>",
      "alerts delete <id>",
      "alerts rearm <id>",
    ],
    options: [
      EXCHANGE_OPTION,
      { flags: "--days <n>", description: `Days before the event the alert goes off, 1 to ${MAX_LEAD_DAYS} (default 1); earnings and calendar event alerts` },
      { flags: "--country <code>", description: "The country of a calendar event, as econ --country takes it (CN, US, DE); a code before the name does the same (alerts add CN PMI)" },
      { flags: "--benchmark <symbol>", description: "The listing an RRG alert is measured against; SPY by default, as in RRG" },
    ],
    examples: [
      "alerts",
      "alerts add AAPL above 250",
      "alerts add AAPL pe below 25",
      "alerts add AAPL ps above 8",
      'alerts add NVDA "rsi(14)" under 30',
      'alerts add SPY "ma(50)" crosses above "ma(200)"',
      'alerts add TSLA closes below "ma(200)"',
      "alerts add XLK/SPY above 0.25",
      "alerts add XLE rrg leading",
      "alerts add SMH rrg weakening --benchmark QQQ",
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
    const benchmarkFlag = rawArgs.some((arg) => arg === "--benchmark" || arg.startsWith("--benchmark="));
    const benchmarkValue = takeOption(args, "--benchmark");
    const benchmark = benchmarkFlag && benchmarkValue === undefined ? null : benchmarkValue;
    const action = args[0] ?? "list";
    const now = Date.now();
    const today = newYorkToday(new Date(now));
    const failWith = (error: unknown): never => ctx.fail(error instanceof Error ? error.message : String(error));

    const parseAdd = (): AlertAddRequest => {
      try {
        return parseAlertAddArgs(args.slice(1), days, exchangeOption, country, benchmark);
      } catch (error) {
        return failWith(error);
      }
    };
    const typedRequest = action === "add" ? parseAdd() : null;
    // XLK/SPY is first a listing written with a slash (BRK/B, EUR/USD); one that quotes nothing is the ratio of the two.
    const pairListing = typedRequest?.kind === "price" && PAIR_SHAPE.test(typedRequest.symbol)
      ? await withMarketData(ctx, (market) => requireQuotedListing(typedRequest.symbol, exchangeOption, market, PROBE, "alerts add")).catch((error: unknown) => {
        if (!(error instanceof ListingRefusal)) throw error;
        if (!notATickerSymbol(error.message)) return ctx.fail(error.message, error.details);
        return null;
      })
      : undefined;
    let request: AlertAddRequest | null = typedRequest;
    if (typedRequest?.kind === "price" && pairListing === null) {
      if (exchangeOption) ctx.fail("A ratio alert names each listing, such as alerts add XLK:NYSEARCA/SPY above 0.25, and takes no --exchange.");
      try {
        request = { kind: "metric", ...parseMetricAlert(`${typedRequest.symbol} ratio ${typedRequest.condition} ${typedRequest.price}`)! };
      } catch (error) {
        failWith(error);
      }
    }
    const research = request && isResearchRequest(request) ? request : null;
    const listedSymbol = (request?.kind === "price" || request?.kind === "metric") ? request.symbol
      : research && research.kind !== "iv_spike" ? research.symbol : null;
    // A price alert is kept for the listing `quote` prints for the symbol, and for no symbol that quotes nothing;
    // a news, flow or IV rule on a symbol follows that listing too, and only in the US, where their data is.
    const priced = pairListing ? pairListing : listedSymbol
      ? await withMarketData(ctx, async (market) => {
        const quoted = await requireQuotedListing(listedSymbol, exchangeOption, market, ctx, "alerts add");
        if (research) {
          const venue = quoted.listing.exchange || canonicalExchange(quoted.quote.listingExchangeName || quoted.quote.exchangeName);
          if (!isUsListingExchange(venue)) {
            const what = research.kind === "news" ? "News alerting" : research.kind === "flow" ? "Options flow" : "Options data";
            const { message, details } = await usListingsOnlyMessage(what, quoted.listing, market,
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
    // The measure as it reads now, from the same completed closes the alert is judged on.
    let metricReading: MetricReading | null = null;
    const benchmarkNotes: string[] = [];
    if (request?.kind === "metric" && priced) {
      const exchange = canonicalExchange(priced.listing.exchange || priced.quote.listingExchangeName || priced.quote.exchangeName);
      const typedMetric = request.metric;
      if (isRelativeMetric(typedMetric)) {
        // The benchmark is held to a listing that quotes, as the symbol is.
        const reference = await withMarketData(ctx, (market) => requireQuotedListing(benchmarkKey(typedMetric), null, market, ctx, "alerts add"));
        const benchmarkExchange = canonicalExchange(reference.listing.exchange || reference.quote.listingExchangeName || reference.quote.exchangeName);
        if (reference.listing.symbol === priced.listing.symbol && benchmarkExchange === exchange) {
          ctx.fail(`${typedMetric.kind === "rrg" ? "An RRG alert" : "A ratio alert"} compares two listings; ${priced.listing.symbol} is on both sides.`);
        }
        request.metric = { ...typedMetric, benchmark: reference.listing.symbol, ...(benchmarkExchange ? { benchmarkExchange } : {}) };
        // Never save a rule its own list would refuse to read back.
        if (!validMetricRule({ ...request, targetPrice: request.price })) ctx.fail(`${reference.listing.key} cannot be a benchmark: relative strength alerts compare two US listings.`);
        benchmarkNotes.push(...reference.notes);
      }
      const preview = { ...createAlert(priced.listing.symbol, request.condition, request.price, exchange), metric: request.metric };
      metricReading = await withMarketData(ctx, market => metricReadings(market.dataProvider, now)(preview)).catch(failWith);
      priced.listing.exchange = exchange;
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
    let read = [...priced?.notes ?? [], ...coinNote ? [coinNote] : [], ...benchmarkNotes];
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
      const { dates, warnings } = await listEventDates(events.rules, now, lookup);
      const rows = [
        ...alerts.map(priceRow),
        ...events.rules.map((rule) => eventRow(rule, now, dates.has(rule.id) ? dates.get(rule.id) : rule.eventDate, checks[rule.id])),
      ];
      const allWarnings = [...(alertsError ? [alertsError] : []), ...(events.error ? [events.error] : []), ...warnings];
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
          { key: "asOf", header: "As Of", optional: true },
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

      if (request?.kind === "price" || request?.kind === "metric") {
        const { condition, price } = request;
        const symbol = requireArg(priceListing?.key, ADD_USAGE, ctx);
        const alert: AlertRule = { ...createAlert(symbol, condition, price, priceListing?.exchange), ...(request.kind === "metric" ? { metric: request.metric } : {}) };
        // Its reading so far, which cannot fire it: only a close after arming can.
        if (alert.metric && metricReading) Object.assign(alert, readingFields(metricReading));
        await save({ alerts: [...alerts, alert] });
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert }, ...(read.length > 0 ? { warnings: read } : {}) }, {
          // The delivery, as docs/usage.md states it, before any full stop, which after the price would read as part of it (below 81.).
          text: (data) => `Added alert ${data.alert.id}: ${data.alert.metric ? `${metricDescription(data.alert)}${metricReading ? `, now ${readingWords(data.alert.metric, metricReading)}` : ""}` : `${symbol} ${condition} ${price}`} (${PRICE_DELIVERY}).${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      if (newResearchRule) {
        const rule = newResearchRule;
        const rules = requireEvents();
        const existing = rules.find((entry) => entry.kind === rule.kind && entry.target === rule.target && entry.value.toLowerCase() === rule.value.toLowerCase());
        if (existing) ctx.fail(`This alert already exists (ID ${existing.id}).`);
        if (rules.length >= MAX_EVENT_ALERTS) ctx.fail(`Keep at most ${MAX_EVENT_ALERTS} event alerts. Delete one with gloom alerts delete <id>.`);
        await save({ events: [...rules, rule] });
        const kind = research!.kind;
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert: rule }, ...(read.length > 0 ? { warnings: read } : {}) }, {
          text: (data) => `Added alert ${data.alert.id}: ${alertKindLabel(rule.kind)} ${researchAlertDescription(rule)} (${researchDelivery(kind)}).${dryRunNote(data.dryRun)}`,
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
          ? `An alert for ${name} results already exists (ID ${existing.id}).`
          : `An alert ${plural(scheduled.leadDays, "day")} before ${name} already exists (ID ${existing.id}).`);
        if (rules.length >= MAX_EVENT_ALERTS) ctx.fail(`Keep at most ${MAX_EVENT_ALERTS} event alerts. Delete one with gloom alerts delete <id>.`);
        await save({ events: [...rules, rule] });
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
        const isPrice = alerts.some((alert) => alert.id === id);
        const isEvent = !isPrice && events.rules.some((rule) => rule.id === id);
        if (!isPrice && !isEvent && alertsError) ctx.fail(alertsError);
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
        const id = requireArg(args[1], "Usage: gloom alerts rearm <id>", ctx);
        const isPrice = alerts.some((alert) => alert.id === id);
        const rule = isPrice ? null : events.rules.find((entry) => entry.id === id) ?? null;
        if (!isPrice && !rule && alertsError) ctx.fail(alertsError);
        if (isPrice) await save({ alerts: alerts.map((alert) => alert.id === id ? rearmAlert(alert) : alert) });
        if (rule) {
          // A scheduled alert alerts again for its coming event; any other event alert resumes.
          const next = readScheduledRule(rule) ? rearmScheduledAlert(rule)
            : rule.kind === "iv_level" && rule.triggeredAt ? rearmIvLevelAlert(rule)
            : rule.status === "paused" ? toggleEventAlert(rule) : rule;
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
      ctx.fail("Usage: gloom alerts list|add|delete|rearm");
    });
  },
};
