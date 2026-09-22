import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchShortVolume } from "./client";
import { volumePercent, volumePointStatus } from "./model";

export const shortVolumeHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "US equity ticker.", placeholder: "ticker" },
  discovery: { aliases: ["SIV"], dataRequirements: ["Gloom Cloud FINRA daily short volume"],
    limitations: ["Regular-session off-exchange volume, not short interest", "Short volume includes exempt volume", "One-year history depends on source discovery and ingestion"] },
  options: [
    { key: "scope", type: "enum", description: "FINRA reporting scope.", values: [{ value: "nms" }, { value: "otc" }], defaultValue: "nms", settingKey: "shortVolumeScope" },
    { key: "finra-symbol", type: "string", settingKey: "finraSymbol", description: "Exact case-sensitive FINRA identity, for example ABRpD." },
  ],
  describe: (args) => `Daily short volume | ${args.symbols[0]}`,
  async load(args, ctx) {
    const symbol = String(args.options["finra-symbol"] || args.symbols[0]);
    const data = await fetchShortVolume(symbol, args.options.scope === "otc" ? "otc" : "nms", ctx.apiClient);
    return { complete: data.status === "available", errors: data.warnings,
      sections: [{ title: "Daily off-exchange volume", columns: [
        { key: "date", header: "Date" },
        { key: "ratioPercent", header: "Short %", align: "right", format: (value) => volumePercent(value as number | null) },
        { key: "shortVolume", header: "Short volume", align: "right" },
        { key: "totalVolume", header: "Total volume", align: "right" },
        { key: "shortExemptVolume", header: "Exempt volume", align: "right" },
        { key: "status", header: "Status" },
      ], rows: data.history.toReversed().map((point) => ({ ...point, status: volumePointStatus(point) })) }],
      metadata: { ...data },
    };
  },
};
