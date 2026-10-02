/**
 * The research function a figure opens: the Ticker Research tab that shows
 * it when this pane has one, otherwise the function's own pane.
 */
export interface OverviewFunctionLink {
  /** Named in the pane menu ("Open Holders"). */
  name: string;
  tabId?: string;
  templateId: string;
}

export interface StatField {
  label: string;
  value: string;
  valueColor?: string;
  /**
   * Muted context after the value (days to cover, days to go), shown whole or
   * not at all; a list offers shorter forms for narrow columns.
   */
  detail?: string | readonly string[];
  /** Descriptive context (a SIC title) that may be cut to fit instead. */
  clipDetail?: boolean;
  link?: OverviewFunctionLink;
  /** An address the value opens in the browser. */
  url?: string;
}

export interface PositionTableRow {
  account: string;
  qty: string;
  quantityUnit?: "face";
  avg: string;
  mark: string;
  cost: string;
  value: string;
  pnl: string;
  ret: string;
  pnlValue: number | null;
  pnlBasis: "quote-and-cost" | "broker-snapshot" | "mixed" | "unavailable";
}
