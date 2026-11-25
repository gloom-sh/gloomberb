import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { sgxVolumeColumns, sgxVolumeEmpty, sgxVolumeSymbol } from "./sgx";
import { fetchShortVolume } from "./client";
import { volumePercent, volumePointStatus, volumeQuantity } from "./model";

export const shortVolumeHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "US or Singapore equity ticker.", placeholder: "ticker" },
  usListingsOnly: "FINRA short volume",
  additionalListingVenues: ["SGX"],
  freshness: { source: "FINRA", status: "not-a-feed", basis: "daily short volume", cadence: "daily", observedKey: "date", oldest: null },
  discovery: { aliases: ["SIV"], dataRequirements: ["FINRA or SGX daily short sale reports"],
    limitations: ["Regular-session off-exchange volume, not short interest.", "Short volume includes exempt volume.", "One-year history depends on source discovery and ingestion."] },
  options: [
    { key: "scope", type: "enum", description: "FINRA reporting scope.", values: [{ value: "nms" }, { value: "otc" }], defaultValue: "nms", settingKey: "shortVolumeScope" },
    { key: "finra-symbol", type: "string", settingKey: "finraSymbol", description: "Exact case-sensitive FINRA identity, for example ABRpD." },
  ],
  describe: (args) => `Daily short volume | ${args.symbols[0]}`,
  async load(args, ctx) {
    const sgx = sgxVolumeSymbol(args.symbols[0]!);
    if (sgx) {
      if (args.options["finra-symbol"] || args.options.scope === "otc")
        throw new Error("FINRA scope and symbol overrides apply only to US listings.");
      const data = await ctx.apiClient.getSgxShortSales(sgx);
      return {
        sections: [{ title: "SGX executed short sales", columns: [...sgxVolumeColumns], rows: data.points.map(point => ({ ...point })) }],
        empty: sgxVolumeEmpty(data),
        metadata: { symbol: sgx, exchange: data.exchange, source: "Singapore Exchange", reportsReviewed: data.reportsReviewed, newestReport: data.newestReport },
        freshness: { source: "Singapore Exchange", status: "not-a-feed", basis: "executed short sales", cadence: "daily", observedKey: "day", oldest: null },
      };
    }
    const symbol = String(args.options["finra-symbol"] || args.symbols[0]);
    const data = await fetchShortVolume(symbol, args.options.scope === "otc" ? "otc" : "nms", ctx.apiClient);
    return { complete: data.status === "available", errors: data.warnings,
      sections: [{ title: "Daily off-exchange volume", columns: [
        { key: "date", header: "Date" },
        { key: "ratioPercent", header: "Short %", align: "right", format: (value) => volumePercent(value as number | null) },
        { key: "shortVolume", header: "Short volume", align: "right", format: (value) => volumeQuantity(value as string | null) },
        { key: "totalVolume", header: "Total volume", align: "right", format: (value) => volumeQuantity(value as string | null) },
        { key: "shortExemptVolume", header: "Exempt volume", align: "right", format: (value) => volumeQuantity(value as string | null) },
        // A reported day, nearly every day, prints no status; exports keep it.
        { key: "status", header: "Status", textFormat: (value) => value === "Reported" ? "" : String(value ?? ""), omitWhenEmpty: true },
      ], rows: data.history.toReversed().map((point) => ({ ...point, status: volumePointStatus(point) })) }],
      metadata: { ...data },
    };
  },
};
