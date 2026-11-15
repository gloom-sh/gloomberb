import { expect, test } from "bun:test";
import { captureConsole } from "../test-support/console";
import { DEFAULT_CLI_OPTIONS } from "./options";
import { portableCsv } from "./csv-export";
import { printCliResult, takeCliFileExport } from "./result";

test("one rectangular CSV preserves columns, heterogeneous sections and quoted multiline cells", () => {
  const csv = portableCsv('# section: Trades\nTime,Price\n10:00,100\n\n# section: Details\nMetric,Value\nNote,"line one\n\nline two, with ""quotes"""\n\n# note: Listing the first 100 of 123 trades.');
  expect(csv.split("\n")[0]).toBe("Time,Price,Metric,Value,section,export_notes");
  expect(csv).toContain('10:00,100,,,Trades,note: Listing the first 100 of 123 trades.');
  expect(csv).toContain(',,Note,"line one\n\nline two, with ""quotes""",Details,');
  expect(csv).not.toContain("# section:");
});

test("file and pipe exports retain caveats and warnings, even when quiet suppresses stderr", async () => {
  const result = { data: [{ symbol: "AAPL", value: 100 }], warnings: ["Free shows 3 of 64 disclosures."] };
  const render = { exportNotes: ["Regular session only.", "Window: 10:00 to 11:00 New York."] };
  const piped = await captureConsole(() => printCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv", quiet: true }, render));
  await captureConsole(() => printCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv", quiet: true, output: "report.csv" }, render));
  expect(takeCliFileExport()).toBe(piped.stdout);
  expect(piped.stdout.split("\n")[0]).toBe("symbol,value,export_notes");
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
