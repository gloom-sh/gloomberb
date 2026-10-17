import { logFailure } from "../utils/log-failure";
import type { PerpBoardRow } from "../api-client/perps";
import type { Quote } from "../types/financials";
import { loadPerpetualMarket } from "../sources/gloomberb-cloud/perpetuals";
import { PERPETUAL_TYPE, perpetualListing } from "../tickers/perpetual-listing";
import { formatCompact } from "../utils/format";

/** What `quote` adds for a perpetual: the market PERP opens, its funding and open interest. Rates are fractions. */
export interface PerpetualContractPayload {
  marketId: string;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  fundingKind: PerpBoardRow["fundingKind"];
  fundingRate8h: number | null;
  nextFundingAt: string | null;
  openInterestUsd: number | null;
  /** Mark over the venue's oracle price. */
  premium: number | null;
  observedAt: string;
}

/** The contract terms of a perpetual quote; null for any other quote or when the market cannot be read. */
export async function cliPerpetualContract(quote: Pick<Quote, "symbol" | "instrumentType" | "listingExchangeName">): Promise<PerpetualContractPayload | null> {
  if (quote.instrumentType !== PERPETUAL_TYPE) return null;
  const listing = perpetualListing(quote.symbol, quote.listingExchangeName);
  if (!listing) return null;
  try {
    const market = await loadPerpetualMarket(listing);
    if (!market) return null;
    const { row } = market;
    return {
      marketId: row.marketId,
      fundingRate: row.fundingRate,
      fundingIntervalHours: row.fundingIntervalHours,
      fundingKind: row.fundingKind,
      fundingRate8h: row.fundingRate8h,
      nextFundingAt: row.nextFundingAt,
      openInterestUsd: row.openInterestUsd,
      premium: row.premium,
      observedAt: row.observedAt,
    };
  } catch (error) {
    logFailure("cli.perpetual-contract", "Read perpetual contract terms failed")(error);
    // The quote stands without its terms.
    return null;
  }
}

const percent = (value: number, digits: number) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
const FUNDING_KINDS: Record<PerpBoardRow["fundingKind"], string> = { current: "current estimate", "last-paid": "last paid", continuous: "accrues continuously" };

/** The rows `quote` prints under a perpetual: the market PERP takes, funding per eight hours, open interest, premium. */
export function perpetualContractStats(contract: PerpetualContractPayload): [string, string][] {
  const basis = [FUNDING_KINDS[contract.fundingKind], contract.fundingIntervalHours ? `paid every ${contract.fundingIntervalHours}h` : null]
    .filter(Boolean).join(", ");
  return [
    ["Market", `${contract.marketId} (PERP)`],
    ["Funding 8h", contract.fundingRate8h == null ? "--" : `${percent(contract.fundingRate8h, 4)}${basis ? ` (${basis})` : ""}`],
    ["Open interest", contract.openInterestUsd == null ? "--" : `${formatCompact(contract.openInterestUsd, { fixedDecimals: true })} USD`],
    ["Premium", contract.premium == null ? "--" : `${percent(contract.premium, 2)} vs oracle`],
  ];
}
