import type { CloudCongressTradePayload } from "../../../api-client";

export function congressReturnUnavailableText(trade: CloudCongressTradePayload, window: "transaction" | "filing"): string {
  switch (trade.returnUnavailable?.[window]) {
    case "no_ticker": return "No ticker reported";
    case "unsupported_asset": return "Return not available for this asset type";
    case "no_date": return "No date reported";
    case "awaiting_close": return "Awaiting a market close";
    case "insufficient_history": return "Not enough price history";
    default: return !trade.ticker ? "No ticker reported" : "No return available";
  }
}
