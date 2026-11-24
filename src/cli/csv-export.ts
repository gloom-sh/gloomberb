import { cliText } from "../utils/cli-output";
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

export function portableCsv(text: string, warnings: readonly string[] = [], extraNotes: readonly string[] = [], trailingColumns: readonly string[] = []): string {
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
      current = { section, columns: row.map((name) => name.replace(/\r\n?|\n/g, "\\n")), rows: [] }; tables.push(current);
    } else current.rows.push(row);
  }
  const usedNames = new Set(tables.flatMap((table) => table.columns));
  const variants = new Map<string, string[]>();
  for (const table of tables) {
    const occurrences = new Map<string, number>();
    table.columns = table.columns.map((name) => {
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      const names = variants.get(name) ?? [name];
      if (names[occurrence] === undefined) {
        let suffix = occurrence + 1;
        while (usedNames.has(`${name}_${suffix}`)) suffix++;
        names[occurrence] = `${name}_${suffix}`;
        usedNames.add(names[occurrence]!);
      }
      variants.set(name, names);
      return names[occurrence]!;
    });
  }
  const columns = [...new Set(tables.flatMap((table) => table.columns))];
  const tagged = tables.length > 1 || tables.some((table) => table.section);
  let sectionKey = "section", notesKey = "export_notes";
  while (usedNames.has(sectionKey)) sectionKey = `_${sectionKey}`;
  while (usedNames.has(notesKey)) notesKey = `_${notesKey}`;
  const notes = [...new Set([...footer, ...extraNotes.flatMap((note) => note.split(/\r\n?|\n/).filter(Boolean).map((line) => `note: ${line}`)), ...warnings.map((warning) => `warning: ${warning}`)].map((note) => cliText(note.replace(/\r\n?|\n/g, " | "))))].join(" | ");
  const trailing = columns.filter((column) => trailingColumns.includes(column));
  const leading = columns.filter((column) => !trailingColumns.includes(column));
  const header = [...leading, ...tagged ? [sectionKey] : [], notesKey, ...trailing];
  const rows = tables.flatMap((table) => {
    const leadingIndices = leading.map((column) => table.columns.indexOf(column));
    const trailingIndices = trailing.map((column) => table.columns.indexOf(column));
    return table.rows.map((row) => [...leadingIndices.map((index) => row[index] ?? ""), ...tagged ? [table.section] : [], notes,
      ...trailingIndices.map((index) => row[index] ?? "")]);
  });
  if (!rows.length && notes) rows.push(header.map((column) => column === notesKey ? notes : ""));
  const records = [header, ...rows];
  const normalized = decimal === "comma"
    ? records.map((row) => row.map((cell) => /^[+-]?(?:\d+(?:,\d+)?|,\d+)(?:e[+-]?\d+)?%?$/i.test(cell) ? cell.replace(",", ".") : cell))
    : records;
  return serializeCsv(normalized);
}
