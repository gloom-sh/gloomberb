import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCryptoBoard } from "./client";
import { cryptoNotices, cryptoPrice, cryptoReturn, cryptoVolume } from "./model";
export const cryptoBoardHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "none" },
  options: [],
  describe: "Crypto board",
  discovery: {
    aliases: ["CRYP"],
    dataRequirements: ["Gloom Cloud Alpaca crypto board"],
    limitations: [
      "Alpaca US venue prices and base-asset volume",
      "Bar prices include quote midpoints",
      "Daily change and seven-day returns have different UTC reference periods",
    ],
  },
  async load(_args, ctx) {
    const data = await fetchCryptoBoard(ctx.apiClient);
    return {
      complete: data.status === "available",
      errors: cryptoNotices(data),
      sections: [
        {
          title: "USD pairs",
          columns: [
            { key: "symbol", header: "Pair" },
            { key: "price", header: "USD", align: "right" },
            { key: "dailyChange", header: "Since UTC close", align: "right" },
            { key: "return7d", header: "7D completed", align: "right" },
            { key: "volume", header: "Alpaca volume", align: "right" },
            { key: "volumeDate", header: "Volume UTC day" },
            { key: "percentile", header: "Price pctl", align: "right" },
            { key: "sampleCount", header: "Daily samples", align: "right" },
            { key: "asOf", header: "Trade as of" },
            { key: "freshness", header: "Trade status" },
          ],
          rows: data.rows.map((row) => ({
            symbol: row.symbol,
            price: cryptoPrice(row.price.value),
            dailyChange: cryptoReturn(row.dailyChange.valuePercent),
            return7d: cryptoReturn(row.return7d.valuePercent),
            volume: cryptoVolume(row),
            volumeDate: row.volume.periodStart.slice(0, 10),
            percentile: row.price.percentile.value,
            sampleCount: row.price.percentile.sampleCount,
            asOf: row.price.asOf,
            freshness: row.price.freshness,
          })),
        },
      ],
      metadata: { ...data },
    };
  },
};
