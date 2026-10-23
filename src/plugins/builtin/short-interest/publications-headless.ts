import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPublication, type PublicationKind } from "./publications-client";
import { publicationReportColumns, publicationRows } from "./publications-model";

export function publicationHeadless(kind: PublicationKind): HeadlessPaneDefinition<"bundle"> {
  const fails = kind === "ftd";
  const subject = fails ? "Fails to deliver" : "Weekly ATS / non-ATS volume";
  return {
    shape: "bundle",
    argument: { kind: "ticker", description: "US equity ticker.", placeholder: "ticker" },
    usListingsOnly: fails ? "SEC fails to deliver" : "FINRA weekly off-exchange volume",
    freshness: { source: fails ? "SEC" : "FINRA", status: "not-a-feed", basis: fails ? "settlement-date outstanding fails" : "published off-exchange volume",
      cadence: fails ? "twice monthly" : "weekly, published with a delay", observedKey: "date", oldest: null },
    discovery: {
      aliases: fails ? ["FTD", "fails to deliver", "fails-to-deliver"] : ["ATS", "dark pool", "dark pools", "non-ATS", "OTC transparency"],
      dataRequirements: ["Gloom Cloud verified account"],
      limitations: fails ? ["Outstanding fails on each settlement date; never add them across dates.", "Multiple CUSIPs remain separate. An absent record does not establish zero fails."]
        : ["ATS share divides ATS shares by published ATS plus non-ATS shares, not total market volume.", "Missing categories stay blank; published off-exchange volume is not short volume.", "FINRA publishes weeks with a delay, which varies by security tier."],
    },
    describe: (args) => `${subject} | ${args.symbols[0]}`,
    async load(args, ctx) {
      const data = await fetchPublication(args.symbols[0]!, kind, ctx.apiClient);
      return { complete: data.status === "available", errors: data.warnings,
        sections: [{ title: subject, columns: publicationReportColumns(kind), rows: publicationRows(data) }],
        metadata: { ...data },
      };
    },
  };
}
