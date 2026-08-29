/**
 * Preview imagery is picked from the pane id alone, so a card drawn from a
 * published layout never touches live pane components, subscriptions, or any
 * user data. Same pane id in, same picture out.
 */
export type PaneImagery =
  | "chart"
  | "table"
  | "feed"
  | "calendar"
  | "chat"
  | "gauge"
  | "heatmap"
  | "media"
  | "generic";

/** First match wins, so put the narrow ids above the broad keywords. */
const IMAGERY_RULES: ReadonlyArray<readonly [string, PaneImagery]> = [
  ["market-heatmap", "heatmap"],
  ["fx-matrix", "heatmap"],
  ["correlation", "heatmap"],
  ["sectors", "heatmap"],
  ["treemap", "heatmap"],
  ["fear-greed", "gauge"],
  ["buffett", "chart"],
  ["kelly", "gauge"],
  ["gauge", "gauge"],
  ["calendar", "calendar"],
  ["corporate-actions", "calendar"],
  ["treasury-auctions", "calendar"],
  ["earnings-monitor", "calendar"],
  ["ipo", "calendar"],
  ["news", "feed"],
  ["substack", "feed"],
  ["changelog", "feed"],
  ["analyst-research", "feed"],
  ["polls", "feed"],
  ["tweets", "feed"],
  ["chat", "chat"],
  ["direct-message", "chat"],
  ["agent", "chat"],
  ["ai-", "chat"],
  ["notes", "chat"],
  ["tv", "media"],
  ["video", "media"],
  ["chart", "chart"],
  ["historical-prices", "chart"],
  ["yield-curve", "chart"],
  ["volatility", "chart"],
  ["credit-conditions", "chart"],
  ["price", "chart"],
  ["portfolio", "table"],
  ["quote-monitor", "table"],
  ["options", "table"],
  ["holders", "table"],
  ["insider", "table"],
  ["short-interest", "table"],
  ["sec", "table"],
  ["movers", "table"],
  ["screener", "table"],
  ["scanner", "table"],
  ["congress", "table"],
  ["thirteenf", "table"],
  ["dividend", "table"],
  ["estimates", "table"],
  ["valuation", "table"],
  ["indices", "table"],
  ["futures", "table"],
  ["analytics", "table"],
  ["brokers", "table"],
  ["trading", "table"],
  ["connections", "table"],
  ["alerts", "table"],
  ["prediction-markets", "table"],
  ["cds", "table"],
  ["halts", "table"],
  ["watchlist", "table"],
];

export function paneImagery(paneId: string): PaneImagery {
  const id = paneId.toLowerCase();
  for (const [needle, imagery] of IMAGERY_RULES) {
    if (id.includes(needle)) return imagery;
  }
  return "generic";
}
