import type { HeadlessPaneFreshness } from "../../../types/plugin";
import { quoteObservation } from "../shared/report-freshness";
import type { ScenarioMarketSnapshot } from "./client";

/**
 * How current a scenario's figures are, for its report and for the pane that
 * publishes the same (`report-freshness`), so `fn OSA` and a capture of it
 * date the position alike. A position typed whole (legs, spot, rate and
 * yield) is the reader's own inputs, not a feed. Otherwise the figures are
 * valued at the underlying's quote, so it dates them, with its delay and where
 * its market stands (after hours, closed), beside the feed the chain came
 * through. Without a current quote the load's own time stands in.
 */
export function scenarioFreshness(
  market: Pick<ScenarioMarketSnapshot, "asOf" | "chain" | "underlyingQuote"> | null,
  inputsOnly: boolean,
  now = Date.now(),
): HeadlessPaneFreshness {
  if (inputsOnly) return { source: "Your inputs", status: "not-a-feed", basis: "scenario" };
  if (!market) return {};
  const { chain, underlyingQuote } = market;
  return {
    ...(chain?.dataSource === "live" || chain?.dataSource === "delayed" ? { status: chain.dataSource } : {}),
    ...(chain?.delayMinutes ? { delayMinutes: chain.delayMinutes } : {}),
    ...(underlyingQuote ? { observations: [{ ...quoteObservation(underlyingQuote, now) }] } : { asOf: market.asOf }),
  };
}
