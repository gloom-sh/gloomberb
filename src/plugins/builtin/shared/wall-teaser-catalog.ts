/** Authored placeholders only. No sample contains a provider payload or numeric value. */
interface SampleColumn {
  label: string;
  width: number;
  /** Lower numbers stay visible first when the pane is narrow. */
  priority: number;
  align: "left" | "right";
}

type WallSample = { summaryHook?: string } & (
  | { layout: "table"; columns: readonly SampleColumn[] }
  | { layout: "prose"; issuer?: string }
);

const column = (label: string, width: number, priority: number, align: "left" | "right" = "left"): SampleColumn =>
  ({ label, width, priority, align });

const callHook = "Pro shows the transcript, Q&A and guidance";

/** Column labels/order mirror the real panes; lower-priority fields give way at narrow widths. */
export const WALL_TEASERS: Readonly<Record<string, WallSample>> = {
  "risk-wall": {
    layout: "prose", issuer: "AAPL",
    summaryHook: "Pro shows which were added, dropped or rewritten",
  },
  "exec-wall": {
    layout: "table",
    summaryHook: "Pro shows pay for each executive",
    columns: [column("NAME", 18, 0), column("TITLE", 16, 1), column("EQ%", 4, 3, "right"), column("TOTAL", 8, 2, "right")],
  },
  "ek-wall": {
    layout: "prose", issuer: "AAPL",
    summaryHook: "Pro shows each item and what it said",
  },
  "calls-wall": {
    layout: "table", summaryHook: callHook,
    columns: [column("TICKER", 8, 0), column("COMPANY", 12, 4), column("DATE", 10, 1), column("PERIOD", 8, 2), column("LENGTH", 7, 5, "right"), column("TONE", 11, 3)],
  },
  "calls-transcript-wall": { layout: "prose", issuer: "AAPL", summaryHook: callHook },
  "diag-wall": { layout: "prose", issuer: "AAPL" },
  "jobs-wall": {
    layout: "table",
    summaryHook: "Pro shows roles by function and location",
    columns: [column("TICKER", 8, 0), column("COMPANY", 18, 5), column("OPEN", 8, 1, "right"), column("30D", 14, 4, "right"), column("POSTED 30D", 11, 3, "right"), column("NEW 7D", 8, 2, "right"), column("TOP FUNCTION", 18, 6), column("TOP COUNTRY", 12, 7)],
  },
  "most-wall": {
    layout: "table",
    columns: [column("#", 3, 10, "right"), column("TICKER", 8, 0), column("NAME", 12, 9), column("LAST", 10, 7, "right"), column("GAP%", 8, 1, "right"), column("CHG%", 8, 6, "right"), column("PRE VOL", 8, 2, "right"), column("RVOL", 6, 3, "right"), column("VWAP%", 7, 8, "right"), column("FLOAT", 7, 4, "right"), column("EVENT", 6, 5)],
  },
  "flow-wall": {
    layout: "table",
    columns: [column("TIME", 8, 1), column("TICKER", 8, 0), column("TYPE", 8, 2), column("STRIKE", 8, 4, "right"), column("EXP", 6, 5, "right"), column("SIDE", 5, 7), column("SIZE", 7, 6, "right"), column("PREM", 7, 3, "right"), column("V/OI", 6, 8, "right")],
  },
  "hilo-wall": {
    layout: "table",
    columns: [column("NEW HIGH", 10, 0), column("PRICE", 10, 1, "right"), column("COUNT", 6, 2, "right")],
  },
  "srch-wall": {
    layout: "table",
    columns: [column("TICKER", 8, 0), column("TYPE", 7, 2), column("DATE", 10, 3), column("TITLE", 14, 1), column("MATCH", 18, 4)],
  },
  "team": { layout: "prose" },
};
