/** Frozen, public examples only. Sources and omissions: docs/wall-teaser.md. */
interface WallSample {
  /** Prose samples keep the pane's section/feed shape instead of inventing a table. */
  layout?: "prose";
  columns: readonly [string, string, string];
  rows: readonly (readonly [string, string, string])[];
  /** A summary is meaningful only for the ticker bound to this wall. */
  summary?: boolean;
}

const callSample: WallSample = {
  summary: true,
  columns: ["COMPANY", "DATE", "PERIOD"],
  rows: [["Apple", "2024-10-31", "Q4 2024"]],
};

export const WALL_TEASERS: Readonly<Record<string, WallSample>> = {
  "risk-wall": {
    summary: true,
    layout: "prose",
    columns: ["Section", "Filing", "Filed"],
    rows: [["Macroeconomic and Industry Risks", "AAPL 10-K", "2024-11-01"]],
  },
  "exec-wall": {
    summary: true,
    columns: ["NAME", "TITLE", "TOTAL"],
    rows: [["Tim Cook", "CEO, FY 2024", ""], ["Luca Maestri", "CFO, FY 2024", ""]],
  },
  "ek-wall": {
    summary: true,
    layout: "prose",
    columns: ["Item", "Filing", "Filed"],
    rows: [["Results of operations", "AAPL 8-K", "2024-10-31"]],
  },
  "calls-wall": callSample,
  "calls-transcript-wall": {
    summary: true,
    layout: "prose",
    columns: ["Period", "Company", "Date"],
    rows: [["Q4 2024", "Apple", "2024-10-31"]],
  },
  "diag-wall": {
    layout: "prose",
    columns: ["Coverage", "Source", "Filed"],
    rows: [["Filings", "AAPL annual report", "2024-11-01"]],
  },
  "jobs-wall": {
    summary: true,
    columns: ["TICKER", "OPEN", "NEW 7D"],
    rows: [["AAPL", "", ""]],
  },
  "most-wall": {
    columns: ["TICKER", "CHG%", "RVOL"],
    rows: [["AAPL", "", ""], ["MSFT", "", ""]],
  },
  "flow-wall": {
    columns: ["TICKER", "TYPE", "PREM"],
    rows: [["AAPL", "", ""], ["MSFT", "", ""]],
  },
  "hilo-wall": {
    columns: ["NEW HIGH", "PRICE", "COUNT"],
    rows: [["AAPL", "", ""], ["MSFT", "", ""]],
  },
  "srch-wall": {
    columns: ["TICKER", "TYPE", "DATE"],
    rows: [["AAPL", "10-K", "2024-11-01"]],
  },
  "team": {
    layout: "prose",
    columns: ["Workspace", "Members", "Notes"],
    rows: [["Research", "Shared notes", ""]],
  },
};
