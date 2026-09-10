import { describe, expect, test } from "bun:test";
import { serializeCliError, serializeCliResult } from "./result";
import type { CliGlobalOptions } from "./options";

const baseOptions: CliGlobalOptions = {
  format: "text",
  quiet: false,
  color: null,
  refresh: false,
  dryRun: false,
  yes: false,
};

describe("serializeCliResult", () => {
  test("renders limited JSON result envelopes", () => {
    const output = serializeCliResult(
      { data: [{ symbol: "AAPL" }, { symbol: "MSFT" }] },
      { ...baseOptions, format: "json", limit: 1 },
    );
    expect(JSON.parse(output)).toEqual({
      ok: true,
      data: [{ symbol: "AAPL" }],
    });
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

  test("renders NDJSON rows", () => {
    const output = serializeCliResult(
      { data: [{ symbol: "AAPL" }, { symbol: "MSFT" }] },
      { ...baseOptions, format: "ndjson" },
    );
    expect(output).toBe('{"symbol":"AAPL"}\n{"symbol":"MSFT"}');
  });
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
