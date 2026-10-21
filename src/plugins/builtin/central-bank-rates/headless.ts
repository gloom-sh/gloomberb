import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { CENTRAL_BANKS, centralBankNames } from "../../../utils/central-banks";
import { fetchCentralBankRates } from "./client";
import { hasNoPolicyRate, policyExportRow, policyNextMeetingText, policyNotices } from "./model";

/** The citation block every export row carries, headed as a journalist's spreadsheet names it. */
const CITATION_FIELDS = [
  "central_bank", "source", "series_id", "source_url", "as_of",
  "next_meeting", "next_meeting_kind", "next_meeting_source_url", "next_meeting_verified_at", "citation",
];

const BOARD_COLUMNS: HeadlessPaneColumn[] = [
  { key: "label", header: "Jurisdiction", shrink: false }, { key: "valueText", header: "Rate", align: "right" },
  { key: "changeText", header: "Last move", align: "right" }, { key: "lastChangeDate", header: "Change observed", shrink: false },
  { key: "percentileValue", header: "Pctl 1Y", align: "right", stackPriority: 1, format: (value) => value == null ? "--" : Number(value).toFixed(0) },
  // A narrow terminal moves the instrument, status and percentile under each row first.
  { key: "asOf", header: "As of", shrink: false }, { key: "status", header: "Status", stackPriority: 2 }, { key: "instrument", header: "Instrument", stackPriority: 3 },
];

export const centralBankRatesHeadless: HeadlessPaneDefinition<"bundle"> = {
  // A bank's name or short form typed as a function (`fn ECB`, `fn BOJ`) points here, unless a function owns the word (FOMC is WIRP).
  discovery: { aliases: ["CBR", "CBRT"], suggestFor: CENTRAL_BANKS.flatMap(centralBankNames), dataRequirements: ["Gloom Cloud central-bank-rates endpoint"],
    limitations: ["Published policy observations with individual dates.", "Policy instruments differ.",
      "Next meetings come from each bank's published calendar; SAMA publishes none, and China's date is the monthly LPR fixing."] },
  shape: "bundle",
  options: [{ key: "history", shot: { reportOnly: "adds each row's one-year history to the JSON report" }, type: "boolean", defaultValue: false, description: "Add each row's one-year daily history to the JSON metadata." }],
  argument: { kind: "none" }, describe: "Policy rates of the G20, SNB, Norges Bank, Riksbank and RBNZ",
  // Each row is dated apart (BIS reports weekly, some banks weeks late), so exports cite the oldest as well.
  freshness: { source: "BIS and FRED", publisher: "each row's central_bank, via BIS and FRED", status: "not-a-feed",
    basis: "published policy rates", citeOldest: true },
  async load(args, ctx) {
    const data = await fetchCentralBankRates(ctx.apiClient);
    const errors = policyNotices(data);
    const complete = data.status === "available" && errors.length === 0;
    // A row says "stale" in its status, not in a `stale` flag: hand the report its rows' staleness so its status line and a capture count them.
    const observations = data.rows.filter((row) => row.status !== "unavailable")
      .map((row) => ({ asOf: row.asOf, stale: row.status === "stale" }));
    const exported = data.rows.map(policyExportRow);
    // A caveat on most rows ("Change date is the first observed new level...") is said once for the report.
    const shared = [...new Set(exported.flatMap((row) => row.notes))]
      .filter((note) => exported.filter((row) => row.notes.includes(note)).length > 1);
    const rows = exported.map((row) => ({ ...row, notes: row.notes.filter((note) => !shared.includes(note)) }));
    return { complete, freshness: { observations }, ...(shared.length ? { notes: shared } : {}), sections: [{ title: "Policy rates",
      columns: [...BOARD_COLUMNS, ...CITATION_FIELDS.map((key): HeadlessPaneColumn => ({ key, header: key, literalHeader: true }))],
      rows,
      // The text keeps the board's table; each row's bank, next meeting and citation go under it.
      textColumns: [...BOARD_COLUMNS, { key: "detail", header: "Detail", underRow: true }],
      textRows: rows.map((row, index) => {
        const source = data.rows[index]!;
        return { ...row, detail: `${row.central_bank ?? "No central bank"} · ${policyNextMeetingText(source)}\n${row.citation}` };
      }),
    }], errors, unavailableSymbols: data.rows.filter((row) => row.status === "unavailable" && !hasNoPolicyRate(row)).map((row) => row.id),
    // A year of daily history per row is most of the payload, so JSON carries it only on request.
    metadata: args.options.history === true ? { ...data, complete }
      : { generatedAt: data.generatedAt, status: data.status, gaps: data.gaps, complete } };
  },
};
