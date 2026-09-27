import { useEffect, useRef } from "react";
import { tf } from "../../../i18n";
import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { coerceFieldString } from "../helpers";
import type {
  CommandBarFieldValue,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";

/** Add Alert's form, the one whose symbol is checked as it is typed. */
const SET_ALERT_WORKFLOW_ID = "plugin-command:set-alert";

function isSetAlertWorkflow(route: CommandBarWorkflowRoute): boolean {
  return route.workflowId === SET_ALERT_WORKFLOW_ID;
}

function normalizeAlertWorkflowSymbol(value: CommandBarFieldValue | undefined): string {
  return coerceFieldString(value).trim().toUpperCase();
}

function formatAlertWorkflowPrice(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function formatAlertWorkflowQuote(quote: Quote): string {
  const price = formatAlertWorkflowPrice(quote.price);
  const exchange = quote.fullExchangeName || quote.exchangeName || quote.listingExchangeName || "";
  const name = quote.name || quote.symbol;
  const source = quote.dataSource === "delayed" ? "delayed" : quote.dataSource || "";
  return [quote.symbol, name, exchange, price, source].filter(Boolean).join("  ");
}

function summarizeAlertWorkflowQuoteError(symbol: string, error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return tf('No quote found for "{symbol}".', { symbol });
}

function updateAlertWorkflowFieldDescriptions(
  fields: CommandBarWorkflowField[],
  descriptions: Partial<Record<"symbol" | "price", string | undefined>>,
): CommandBarWorkflowField[] {
  return fields.map((field) => {
    if (field.id !== "symbol" && field.id !== "price") return field;
    const description = descriptions[field.id];
    return field.description === description ? field : { ...field, description };
  });
}

/**
 * Add Alert checks the symbol as it is typed, shows the quote under it and
 * fills the target from the current price until the user types their own. Run
 * by every form, which owns the values; it acts only in Add Alert's.
 */
export function useAlertWorkflowQuoteSync({
  dataProvider,
  route,
  updateRoute,
}: {
  dataProvider: DataProvider;
  route: CommandBarWorkflowRoute;
  updateRoute: (updater: (route: CommandBarWorkflowRoute) => CommandBarWorkflowRoute) => void;
}): void {
  const quoteRequestRef = useRef(0);
  const alertWorkflowActive = isSetAlertWorkflow(route);
  const alertWorkflowSymbol = alertWorkflowActive
    ? normalizeAlertWorkflowSymbol(route.values.symbol)
    : "";

  useEffect(() => {
    if (!alertWorkflowActive) return;

    const requestId = quoteRequestRef.current + 1;
    quoteRequestRef.current = requestId;

    if (!alertWorkflowSymbol) {
      updateRoute((route) => {
        if (!isSetAlertWorkflow(route)) return route;
        return {
          ...route,
          fields: updateAlertWorkflowFieldDescriptions(route.fields, {
            symbol: "Enter a symbol to validate it.",
            price: "Target fills from the current price after the symbol resolves.",
          }),
          payloadMeta: {
            ...(route.payloadMeta ?? {}),
            alertQuoteSymbol: "",
            alertQuoteStatus: "idle",
          },
        };
      });
      return;
    }

    updateRoute((route) => {
      if (!isSetAlertWorkflow(route)) return route;
      if (normalizeAlertWorkflowSymbol(route.values.symbol) !== alertWorkflowSymbol) return route;
      return {
        ...route,
        fields: updateAlertWorkflowFieldDescriptions(route.fields, {
          symbol: tf("Checking {symbol}...", { symbol: alertWorkflowSymbol }),
          price: "Target fills from the current price after the symbol resolves.",
        }),
        payloadMeta: {
          ...(route.payloadMeta ?? {}),
          alertQuoteSymbol: alertWorkflowSymbol,
          alertQuoteStatus: "checking",
        },
      };
    });

    void dataProvider.getQuote(alertWorkflowSymbol, "")
      .then((quote) => {
        if (quoteRequestRef.current !== requestId) return;
        if (!quote || typeof quote.price !== "number" || !Number.isFinite(quote.price)) {
          throw new Error(tf('No quote found for "{symbol}".', { symbol: alertWorkflowSymbol }));
        }

        const quotePrice = formatAlertWorkflowPrice(quote.price);
        updateRoute((route) => {
          if (!isSetAlertWorkflow(route)) return route;
          if (normalizeAlertWorkflowSymbol(route.values.symbol) !== alertWorkflowSymbol) return route;

          const currentPrice = coerceFieldString(route.values.price).trim();
          const previousAutoPrice = String(route.payloadMeta?.alertAutoPrice ?? "");
          const shouldPrefill = currentPrice.length === 0 || currentPrice === previousAutoPrice;
          const nextValues = shouldPrefill
            ? { ...route.values, price: quotePrice }
            : route.values;

          return {
            ...route,
            values: nextValues,
            fields: updateAlertWorkflowFieldDescriptions(route.fields, {
              symbol: formatAlertWorkflowQuote(quote),
              price: tf("Current price {price}; edit to set the target.", { price: quotePrice }),
            }),
            payloadMeta: {
              ...(route.payloadMeta ?? {}),
              alertQuoteSymbol: alertWorkflowSymbol,
              alertQuoteStatus: "valid",
              alertAutoPrice: quotePrice,
            },
          };
        });
      })
      .catch((error) => {
        if (quoteRequestRef.current !== requestId) return;
        const message = summarizeAlertWorkflowQuoteError(alertWorkflowSymbol, error);
        updateRoute((route) => {
          if (!isSetAlertWorkflow(route)) return route;
          if (normalizeAlertWorkflowSymbol(route.values.symbol) !== alertWorkflowSymbol) return route;
          return {
            ...route,
            fields: updateAlertWorkflowFieldDescriptions(route.fields, {
              symbol: message,
              price: undefined,
            }),
            payloadMeta: {
              ...(route.payloadMeta ?? {}),
              alertQuoteSymbol: alertWorkflowSymbol,
              alertQuoteStatus: "invalid",
              alertQuoteError: message,
            },
          };
        });
      });
  }, [alertWorkflowActive, alertWorkflowSymbol, dataProvider, updateRoute]);
}
