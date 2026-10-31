import { METRIC_CHOICES, benchmarkKey, metricWizardFields, parseMetricAlert } from "./metric-command";
import { firstDailyCheck, metricAvailabilityError, metricReadings } from "./metric-data";
import { alertLogRule } from "./alert-log";
import { closeBasis, isDailyMetric, isRelativeMetric, metricReadingText, metricTrigger, validMetricRule, type MetricReading } from "./metric-model";
import { canonicalExchange } from "../../../utils/exchanges";
import { startCatalystAlerts } from "./catalysts";
import { notTheCoinNote } from "../../../cli/commands/crypto-hints";
import { alertChangeEntry, createFiredAlertRecorder, firedAlertTime, quoteSourceWords } from "./fired-log";
import { checkIvLevelAlertsNow, startIvLevelAlerts } from "./iv-level";
import { logFailure } from "../../../utils/log-failure";
import { RESEARCH_FORM_KINDS, RESEARCH_LABELS, researchWizardFields, createResearchAlert } from "./research-builder";
import { newYorkToday } from "../earnings/board-model";
import { checkScheduledEventAlertsNow, startScheduledEventAlerts } from "./scheduled-check";
import { scheduledEventSources } from "./scheduled-sources";
import {
  eventDateUnavailableMessage,
  lookupScheduledDates,
  noUpcomingEventMessage,
  parseLeadDays,
  readScheduledRule,
  scheduledTargetKey,
} from "./scheduled";
import { isResearchAlertKind, MAX_LEAD_DAYS } from "./research-rules";
import { EVENT_ALERT_TEMPLATES, MAX_EVENT_ALERTS, createEventAlert, eventAlertStoreKey, readEventAlertStores, updateEventAlerts } from "./events";
import { formatMarketPrice } from "../../../market-data/market/format";
import { settleTypedListingKey } from "../../../tickers/listing-venues";
import { parseListingArg } from "../../../cli/listing-arg";
import { notATickerSymbol } from "../../../sources/provider-errors";
import type { Quote } from "../../../types/financials";
import type { GloomPlugin } from "../../../types/plugin";
import {
  createAlert,
  evaluateAlert,
  formatAlertDescription,
  sameLevelRule,
} from "./alert-engine";
import {
  parseAlertCommandValues,
  parseAlertShortcutValues,
} from "./command";
import { ALERTS_PLUGIN_ID, POLL_INTERVAL_MS, POLL_SECONDS_KEY } from "./constants";
import { alertHistoryLockNote, alertsHeadless } from "./headless";
import { alertsCliCommand } from "./cli";
import {
  createQuoteErrorMessage,
  farTargetMessage,
  quoteAlertFields,
  quoteErrorAlertFields,
  resolveAlertQuote,
} from "./quotes";
import {
  loadAlerts,
  saveAlerts,
} from "./storage";
import { createAlertQuoteStream, readStreamedAlertQuote, type AlertQuoteStream } from "./live";
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

/** BTC/USD, BRK/B and EUR/USD are one listing written with a slash, as `alerts add` reads them; XLK/SPY is not. */
function slashSpellsListing(symbol: string): boolean {
  try {
    return parseListingArg(symbol).key !== symbol.toUpperCase();
  } catch {
    // Intentional ignore: text the listing reader refuses is no pair to divide, so the quote's own error stands.
    return true;
  }
}

export const alertsPlugin: GloomPlugin = {
  id: ALERTS_PLUGIN_ID,
  name: "Alerts",
  version: "1.0.0",
  description: "Price, valuation, daily technical and event alerts",
  toggleable: true,
  cliCommands: [alertsCliCommand],

  setup(ctx) {
    const generation = ++pollGeneration;
    // Every alert the app fires is kept on this device, for History and `fn ALRT --tab history`.
    const recordFired = createFiredAlertRecorder(ctx.resume, logFailure("alerts.fired-log", "Record fired alert failed"));
    catalystAlertsStop?.();
    catalystAlertsStop = startCatalystAlerts(ctx);
    scheduledAlertsStop?.();
    scheduledAlertsStop = startScheduledEventAlerts(ctx, scheduledEventSources(ctx.marketData), Date.now, recordFired);
    ivLevelAlertsStop?.();
    ivLevelAlertsStop = startIvLevelAlerts(ctx, recordFired);
    const notifyTriggered = (alert: AlertRule, quote: Quote, firedAt: number) => {
      const price = quote.price;
      recordFired({
        kind: "price", ruleId: alert.id, rule: `${alert.exchange ? `${alert.symbol}:${alert.exchange}` : alert.symbol} ${alert.condition} ${alert.targetPrice}`,
        firedAt, value: price, ...(quote.currency ? { unit: quote.currency } : {}),
        quoteAt: firedAlertTime(quote.lastUpdated), source: quoteSourceWords(quote.dataSource),
        symbol: alert.symbol, ...(alert.exchange ? { exchange: alert.exchange } : {}),
      });
      ctx.notify({
        body: `${formatAlertDescription(alert)} triggered at ${price}`,
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

    // The last price each alert was judged on by the stream. `crosses` needs
    // it tick to tick, and writing it to the store on every tick would churn
    // the saved config.
    const streamedBaselines = new Map<string, number>();
    let lastStreamPersistAt = 0;
    const evaluateStreamed = () => {
      if (generation !== pollGeneration) return;
      const alerts = loadAlerts(ctx);
      const now = Date.now();
      let persist = false;
      let touched = false;
      for (const alert of alerts) {
        if (alert.metric || alert.status !== "active") continue;
        const quote = readStreamedAlertQuote(alert, undefined, now);
        if (!quote) continue;
        // A re-armed or new alert has no stored baseline: judge nothing on this
        // tick and store one at once, so `crosses` never compares against a
        // price from before the edit.
        const stored = alert.lastCheckedPrice;
        const previous = stored == null ? undefined : streamedBaselines.get(alert.id) ?? stored;
        if (stored == null) persist = true;
        if (evaluateAlert({ ...alert, lastCheckedPrice: previous }, quote.price)) {
          alert.status = "triggered";
          alert.triggeredAt = now;
          ctx.log.info("stream: TRIGGERED", { symbol: alert.symbol, price: quote.price });
          notifyTriggered(alert, quote, now);
          persist = true;
        }
        streamedBaselines.set(alert.id, quote.price);
        Object.assign(alert, quoteAlertFields(quote, now));
        touched = true;
      }
      if (!persist && !(touched && now - lastStreamPersistAt >= STREAM_PERSIST_MS)) return;
      lastStreamPersistAt = now;
      void saveAlerts(ctx, alerts, "price").catch(logFailure("alerts.stream", "Save streamed price alerts failed"));
      if (persist) alertStream?.sync();
    };
    alertStream?.dispose();
    alertStream = createAlertQuoteStream({ readAlerts: () => loadAlerts(ctx), onQuotes: evaluateStreamed });
    ctx.registerCommand({
      id: "set-alert",
      label: "Add Alert",
      description: "Create a price, valuation or daily technical alert",
      keywords: ["add", "set", "alert", "pe", "ps", "rsi", "moving average", "valuation", "price", "trigger", "notify", "alarm", "watch"],
      category: "data",
      shortcut: "SA",
      shortcutArg: {
        placeholder: "symbol condition price",
        kind: "ticker",
        parse: parseAlertShortcutValues,
      },
      wizardLayout: "form",
      wizard: [
        { key: "kind", label: "Kind", type: "select", defaultValue: "price", options: METRIC_CHOICES },
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
          type: "number",
        },
        ...metricWizardFields,
      ],
      async execute(values) {
        let input = parseAlertCommandValues(values);
        if (!input) throw new Error("Use a symbol, condition, and target price.");
        // 7203:TSE, typed or from a link, is the venue its symbol trades on, as `alerts add` reads it.
        const quoteFor = async (typed: string) => {
          const key = (await settleTypedListingKey(typed, { store: ctx.tickerRepository, dataProvider: ctx.marketData })).toUpperCase();
          return { key, quote: await resolveAlertQuote(ctx.marketData, key) };
        };
        let resolved: Awaited<ReturnType<typeof quoteFor>>;
        try {
          resolved = await quoteFor(input.symbol);
        } catch (error) {
          // XLK/SPY is a listing first; only one the service says is no ticker is the ratio of the two, as `alerts add` reads it.
          // A timeout stays a timeout, and BTC/USD, BRK/B or EUR/USD, one listing written with a slash, keeps its own answer.
          const pair = !input.metric && /^[^/\s]+\/[^/\s]+$/.test(input.symbol) && notATickerSymbol(error instanceof Error ? error.message : String(error))
            && !slashSpellsListing(input.symbol) ? parseMetricAlert(`${input.symbol} ratio ${input.condition} ${input.price}`) : null;
          if (!pair) throw error;
          input = pair;
          resolved = await quoteFor(pair.symbol);
        }
        const { key: symbol, quote } = resolved;
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
        // A target ten times away is a slip or another instrument's price, such as bitcoin's on the BTC fund.
        const far = farTargetMessage(symbol, input.price, quote.price, symbol.includes(":") ? null : notTheCoinNote(symbol, quote));
        if (!input.metric && far) throw new Error(far);

        const alert: AlertRule = {
          ...createAlert(quote.symbol || symbol, input.condition, input.price),
          ...(!metric ? quoteAlertFields(quote) : {
            metric, exchange: quote.listingExchangeName || quote.exchangeName,
            ...quote.currency ? { lastQuoteCurrency: quote.currency } : {},
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
            Object.assign(alert, { lastCheckedPrice: reading.value, lastCheckedTarget: reading.target, lastQuoteUpdatedAt: reading.at,
              lastCheckedAt: now, ...reading.day ? { lastDailyClose: reading.day } : {} });
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

        ctx.notify({
          body: `Alert set: ${formatAlertDescription(alert)}${input.metric ? firstCheck ? `, ${firstCheck}` : "" : ` (current ${formatMarketPrice(quote.price, { minimumFractionDigits: 2 })})`}`,
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
          defaultValue: "congress-watched",
          options: [...RESEARCH_FORM_KINDS.map((value) => ({ value, label: RESEARCH_LABELS[value] })), ...EVENT_ALERT_TEMPLATES.map((entry) => ({ label: entry.label, value: entry.id }))],
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
        // Earnings and macro events alert before a date: one has to be known, or the rule would never go off.
        const scheduled = event === "earnings_date" || event === "macro_event";
        const awaitsResults = event === "earnings_date" && values["earnings_date:when"] === "results";
        if (scheduled && !awaitsResults && parseLeadDays(values[`${event}:leadDays`]) == null)
          throw new Error(`Days before must be a whole number from 1 to ${MAX_LEAD_DAYS}.`);
        let rule = isResearchAlertKind(event) ? createResearchAlert(event, values) : createEventAlert(event, values?.[event] || "");
        const target = scheduled ? readScheduledRule(rule)?.target : null;
        if (target) {
          const lookup = (await lookupScheduledDates([target], scheduledEventSources(ctx.marketData), newYorkToday()))
            .get(scheduledTargetKey(target));
          if (!lookup || "error" in lookup) throw new Error(eventDateUnavailableMessage(target, lookup?.error ?? "no answer"));
          if (!lookup.date) throw new Error(noUpcomingEventMessage(target));
          rule = { ...rule, eventDate: lookup.date };
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
        ctx.notify({ body: "Event alert saved.", type: "success" });
        if (scheduled) checkScheduledEventAlertsNow();
        if (rule.kind === "iv_level") checkIvLevelAlertsNow();
      },
    });

    // The poll carries whatever the stream does not: symbols the feed has not
    // delivered lately, and every symbol while the app is hidden.
    const pollLevels = async (metrics: boolean) => {
      alertStream?.sync();
      const pending = loadAlerts(ctx).filter((alert) => Boolean(alert.metric) === metrics && alert.status === "active" && !readStreamedAlertQuote(alert));
      if (pending.length === 0) return;

      ctx.log.info("poll", { active: pending.length });

      // One batched pass over the distinct symbols: the alerts pane reads the same
      // persisted store, so this is the only place that talks to the provider.
      const quoteKeys = [...new Set(pending.filter(alert => !alert.metric).map((alert) => `${alert.symbol}\0${alert.exchange ?? ""}`))];
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
      const readings = new Map<string, { armedAt: number; reading: MetricReading | string }>();
      for (const alert of pending.filter(a => a.metric)) {
        try { readings.set(alert.id, { armedAt: alert.armedAt ?? alert.createdAt, reading: await readMetric(alert) }); }
        catch (error) { readings.set(alert.id, { armedAt: alert.armedAt ?? alert.createdAt, reading: error instanceof Error ? error.message : String(error) }); }
      }
      if (generation !== pollGeneration) return;
      const quotes = new Map<string, Quote | string>(results);

      // Read the store again: the stream or the pane may have changed an alert
      // while the quotes were in flight, and an alert must trigger only once.
      const alerts = loadAlerts(ctx).filter(alert => Boolean(alert.metric) === metrics);
      let changed = false;
      for (const alert of alerts) {
        if (alert.status !== "active") continue;
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
              const readingText = metricReadingText(alert.metric, reading);
              recordFired({ kind: alert.metric.kind, ruleId: alert.id, rule: description, firedAt, value: reading.value,
                unit: alert.metric.kind === "pe" || alert.metric.kind === "ps" ? "x" : undefined,
                // An RRG quadrant is two readings; the figure is strength, the detail says both.
                ...(alert.metric.kind === "rrg" ? { detail: readingText } : {}),
                quoteAt: firedAlertTime(reading.at), source: closeBasis(alert.metric),
                symbol: alert.symbol, exchange: alert.exchange });
              ctx.notify({ body: alert.metric.kind === "rrg" ? `${description} triggered: ${readingText}` : `${description} triggered at ${readingText}`, type: "success",
                refId: `price:${alert.id}`, desktop: "always", persistent: true, sound: "Glass",
                action: { label: "Open", onClick: () => ctx.showPane("alerts") } });
            }
            Object.assign(alert, { lastCheckedPrice: reading.value, lastCheckedTarget: reading.target,
              lastDailyClose: reading.day, lastQuoteUpdatedAt: reading.at, lastCheckedAt: Date.now(), lastCheckError: undefined });
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
        await saveAlerts(ctx, alerts, metrics ? "metric" : "price");
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

    void poll().catch(logFailure("alerts.poll", "Check price alerts failed")).finally(scheduleNextPoll);

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
