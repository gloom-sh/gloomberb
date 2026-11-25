import type { DataTableColumn } from "../../../components";
import type { HolderRecord } from "../../../types/financials";
import type { SortDirection } from "../../../utils/sort-values";

/** `13dg`: the Schedule 13D and 13G beneficial owners. `ccass`: Hong Kong CCASS custody. */
export type ViewMode = "table" | "chart" | "13dg" | "disclosures" | "ccass";
export type HolderColumnId = "holder" | "value" | "shares" | "changeShares" | "changePercent" | "percentHeld" | "reportDate";
export type HolderColumn = DataTableColumn & { id: HolderColumnId };

export interface SortPreference {
  columnId: HolderColumnId;
  direction: SortDirection;
}

export interface HolderRow extends HolderRecord {
  id: string;
}
