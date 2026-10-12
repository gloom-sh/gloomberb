import type { RateMeeting } from "../../../api-client/rates";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchRatePath } from "./client";
import { meetingMoves, moveOddsText, movesPriced, movesText, rateText } from "./model";
import { finiteOrNull } from "../../../utils/guards";

const rate = (value: unknown) => rateText(finiteOrNull(value));
const pctl = (value: unknown) => finiteOrNull(value)?.toFixed(0) ?? "--";
const bps = (value: unknown) => {
  const bp = finiteOrNull(value);
  return bp == null ? "--" : `${bp > 0 ? "+" : ""}${bp.toFixed(1)}bp`;
};
/** What a text report calls each current policy rate; JSON keeps the keys. */
const POLICY_LABELS: Record<string, string> = {
  effr: "Effective fed funds rate",
  targetLower: "Target range lower",
  targetUpper: "Target range upper",
};
const policyLabel = (value: unknown) => POLICY_LABELS[String(value)] ?? String(value);
const yesNo = (value: unknown) => value === true ? "yes" : value === false ? "no" : "--";
const timestamp = (value: unknown) => typeof value === "string" ? value.replace("T", " ").slice(0, 16) : "--";
const probabilities = (value: unknown) => {
  const outcomes = Array.isArray(value) ? value as RateMeeting["probabilities"] : [];
  return outcomes.length === 0 ? "--"
    : outcomes.map((outcome) => `${outcome.targetMidpoint.toFixed(3)}% ${(outcome.probability * 100).toFixed(0)}%`).join(" / ");
};

const contractColumns: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Symbol" }, { key: "month", header: "Month" },
  { key: "price", header: "Price", align: "right", format: (value) => finiteOrNull(value)?.toFixed(3) ?? "--" },
  { key: "impliedRate", header: "Implied rate", align: "right", format: rate },
  { key: "percentile", header: "Pctl 1Y", align: "right", format: pctl },
  { key: "samples", header: "Samples", align: "right" },
  { key: "asOf", header: "As of UTC", format: timestamp },
  { key: "status", header: "Status" }, { key: "stale", header: "Data stale", format: yesNo },
];

/**
 * How far the fed funds and SOFR futures quotes are held back. The rate-path
 * endpoint does not carry a delay. CME Group's delayed market data is at least
 * 10 minutes behind its real-time feed (its information license agreement
 * defines delayed data as published more than 10 minutes after it is
 * disseminated), and the futures-curve endpoint reports `delayMinutes: 10` on
 * every CME contract.
 */
const CME_FUTURES_DELAY_MINUTES = 10;

export const ratePathHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["WIRP", "FFIP"], dataRequirements: ["Gloom Cloud rate-path endpoint"],
    limitations: ["Conditional two-outcome probabilities.", "SR3 history from hourly trades.", "Maintained FOMC schedule and SEP snapshot."] },
  shape: "bundle", argument: { kind: "none" }, options: [], describe: "US rate path",
  // Delayed CME futures quotes; each contract and policy rate says whether it is stale.
  freshness: { source: "CME futures", status: "delayed", delayMinutes: CME_FUTURES_DELAY_MINUTES },
  async load(_args, ctx) {
    const data = await fetchRatePath(ctx.apiClient);
    const moves = meetingMoves(data.meetings);
    return {
      sections: [
        { title: "Current policy", columns: [
          { key: "name", header: "Name", format: policyLabel }, { key: "value", header: "Value", align: "right", format: rate },
          { key: "asOf", header: "As of" }, { key: "percentile", header: "Pctl 1Y", align: "right", format: pctl },
          { key: "samples", header: "Samples", align: "right" }, { key: "stale", header: "Data stale", format: yesNo },
        ], rows: Object.entries(data.current).map(([name, metric]) => ({ name, ...metric })) },
        { title: "FOMC meetings", columns: [
          { key: "date", header: "Date" },
          { key: "moves", header: "Moves", align: "right", format: (value) => movesText(finiteOrNull(value)) },
          { key: "moveOdds", header: "P(move)", align: "right", format: (value) => moveOddsText(finiteOrNull(value)) },
          { key: "impliedRate", header: "Implied rate", align: "right", format: rate },
          { key: "targetMidpoint", header: "Target midpoint", align: "right", format: (value) => finiteOrNull(value)?.toFixed(3) ?? "--" },
          { key: "changeBps", header: "Change", align: "right", format: bps },
          { key: "percentile", header: "Pctl 1Y", align: "right", format: pctl },
          { key: "samples", header: "Samples", align: "right" }, { key: "asOf", header: "As of UTC", format: timestamp },
          { key: "probabilities", header: "Probabilities", format: probabilities },
          { key: "method", header: "Method" }, { key: "reason", header: "Reason" },
        ], rows: data.meetings.map((meeting) => ({ ...meeting, moves: movesPriced(meeting), moveOdds: moves.get(meeting.date) ?? null })) },
        { title: "Fed funds contracts", columns: contractColumns, rows: data.fedFunds.map((contract) => ({ ...contract })) },
        { title: "SOFR contracts", columns: contractColumns, rows: data.sofr.map((contract) => ({ ...contract })) },
      ],
      errors: data.gaps,
      metadata: { ...data, probabilityBasis: data.probabilityAssumption, units: "percent", complete: data.status === "available" },
    };
  },
};
