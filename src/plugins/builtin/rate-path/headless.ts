import type { RateMeeting } from "../../../api-client/rates";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchRatePath } from "./client";
import { rateText } from "./model";

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const rate = (value: unknown) => rateText(num(value));
const pctl = (value: unknown) => num(value)?.toFixed(0) ?? "--";
const bps = (value: unknown) => {
  const bp = num(value);
  return bp == null ? "--" : `${bp > 0 ? "+" : ""}${bp.toFixed(1)}bp`;
};
const timestamp = (value: unknown) => typeof value === "string" ? value.replace("T", " ").slice(0, 16) : "--";
const probabilities = (value: unknown) => {
  const outcomes = Array.isArray(value) ? value as RateMeeting["probabilities"] : [];
  return outcomes.length === 0 ? "--"
    : outcomes.map((outcome) => `${outcome.targetMidpoint.toFixed(3)}% ${(outcome.probability * 100).toFixed(0)}%`).join(" / ");
};

const contractColumns: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Symbol" }, { key: "month", header: "Month" },
  { key: "price", header: "Price", align: "right", format: (value) => num(value)?.toFixed(3) ?? "--" },
  { key: "impliedRate", header: "Implied rate", align: "right", format: rate },
  { key: "percentile", header: "Pctl 1Y", align: "right", format: pctl },
  { key: "samples", header: "Samples", align: "right" },
  { key: "asOf", header: "As of UTC", format: timestamp },
  { key: "status", header: "Status" }, { key: "stale", header: "Stale" },
];

export const ratePathHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["WIRP", "FFIP"], dataRequirements: ["Gloom Cloud rate-path endpoint"],
    limitations: ["Conditional two-outcome probabilities", "Sparse SOFR history", "Maintained FOMC schedule and SEP snapshot"] },
  shape: "bundle", argument: { kind: "none" }, options: [], describe: "US rate path",
  async load(_args, ctx) {
    const data = await fetchRatePath(ctx.apiClient);
    return {
      sections: [
        { title: "Current policy", columns: [
          { key: "name", header: "Name" }, { key: "value", header: "Value", align: "right", format: rate },
          { key: "asOf", header: "As of" }, { key: "percentile", header: "Pctl 1Y", align: "right", format: pctl },
          { key: "samples", header: "Samples", align: "right" }, { key: "source", header: "Source" }, { key: "stale", header: "Stale" },
        ], rows: Object.entries(data.current).map(([name, metric]) => ({ name, ...metric })) },
        { title: "FOMC meetings", columns: [
          { key: "date", header: "Date" }, { key: "impliedRate", header: "Implied rate", align: "right", format: rate },
          { key: "targetMidpoint", header: "Target midpoint", align: "right", format: (value) => num(value)?.toFixed(3) ?? "--" },
          { key: "changeBps", header: "Change", align: "right", format: bps },
          { key: "percentile", header: "Pctl 1Y", align: "right", format: pctl },
          { key: "samples", header: "Samples", align: "right" }, { key: "asOf", header: "As of UTC", format: timestamp },
          { key: "probabilities", header: "Probabilities", format: probabilities },
          { key: "method", header: "Method" }, { key: "reason", header: "Reason" },
        ], rows: data.meetings.map((meeting) => ({ ...meeting })) },
        { title: "Fed funds contracts", columns: contractColumns, rows: data.fedFunds.map((contract) => ({ ...contract })) },
        { title: "SOFR contracts", columns: contractColumns, rows: data.sofr.map((contract) => ({ ...contract })) },
      ],
      errors: data.gaps,
      metadata: { ...data, probabilityBasis: data.probabilityAssumption, units: "percent", complete: data.status === "available" },
    };
  },
};
