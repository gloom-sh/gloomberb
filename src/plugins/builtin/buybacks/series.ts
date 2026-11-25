import type { SeriesDefinition } from "../../../series/types";
import { buybackSymbol, fetchBuybacks } from "./client";
import { boughtPoints } from "./model";

const WHERE = [
  { id: "shares", where: "exchange", name: "Buyback shares, on the Exchange", tags: ["on-market", "HKEX"],
    description: "Shares a Hong Kong listing bought back on the Exchange each session, 0 on a session without one, from its next day disclosure returns, as DES › Ownership › Buybacks charts them. Needs Pro." },
  { id: "shares-elsewhere", where: "elsewhere", name: "Buyback shares, elsewhere", tags: ["off-market", "other exchanges"],
    description: "Shares a Hong Kong listing bought back each session other than on the Exchange (another exchange it is listed on, or off market), 0 on a session without one, as DES › Ownership › Buybacks charts them. Needs Pro." },
] as const;

/**
 * The shares a Hong Kong listing bought back each session, the two column
 * series of DES › Ownership › Buybacks. The close they are drawn under is
 * the ticker's own price. Pro readings: the free preview holds only the
 * newest sessions, so it fails with the pane's words.
 */
export const BUYBACK_SERIES: readonly SeriesDefinition[] = WHERE.map(({ id, where, name, tags, description }): SeriesDefinition => ({
  id: `buybacks:${id}`,
  name,
  unit: "shares",
  frequency: "daily",
  group: "Positioning",
  tags: ["buybacks", "share repurchases", "Hong Kong", ...tags],
  description,
  input: "ticker",
  style: "columns",
  load: async ({ ticker, signal }) => {
    const symbol = buybackSymbol(ticker!);
    if (!symbol) throw new Error(`Buybacks cover Hong Kong listings, such as 0700.HK; ${ticker} is not one.`);
    const data = await fetchBuybacks(symbol, signal);
    if (data.status !== "available") throw new Error(`No buyback returns are held for ${symbol}.`);
    if (data.access === "preview") throw new Error("Full buyback history requires Pro.");
    return boughtPoints(data, where).map((point) => ({ date: point.date, value: point.value }));
  },
}));
