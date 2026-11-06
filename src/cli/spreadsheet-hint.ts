/** Spreadsheet formats people ask for by name, which no command writes: CSV is the one a spreadsheet opens. */
const SPREADSHEET_OPTIONS = new Set(["--xlsx", "--xls", "--excel", "--spreadsheet", "--sheet", "--sheets", "--tsv"]);

/** `quote ^TNX --xlsx`: the error names the formats there are, and the one a spreadsheet opens. */
export function spreadsheetOptionHint(flag: string): string | null {
  return SPREADSHEET_OPTIONS.has(flag.toLowerCase())
    ? "Exports are --csv (opens in Excel and Google Sheets), --json or --ndjson: gloom quote ^TNX --csv > quote.csv."
    : null;
}
