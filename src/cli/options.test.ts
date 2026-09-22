import { describe, expect, test } from "bun:test";
import { parseCliGlobalArgs } from "./options";

describe("parseCliGlobalArgs", () => {
  test("extracts global output and execution flags anywhere before --", () => {
    const parsed = parseCliGlobalArgs([
      "quote",
      "--json",
      "AAPL",
      "--limit",
      "2",
      "--refresh",
      "--dry-run",
      "--yes",
      "--no-color",
    ]);

    expect(parsed.args).toEqual(["quote", "AAPL"]);
    expect(parsed.options).toMatchObject({
      format: "json",
      limit: 2,
      refresh: true,
      dryRun: true,
      yes: true,
      color: false,
    });
  });

  test("takes help flags out of the arguments so a command never reads them as input", () => {
    const parsed = parseCliGlobalArgs(["notes", "set", "-h", "AAPL", "--help"]);
    expect(parsed.args).toEqual(["notes", "set", "AAPL"]);
    expect(parsed.help).toBe(true);
  });

  test("leaves arguments after -- untouched", () => {
    const parsed = parseCliGlobalArgs(["ai", "ask", "--", "--json", "--help"]);
    expect(parsed.args).toEqual(["ai", "ask", "--json", "--help"]);
    expect(parsed.options.format).toBe("text");
    expect(parsed.help).toBe(false);
  });

  test("rejects invalid limits", () => {
    expect(() => parseCliGlobalArgs(["quote", "AAPL", "--limit=0"])).toThrow("--limit");
  });
});
