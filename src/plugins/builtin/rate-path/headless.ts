import type { RateMeeting, RatePathPayload } from "../../../api-client/rates";
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

const STALE_COLUMN: HeadlessPaneColumn = { key: "stale", header: "Data stale", stackPriority: 2, format: yesNo };
// A narrow terminal leaves out the sample count, status, percentile and quote time (the closing line has it),
// then moves the month under each row.
const contractColumns: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Symbol", shrink: false }, { key: "month", header: "Month", shrink: false, stackPriority: 1 },
  { key: "price", header: "Price", align: "right", format: (value) => finiteOrNull(value)?.toFixed(3) ?? "--" },
  { key: "impliedRate", header: "Implied rate", align: "right", format: rate },
  { key: "percentile", header: "Pctl 1Y", align: "right", stackPriority: 4, stackRows: 0, format: pctl },
  { key: "samples", header: "Samples", align: "right", stackPriority: 6, stackRows: 0 },
  { key: "asOf", header: "As of UTC", shrink: false, stackPriority: 3, stackRows: 0, format: timestamp },
  { key: "status", header: "Status", stackPriority: 5, stackRows: 0 }, STALE_COLUMN,
];
/** The text says once which rows are stale, under the tables (`staleNote`), not "no" on every row; JSON keeps the column. */
const textColumns = (columns: HeadlessPaneColumn[]) => columns.filter((column) => column.key !== "stale");

/** "Stale: Effective fed funds rate, ZQX26.CBT.", naming each row whose figure is stale; null when none is. */
function staleNote(data: Pick<RatePathPayload, "current" | "fedFunds" | "sofr">): string | null {
  const stale = [...Object.entries(data.current).filter(([, metric]) => metric.stale).map(([name]) => policyLabel(name)),
    ...[...data.fedFunds, ...data.sofr].filter((contract) => contract.stale && contract.status !== "unavailable").map((contract) => contract.symbol)];
  return stale.length ? `Stale: ${stale.join(", ")}.` : null;
}

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
  // Delayed CME futures quotes.
  freshness: { source: "CME futures", status: "delayed", delayMinutes: CME_FUTURES_DELAY_MINUTES },
  async load(_args, ctx) {
    const data = await fetchRatePath(ctx.apiClient);
    const moves = meetingMoves(data.meetings);
    // The line cites CME futures, so the contracts alone date it and count its stale rows. The policy rates
    // (FRED) keep their own date and stale flag in their table, and the meetings are read from the contracts.
    const contracts = [...data.fedFunds, ...data.sofr].filter((contract) => contract.status !== "unavailable")
      .map(({ asOf, stale }) => ({ asOf, stale }));
    const policyColumns: HeadlessPaneColumn[] = [
      { key: "name", header: "Name", minWidth: 18, format: policyLabel }, { key: "value", header: "Value", align: "right", format: rate },
      { key: "asOf", header: "As of", shrink: false }, { key: "percentile", header: "Pctl 1Y", align: "right", stackPriority: 1, format: pctl },
      { key: "samples", header: "Samples", align: "right", stackPriority: 2, stackRows: 0 }, { key: "stale", header: "Data stale", format: yesNo },
    ];
    const stale = staleNote(data);
    return {
      freshness: { observedKey: "asOf", observations: contracts },
      sections: [
        { title: "Current policy", columns: policyColumns, textColumns: textColumns(policyColumns),
          rows: Object.entries(data.current).map(([name, metric]) => ({ name, ...metric })) },
        // A narrow terminal keeps the moves and change, prints the probabilities of the next two meetings
        // under their rows, and leaves out the rest; a reason a meeting has no rate stays under its row.
        { title: "FOMC meetings", columns: [
          { key: "date", header: "Date", shrink: false },
          { key: "moves", header: "Moves", align: "right", format: (value) => movesText(finiteOrNull(value)) },
          { key: "moveOdds", header: "P(move)", align: "right", format: (value) => moveOddsText(finiteOrNull(value)) },
          { key: "impliedRate", header: "Implied rate", align: "right", stackPriority: 3, stackRows: 0, format: rate },
          { key: "targetMidpoint", header: "Target midpoint", align: "right", stackPriority: 6, stackRows: 0, format: (value) => finiteOrNull(value)?.toFixed(3) ?? "--" },
          { key: "changeBps", header: "Change", align: "right", format: bps },
          { key: "percentile", header: "Pctl 1Y", align: "right", stackPriority: 7, stackRows: 0, format: pctl },
          { key: "samples", header: "Samples", align: "right", stackPriority: 8, stackRows: 0 },
          { key: "asOf", header: "As of UTC", shrink: false, stackPriority: 5, stackRows: 0, format: timestamp },
          { key: "probabilities", header: "Probabilities", shrink: false, stackPriority: 4, stackRows: 2, format: probabilities },
          { key: "method", header: "Method", stackPriority: 9, stackRows: 0 }, { key: "reason", header: "Reason", stackPriority: 10 },
        ], rows: data.meetings.map((meeting) => ({ ...meeting, moves: movesPriced(meeting), moveOdds: moves.get(meeting.date) ?? null })) },
        { title: "Fed funds contracts", columns: contractColumns, textColumns: textColumns(contractColumns), rows: data.fedFunds.map((contract) => ({ ...contract })) },
        { title: "SOFR contracts", columns: contractColumns, textColumns: textColumns(contractColumns), rows: data.sofr.map((contract) => ({ ...contract })) },
      ],
      ...(stale ? { notes: [stale] } : {}),
      errors: data.gaps,
      metadata: { ...data, probabilityBasis: data.probabilityAssumption, units: "percent", complete: data.status === "available" },
    };
  },
};
