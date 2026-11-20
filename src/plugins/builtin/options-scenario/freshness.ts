import type { HeadlessPaneFreshness } from "../../../types/plugin";
import { quoteObservation } from "../shared/report-freshness";
import { optionQuoteTime, type ScenarioMarketSnapshot } from "./client";
import { extendedSession, formatSpotTime } from "../options/model-spot";

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
  const chainTime = optionQuoteTime(chain);
  const observations = [
    ...(underlyingQuote ? [{ ...quoteObservation(underlyingQuote, now), series: "Underlying quote" }] : []),
    ...(chainTime == null ? [] : [{ updatedAt: chainTime, series: "Option quotes", dataSource: chain?.dataSource,
      delayMinutes: chain?.delayMinutes }]),
  ];
  return {
    ...(chain?.dataSource === "live" || chain?.dataSource === "delayed" ? { status: chain.dataSource } : {}),
    ...(chain?.delayMinutes ? { delayMinutes: chain.delayMinutes } : {}),
    ...(observations.length ? { observations } : { asOf: market.asOf }),
  };
}

const usDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", dateStyle: "short" });

export function earlierOptionSession(optionTime: number | null | undefined, quote: ScenarioMarketSnapshot["underlyingQuote"]): boolean {
  const printTime = quote?.lastUpdated;
  if (optionTime == null || !quote || printTime == null || !(printTime > optionTime)) return false;
  const session = extendedSession(quote);
  return usDate.format(optionTime) !== usDate.format(printTime) || session === "after hours" || session === "overnight";
}

export function scenarioQuoteTime(time: number | null | undefined): string {
  return time != null && Number.isFinite(time) && time > 0 ? formatSpotTime(time) : "time unavailable";
}

export interface ScenarioQuoteTimes {
  options: number | null;
  underlying: number | null;
  farOptions?: number | null;
  earlierSession: boolean;
}

export function scenarioQuoteTimes(market: ScenarioMarketSnapshot): ScenarioQuoteTimes {
  const options = optionQuoteTime(market.chain);
  return { options, underlying: market.underlyingQuote?.lastUpdated ?? null, earlierSession: earlierOptionSession(options, market.underlyingQuote) };
}

export function scenarioQuoteTimesLabel(times: ScenarioQuoteTimes): string {
  return `Option quotes ${scenarioQuoteTime(times.options)}${times.earlierSession ? " (earlier session)" : ""}`
    + `${times.farOptions !== undefined ? ` · Far expiry ${scenarioQuoteTime(times.farOptions)}` : ""} · Underlying ${scenarioQuoteTime(times.underlying)}`;
}
