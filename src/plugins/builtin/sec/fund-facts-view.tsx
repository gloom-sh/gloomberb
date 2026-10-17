import { useCallback } from "react";
import { loadingText, Notice, StatGrid } from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { Box } from "../../../ui";
import type { FundFactsPayload } from "../../../api-client/fund-facts";
import { cachedFundFacts, fundFactItems, fundFactsEmpty, fundFactsErrorText, loadFundFacts } from "./fund-facts";
import type { CloudResource } from "../shared/cloud-resource";

/** A fund's facts, served from the cache first and refreshed behind it; null asks for nothing. */
export function useFundFacts(symbol: string | null | undefined) {
  const ticker = symbol?.trim().toUpperCase() || null;
  const loader = useCallback((force: boolean) => loadFundFacts(ticker!, force), [ticker]);
  const initialData = useCallback(() => (ticker ? cachedFundFacts(ticker) : null), [ticker]);
  return useAsyncResource<CloudResource<FundFactsPayload>>(ticker ? loader : null, { initialData });
}

/**
 * The fund's facts as the summary sheet over its filings, or one line saying
 * why there are none. Loading is one muted line, so the filings never wait.
 */
export function FundFactsSummary({ symbol, width, facts, loading, error }: {
  symbol: string;
  width: number;
  facts: FundFactsPayload | null;
  loading: boolean;
  error: unknown;
}) {
  if (facts?.covered) return <StatGrid width={width} items={fundFactItems(facts)} />;
  const message = facts
    ? fundFactsEmpty(symbol, facts, false)
    : error ? fundFactsErrorText(error) : loading ? loadingText("fund facts") : null;
  if (!message) return null;
  return <FundViewNotice lines={[message]} />;
}

/** Muted lines in the fund view's body, inset like the table's text; they wrap rather than lose their tail. */
export function FundViewNotice({ lines, paddingTop = 0 }: { lines: readonly string[]; paddingTop?: number }) {
  return (
    <Box flexDirection="column" paddingX={1} paddingTop={paddingTop} flexShrink={0} data-gloom-role="fund-view-notice">
      {lines.map((line) => <Notice key={line} tone="muted">{line}</Notice>)}
    </Box>
  );
}
