/**
 * The pane state each Commodities & Energy tab keeps its own under, which the
 * workspace wraps it with and a function's options write to for `shot`.
 */
export const COMMODITIES_VIEW_STATE = {
  /** The workspace's own state: the tab it shows. */
  workspace: "market-overview",
  curve: "market-overview:futures-curve",
  cot: "market-overview:cot",
  doe: "market-overview:doe",
  crops: "commodity-balances",
  balances: "jodi",
} as const;
