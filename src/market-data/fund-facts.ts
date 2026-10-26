import { apiClient } from "../api-client";
import type { FundFactsPayload, FundFlows } from "../api-client/fund-facts";
import { isBondFactsShape } from "./bond-funds";

/**
 * A fund facts answer as every reader takes it (the ETF pane, DES, CMP,
 * `ticker`, `fundamentals`): each figure dated and published, the parts a
 * server before them leaves out still readable, anything malformed refused.
 */

const fact = (value: unknown) => value === null || (typeof value === "object" && value !== null && "value" in value && "source" in value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isMetalHoldingsShape(value: FundFactsPayload["metalHoldings"]): boolean {
  return value == null || ((value.metal === "gold" || value.metal === "silver") && typeof value.asOf === "string" && finite(value.ounces)
    && (value.tonnes === null || finite(value.tonnes)) && typeof value.source?.publisher === "string"
    && (value.change === null || (typeof value.change?.since === "string" && finite(value.change.ounces))));
}

/** Absent from servers before it; otherwise a dated factor with its reset period. */
const leverageShape = (value: FundFactsPayload["leverage"]) => value === undefined || value === null
  || (fact(value) && typeof value.value === "number" && Number.isFinite(value.value) && (value.reset === "daily" || value.reset === "monthly"));

/** A NAV's estimate range, when the sponsor published one: absent, or two ends in order. */
const estimateShape = (nav: FundFactsPayload["nav"]) => !nav?.estimate
  || (finite(nav.estimate.low) && finite(nav.estimate.high) && nav.estimate.low <= nav.estimate.high);

/** Absent from servers before them; otherwise a dated count, and a change between two dated counts. */
const sharesShape = (value: FundFactsPayload["sharesOutstanding"]) => value == null || (fact(value) && finite(value.value));
const flowsShape = (value: FundFlows | null | undefined) => value == null
  || (finite(value.shares) && (value.value === null || finite(value.value)) && typeof value.from === "string" && typeof value.asOf === "string");

export function validateFundFacts(data: FundFactsPayload): FundFactsPayload {
  if (!data || typeof data.ticker !== "string" || typeof data.covered !== "boolean"
    || ![data.expenseRatio, data.nav, data.premiumDiscount, data.netAssets, data.sponsor, data.inception, data.index].every(fact)
    || !estimateShape(data.nav) || !sharesShape(data.sharesOutstanding) || !flowsShape(data.flows)
    || !isBondFactsShape(data.bond) || !leverageShape(data.leverage) || !isMetalHoldingsShape(data.metalHoldings)) {
    throw new Error("Unreadable fund facts response");
  }
  return data;
}

/** `GET /cloud/fund-facts/:ticker`, read and checked. */
export async function readFundFacts(
  symbol: string,
  client: Pick<typeof apiClient, "getFundFacts"> = apiClient,
  signal?: AbortSignal,
): Promise<FundFactsPayload> {
  return validateFundFacts(await (signal ? client.getFundFacts(symbol, { signal }) : client.getFundFacts(symbol)));
}
