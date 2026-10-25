import { describe, expect, test } from "bun:test";
import { printCliResult, serializeCliError, serializeCliResult, type CliResultRenderOptions } from "./result";
import { printCliError } from "./errors";
import { captureConsole } from "../test-support/console";
import { setCliColorEnabledOverride, setCliPlainOverride } from "../utils/cli-output";
import type { CliGlobalOptions } from "./options";
import type { ReportFreshness } from "./pane-functions/freshness";

const baseOptions: CliGlobalOptions = {
  format: "text",
  quiet: false,
  color: null,
  plain: null,
  refresh: false,
  dryRun: false,
  yes: false,
};

describe("serializeCliResult", () => {
  test("--limit keeps the first rows and says when they are a series' oldest; --tail keeps the newest in printed order", () => {
    const ascending = [{ date: "2026-10-05" }, { date: "2026-10-06" }, { date: "2026-10-07" }, { date: "2026-10-08" }];
    const descending = [...ascending].reverse();
    const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
    const dates = (data: unknown[], options: Partial<CliGlobalOptions>, render: CliResultRenderOptions = { dateKey: "date" }) => {
      const envelope = JSON.parse(serializeCliResult({ data }, { ...baseOptions, format: "json", ...options }, render));
      return { dates: envelope.data.map((row: { date: string }) => row.date), rows: envelope.metadata?.rows };
    };

    const note = "showing the oldest 2 of 4 rows; --tail 2 for the latest";
    expect(dates(ascending, { limit: 2 })).toEqual({
      dates: ["2026-10-05", "2026-10-06"], rows: { shown: 2, total: 4, kept: "oldest", note },
    });
    expect(plain(serializeCliResult({ data: ascending }, { ...baseOptions, limit: 2 }, { dateKey: "date" })).split("\n").at(-1)).toBe(note);
    expect(dates(ascending, { tail: 2 })).toEqual({ dates: ["2026-10-07", "2026-10-08"], rows: { shown: 2, total: 4, kept: "newest" } });
    // Newest first, the newest are the first rows: --tail and --limit agree, and nothing needs saying.
    expect(dates(descending, { tail: 2 })).toEqual({ dates: ["2026-10-08", "2026-10-07"], rows: { shown: 2, total: 4, kept: "newest" } });
    expect(dates(descending, { limit: 2 }).dates).toEqual(["2026-10-08", "2026-10-07"]);
    expect(serializeCliResult({ data: descending }, { ...baseOptions, limit: 2 }, { dateKey: "date" })).not.toContain("--tail");
    // A list with no dates: the last rows, and a command's own default cut.
    expect(dates(ascending, { tail: 1 }, {}).dates).toEqual(["2026-10-08"]);
    expect(dates(ascending, {}, { dateKey: "date", defaultLimit: 3 }).rows).toMatchObject({ shown: 3, total: 4, kept: "oldest" });
    expect(dates(ascending, {}).rows).toBeUndefined();
  });

  test("includes display column metadata in JSON envelopes", () => {
    const output = serializeCliResult(
      { data: [{ quote: { symbol: "AAPL", price: 123 } }] },
      { ...baseOptions, format: "json" },
      {
        rows: (data) => data.map((row) => row.quote),
        columns: [
          { key: "symbol", header: "Symbol" },
          { key: "price", header: "Last", align: "right" },
        ],
      },
    );
    expect(JSON.parse(output)).toEqual({
      ok: true,
      data: [{ quote: { symbol: "AAPL", price: 123 } }],
      columns: [
        { key: "symbol", header: "Symbol" },
        { key: "price", header: "Last", align: "right" },
      ],
    });
  });

  test("renders CSV with provided column order", () => {
    const output = serializeCliResult(
      { data: [{ symbol: "AAPL", name: "Apple, Inc." }] },
      { ...baseOptions, format: "csv" },
      {
        columns: [
          { key: "symbol", header: "Symbol" },
          { key: "name", header: "Name" },
        ],
      },
    );
    expect(output).toBe('Symbol,Name\nAAPL,"Apple, Inc."');
  });

  test("prints one record as aligned label/value lines while CSV keeps raw keys and values", () => {
    const data = { dataDir: "/tmp/gloom", changePercent: 0.9499999999999886, enabled: true, tags: [] };

    const text = serializeCliResult({ data }, baseOptions);
    expect(text.split("\n")).toEqual([
      "Data Dir        /tmp/gloom",
      "Change Percent  0.95",
      "Enabled         yes",
      "Tags            none",
    ]);
    expect(serializeCliResult({ data }, { ...baseOptions, format: "csv" }))
      .toBe("dataDir,changePercent,enabled,tags\n/tmp/gloom,0.9499999999999886,true,[]");
  });

  test("text-only columns reshape the table but leave CSV on the data keys", () => {
    const data = [{ left: "AAPL", right: "MSFT", correlation: 0.1234, empty: "" }];
    const options = {
      textColumns: [
        { key: "left", header: "Symbols", value: (row: Record<string, unknown>) => `${row.left} / ${row.right}` },
        { key: "correlation", header: "Correlation" },
        { key: "empty", header: "Empty" },
      ],
    };

    expect(serializeCliResult({ data }, baseOptions, options).split("\n")[0]).toBe("Symbols      Correlation");
    expect(serializeCliResult({ data }, { ...baseOptions, format: "csv" }, options))
      .toBe("left,right,correlation,empty\nAAPL,MSFT,0.1234,");
  });

  test("shows an empty-state message instead of an empty table", () => {
    expect(serializeCliResult({ data: [] }, baseOptions, { empty: "No alerts." })).toBe("No alerts.");
  });

  // A spreadsheet reads every cell of a figure column as a number, and every row says why it has none.
  test("exports write a figure that is no number empty, with the reason in a status column that is there with rows or without", () => {
    const columns = [{ key: "symbol", header: "Symbol" }, { key: "last", header: "Last" }, { key: "move", header: "Chg%" }];
    const render: CliResultRenderOptions = { columns, exportStatus: (row) => typeof row.error === "string" ? row.error : null };
    const rows = [
      { symbol: "AAPL", last: 349.8, move: 0.45 },
      { symbol: "STALE", last: 12, move: Number.NaN },
      { symbol: "ZZZZQQ", last: null, move: null, error: "Not a ticker: ZZZZQQ." },
    ];
    const csv = serializeCliResult({ data: rows }, { ...baseOptions, format: "csv" }, render);
    expect(csv).toBe("Symbol,Last,Chg%,status\nAAPL,349.8,0.45,\nSTALE,12,,Chg%: not available\nZZZZQQ,,,Not a ticker: ZZZZQQ.");
    expect(serializeCliResult({ data: [] }, { ...baseOptions, format: "csv" }, render)).toBe("Symbol,Last,Chg%,status");
    const ndjson = serializeCliResult({ data: rows }, { ...baseOptions, format: "ndjson" }, render).split("\n").map((line) => JSON.parse(line));
    expect(ndjson.map((row) => [row.move, row.status])).toEqual([[0.45, null], [null, "move: not available"], [null, "Not a ticker: ZZZZQQ."]]);
  });

  test("an infinity is written empty like NaN, and a table with a Status column of its own gets value_status", () => {
    const render: CliResultRenderOptions = {
      columns: [{ key: "symbol", header: "Symbol" }, { key: "status", header: "Status" }, { key: "ratio", header: "Ratio" }],
      exportStatus: () => null,
    };
    const rows = [{ symbol: "A", status: "open", ratio: 1.5 }, { symbol: "B", status: "closed", ratio: Infinity }, { symbol: "C", status: "open", ratio: -Infinity }];
    expect(serializeCliResult({ data: rows }, { ...baseOptions, format: "csv" }, render))
      .toBe("Symbol,Status,Ratio,value_status\nA,open,1.5,\nB,closed,,Ratio: not available\nC,open,,Ratio: not available");
    const ndjson = serializeCliResult({ data: rows }, { ...baseOptions, format: "ndjson" }, render).split("\n").map((line) => JSON.parse(line));
    // The row's own status stays beside the reason, which is under the other name.
    expect(ndjson.map((row) => [row.status, row.ratio, row.value_status])).toEqual([["open", 1.5, null], ["closed", null, "ratio: not available"], ["open", null, "ratio: not available"]]);
  });

  test("--tail and --limit keep each series' own rows when rows of several symbols share one table", () => {
    const bars = ["AAPL", "MSFT"].flatMap((symbol) => ["2026-10-21", "2026-10-22", "2026-10-23"].map((date) => ({ symbol, date })));
    const kept = (options: Partial<CliGlobalOptions>) => JSON.parse(serializeCliResult({ data: bars }, { ...baseOptions, format: "json", ...options },
      { dateKey: "date", seriesKey: "symbol" }));
    expect(kept({ tail: 1 }).data).toEqual([{ symbol: "AAPL", date: "2026-10-23" }, { symbol: "MSFT", date: "2026-10-23" }]);
    expect(kept({ limit: 1 })).toMatchObject({
      data: [{ symbol: "AAPL", date: "2026-10-21" }, { symbol: "MSFT", date: "2026-10-21" }],
      metadata: { rows: { shown: 2, total: 6, kept: "oldest", note: "showing the oldest 1 row of each symbol; --tail 1 for the latest" } },
    });
  });

  test("renders NDJSON rows", () => {
    const output = serializeCliResult(
      { data: [{ symbol: "AAPL" }, { symbol: "MSFT" }] },
      { ...baseOptions, format: "ndjson" },
    );
    expect(output).toBe('{"symbol":"AAPL"}\n{"symbol":"MSFT"}');
  });

  test("ends text with the source line, CSV with the export footer, cites it in JSON and keeps NDJSON to rows", () => {
    const freshness: ReportFreshness = {
      source: "Gloom Cloud", asOf: "2026-10-09T13:22:00.000Z", status: "delayed", delayMinutes: 15,
      retrievedAt: "2026-10-09T13:30:00.000Z",
    };
    const result = { data: [{ symbol: "AAPL" }], metadata: { range: "1Y" }, freshness };
    const line = "Source: Gloom Cloud · Fri 9 Oct 2026 13:22 UTC · 15 min delayed";
    const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain(serializeCliResult(result, baseOptions)).split("\n").slice(-2)).toEqual(["", line]);
    expect(plain(serializeCliResult(result, baseOptions, { text: () => "Report" }))).toBe(`Report\n\n${line}`);
    const source = {
      name: "Gloom Cloud", publisher: null, observationDate: "2026-10-09T13:22:00.000Z", publicationTime: null,
      retrievalTime: "2026-10-09T13:30:00.000Z",
    };
    const json = JSON.parse(serializeCliResult(result, { ...baseOptions, format: "json" }));
    expect(json.metadata).toEqual({ range: "1Y", freshness });
    expect(json.source).toEqual(source);
    // Every row ends with what it is: the symbol it carries, and the source and as-of the footer cites.
    expect(serializeCliResult(result, { ...baseOptions, format: "csv" }).split("\n")).toEqual([
      "symbol,symbol_or_series,currency_or_unit,interval,source,as_of",
      "AAPL,AAPL,,,Gloom Cloud,2026-10-09T13:22:00.000Z",
      "", `# ${line}`, "# Publisher: not published", "# Observation date: 2026-10-09T13:22:00.000Z",
      "# Publication time: not published", "# Retrieval time: 2026-10-09T13:30:00.000Z",
    ]);
    expect(JSON.parse(serializeCliResult(result, { ...baseOptions, format: "ndjson" }))).toEqual({
      symbol: "AAPL", symbol_or_series: "AAPL", currency_or_unit: null, interval: null, source: "Gloom Cloud", as_of: "2026-10-09T13:22:00.000Z",
    });
    // A command's own identity wins over the row's fields, and its notes close the CSV.
    const declared = serializeCliResult(result, { ...baseOptions, format: "csv" }, {
      exportIdentity: { symbolOrSeries: "DEXSFUS", currencyOrUnit: "bp", interval: "daily" },
      exportNotes: ["Series begins 1980-01-02."],
    }).split("\n");
    expect(declared[1]).toBe("AAPL,DEXSFUS,bp,daily,Gloom Cloud,2026-10-09T13:22:00.000Z");
    expect(declared.at(-1)).toBe("# note: Series begins 1980-01-02.");
    // Data that states its own freshness (an `fn` report) is cited in JSON without a second copy in metadata or text.
    const cited = { data: { rows: [] }, exportFreshness: freshness };
    expect(JSON.parse(serializeCliResult(cited, { ...baseOptions, format: "json" }))).toEqual({ ok: true, data: { rows: [] }, source });
    expect(serializeCliResult(cited, baseOptions, { text: () => "Report" })).toBe("Report");
  });
});

test("plain text keeps every column with a dash in the empty cells, and JSON, CSV and NDJSON are the same bytes plain or not", () => {
  // Two econ queries: the second fills no Forecast, which a decorated table leaves out.
  const columns = [
    { key: "event", header: "Event" },
    { key: "forecast", header: "Forecast" },
    { key: "prior", header: "Prior" },
  ];
  const rows = [{ event: "Banxico Interest Rate Decision", forecast: null, prior: "6.50%" }];
  const render = { columns, rows: (data: typeof rows) => data };
  const result = { data: rows, freshness: { source: "Gloom Cloud", asOf: "2026-10-23T15:48:00Z", status: "not-a-feed", basis: "calendar" } as ReportFreshness };
  const print = (plain: boolean, format: CliGlobalOptions["format"]) => {
    setCliPlainOverride(plain);
    setCliColorEnabledOverride(false);
    try {
      return serializeCliResult(result, { ...baseOptions, format }, render);
    } finally {
      setCliPlainOverride(null);
      setCliColorEnabledOverride(null);
    }
  };
  expect(print(false, "text").split("\n").slice(0, 3)).toEqual([
    "Event                           Prior",
    "──────────────────────────────  ─────",
    "Banxico Interest Rate Decision  6.50%",
  ]);
  expect(print(true, "text").split("\n").slice(0, 2)).toEqual([
    "Event                           Forecast  Prior",
    "Banxico Interest Rate Decision  —         6.50%",
  ]);
  for (const format of ["json", "csv", "ndjson"] as const) expect(print(true, format)).toBe(print(false, format));
});

test("a CSV or NDJSON export a --limit cut says so: CSV in a closing note line, NDJSON on stderr, rows alone on stdout", async () => {
  const rows = [{ date: "2026-10-05" }, { date: "2026-10-06" }, { date: "2026-10-07" }];
  const note = "showing the oldest 2 of 3 rows; --tail 2 for the latest";
  const freshness = { source: "Gloom Cloud", asOf: "2026-10-23T15:48:00Z", status: "not-a-feed", basis: "calendar" } as ReportFreshness;
  const render: CliResultRenderOptions = { dateKey: "date", exportNotes: ["kept by the command"] };
  // With or without a cited source the note follows the rows, ahead of the command's own notes.
  const cited = serializeCliResult({ data: rows, freshness }, { ...baseOptions, format: "csv", limit: 2 }, render).split("\n");
  expect(cited.slice(0, 3)).toEqual(["date,symbol_or_series,currency_or_unit,interval,source,as_of", "2026-10-05,,,,Gloom Cloud,2026-10-23T15:48:00Z", "2026-10-06,,,,Gloom Cloud,2026-10-23T15:48:00Z"]);
  expect(cited.slice(-3)).toEqual([expect.stringContaining("# Retrieval time"), `# note: ${note}`, "# note: kept by the command"]);
  expect(serializeCliResult({ data: rows }, { ...baseOptions, format: "csv", limit: 2 }, { dateKey: "date" })).toBe(`date\n2026-10-05\n2026-10-06\n\n# note: ${note}`);
  // Rows that were all kept have nothing to say, and neither does a newest-first series' newest rows.
  expect(serializeCliResult({ data: rows }, { ...baseOptions, format: "csv", limit: 3 }, { dateKey: "date" })).not.toContain("note");
  expect(serializeCliResult({ data: [...rows].reverse() }, { ...baseOptions, format: "csv", limit: 2 }, { dateKey: "date" })).not.toContain("note");
  // NDJSON has no place for a line among its rows: they stay rows alone, and the note goes where warnings do.
  const printed = await captureConsole(() => printCliResult({ data: rows }, { ...baseOptions, format: "ndjson", limit: 2 }, { dateKey: "date" }));
  expect(printed.stdout).toBe('{"date":"2026-10-05"}\n{"date":"2026-10-06"}');
  expect(printed.stderr).toBe(`note: ${note}`);
  const whole = await captureConsole(() => printCliResult({ data: rows }, { ...baseOptions, format: "ndjson" }, { dateKey: "date" }));
  expect(whole.stderr).toBe("");
  // A command's own notes (where a stored calendar starts) follow the cut on stderr, as CSV closes with them; --quiet silences both.
  const noted = await captureConsole(() => printCliResult({ data: rows }, { ...baseOptions, format: "ndjson", limit: 2 }, { dateKey: "date", exportNotes: ["kept by the command", "and another"] }));
  expect(noted.stdout).toBe('{"date":"2026-10-05"}\n{"date":"2026-10-06"}');
  expect(noted.stderr).toBe(`note: ${note}\nnote: kept by the command\nnote: and another`);
  const quiet = await captureConsole(() => printCliResult({ data: rows }, { ...baseOptions, format: "ndjson", limit: 2, quiet: true }, { dateKey: "date", exportNotes: ["kept by the command"] }));
  expect(quiet.stderr).toBe("");
});

test("plain output words the arrows of its tables and nothing else: a note, an answer or an error prints as written", async () => {
  setCliPlainOverride(true);
  setCliColorEnabledOverride(false);
  try {
    const note = "margin ↑ → buy\n→ keep ←/→ in mind";
    const { stdout, stderr } = await captureConsole(() => {
      printCliResult({ data: { text: note }, warnings: ["Read as typed: a ↓ b"] }, baseOptions, { text: (data) => data.text });
      printCliResult({ data: [{ move: "+25bp ↑", text: "a → b" }] }, baseOptions);
      printCliError(new Error("Not found: x → y"), baseOptions);
    });
    expect(stdout.split("\n")).toEqual(["margin ↑ → buy", "→ keep ←/→ in mind", "Move      Text", "+25bp up  a to b"]);
    expect(stderr).toBe("warning: Read as typed: a ↓ b\nerror: Not found: x → y");
  } finally {
    setCliPlainOverride(null);
    setCliColorEnabledOverride(null);
  }
});

describe("serializeCliError", () => {
  test("renders stable structured errors for JSON", () => {
    const output = serializeCliError(
      { code: "auth_required", message: "Sign in first.", retryable: true },
      { ...baseOptions, format: "json" },
    );
    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: { code: "auth_required", message: "Sign in first.", retryable: true },
    });
  });
});

test("large research reports remain complete through a pipe after stdout initialization", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import { printCliResult } from ${JSON.stringify(new URL("./result.ts", import.meta.url).pathname)};
    import { DEFAULT_CLI_OPTIONS } from ${JSON.stringify(new URL("./options.ts", import.meta.url).pathname)};
    // CLI color/terminal detection initializes the stream before reports print.
    void process.stdout;
    printCliResult({ data: { rows: Array.from({ length: 6000 }, (_, id) => ({ id, name: "東京 — research report" })) } },
      { ...DEFAULT_CLI_OPTIONS, format: "json" });
  `], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const report = JSON.parse(stdout);
  expect(report.data.rows).toHaveLength(6000);
  expect(report.data.rows.at(-1)).toEqual({ id: 5999, name: "東京 — research report" });
});
