import { t } from "../../../i18n";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { noLongerTradingNote } from "../../../tickers/listing-fate";
import type { ContextMenuItem } from "../../../types/context-menu";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { ADD_ALERT_COMMAND_ID, alertListingOfTicker, openPluginCommandForm, pluginCommandAvailable } from "../../../ui/context-menu";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import type { PluginRegistry } from "../../registry";
import { listingResearchAlertValues, type ListingResearchAlertKind } from "../alerts/research-builder";

/** Add Event Alert, the alerts plugin's command for earnings, filings and the other event rules. */
const ADD_EVENT_ALERT_COMMAND_ID = "set-event-alert";

const LISTING_EVENT_ALERTS: ReadonlyArray<{ kind: ListingResearchAlertKind; id: string; label: string }> = [
  { kind: "earnings_date", id: "add-earnings-alert", label: "Add Earnings Alert…" },
  { kind: "filing_type", id: "add-filing-alert", label: "Add Filing Alert…" },
];

/**
 * The listing an earnings or SEC filing alert follows for the ticker on
 * screen: a company's shares on a US exchange, by symbol and venue (BHP's
 * NYSE receipt is BHP on NYSE). Null for what Add Event Alert and `alerts add`
 * refuse those rules on: a fund, a coin, a currency, a future, a line abroad
 * (BHP on ASX, Sanofi in Paris saved under the bare SAN, which is Banco
 * Santander's NYSE receipt) or over the counter, or a venue nothing names.
 */
export function usCompanyAlertListing(
  ticker: TickerRecord,
  financials: TickerFinancials | null | undefined,
): { symbol: string; exchange: string } | null {
  if (resolveTickerInstrumentKind(ticker, financials) !== "equity") return null;
  const key = parsePublicTickerKey(ticker.metadata.ticker);
  const quote = financials?.quote;
  const exchange = key.exchange
    ?? canonicalExchange(ticker.metadata.exchange || quote?.listingExchangeName || quote?.exchangeName || "");
  return isUsListingExchange(exchange) ? { symbol: key.symbol, exchange } : null;
}

/**
 * The alerts DES's pane menu offers on the listing it shows: a price alert
 * (SA's form) on any listing, and earnings and SEC filing alerts (Add Event
 * Alert's) on a US company's shares, each form filled in with that listing,
 * venue included. Nothing is added until the form is sent. A command that is
 * missing, hidden or whose plugin is off offers nothing, and neither does a
 * listing that no longer trades, which every one of these forms refuses.
 */
export function tickerAlertMenuItems({
  ticker,
  financials,
  registry,
  disabledPlugins,
  now = Date.now(),
}: {
  ticker: TickerRecord;
  financials: TickerFinancials | null | undefined;
  registry: Pick<PluginRegistry, "commands" | "getCommandPluginId" | "getConfig" | "notify"> | null | undefined;
  disabledPlugins: readonly string[];
  now?: number;
}): ContextMenuItem[] {
  if (!registry) return [];
  const quote = financials?.quote;
  if (quote && noLongerTradingNote(ticker.metadata.ticker, quote, now)) return [];
  const items: ContextMenuItem[] = [];
  if (pluginCommandAvailable(registry, ADD_ALERT_COMMAND_ID, disabledPlugins)) {
    items.push({
      id: "add-price-alert",
      label: t("Add Price Alert…"),
      onSelect: () => openPluginCommandForm(ADD_ALERT_COMMAND_ID, { kind: "price", symbol: alertListingOfTicker(ticker) }, registry),
    });
  }
  const listing = pluginCommandAvailable(registry, ADD_EVENT_ALERT_COMMAND_ID, disabledPlugins)
    ? usCompanyAlertListing(ticker, financials)
    : null;
  for (const entry of listing ? LISTING_EVENT_ALERTS : []) {
    const values = listingResearchAlertValues(entry.kind, listing!);
    if (!values) continue;
    items.push({
      id: entry.id,
      label: t(entry.label),
      onSelect: () => openPluginCommandForm(ADD_EVENT_ALERT_COMMAND_ID, values, registry),
    });
  }
  return items;
}
