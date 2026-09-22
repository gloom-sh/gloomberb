import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchFuturesCurve } from "./client";
import { normalizeCurveRoot } from "./model";

export const futuresCurveHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["CTM"], dataRequirements: ["Gloom Cloud futures curve endpoint"],
    limitations: ["Yahoo catalogues can be incomplete", "Ghosts and percentiles use the same listed contracts", "Cboe VIX is daily settlement"] },
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "root", description: "FUT root such as CL, ES, ZN or VX. Defaults to ES." },
  options: [], describe: (args) => `Futures curve ${args.argument || "ES"}`,
  async load(args, ctx) {
    const input = args.argument || "ES";
    const root = normalizeCurveRoot(input);
    if (!root) throw new Error(`Unsupported futures root: ${input}`);
    const data = await fetchFuturesCurve(root, ctx.apiClient);
    return {
      sections: [
        { title: "Contracts", rows: data.contracts.map((row) => ({ ...row })) },
        { title: "Front spread", rows: [{ ...data.slope }] },
        ...data.ghosts.map((ghost) => ({ title: `${ghost.label} same-contract history`, rows: ghost.points.map((point) => ({ ...point })) })),
      ],
      errors: data.gaps,
      metadata: { ...data, complete: data.status === "available", percentileBasis: "Same-contract observations within one year; actual sample start/end retained" },
    };
  },
};
