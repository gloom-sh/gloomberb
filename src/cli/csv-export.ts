import { csvDecimal, serializeCsv } from "../utils/csv";
import { splitCsvFooter } from "./report-tables";

function csvRows(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === separator) {
      row.push(cell); cell = "";
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      rows.push([...row, cell]); row = []; cell = "";
    } else cell += character;
  }
  if (row.length || cell) rows.push([...row, cell]);
  return rows;
}

export function portableCsv(text: string, warnings: readonly string[] = [], extraNotes: readonly string[] = []): string {
  const decimal = csvDecimal();
  const separator = decimal === "comma" ? ";" : ",";
  const { csv, footer } = splitCsvFooter(text);
  const tables: Array<{ section: string; columns: string[]; rows: string[][] }> = [];
  let section = "", current: (typeof tables)[number] | null = null;
  for (const row of csvRows(csv, separator)) {
    if (row.length === 1 && row[0] === "") { current = null; continue; }
    if (!current && row[0]?.startsWith("# section: ")) {
      section = row.join(separator).slice("# section: ".length); current = null; continue;
    }
    if (!current) {
      current = { section, columns: row, rows: [] }; tables.push(current);
    } else current.rows.push(row);
  }
  const columns = [...new Set(tables.flatMap((table) => table.columns))];
  const tagged = tables.length > 1 || tables.some((table) => table.section);
  const sectionKey = columns.includes("section") ? "_section" : "section";
  const notesKey = columns.includes("export_notes") ? "_export_notes" : "export_notes";
  const notes = [...new Set([...footer, ...extraNotes.flatMap((note) => note.split("\n").filter(Boolean).map((line) => `note: ${line}`)), ...warnings.map((warning) => `warning: ${warning}`)])].join("\n");
  const header = [...columns, ...tagged ? [sectionKey] : [], notesKey];
  const rows = tables.flatMap((table) => {
    const indices = columns.map((column) => table.columns.indexOf(column));
    return table.rows.map((row) => [...indices.map((index) => index < 0 ? "" : row[index] ?? ""), ...tagged ? [table.section] : [], notes]);
  });
  if (!rows.length && notes) rows.push([...header.slice(0, -1).map(() => ""), notes]);
  const normalized = decimal === "comma"
    ? [header, ...rows].map((row) => row.map((cell) => /^[+-]?(?:\d+(?:,\d+)?|,\d+)(?:e[+-]?\d+)?%?$/i.test(cell) ? cell.replace(",", ".") : cell))
    : [header, ...rows];
  return serializeCsv(normalized);
}
