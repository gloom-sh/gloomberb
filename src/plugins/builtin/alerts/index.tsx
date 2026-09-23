import { RESEARCH_LABELS, researchWizardFields, createResearchAlert } from "./research-builder";
import { isResearchAlertKind } from "./research-rules";
import { EVENT_ALERTS_KEY, EVENT_ALERT_TEMPLATES, MAX_EVENT_ALERTS, createEventAlert, readEventAlerts } from "./events";
import { formatMarketPrice } from "../../../market-data/market/format";
import type { Quote } from "../../../types/financials";
import type { GloomPlugin } from "../../../types/plugin";
import {
  createAlert,
  evaluateAlert,
  formatAlertDescription,
} from "./alert-engine";
import {
  parseAlertCommandValues,
  parseAlertShortcutValues,
} from "./command";
import { POLL_INTERVAL_MS, POLL_SECONDS_KEY } from "./constants";
import { AlertsPane } from "./pane";
import {
  createQuoteErrorMessage,
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
  id: "alerts",
  name: "Alerts",
  version: "1.0.0",
  description: "Price, market and filing event alerts",
  toggleable: true,

  setup(ctx) {
    const generation = ++pollGeneration;
    const notifyTriggered = (alert: AlertRule, price: number) => {
      ctx.notify({
        body: `${formatAlertDescription(alert)} triggered at ${price}`,
        type: "success",
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
        if (alert.status !== "active") continue;
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
          notifyTriggered(alert, quote.price);
          persist = true;
        }
        streamedBaselines.set(alert.id, quote.price);
        Object.assign(alert, quoteAlertFields(quote, now));
        touched = true;
      }
      if (!persist && !(touched && now - lastStreamPersistAt >= STREAM_PERSIST_MS)) return;
      lastStreamPersistAt = now;
      saveAlerts(ctx, alerts);
      if (persist) alertStream?.sync();
    };
    alertStream?.dispose();
    alertStream = createAlertQuoteStream({ readAlerts: () => loadAlerts(ctx), onQuotes: evaluateStreamed });
    ctx.registerCommand({
      id: "set-alert",
      label: "Add Alert",
      description: "Create a price alert from a symbol, condition, and target price",
      keywords: ["add", "set", "alert", "price", "trigger", "notify", "alarm", "watch"],
      category: "data",
      shortcut: "SA",
      shortcutArg: {
        placeholder: "symbol condition price",
        kind: "ticker",
        parse: parseAlertShortcutValues,
      },
      wizardLayout: "form",
      wizard: [
        {
          key: "symbol",
          label: "Symbol",
          placeholder: "AAPL",
          type: "text",
        },
        {
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
          key: "price",
          label: "Target Price",
          placeholder: "200.00",
          type: "number",
        },
      ],
      async execute(values) {
        const input = parseAlertCommandValues(values);
        if (!input) throw new Error("Use a symbol, condition, and target price.");

        const quote = await resolveAlertQuote(ctx.marketData, input.symbol);

        const alert = {
          ...createAlert(quote.symbol || input.symbol, input.condition, input.price),
          ...quoteAlertFields(quote),
        };
        const existing = loadAlerts(ctx);
        existing.push(alert);
        saveAlerts(ctx, existing);
        alertStream?.sync();

        ctx.notify({
          body: `Alert set: ${formatAlertDescription(alert)} (current ${formatMarketPrice(quote.price, { minimumFractionDigits: 2 })})`,
          type: "success",
        });
      },
    });

    ctx.registerCommand({
      id: "set-event-alert",
      label: "Add Event Alert",
      description: "Create a filing, news, earnings or market alert",
      keywords: ["alert", "event", "congress", "13f", "fund", "member", "follow"],
      category: "data",
      wizardLayout: "form",
      wizard: [
        {
          key: "event",
          label: "Event",
          type: "select",
          defaultValue: "congress-watched",
          options: [...Object.entries(RESEARCH_LABELS).map(([value,label]) => ({value,label})), ...EVENT_ALERT_TEMPLATES.map((entry) => ({ label: entry.label, value: entry.id }))],
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
      execute(values = {}) {
        const event = values?.event || "congress-watched";
        const result = readEventAlerts(ctx.configState.get<string>(EVENT_ALERTS_KEY) || "[]");
        if (result.error) throw new Error(result.error);
        if (result.rules.length >= MAX_EVENT_ALERTS)
          throw new Error("Keep at most 40 event alerts.");
        const rule = isResearchAlertKind(event) ? createResearchAlert(event, values) : createEventAlert(event, values?.[event] || "");
        if (
          result.rules.some(
            (existing) =>
              existing.kind === rule.kind &&
              existing.target === rule.target &&
              existing.value.toLowerCase() === rule.value.toLowerCase(),
          )
        )
          throw new Error("This event is already followed.");
        ctx.configState.set(EVENT_ALERTS_KEY, JSON.stringify([...result.rules, rule]));
        ctx.notify({ body: "Event alert saved.", type: "success" });
      },
    });

    // The poll carries whatever the stream does not: symbols the feed has not
    // delivered lately, and every symbol while the app is hidden.
    const poll = async () => {
      alertStream?.sync();
      const pending = loadAlerts(ctx).filter((alert) => alert.status === "active" && !readStreamedAlertQuote(alert));
      if (pending.length === 0) return;

      ctx.log.info("poll", { active: pending.length });

      // One batched pass over the distinct symbols: the alerts pane reads the same
      // persisted store, so this is the only place that talks to the provider.
      const quoteKeys = [...new Set(pending.map((alert) => `${alert.symbol}\0${alert.exchange ?? ""}`))];
      const results = await Promise.all(quoteKeys.map(async (key): Promise<[string, Quote | string]> => {
        const [symbol, exchange = ""] = key.split("\0");
        try {
          return [key, await resolveAlertQuote(ctx.marketData, symbol ?? "", exchange)];
        } catch (err) {
          ctx.log.warn("poll: no quote", { symbol, exchange, error: String(err) });
          return [key, createQuoteErrorMessage(symbol ?? "", err)];
        }
      }));
      if (generation !== pollGeneration) return;
      const quotes = new Map<string, Quote | string>(results);

      // Read the store again: the stream or the pane may have changed an alert
      // while the quotes were in flight, and an alert must trigger only once.
      const alerts = loadAlerts(ctx);
      let changed = false;
      for (const alert of alerts) {
        if (alert.status !== "active") continue;
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
          notifyTriggered(alert, quote.price);
        }
        streamedBaselines.delete(alert.id);
        Object.assign(alert, quoteAlertFields(quote));
        changed = true;
      }

      if (changed) {
        saveAlerts(ctx, alerts);
      }
    };

    // Re-armed each cycle so a change to the pane's Check interval setting takes
    // effect on the next tick without a restart.
    const scheduleNextPoll = () => {
      if (generation !== pollGeneration) return;
      const seconds = Number(ctx.paneSettings?.get<string>("alerts", POLL_SECONDS_KEY));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : POLL_INTERVAL_MS;
      pollTimer = setTimeout(() => {
        void poll().finally(scheduleNextPoll);
      }, delay);
    };

    void poll().finally(scheduleNextPoll);

    ctx.registerPane({
      id: "alerts",
      name: "Alerts",
      icon: "A",
      component: AlertsPane,
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
      description: "Price, market and filing event alerts",
      keywords: ["alerts", "price", "trigger", "alarm", "watch", "notify"],
      shortcut: { prefix: "ALRT" },
    });
  },

  dispose() {
    pollGeneration += 1;
    alertStream?.dispose();
    alertStream = null;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  },
};
