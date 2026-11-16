import { afterEach, expect, test } from "bun:test";
import { serializeCsv, setCsvDecimal } from "../utils/csv";
import { captureConsole } from "../test-support/console";
import { DEFAULT_CLI_OPTIONS } from "./options";
import { portableCsv } from "./csv-export";
import { printCliResult, takeCliFileExport } from "./result";

afterEach(() => setCsvDecimal("dot"));

test("one rectangular CSV preserves columns, heterogeneous sections and quoted data line breaks", () => {
  const csv = portableCsv('# section: Trades\nTime,Price\n10:00,100\n\n# section: Details\nMetric,Value\nNote,"line one\n\nline two, with ""quotes"""\n\n# note: Listing the first 100 of 123 trades.');
  expect(csv.split("\n")[0]).toBe("Time,Price,Metric,Value,section,export_notes");
  expect(csv).toContain('10:00,100,,,Trades,note: Listing the first 100 of 123 trades.');
  expect(csv).toContain(',,Note,"line one\n\nline two, with ""quotes""",Details,');
  expect(csv).not.toContain("# section:");
});

test("file and pipe exports retain caveats and warnings, even when quiet suppresses stderr", async () => {
  const result = { data: [{ symbol: "AAPL", value: 100, note: "first line\r\nsecond line" }], warnings: ["Free shows 3 of 64 disclosures."] };
  const render = { exportNotes: ["Regular session only.", "Window: 10:00 to 11:00 New York."] };
  const piped = await captureConsole(() => printCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv", quiet: true }, render));
  await captureConsole(() => printCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv", quiet: true, output: "report.csv" }, render));
  expect(takeCliFileExport()).toBe(piped.stdout);
  expect(piped.stdout.split("\n")[0]).toBe("symbol,value,note,export_notes");
  expect(piped.stdout).toContain('"first line\r\nsecond line"');
  expect(piped.stdout).toContain("Regular session only.");
  expect(piped.stdout).toContain("Free shows 3 of 64 disclosures.");
  expect(piped.stdout).toContain("Window: 10:00 to 11:00 New York.");
  expect(piped.stderr).toBe("");
});

test("a quoted cell ending in a note-like line is data, not an export footer", () => {
  const csv = portableCsv('Value\n"line one\n\n# note: still data"');
  expect(csv).toBe('Value,export_notes\n"line one\n\n# note: still data",');
});

test("a data cell resembling a section marker stays attached to its row", () => {
  expect(portableCsv("Headline,Value\n# section: housing,10")).toBe("Headline,Value,export_notes\n# section: housing,10,");
});

test("decimal-comma exports retain their cells, precision and caveats through the final boundary", () => {
  setCsvDecimal("comma");
  const data = serializeCsv([["Name", "Value"], ["permits; revised", 1.398], ["rate", 17.2], ["amount", 1234.5]]);
  expect(portableCsv(`${data}\n\n# note: Revised; first release differs.`)).toBe(
    'Name;Value;export_notes\n"permits; revised";1,398;"note: Revised; first release differs."\nrate;17,2;"note: Revised; first release differs."\namount;1234,5;"note: Revised; first release differs."',
  );
});

test("decimal-comma exports keep numeric-looking identifiers as typed: only values take the comma", async () => {
  // A spreadsheet would read 0700 as 700, but the export must still write it as the listing's code, and a
  // CIK, an accession number or a long id as they are; the price beside them is a number.
  setCsvDecimal("comma");
  const data = [
    { symbol: "0700", exchange: "HKEX", cik: "0000320193", accession: "0000320193-26-000001", id: "12345678901234567890", price: 412.6 },
    { symbol: "7203", exchange: "TSE", cik: "320193", accession: "0001045810-26-000052", id: "000001", price: 2_634.5 },
  ];
  const { stdout } = await captureConsole(() => printCliResult({ data }, { ...DEFAULT_CLI_OPTIONS, format: "csv", quiet: true }));
  expect(stdout.trimEnd().split("\n")).toEqual([
    "symbol;exchange;cik;accession;id;price;export_notes",
    "0700;HKEX;0000320193;0000320193-26-000001;12345678901234567890;412,6;",
    "7203;TSE;320193;0001045810-26-000052;000001;2634,5;",
  ]);
});

test("source details and multiline caveats are joined inside each export-notes cell", () => {
  const csv = portableCsv("Time,Price\n10:00,100\n10:01,101\n\n# Source: session prices\n# note: Regular session only.", ["First 100 of 123 trades.\r\nWindow: last session."], ["Free shows 3 of 64.\nPreview only."]);
  const lines = csv.split("\n");
  expect(lines).toHaveLength(3);
  for (const line of lines.slice(1)) {
    expect(line).toContain("Source: session prices | note: Regular session only.");
    expect(line).toContain("note: Free shows 3 of 64. | note: Preview only.");
    expect(line).toContain("warning: First 100 of 123 trades. | Window: last session.");
    expect(line).not.toContain("\r");
  }
});

test.each(["dot", "comma"] as const)("%s exports preserve data newlines and literal escapes while normalizing headers", (decimal) => {
  setCsvDecimal(decimal);
  const data = ['line one\r\nline two\nline three\rline four\\n', 'news, with "quotes"'];
  const csv = portableCsv(serializeCsv([["Headline\r\nText", "Notes"], data]));
  expect(csv).toBe(serializeCsv([["Headline\\nText", "Notes", "export_notes"], [...data, ""]]));
});

test("duplicate headers keep every cell without colliding with named suffixes or export metadata", () => {
  const csv = portableCsv("# section: A\nValue,Value,Value_2,export_notes,_export_notes,section,_section\n1,2,3,original,other,sector,legacy\n\n# section: B\nValue,Value\n4,5\n\n# note: caveat");
  expect(csv.split("\n")).toEqual([
    "Value,Value_3,Value_2,export_notes,_export_notes,section,_section,__section,__export_notes",
    "1,2,3,original,other,sector,legacy,A,note: caveat",
    "4,5,,,,,,B,note: caveat",
  ]);
  expect(portableCsv(",\n1,2")).toBe(",_2,export_notes\n1,2,");
  expect(portableCsv('"Value\nName",Value\\nName\n1,2')).toBe("Value\\nName,Value\\nName_2,export_notes\n1,2,");
});
