import { METRIC_CHOICES, benchmarkKey, metricWizardFields, namesTwoListings, parseMetricAlert } from "./metric-command";
import { firstDailyCheck, metricAvailabilityError, metricReadingFields, metricReadings } from "./metric-data";
import { alertLogRule } from "./alert-log";
import { closeBasis, isDailyMetric, isRelativeMetric, metricTrigger, validMetricRule } from "./metric-model";
import { canonicalExchange } from "../../../utils/exchanges";
import { startCatalystAlerts } from "./catalysts";
import { notTheCoinNote } from "../../../cli/commands/crypto-hints";
import { alertChangeEntry, createFiredAlertRecorder, firedAlertTime, quoteSourceWords } from "./fired-log";
import { checkIvLevelAlertsNow, startIvLevelAlerts } from "./iv-level";
import { logFailure } from "../../../utils/log-failure";
import { RESEARCH_FORM_KINDS, RESEARCH_LABELS, researchWizardFields, createResearchAlert } from "./research-builder";
import { checkedOnlyWithPro, checksProRules, savedWithoutProNote } from "./pro-rules";
import { OCC_CONTRACT, parseLooseOptionContract, resolveLooseOptionContract } from "./option-contract";
import { apiClient } from "../../../api-client";
import { newYorkToday } from "../earnings/board-model";
import { checkScheduledEventAlertsNow, startScheduledEventAlerts } from "./scheduled-check";
import { scheduledEventSources } from "./scheduled-sources";
import {
  earningsUsOnlyMessage,
  eventDateUnavailableMessage,
  lookupScheduledDates,
  noUpcomingEventMessage,
  parseLeadDays,
  readScheduledRule,
  scheduledTargetKey,
} from "./scheduled";
import { isResearchAlertKind, MAX_LEAD_DAYS } from "./research-rules";
import { EVENT_ALERT_TEMPLATES, MAX_EVENT_ALERTS, createEventAlert, eventAlertStoreKey, readEventAlertStores, updateEventAlerts } from "./events";
import { AlertListingRefusal, resolveAlertListing } from "../../../cli/alert-listing";
import { earningsListingVenue } from "./earnings-listing";
import { parseListingArg } from "../../../cli/listing-arg";
import { notATickerSymbol } from "../../../sources/provider-errors";
import type { Quote } from "../../../types/financials";
import type { GloomPlugin } from "../../../types/plugin";
import {
  createAlert,
  evaluateAlert,
  formatAlertDescription,
  levelAlreadyMet,
  sameLevelRule,
  tickTrigger,
} from "./alert-engine";
import {
  MOVE_KIND_CHOICE,
  moveWizardFields,
  parseAlertCommandValues,
  parseAlertShortcutValues,
  slashSpellsListing,
} from "./command";
import { ALERTS_PLUGIN_ID, POLL_INTERVAL_MS, POLL_SECONDS_KEY, PRICE_DELIVERY } from "./constants";
import { alertHistoryLockNote, alertsHeadless } from "./headless";
import { alertsCliCommand } from "./cli";
import {
  commodityFutureNote,
  createQuoteErrorMessage,
  farTargetMessage,
  levelInQuoteUnit,
  assertAlertCurrency,
  moveQuoteFields,
  printedBeforeLastCheck,
  quoteAlertFields,
  quoteErrorAlertFields,
  alertQuote,
  resolveAlertQuote,
  resolveAlertQuotes,
} from "./quotes";
import { MOVE_CHECKS_KEY, moveChecksOf, readMoveChecks, withMoveChecks } from "./move-checks";
import {
  loadAlerts,
  saveAlerts,
} from "./storage";
import { alertInstrument, alertQuoteAtTick, createAlertQuoteStream, readStreamedAlertQuote, type AlertQuoteStream } from "./live";
import { buildQuoteKey } from "../../../market-data/selectors";
import type { StreamTickRange } from "../../../market-data/quotes/tick-range";
import { isPenceQuotedLine, isSharePriceQuote } from "../../../market-data/market/format";
import { alertPriceText, alertPriceWithCurrency, alertQuoteTime } from "./price-text";
import { judgeMove, moveBasisText, moveFiredText, MOVE_DELIVERY } from "./move";
import { acceptsAlertSession, alertSessionField } from "./session";
import { MOVE_REARM, moveNowText, planMoveAlerts } from "./cli-move";
import { alertListing, formatMetricReading, readingSessionWords } from "./format";
import type { AlertRule } from "./types";

let catalystAlertsStop: (() => void) | null = null;
let scheduledAlertsStop: (() => void) | null = null;
let ivLevelAlertsStop: (() => void) | null = null;
let pollGeneration = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let alertStream: AlertQuoteStream | null = null;

/**
 * Streamed checks judge every tick in memory; the last-checked fields they
 * leave behind are written at most this often, or at once when an alert
 * triggers or first gets a baseline.
 */
const STREAM_PERSIST_MS = 60_000;

export const alertsPlugin: GloomPlugin = {
  id: ALERTS_PLUGIN_ID,
  name: "Alerts",
  version: "1.0.0",
  description: "Price, valuation, daily technical and event alerts",
  toggleable: true,
  cliCommands: [alertsCliCommand],

  setup(ctx) {
    const generation = ++pollGeneration;
    // A command (`gloom doctor`) loads the plugins and exits: an alert checked there would reach no one, and the
    // command could not save that it went off, so each run would fire it again. Only the app checks alerts.
    const checks = ctx.runtime !== "command";
    // Every alert the app fires is kept on this device, for History and `fn ALRT --tab history`.
    const recordFired = createFiredAlertRecorder(ctx.resume, logFailure("alerts.fired-log", "Record fired alert failed"));
    catalystAlertsStop?.();
    catalystAlertsStop = checks ? startCatalystAlerts(ctx) : null;
    scheduledAlertsStop?.();
    scheduledAlertsStop = checks ? startScheduledEventAlerts(ctx, scheduledEventSources(ctx.marketData), Date.now, recordFired) : null;
    ivLevelAlertsStop?.();
    ivLevelAlertsStop = checks ? startIvLevelAlerts(ctx, recordFired) : null;
    const notifyTriggered = (alert: AlertRule, quote: Quote, firedAt: number) => {
      const price = quote.price;
      // The price at the instrument's precision, as the quote that fired it says it (1.33702, 69.80p).
      const priced = { ...alert, ...quoteAlertFields(quote) };
      recordFired({
        // The rule as every other entry of the log names it: the listing once, the level at its precision and in its unit.
        kind: "price", ruleId: alert.id, rule: alertLogRule(priced).rule,
        firedAt, value: price, ...(quote.currency ? { unit: quote.currency } : {}),
        quoteAt: firedAlertTime(quote.lastUpdated), source: quoteSourceWords(quote.dataSource),
        symbol: alert.symbol, ...(alert.exchange ? { exchange: alert.exchange } : {}),
      });
      ctx.notify({
        body: `${formatAlertDescription(priced)} triggered at ${alertPriceText(priced, price)}`,
        type: "success",
        refId: `price:${alert.id}`,
        desktop: "always",
        persistent: true,
        sound: "Glass",
        action: {
          label: "Open",
          onClick: () => ctx.showPane("alerts"),
        },
      });
    };

    /**
     * A move rule judged on a quote, its fields updated in place: armed again in
     * a new session, and notified once when the move reaches it. Whether it went off.
     */
    const checkMove = (alert: AlertRule, quote: Quote, now: number): boolean => {
      const judged = judgeMove(alert, quote, now);
      Object.assign(alert, moveQuoteFields(quote, now), judged.alert);
      if (!judged.fired || !judged.reading) return false;
      const reading = judged.reading;
      const listing = alertListing({ symbol: alert.symbol, exchange: alert.exchange });
      const body = moveFiredText(listing, reading, alertPriceText(alert, quote.price), now);
      ctx.log.info("move: TRIGGERED", { symbol: alert.symbol, percent: reading.percent });
      recordFired({
        kind: "move", ruleId: alert.id, rule: formatAlertDescription(alert), firedAt: now, value: Number(reading.percent.toFixed(4)), unit: "%",
        detail: moveBasisText(reading.basis, now), quoteAt: firedAlertTime(quote.lastUpdated), source: quoteSourceWords(quote.dataSource),
        symbol: alert.symbol, ...(alert.exchange ? { exchange: alert.exchange } : {}),
      });
      ctx.notify({
        body, type: "success", refId: `price:${alert.id}`, desktop: "always", persistent: true, sound: "Glass",
        action: { label: "Open", onClick: () => ctx.showPane("alerts") },
      });
      return true;
    };

    // Move rules are judged with this device's readings of them, and their readings are kept here, never in the synced
    // list: five hundred rules checked every minute write nothing another device pulls.
    const loadJudgedAlerts = () => {
      const alerts = loadAlerts(ctx);
      return alerts.some((alert) => alert.move) ? withMoveChecks(alerts, readMoveChecks(ctx.resume.getState(MOVE_CHECKS_KEY))) : alerts;
    };
    const saveMoveChecks = (alerts: readonly AlertRule[]) => {
      if (!alerts.some((alert) => alert.move)) return;
      try {
        ctx.resume.setState(MOVE_CHECKS_KEY, moveChecksOf(alerts));
      } catch (failure) {
        ctx.log.warn("Move alert readings not kept", { error: String(failure) });
      }
    };

    /** The quote at a tick a frame folded in that sets a move rule off, when the newest quote does not. */
    const movedTick = (alert: AlertRule, quote: Quote, ticks: StreamTickRange, now: number): Quote | null => {
      if (judgeMove(alert, quote, now).fired) return null;
      const edges = alert.condition === "above" ? [ticks.high] : alert.condition === "below" ? [ticks.low] : [ticks.high, ticks.low];
      for (const tick of edges) {
        const atTick = alertQuoteAtTick(quote, tick, now);
        if (atTick && judgeMove(alert, atTick, now).fired) return atTick;
      }
      return null;
    };

    // The last price each alert was judged on by the stream, and the arming
    // it was judged in. `crosses` needs it tick to tick, and writing it to the
    // store on every tick would churn the saved config. An alert with one also
    // judges every tick its symbol's frames folded in since, so a tick that
    // crossed and came back counts.
    const streamedBaselines = new Map<string, { price: number; armedAt: number }>();
    const armingOf = (alert: AlertRule) => alert.armedAt ?? alert.createdAt;
    let lastStreamPersistAt = 0;
    const evaluateStreamed = () => {
      if (generation !== pollGeneration) return;
      const tickRanges = alertStream?.takeTicks() ?? new Map<string, StreamTickRange>();
      const alerts = loadJudgedAlerts();
      const now = Date.now();
      let persist = false;
      let touched = false;
      let movesTouched = false;
      for (const alert of alerts) {
        if (alert.metric || (alert.status !== "active" && !alert.move)) continue;
        const latest = readStreamedAlertQuote(alert, undefined, now);
        if (!latest) continue;
        const range = tickRanges.get(buildQuoteKey(alertInstrument(alert)));
        const regular = range?.regular?.latest;
        const quote = acceptsAlertSession(alert, latest) ? latest : regular && (!regular.lastUpdated || regular.lastUpdated >= armingOf(alert))
          ? alertQuoteAtTick({ ...latest, marketState: "REGULAR", overnightPrice: undefined }, regular, now) : null;
        // A quote older than the one the alert was last checked on is no news of its price.
        if (!quote || !acceptsAlertSession(alert, quote) || printedBeforeLastCheck(alert, quote)) continue;
        // A new or edited alert's first check judges its quote alone: earlier ticks may be from before it. An edited
        // move rule is one too, though this device's reading of it (a poll's since the edit) comes back with it.
        const baseline = streamedBaselines.get(alert.id);
        const sameArming = baseline?.armedAt === armingOf(alert);
        const ticks = alert.lastCheckedPrice != null && sameArming ? (alert.regularHoursOnly ? range?.regular : range) : undefined;
        if (alert.move) {
          const status = alert.status;
          const atTick = ticks ? movedTick(alert, quote, ticks, now) : null;
          // Gone off at the tick, the rule still keeps the newest quote's reading.
          const firedAtTick = atTick ? checkMove(alert, atTick, now) : false;
          if (checkMove(alert, quote, now) || firedAtTick || alert.status !== status) persist = true;
          streamedBaselines.set(alert.id, { price: quote.price, armedAt: armingOf(alert) });
          touched = true;
          movesTouched = true;
          continue;
        }
        // A re-armed or new alert has no stored baseline: judge nothing on this
        // tick and store one at once, so `crosses` never compares against a
        // price from before the edit.
        const stored = alert.lastCheckedPrice;
        const previous = stored == null ? undefined : sameArming ? baseline!.price : stored;
        if (stored == null) persist = true;
        const judged = { ...alert, lastCheckedPrice: previous };
        const firesNow = evaluateAlert(judged, quote.price);
        const tick = ticks && !firesNow ? tickTrigger(judged, ticks) : null;
        // Noted at the price that crossed: the newest, or a tick that came back before its frame.
        const firedOn = firesNow ? quote : tick ? alertQuoteAtTick(quote, tick, now) : null;
        if (firedOn) {
          alert.status = "triggered";
          alert.triggeredAt = now;
          ctx.log.info("stream: TRIGGERED", { symbol: alert.symbol, price: firedOn.price });
          notifyTriggered(alert, firedOn, now);
          persist = true;
        }
        streamedBaselines.set(alert.id, { price: quote.price, armedAt: armingOf(alert) });
        Object.assign(alert, quoteAlertFields(quote, now));
        touched = true;
      }
      if (!persist && !(touched && now - lastStreamPersistAt >= STREAM_PERSIST_MS)) return;
      lastStreamPersistAt = now;
      if (movesTouched) saveMoveChecks(alerts);
      void saveAlerts(ctx, alerts, "price").catch(logFailure("alerts.stream", "Save streamed price alerts failed"));
      if (persist) alertStream?.sync();
    };
    alertStream?.dispose();
    // Followed as judged: a move rule set by symbol alone learns its listing from this device's reading of it.
    alertStream = checks ? createAlertQuoteStream({ readAlerts: loadJudgedAlerts, onQuotes: evaluateStreamed }) : null;
    ctx.registerCommand({
      id: "set-alert",
      label: "Add Alert",
      description: "Create a price, move, valuation or daily technical alert",
      keywords: ["add", "set", "alert", "move", "previous close", "pe", "ps", "rsi", "moving average", "valuation", "price", "trigger", "notify", "alarm", "watch"],
      category: "data",
      shortcut: "SA",
      shortcutArg: {
        placeholder: "symbol condition price",
        kind: "ticker",
        parse: parseAlertShortcutValues,
      },
      wizardLayout: "form",
      wizard: [
        // A move from the previous close sits beside a price level: both are checked on the listing's quotes.
        { key: "kind", label: "Kind", type: "select", defaultValue: "price", options: [METRIC_CHOICES[0]!, MOVE_KIND_CHOICE, ...METRIC_CHOICES.slice(1)] },
        {
          key: "symbol",
          label: "Symbol",
          placeholder: "AAPL",
          type: "text",
        },
        {
          dependsOn: { key: "kind", value: "price" },
          key: "condition",
          label: "Condition",
          type: "select",
          options: [
            { label: "Above", value: "above" },
            { label: "Below", value: "below" },
            { label: "Crosses", value: "crosses" },
          ],
        },
        {
          dependsOn: { key: "kind", value: "price" },
          key: "price",
          label: "Target Price",
          placeholder: "200.00",
          type: "text",
        },
        alertSessionField("price"),
        ...moveWizardFields,
        alertSessionField("move"),
        ...metricWizardFields,
      ],
      async execute(values) {
        let input = parseAlertCommandValues(values);
        if (!input) throw new Error("Use a symbol, condition, and target price.");
        // Read as `alerts add` and `quote` read it (`resolveAlertListing`): 7203:TSE is the venue its symbol trades on,
        // "Singtel" is Z74:SGX, a listing that stopped trading is refused, and FB says Meta trades as META.
        const notes: string[] = [];
        const quoteFor = async (typed: string) => {
          const found = await resolveAlertListing(typed, null, { store: ctx.tickerRepository, dataProvider: ctx.marketData })
            .catch((error: unknown) => {
              if (error instanceof AlertListingRefusal) throw new Error(error.details ? `${error.message} ${error.details}` : error.message);
              throw error;
            });
          notes.push(...found.notes);
          const key = found.listing.key.toUpperCase();
          return { key, exchange: found.listing.exchange, quote: alertQuote(found.quote, key) };
        };
        // META:NASDAQ/GOOGL, with a venue before the slash, is no listing: the ratio of two, as `alerts add` reads it.
        if (!input.metric && !input.move && namesTwoListings(input.symbol)) {
          input = parseMetricAlert(`${input.symbol} ratio ${input.condition} ${input.price}`)!;
        }
        let resolved: Awaited<ReturnType<typeof quoteFor>>;
        try {
          resolved = await quoteFor(input.symbol);
        } catch (error) {
          // XLK/SPY is a listing first; only one the service says is no ticker is the ratio of the two, as `alerts add` reads it.
          // A timeout stays a timeout, and BTC/USD, BRK/B or EUR/USD, one listing written with a slash, keeps its own answer.
          const pair = !input.metric && !input.move && /^[^/\s]+\/[^/\s]+$/.test(input.symbol) && notATickerSymbol(error instanceof Error ? error.message : String(error))
            && !slashSpellsListing(input.symbol) ? parseMetricAlert(`${input.symbol} ratio ${input.condition} ${input.price}`) : null;
          if (!pair) throw error;
          input = pair;
          resolved = await quoteFor(pair.symbol);
        }
        const { key: symbol, quote } = resolved;
        // A move from the previous close is made as `alerts add` makes one: its first reading is the quote it was read on.
        if (input.move) {
          const now = Date.now();
          const exchange = resolved.exchange ? canonicalExchange(resolved.exchange) : canonicalExchange(quote.listingExchangeName || quote.exchangeName);
          const saved = loadJudgedAlerts();
          const plan = planMoveAlerts({ kind: "move", symbols: [input.symbol], condition: input.condition, percent: input.price,
            ...input.regularHoursOnly ? { regularHoursOnly: true } : {} },
            [{ input: input.symbol, listing: { symbol, ...exchange ? { exchange } : {} }, quote }], saved, now);
          const existing = plan.existing[0]?.alert;
          if (existing) {
            throw new Error(`${formatAlertDescription(existing)} already exists (alert ${existing.id})${existing.status === "triggered"
              ? "; it went off this session and arms again in the next" : ""}. Nothing was added.`);
          }
          const alert = plan.added[0];
          if (!alert) throw new Error(plan.failed[0]?.error ?? "No move alert was added.");
          const alerts = [...saved, alert];
          await saveAlerts(ctx, alerts, "price");
          // Its readings stay on this device, beside the rules, as the checks keep them.
          saveMoveChecks(alerts);
          recordFired(alertChangeEntry("created", alertLogRule(alert)));
          alertStream?.sync();
          const reading = moveNowText(alert, now);
          ctx.notify({
            body: [`Alert set: ${formatAlertDescription(alert)} (${MOVE_REARM})${reading ? `, ${reading}` : ""}.`, MOVE_DELIVERY,
              ...notes.map((note) => /[.?!]$/.test(note) ? note : `${note}.`)].join(" "),
            type: "success",
          });
          return;
        }
        let metric = input.metric;
        if (metric && isRelativeMetric(metric)) {
          const reference = (await quoteFor(benchmarkKey(metric))).quote;
          const benchmarkExchange = canonicalExchange(reference.listingExchangeName || reference.exchangeName || "");
          const exchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName || "");
          const benchmark = reference.symbol || metric.benchmark;
          if (benchmark === (quote.symbol || symbol) && benchmarkExchange === exchange) throw new Error(`Compare ${benchmark} with another listing.`);
          metric = { ...metric, benchmark, ...(benchmarkExchange ? { benchmarkExchange } : {}) };
          // Never save a rule its own list would refuse to read back.
          if (!validMetricRule({ metric, condition: input.condition, targetPrice: input.price })) throw new Error(`${benchmark} cannot be a benchmark: relative strength alerts compare two US listings.`);
        }
        // A London line's level is in the pence its quote shows: 70p, or 70 where 70 in pounds is far off.
        if (!input.metric) {
          await assertAlertCurrency(input, quote, symbol, ctx.marketData);
          input = { ...input, price: levelInQuoteUnit(input, quote, symbol).price };
        }
        // A target ten times away is a slip or another instrument's price, such as bitcoin's on the BTC fund.
        // GOLD is Gold.com: a target at gold's price names the future, as `alerts add` does.
        const named = input.symbol.includes(":");
        const far = farTargetMessage(symbol, input.price, quote.price, named ? null : notTheCoinNote(input.symbol.toUpperCase(), quote) ?? commodityFutureNote(input.symbol, quote), isPenceQuotedLine(quote));
        if (!input.metric && far) throw new Error(far);

        const eligible = acceptsAlertSession(input, quote);
        const alert: AlertRule = {
          ...createAlert(quote.symbol || symbol, input.condition, input.price),
          ...input.regularHoursOnly ? { regularHoursOnly: true } : {},
          ...(!metric && eligible ? quoteAlertFields(quote) : {
            ...(metric ? { metric } : {}), exchange: quote.listingExchangeName || quote.exchangeName,
            ...quote.currency ? { lastQuoteCurrency: quote.currency } : {},
            ...(!metric && isPenceQuotedLine(quote) ? { lastQuotePence: true } : {}),
          }),
        };
        // A close not yet final is read once it is: the rule is kept and says when it is first judged.
        let firstCheck: string | null = null;
        if (metric) {
          const now = Date.now();
          if (isDailyMetric(metric)) {
            const check = firstDailyCheck(alert.exchange, now, metric.kind === "rrg");
            if (check) firstCheck = `first checked on the ${check.day} ${closeBasis(metric) === "weekly close" ? "weekly close" : "close"}, from ${new Date(check.at).toISOString().slice(11, 16)} UTC`;
          }
          try {
            const reading = await metricReadings(ctx.marketData, now)(alert);
            Object.assign(alert, metricReadingFields(reading, now));
          } catch (error) {
            if (!isDailyMetric(metric) || metricAvailabilityError(alert)) throw error;
          }
        }
        const existing = loadAlerts(ctx);
        // The same rule on the same listing is one alert: adding it again names it and adds nothing.
        const duplicate = existing.find((entry) => sameLevelRule(entry, alert));
        if (duplicate) throw new Error(`${formatAlertDescription(alert)} already exists (alert ${duplicate.id}). Nothing was added.`);
        existing.push(alert);
        await saveAlerts(ctx, existing, input.metric ? "metric" : "price");
        recordFired(alertChangeEntry("created", alertLogRule(alert)));
        alertStream?.sync();

        // A level the price is already past goes off at the next check, as `alerts add` says.
        const met = eligible && !input.metric && levelAlreadyMet(alert.condition, quote.price, alert.targetPrice)
          ? `, already ${alert.condition}, so it goes off at the next check` : "";
        // What delivers it and what became of the symbol, as `alerts add` says them.
        ctx.notify({
          body: [
            `Alert set: ${formatAlertDescription(alert)}${input.metric ? firstCheck ? `, ${firstCheck}` : "" : eligible ? `${isSharePriceQuote(quote) ? " per share" : ""} (current ${alertPriceWithCurrency(alert, quote.price)}${readingSessionWords(alert)} · ${alertQuoteTime(alert.lastQuoteUpdatedAt)}${met})` : " (waiting for a regular-hours quote)"}.`,
            `${PRICE_DELIVERY.charAt(0).toUpperCase()}${PRICE_DELIVERY.slice(1)}.`,
            ...notes.map((note) => /[.?!]$/.test(note) ? note : `${note}.`),
          ].join(" "),
          type: "success",
        });
      },
    });

    ctx.registerCommand({
      id: "set-event-alert",
      label: "Add Event Alert",
      description: "Create an alert before earnings, CPI or FOMC, when earnings results are out, or for filings, news, IPOs, IV levels, hiring and market moves",
      keywords: [
        "alert", "event", "congress", "13f", "fund", "member", "follow", "earnings", "cpi", "fomc", "days before",
        "filing", "filings", "sec", "8-k", "news", "keyword", "analyst", "52-week", "unusual volume", "volume",
        "short interest", "insider", "catalyst", "implied volatility", "iv spike", "iv level", "risk reversal", "skew", "options flow", "perps", "funding", "hiring", "jobs",
        "ipo", "going public", "listing",
      ],
      category: "data",
      wizardLayout: "form",
      wizard: [
        {
          key: "event",
          label: "Event",
          type: "select",
          // Earnings first, as the command describes itself: an alert anyone can add for any US listing.
          defaultValue: "earnings_date",
          options: [...RESEARCH_FORM_KINDS.map((value) => ({ value, label: checkedOnlyWithPro({ kind: value }) ? `${RESEARCH_LABELS[value]} (Pro)` : RESEARCH_LABELS[value] })),
            ...EVENT_ALERT_TEMPLATES.map(({ id, kind, label }) => ({ value: id, label: checkedOnlyWithPro({ kind }) ? `${label} (Pro)` : label }))],
        },
        ...EVENT_ALERT_TEMPLATES.filter((entry) => entry.field != null).map((entry) => ({
          key: entry.id,
          label: entry.field!,
          placeholder: entry.placeholder,
          type: "text" as const,
          required: true,
          dependsOn: { key: "event", value: entry.id },
        })),
        ...researchWizardFields,
      ],
      async execute(values = {}) {
        const event = values?.event || "congress-watched";
        const readAll = () => readEventAlertStores((key) => ctx.configState.get<string>(key));
        const initial = readAll();
        if (initial.error) throw new Error(initial.error);
        if (initial.rules.length >= MAX_EVENT_ALERTS)
          throw new Error("Keep at most 40 event alerts.");
        const scheduled = event === "earnings_date" || event === "macro_event";
        const awaitsResults = event === "earnings_date" && values["earnings_date:when"] === "results";
        if (scheduled && !awaitsResults && parseLeadDays(values[`${event}:leadDays`]) == null)
          throw new Error(`Days before must be a whole number from 1 to ${MAX_LEAD_DAYS}.`);
        // A bare symbol is read as every alert reads it: D05 is on SGX, which earnings alerts do not follow, as `alerts add` says.
        const earningsSymbol = event === "earnings_date" ? String(values["earnings_date:symbol"] ?? "").trim() : "";
        if (earningsSymbol && (values["earnings_date:exchange"] ?? "US") === "US" && !parseListingArg(earningsSymbol).exchange) {
          const abroad = await earningsListingVenue(earningsSymbol, { store: ctx.tickerRepository, dataProvider: ctx.marketData }).catch((error: unknown) => {
            if (error instanceof AlertListingRefusal) throw new Error(error.details ? `${error.message} ${error.details}` : error.message);
            throw error;
          });
          if (abroad.exchange) throw new Error(earningsUsOnlyMessage(`${abroad.symbol}:${abroad.exchange}`));
        }
        // A contract typed loosely (`SPY 680C 11/19`) is the one listed contract it names, as `alerts add` reads it.
        const typedContract = event === "iv_spike" ? String(values["iv_spike:contract"] ?? "").trim() : "";
        const looseContract = typedContract && !OCC_CONTRACT.test(typedContract) ? parseLooseOptionContract(typedContract) : null;
        const notes: string[] = [];
        if (looseContract) {
          const getChain = ctx.marketData.getOptionsChain?.bind(ctx.marketData);
          if (!getChain) throw new Error(`Option chains cannot be read here to find ${typedContract}.`);
          const resolved = await resolveLooseOptionContract(typedContract, looseContract, (expiration) => getChain(looseContract.root, "", expiration), Date.now());
          values = { ...values, "iv_spike:contract": resolved.contract };
          if (resolved.readAs) notes.push(resolved.readAs);
        }
        let rule = isResearchAlertKind(event) ? createResearchAlert(event, values) : createEventAlert(event, values?.[event] || "");
        const target = scheduled ? readScheduledRule(rule)?.target : null;
        if (target) {
          const lookup = (await lookupScheduledDates([target], scheduledEventSources(ctx.marketData), newYorkToday()))
            .get(scheduledTargetKey(target));
          if (!lookup || "error" in lookup) throw new Error(eventDateUnavailableMessage(target, lookup?.error ?? "no answer"));
          if (lookup.date) rule = { ...rule, eventDate: lookup.date };
          else if (target.kind === "earnings") notes.push("Waiting for the next earnings date to be published.");
          else throw new Error(noUpcomingEventMessage(target));
        }
        // Read again: the lookup took a while and the rules may have changed meanwhile.
        const result = scheduled ? readAll() : initial;
        if (result.error) throw new Error(result.error);
        if (
          result.rules.some(
            (existing) =>
              existing.kind === rule.kind &&
              existing.target === rule.target &&
              existing.value.toLowerCase() === rule.value.toLowerCase(),
          )
        )
          throw new Error("This event is already followed.");
        // An IV level goes in its own list, which released versions never read.
        const key = eventAlertStoreKey(rule);
        await ctx.configState.set(key, updateEventAlerts(ctx.configState.get<string>(key), (rules) => [...rules, rule]));
        recordFired(alertChangeEntry("created", alertLogRule(rule)));
        // Saved without Pro, a Pro rule waits on it, as its form said and its row reads (Needs Pro).
        const signedIn = !!apiClient.getSessionToken() || !!apiClient.getCurrentUser();
        const waitsOnPro = checkedOnlyWithPro(rule) && !checksProRules(signedIn, apiClient.getCurrentUser());
        ctx.notify({ body: [`Event alert saved.${waitsOnPro ? savedWithoutProNote(rule) : ""}`, ...notes].join(" "), type: "success" });
        if (scheduled) checkScheduledEventAlertsNow();
        if (rule.kind === "iv_level") checkIvLevelAlertsNow();
      },
    });

    // The poll carries whatever the stream does not: symbols the feed has not
    // delivered lately, and every symbol while the app is hidden.
    const pollLevels = async (metrics: boolean) => {
      alertStream?.sync();
      // A move rule that went off is asked for too: the next session's quote arms it again.
      const pending = loadJudgedAlerts().filter((alert) => Boolean(alert.metric) === metrics && (alert.status === "active" || alert.move) && !readStreamedAlertQuote(alert));
      if (pending.length === 0) return;

      ctx.log.info("poll", { active: pending.length });

      // One batched pass over the distinct symbols: the alerts pane reads the same
      // persisted store, so this is the only place that talks to the provider.
      const keyOf = (alert: AlertRule) => `${alert.symbol}\0${alert.exchange ?? ""}`;
      // Move rules, up to five hundred from one bulk add, are asked a hundred listings to a request.
      const moveKeys = [...new Set(pending.filter((alert) => alert.move).map(keyOf))];
      const quoteKeys = [...new Set(pending.filter(alert => !alert.metric && !alert.move).map(keyOf))].filter((key) => !moveKeys.includes(key));
      const moveQuotes = moveKeys.length === 0 ? [] : await resolveAlertQuotes(ctx.marketData, moveKeys.map((key) => {
        const [symbol = "", exchange = ""] = key.split("\0");
        return { symbol, exchange };
      }));
      const results = await Promise.all(quoteKeys.map(async (key): Promise<[string, Quote | string]> => {
        const [symbol, exchange = ""] = key.split("\0");
        try {
          return [key, await resolveAlertQuote(ctx.marketData, symbol ?? "", exchange)];
        } catch (err) {
          ctx.log.warn("poll: no quote", { symbol, exchange, error: String(err) });
          return [key, createQuoteErrorMessage(symbol ?? "", err)];
        }
      }));
      const readMetric = metricReadings(ctx.marketData);
      const readings = new Map<string, { armedAt: number; reading: Awaited<ReturnType<typeof readMetric>> | string }>();
      for (const alert of pending.filter(a => a.metric)) {
        try { readings.set(alert.id, { armedAt: alert.armedAt ?? alert.createdAt, reading: await readMetric(alert) }); }
        catch (error) { readings.set(alert.id, { armedAt: alert.armedAt ?? alert.createdAt, reading: error instanceof Error ? error.message : String(error) }); }
      }
      if (generation !== pollGeneration) return;
      const quotes = new Map<string, Quote | string>([...results, ...moveKeys.map((key, index) => [key, moveQuotes[index]!] as [string, Quote | string])]);

      // Read the store again: the stream or the pane may have changed an alert
      // while the quotes were in flight, and an alert must trigger only once.
      const alerts = loadJudgedAlerts().filter(alert => Boolean(alert.metric) === metrics);
      let changed = false;
      for (const alert of alerts) {
        if (alert.status !== "active" && !alert.move) continue;
        if (alert.metric) {
          const result = readings.get(alert.id);
          if (!result || result.armedAt !== (alert.armedAt ?? alert.createdAt)) continue;
          const reading = result.reading;
          if (typeof reading !== "string" && reading.day && reading.day === alert.lastDailyClose && !alert.lastCheckError) continue;
          if (typeof reading === "string" && reading === alert.lastCheckError) continue;
          if (typeof reading === "string") Object.assign(alert, quoteErrorAlertFields(reading));
          else {
            if (metricTrigger(alert, reading)) {
              const firedAt = Date.now();
              alert.status = "triggered"; alert.triggeredAt = firedAt;
              const description = formatAlertDescription(alert);
              const readingText = formatMetricReading(alert.metric, reading);
              recordFired({ kind: alert.metric.kind, ruleId: alert.id, rule: description, firedAt, value: reading.value,
                unit: alert.metric.kind === "pe" || alert.metric.kind === "ps" ? "x" : undefined,
                // An RRG quadrant is two readings; the figure is strength, the detail says both.
                ...(alert.metric.kind === "rrg" ? { detail: readingText } : {}),
                quoteAt: firedAlertTime(reading.at), source: closeBasis(alert.metric) ?? quoteSourceWords(reading.quoteSource),
                symbol: alert.symbol, exchange: alert.exchange });
              ctx.notify({ body: alert.metric.kind === "rrg" ? `${description} triggered: ${readingText}` : `${description} triggered at ${readingText}`, type: "success",
                refId: `price:${alert.id}`, desktop: "always", persistent: true, sound: "Glass",
                action: { label: "Open", onClick: () => ctx.showPane("alerts") } });
            }
            Object.assign(alert, metricReadingFields(reading, Date.now()));
          }
          changed = true;
          continue;
        }
        if (readStreamedAlertQuote(alert)) continue;
        const quote = quotes.get(`${alert.symbol}\0${alert.exchange ?? ""}`);
        if (quote === undefined) continue;
        if (typeof quote === "string") {
          Object.assign(alert, quoteErrorAlertFields(quote));
          changed = true;
          continue;
        }
        // A cached quote older than the alert's last check (one read before the app last closed) is left alone:
        // judged, it would set the alert off at a price already gone, or wind its baseline back.
        if (!acceptsAlertSession(alert, quote) || printedBeforeLastCheck(alert, quote)) continue;

        if (alert.move) {
          checkMove(alert, quote, Date.now());
          changed = true;
          continue;
        }
        if (evaluateAlert(alert, quote.price)) {
          alert.status = "triggered";
          alert.triggeredAt = Date.now();
          ctx.log.info("poll: TRIGGERED", { symbol: alert.symbol, price: quote.price });
          notifyTriggered(alert, quote, alert.triggeredAt);
        }
        streamedBaselines.delete(alert.id);
        Object.assign(alert, quoteAlertFields(quote));
        changed = true;
      }

      if (changed) {
        if (!metrics) saveMoveChecks(alerts);
        await saveAlerts(ctx, alerts, metrics ? "metric" : "price");
        // A rule set by symbol alone now knows the listing its quotes stream on.
        if (!metrics) alertStream?.sync();
      }
    };

    // Metric work may span a poll, but cannot delay the next price check or overlap itself.
    let metricPoll: Promise<void> | null = null;
    const poll = () => {
      metricPoll ??= pollLevels(true).catch(logFailure("alerts.metrics", "Check metric alerts failed")).finally(() => { metricPoll = null; });
      return pollLevels(false);
    };

    // Re-armed each cycle so a change to the pane's Check interval setting takes
    // effect on the next tick without a restart.
    const scheduleNextPoll = () => {
      if (generation !== pollGeneration) return;
      const seconds = Number(ctx.paneSettings?.get<string>("alerts", POLL_SECONDS_KEY));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : POLL_INTERVAL_MS;
      pollTimer = setTimeout(() => {
        void poll().catch(logFailure("alerts.poll", "Check price alerts failed")).finally(scheduleNextPoll);
      }, delay);
    };

    if (checks) void poll().catch(logFailure("alerts.poll", "Check price alerts failed")).finally(scheduleNextPoll);

    ctx.registerPane({
      id: "alerts",
      reportFreshness: { source: "Your alerts", status: "not-a-feed", basis: "your alert rules" },
      reportLockNote: alertHistoryLockNote,
      name: "Alerts",
      icon: "A",
      get component(): typeof import("./pane").AlertsPane { const { AlertsPane } = require("./pane"); return AlertsPane; },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 82, height: 20 },
      settings: {
        title: "Alerts Settings",
        fields: [
          {
            key: POLL_SECONDS_KEY,
            label: "Check interval",
            description: "How often active alerts are re-quoted.",
            type: "select",
            options: [
              { value: "15", label: "15 seconds" },
              { value: "30", label: "30 seconds" },
              { value: "60", label: "1 minute" },
              { value: "300", label: "5 minutes" },
            ],
          },
        ],
      },
    });

    ctx.registerPaneTemplate({
      id: "alerts-pane",
      paneId: "alerts",
      label: "Alerts",
      description: "Price, valuation, daily technical and event alerts",
      keywords: [
        "alerts", "alert", "price", "valuation", "pe", "ps", "rsi", "moving average", "trigger", "alarm", "watch", "notify", "notification",
        "earnings", "cpi", "fomc", "filing", "filings", "sec", "8-k", "13f", "news", "keyword",
        "analyst", "upgrade", "downgrade", "52-week", "unusual volume", "volume", "short interest",
        "insider", "congress", "catalyst", "implied volatility", "iv spike", "options flow", "perps", "funding",
      ],
      shortcut: { prefix: "ALRT" },
      headless: alertsHeadless,
    });
  },

  dispose() {
    catalystAlertsStop?.();
    catalystAlertsStop = null;
    scheduledAlertsStop?.();
    scheduledAlertsStop = null;
    ivLevelAlertsStop?.();
    ivLevelAlertsStop = null;
    pollGeneration += 1;
    alertStream?.dispose();
    alertStream = null;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  },
};
