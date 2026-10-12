import type { DataTableColumn } from "../../../components";
import type { OptionContract } from "../../../types/financials";
import type { OptionSide, OptionValuation } from "../shared/volatility";

export type OptionFieldId =
  | "bid"
  | "ask"
  | "spread"
  | "last"
  | "delta"
  | "gamma"
  | "theta"
  | "vega"
  | "rho"
  | "iv"
  | "volume"
  | "openInterest"
  | "extrinsicPerYear"
  | "costOfSpot";

type OptionColumnId = "strike" | `${OptionSide}${Capitalize<OptionFieldId>}`;

export type OptionColumn = DataTableColumn & {
  id: OptionColumnId;
  field: OptionFieldId | "strike";
  side: OptionSide | null;
};

export interface OptionTableRow {
  strike: number;
  call?: OptionContract;
  put?: OptionContract;
  /** Solved from quote midpoints; the call and put at a strike share it. */
  impliedVolatility?: number;
  callGreeks?: OptionValuation;
  putGreeks?: OptionValuation;
  /** Time value as a share of spot per year (see `carry.ts`); null when it cannot be read. */
  callExtrinsicPerYear?: number | null;
  putExtrinsicPerYear?: number | null;
  /** The put's midpoint as a share of spot (see `carry.ts`); null without a two-sided quote or a current spot. */
  putCostOfSpot?: number | null;
  isPositionStrike: boolean;
}

export type OptionsViewProps = {
  width: number;
  height: number;
  focused: boolean;
  /**
   * Set inside a tab strip that owns h/l and the arrows (the ticker research
   * Options tab). The chain then steps expiries with [ and ] only; a pane of
   * its own also takes h/l and the arrows for its expiry strip.
   */
  nestedInTabs?: boolean;
  /** Show IV rank from Cloud IV history; the registered panes opt in, isolated renders stay offline. */
  ivRank?: boolean;
};
