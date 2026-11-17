import { useEffect, useRef } from "react";
import { t, tf } from "../../../i18n";
import { AlertListingRefusal, resolveAlertListing } from "../../../cli/alert-listing";
import { extendedSessionLineLabel, getLatestPrintDisplay, type SessionPriceDisplay } from "../../../market-data/market/status";
import type { ListingDeps } from "../../../tickers/listing-venues";
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
  return route.workflowId === SET_ALERT_WORKFLOW_ID && (!route.values.kind || route.values.kind === "price");
}

function normalizeAlertWorkflowSymbol(value: CommandBarFieldValue | undefined): string {
  return coerceFieldString(value).trim().toUpperCase();
}

function formatAlertWorkflowPrice(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

/**
 * The price an alert is judged on, as the form shows it: the latest print, an
 * extended-hours one named by its session (158.78 After-Hours), as `quote`
 * names it beside Last.
 */
function formatAlertWorkflowCurrentPrice(print: SessionPriceDisplay): string {
  const price = formatAlertWorkflowPrice(print.price);
  const session = print.session;
  return session ? `${price} ${extendedSessionLineLabel({ ...print, session }, t)}` : price;
}

function formatAlertWorkflowQuote(quote: Quote, print: SessionPriceDisplay): string {
  const price = formatAlertWorkflowCurrentPrice(print);
  const exchange = quote.fullExchangeName || quote.exchangeName || quote.listingExchangeName || "";
  const name = quote.name || quote.symbol;
  const source = quote.dataSource === "delayed" ? "delayed" : quote.dataSource || "";
  return [quote.symbol, name, exchange, price, source].filter(Boolean).join("  ");
}

function summarizeAlertWorkflowQuoteError(symbol: string, error: unknown): string {
  if (error instanceof AlertListingRefusal) return error.details ? `${error.reason} ${error.details}` : error.reason;
  if (error instanceof Error && error.message.trim()) return error.message;
  return tf('No quote found for "{symbol}".', { symbol });
}

/** How long typing rests before the symbol is read: a company's name is a search, not one quote. */
const ALERT_WORKFLOW_READ_DELAY_MS = 250;

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
 * by every form, which owns the values; it acts only in Add Alert's. The
 * symbol is read as Add Alert and `alerts add` read it (`resolveAlertListing`):
 * a company's name finds its listing, a listing that stopped trading says
 * why it is refused, and a symbol its company left says where it went.
 */
export function useAlertWorkflowQuoteSync({
  listingDeps,
  route,
  updateRoute,
}: {
  listingDeps: ListingDeps;
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

    const read = () => resolveAlertListing(alertWorkflowSymbol, null, listingDeps)
      .then(({ quote, fate }) => {
        if (quoteRequestRef.current !== requestId) return;
        // An alert is judged on the latest print, extended hours included: the target starts there.
        const print = getLatestPrintDisplay(quote);
        if (!quote || !print || !Number.isFinite(print.price)) {
          throw new Error(tf('No quote found for "{symbol}".', { symbol: alertWorkflowSymbol }));
        }

        const quotePrice = formatAlertWorkflowPrice(print.price);
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
              // What became of the symbol goes under its quote, which names the listing: FB is a fund now, and Meta trades as META.
              symbol: [formatAlertWorkflowQuote(quote, print), ...fate].join("\n"),
              price: tf("Current price {price}; edit to set the target.", { price: formatAlertWorkflowCurrentPrice(print) }),
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
    const timer = setTimeout(() => { void read(); }, ALERT_WORKFLOW_READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [alertWorkflowActive, alertWorkflowSymbol, listingDeps, updateRoute]);
}
