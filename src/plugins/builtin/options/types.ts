import type { DataTableColumn } from "../../../components";
import type { OptionContract } from "../../../types/financials";
import type { OptionSide, OptionValuation } from "../options-calculator/model";

export type OptionFieldId =
  | "bid"
  | "ask"
  | "last"
  | "delta"
  | "gamma"
  | "theta"
  | "vega"
  | "rho"
  | "iv"
  | "volume"
  | "openInterest";

export type OptionColumnId = "strike" | `${OptionSide}${Capitalize<OptionFieldId>}`;

export type OptionColumn = DataTableColumn & {
  id: OptionColumnId;
  field: OptionFieldId | "strike";
  side: OptionSide | null;
};

export interface OptionTableRow {
  strike: number;
  call?: OptionContract;
  put?: OptionContract;
  callGreeks?: OptionValuation;
  putGreeks?: OptionValuation;
  isPositionStrike: boolean;
}

export type OptionsViewProps = {
  width: number;
  height: number;
  focused: boolean;
  onCapture?: (capturing: boolean) => void;
};
