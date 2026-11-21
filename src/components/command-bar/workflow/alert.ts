import { useEffect, useRef } from "react";
import { t, tf } from "../../../i18n";
import { AlertListingRefusal, resolveAlertListing } from "../../../cli/alert-listing";
import { extendedSessionLineLabel, getLatestPrintDisplay, type SessionPriceDisplay } from "../../../market-data/market/status";
import type { ListingDeps } from "../../../tickers/listing-venues";
import type { Quote } from "../../../types/financials";
import { isPenceQuotedLine, isSharePriceQuote } from "../../../market-data/market/format";
import { formatUtcDayTime } from "../../../utils/utc-time";
import { isRegularSessionPrint } from "../../../market-data/quotes/tick-range";
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
function formatAlertWorkflowCurrentPrice(print: SessionPriceDisplay, quote: Quote): string {
  const price = isPenceQuotedLine(quote) ? `${Number((print.price * 100).toPrecision(12))}p`
    : [formatAlertWorkflowPrice(print.price), quote.currency].filter(Boolean).join(" ");
  const session = print.session;
  const time = Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0
    ? `${formatUtcDayTime({ time: quote.lastUpdated, dateOnly: false })} UTC` : "time unavailable";
  return [price, session ? extendedSessionLineLabel({ ...print, session }, t) : "",
    `· ${time}`].filter(Boolean).join(" ");
}

function formatAlertWorkflowQuote(quote: Quote): string {
  const exchange = quote.fullExchangeName || quote.exchangeName || quote.listingExchangeName || "";
  const name = quote.name || quote.symbol;
  const source = quote.dataSource === "delayed" ? "delayed" : quote.dataSource || "";
  return [quote.symbol, name, exchange, source].filter(Boolean).join("  ");
}

function summarizeAlertWorkflowQuoteError(symbol: string, error: unknown): string {
  if (error instanceof AlertListingRefusal) return error.details ? `${error.reason} ${error.details}` : error.reason;
  if (error instanceof Error && error.message.trim()) return error.message;
  return tf('No quote found for "{symbol}".', { symbol });
}

/** How long typing rests before the symbol is read: a company's name is a search, not one quote. */
const ALERT_WORKFLOW_READ_DELAY_MS = 250;

/**
 * The fields with their lines under Symbol and Target Price. A pane that fills
 * the form in can add its own line under Target Price (`priceNote` in its
 * values: GEX's flip alert says the level is fixed), kept below the price's.
 */
function updateAlertWorkflowFieldDescriptions(
  fields: CommandBarWorkflowField[],
  descriptions: Partial<Record<"symbol" | "price", string | undefined>>,
  values: Record<string, CommandBarFieldValue>,
  quote?: Quote,
): CommandBarWorkflowField[] {
  const priceNote = coerceFieldString(values.priceNote).trim();
  return fields.map((field) => {
    if (field.id !== "symbol" && field.id !== "price") return field;
    const own = descriptions[field.id];
    const description = field.id === "price" && priceNote ? [own, priceNote].filter(Boolean).join("\n") : own;
    const currency = quote && (isPenceQuotedLine(quote) ? "GBp" : quote.currency);
    const label = field.id === "price" ? `${t("Target Price")}${quote && currency ? ` (${currency}${isSharePriceQuote(quote) ? "/share" : ""})` : ""}` : field.label;
    return field.description === description && field.label === label ? field : { ...field, description, label };
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
          }, route.values),
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
        }, route.values),
        payloadMeta: {
          ...(route.payloadMeta ?? {}),
          alertQuoteSymbol: alertWorkflowSymbol,
          alertQuoteStatus: "checking",
        },
      };
    });

    const read = () => void resolveAlertListing(alertWorkflowSymbol, null, listingDeps)
      .then(({ quote, fate }) => {
        if (quoteRequestRef.current !== requestId) return;
        const print = getLatestPrintDisplay(quote);
        if (!quote || !print || !Number.isFinite(print.price)) {
          throw new Error(tf('No quote found for "{symbol}".', { symbol: alertWorkflowSymbol }));
        }

        updateRoute((route) => {
          if (!isSetAlertWorkflow(route)) return route;
          if (normalizeAlertWorkflowSymbol(route.values.symbol) !== alertWorkflowSymbol) return route;

          const currentPrice = coerceFieldString(route.values.price).trim();
          const previousAutoPrice = String(route.payloadMeta?.alertAutoPrice ?? "");
          const shouldPrefill = currentPrice.length === 0 || currentPrice === previousAutoPrice;
          const waiting = route.values["price:session"] === "regular" && !isRegularSessionPrint(quote);
          const quotePrice = waiting ? "" : isPenceQuotedLine(quote) ? `${Number((print.price * 100).toPrecision(12))}p` : formatAlertWorkflowPrice(print.price);
          const nextValues = shouldPrefill
            ? { ...route.values, price: quotePrice }
            : route.values;

          return {
            ...route,
            values: nextValues,
            fields: updateAlertWorkflowFieldDescriptions(route.fields, {
              // What became of the symbol goes under its quote, which names the listing: FB is a fund now, and Meta trades as META.
              symbol: [formatAlertWorkflowQuote(quote), ...fate].join("\n"),
              price: waiting ? "Enter a target. The alert waits for a regular-hours quote."
                : tf("Current price {price}; edit to set the target.", { price: formatAlertWorkflowCurrentPrice(print, quote) }),
            }, nextValues, quote),
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
            }, route.values),
            payloadMeta: {
              ...(route.payloadMeta ?? {}),
              alertQuoteSymbol: alertWorkflowSymbol,
              alertQuoteStatus: "invalid",
              alertQuoteError: message,
            },
          };
        });
      });
    const timer = setTimeout(read, ALERT_WORKFLOW_READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [alertWorkflowActive, alertWorkflowSymbol, route.values["price:session"], listingDeps, updateRoute]);
}
