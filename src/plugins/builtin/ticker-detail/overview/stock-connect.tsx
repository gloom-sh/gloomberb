import { useCallback } from "react";
import { apiClient } from "../../../../api-client";
import type { StockConnectReport, StockConnectVenue } from "../../../../api-client/stock-connect";
import { PaneLinkMenu, SectionHeading } from "../../../../components";
import { ahListingKey } from "../../../../market-data/ah-pair";
import { useAsyncResource } from "../../../../react/async-resource";
import { useAutoRefresh } from "../../../../react/auto-refresh";
import { Box } from "../../../../ui";
import { parsePublicTickerKey } from "../../../../utils/exchanges";
import { FundamentalsGrid } from "./components";
import type { StatField } from "./types";

const statusText = {
  "buy-sell": "Buy and sell", "sell-only": "Sell only", "not-listed": "Off both lists",
  "not-on-buy-list": "Off buy list", unknown: "Unverified",
} satisfies Record<StockConnectReport["routes"][number]["status"], string>;

export function stockConnectListing(symbol: string, exchange?: string | null): { symbol: string; exchange: StockConnectVenue } | null {
  const line = parsePublicTickerKey(ahListingKey(symbol, exchange));
  const venue = line.exchange;
  if (venue !== "HKEX" && venue !== "SSE" && venue !== "SZSE") return null;
  const code = venue === "HKEX" ? /^\d{4,5}$/ : /^\d{6}$/;
  return code.test(line.symbol) ? { symbol: line.symbol, exchange: venue } : null;
}

export function StockConnectSection({ symbol, exchange, width }: { symbol: string; exchange: StockConnectVenue; width: number }) {
  const read = useCallback(() => apiClient.getStockConnect(symbol, exchange), [symbol, exchange]);
  const resource = useAsyncResource(read, { clearOnError: true });
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 30 * 60_000 });
  const north = exchange !== "HKEX";
  const fields: StatField[] = resource.data?.routes.map(route => ({
    label: route.venue === "SSE" ? "Shanghai" : "Shenzhen",
    value: statusText[route.status],
    detail: route.publishedOn ? (north ? "Session after " : "List dated ") + route.publishedOn : undefined,
    url: route.sourceUrl,
  })) ?? [{ label: "Eligibility", value: resource.loading ? "Loading…" : "Unverified" }];
  return (
    <Box flexDirection="column">
      <SectionHeading title={north ? "Stock Connect · Northbound" : "Stock Connect · Southbound"} />
      <PaneLinkMenu><FundamentalsGrid fields={fields} columns={1} width={width} /></PaneLinkMenu>
    </Box>
  );
}
