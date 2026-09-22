import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchRatePath } from "./client";

export const ratePathHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["WIRP", "FFIP"], dataRequirements: ["Gloom Cloud rate-path endpoint"],
    limitations: ["Conditional two-outcome probabilities", "Sparse SOFR history", "Maintained FOMC schedule and SEP snapshot"] },
  shape: "bundle", argument: { kind: "none" }, options: [], describe: "US rate path",
  async load(_args, ctx) {
    const data = await fetchRatePath(ctx.apiClient);
    return {
      sections: [
        { title: "Current policy", rows: Object.entries(data.current).map(([name, metric]) => ({ name, ...metric })) },
        { title: "FOMC meetings", rows: data.meetings.map((meeting) => ({ ...meeting })) },
        { title: "Fed funds contracts", rows: data.fedFunds.map((contract) => ({ ...contract })) },
        { title: "SOFR contracts", rows: data.sofr.map((contract) => ({ ...contract })) },
      ],
      errors: data.gaps,
      metadata: { ...data, probabilityBasis: data.probabilityAssumption, units: "percent", complete: data.status === "available" },
    };
  },
};
