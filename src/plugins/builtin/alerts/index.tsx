import type { GloomPlugin } from "../../../types/plugin";
import type { Quote } from "../../../types/financials";
import { formatMarketPrice } from "../../../market-data/market/format";
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

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const alertsPlugin: GloomPlugin = {
  id: "alerts",
  name: "Alerts",
  version: "1.0.0",
  description: "Price trigger alerts with desktop notifications",
  toggleable: true,

  setup(ctx) {
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

        ctx.notify({
          body: `Alert set: ${formatAlertDescription(alert)} (current ${formatMarketPrice(quote.price, { minimumFractionDigits: 2 })})`,
          type: "success",
        });
      },
    });

    const poll = async () => {
      const alerts = loadAlerts(ctx);
      if (alerts.length === 0) return;

      const activeAlerts = alerts.filter((a) => a.status === "active");
      if (activeAlerts.length === 0) return;

      ctx.log.info("poll", { total: alerts.length, active: activeAlerts.length });

      // One batched pass over the distinct symbols: the alerts pane reads the same
      // persisted store, so this is the only place that talks to the provider.
      const quoteKeys = [...new Set(activeAlerts.map((alert) => `${alert.symbol}\0${alert.exchange ?? ""}`))];
      const results = await Promise.all(quoteKeys.map(async (key): Promise<[string, Quote | string]> => {
        const [symbol, exchange = ""] = key.split("\0");
        try {
          return [key, await resolveAlertQuote(ctx.marketData, symbol ?? "", exchange)];
        } catch (err) {
          ctx.log.warn("poll: no quote", { symbol, exchange, error: String(err) });
          return [key, createQuoteErrorMessage(symbol ?? "", err)];
        }
      }));
      const quotes = new Map<string, Quote | string>(results);

      let changed = false;
      for (const alert of alerts) {
        if (alert.status !== "active") continue;
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
          ctx.notify({
            body: `${formatAlertDescription(alert)} triggered at ${quote.price}`,
            type: "success",
            desktop: "always",
            persistent: true,
            sound: "Glass",
            action: {
              label: "Open",
              onClick: () => ctx.showPane("alerts"),
            },
          });
        }
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
      description: "Price trigger alerts with notifications",
      keywords: ["alerts", "price", "trigger", "alarm", "watch", "notify"],
      shortcut: { prefix: "ALRT" },
    });
  },

  dispose() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  },
};
