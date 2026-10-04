import type { CpiRow } from "../../../api-client/cpi";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCpiBoard } from "./client";
import { cpiHeaderLine, cpiMonth, cpiRowOption, cpiRows } from "./model";

/** Two decimals; a value that rounds to zero reads 0.00, never -0.00. */
const percent = (value: unknown) => typeof value === "number" ? (Number(value.toFixed(2)) === 0 ? "0.00" : value.toFixed(2)) : "--";
const weight = (value: unknown) => typeof value === "number" ? value.toFixed(3) : "--";
const text = (value: unknown) => typeof value === "string" ? value : "--";

/** One row per component in the release's order; numbers stay raw for JSON, rounded for text. */
function reportRow(row: CpiRow, indent = true) {
  return {
    id: row.id, component: `${indent ? "  ".repeat(row.depth) : ""}${row.label}`, depth: row.depth, weight: row.weight, monthChange: row.change,
    annualized3m: row.annualized3m, annualized6m: row.annualized6m, yearChange: row.yoy,
    contributionMonth: row.contribution, contributionYear: row.contributionYoy, read: row.read,
  };
}

const SUMMARY_COLUMNS = [
  { key: "component", header: "Component" },
  { key: "weight", header: "Weight %", align: "right" as const, format: weight },
  { key: "monthChange", header: "M/M % SA", align: "right" as const, format: percent },
  { key: "annualized3m", header: "3M ann %", align: "right" as const, format: percent },
  { key: "annualized6m", header: "6M ann %", align: "right" as const, format: percent },
  { key: "yearChange", header: "Y/Y % NSA", align: "right" as const, format: percent },
  { key: "contributionMonth", header: "M/M pts", align: "right" as const, format: percent },
  { key: "contributionYear", header: "Y/Y pts", align: "right" as const, format: percent },
];

/** The selected row's months against the headline's year over year: the chart as a table. */
function historyRows(row: CpiRow, headline: CpiRow | null) {
  const headlineYear = new Map((headline?.history ?? []).map(([month, , yoy]) => [month, yoy]));
  return [...row.history].reverse().map(([month, change, yoy]) => ({
    month, monthChange: change, yearChange: yoy, headlineYearChange: headlineYear.get(month) ?? null,
  }));
}

/** `CPI` reads every component; a component argument adds its monthly history. */
export const cpiHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "free-text", optional: true, placeholder: "component", description: "A component such as shelter, core, gasoline or supercore; omit for the table." },
  options: [],
  discovery: { aliases: ["CPI", "ECAN"], dataRequirements: ["Gloom Cloud US consumer price history"],
    limitations: ["Monthly data, published by BLS at 08:30 ET on its release schedule",
      "Weights and contributions are BLS's for the month; services ex shelter is computed from two BLS series",
      "No October 2025 index was published, so changes that need it are empty"] },
  describe: "US consumer prices by component",
  async load(args) {
    const data = await fetchCpiBoard();
    const header = cpiHeaderLine(data.release) ?? "US consumer prices";
    const headline = data.rows.find((row) => row.code === "SA0") ?? null;
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument;
    const metadata = { ...data, complete: data.status === "available" };
    if (argument) {
      const option = cpiRowOption(argument);
      const row = option ? data.rows.find((entry) => entry.id === option.value) : null;
      if (!row) throw new Error("Use a component such as shelter, core, gasoline or supercore");
      return {
        sections: [
          { title: header, columns: [...SUMMARY_COLUMNS, { key: "read", header: "Read", format: text }], rows: [reportRow(row, false)] },
          { title: `${row.label} by month to ${data.release.period ? cpiMonth(data.release.period) : "date"}`,
            columns: [{ key: "month", header: "Month" }, { key: "monthChange", header: "M/M % SA", align: "right" as const, format: percent },
              { key: "yearChange", header: "Y/Y % NSA", align: "right" as const, format: percent },
              ...(headline && headline.id !== row.id ? [{ key: "headlineYearChange", header: "All items Y/Y %", align: "right" as const, format: percent }] : [])],
            rows: historyRows(row, headline) },
        ],
        errors: data.gaps,
        metadata: { ...metadata, rows: [row] },
      };
    }
    return {
      sections: [{ title: header, columns: SUMMARY_COLUMNS, rows: cpiRows(data).map((row) => reportRow(row)) }],
      errors: data.gaps,
      metadata,
    };
  },
};
