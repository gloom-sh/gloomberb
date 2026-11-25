import { formatSpotTime } from "../options/model-spot";
import { formatStrikeLabel } from "../../../utils/options";
import type { ChainIvBasis, OptionCalcValuation } from "./model";

const percent = (volatility: number) => `${(volatility * 100).toFixed(2)}%`;
/** A forward to four decimals: it sits within a few cents of spot, which is what it explains. */
const forwardText = (forward: number) => forward.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/**
 * Where a calculator opened on a chain or a surface counts its days from, so a
 * snapshot is never read at today's clock: `Valued at Mon 23 Nov 20:59 UTC,
 * when the quotes were taken · spot close Mon 23 Nov`. The spot's stamp is
 * said only while the spot is still the one seeded.
 */
export function calculatorValuationText(valuation: OptionCalcValuation, spot: number): string {
  const stamp = valuation.spotLabel && spot === valuation.spot ? ` · spot ${valuation.spotLabel}` : "";
  return `Valued at ${formatSpotTime(valuation.at)}, when the quotes were taken${stamp}`;
}

/**
 * Why the chain's IV for this contract is not the one its midpoint gives here:
 * the chain solves each strike from its out-of-the-money side against the
 * expiry's put-call parity forward, and reads a strike with no such quote off
 * its neighbours. The forward is the reason only while the two IVs differ as
 * shown (two decimals) and the model is the chain's European one.
 */
export function chainIvText(basis: ChainIvBasis, strike: number, implied: number | null, european: boolean): string | null {
  const chain = `Chain IV ${percent(basis.volatility)}`;
  if (basis.kind === "filled") return `${chain} is read off neighbouring strikes: this strike has no two-sided out-of-the-money quote.`;
  if (basis.kind === "other-side") return `${chain} is solved from the ${formatStrikeLabel(strike)} ${basis.side}'s mid, the out-of-the-money side.`;
  if (!european || implied == null || percent(implied) === percent(basis.volatility)) return null;
  return `${chain} solves this mid against the expiry's parity forward, ${forwardText(basis.forward)}, not spot.`;
}
