import type { DataTableColumn } from "../../../components";
import type { HolderRecord } from "../../../types/financials";
import type { SortDirection } from "../../../utils/sort-values";

export type ViewMode = "table" | "chart";
export type HolderColumnId = "holder" | "value" | "shares" | "changeShares" | "changePercent" | "percentHeld" | "reportDate";
export type HolderColumn = DataTableColumn & { id: HolderColumnId };

export interface SortPreference {
  columnId: HolderColumnId;
  direction: SortDirection;
}

export interface HolderRow extends HolderRecord {
  id: string;
}
