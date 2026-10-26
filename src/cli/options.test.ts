import { describe, expect, test } from "bun:test";
import { parseCliGlobalArgs } from "./options";
import { inferCliErrorOptions } from "./errors";
import { cliPlainEnabled, plainByDefault, setCliColorEnabledOverride, setCliPlainOverride, setCliWidthOverride } from "../utils/cli-output";

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

  test("--plain and --no-plain decide plain output either way, the last one wins, and with neither NO_COLOR or a pipe does", async () => {
    expect(parseCliGlobalArgs(["econ"]).options.plain).toBeNull();
    expect(parseCliGlobalArgs(["econ", "--plain"]).options.plain).toBe(true);
    expect(parseCliGlobalArgs(["--no-plain", "econ"]).options.plain).toBe(false);
    expect(parseCliGlobalArgs(["econ", "--no-plain", "--plain"]).options.plain).toBe(true);
    expect(parseCliGlobalArgs(["notes", "set", "AAPL", "--", "--plain"]).options.plain).toBeNull();
    // An error printed before the arguments parse reads them the same way.
    expect(inferCliErrorOptions(["econ", "--no-plain", "--limit", "x"]).plain).toBe(false);
    expect(inferCliErrorOptions(["econ", "--plain"]).plain).toBe(true);

    // NO_COLOR with a value turns it on; an empty one is the same as unset.
    const terminal = { isTTY: true };
    expect(plainByDefault({}, terminal)).toBe(false);
    expect(plainByDefault({ NO_COLOR: "" }, terminal)).toBe(false);
    expect(plainByDefault({ NO_COLOR: "1" }, terminal)).toBe(true);
    expect(plainByDefault({ NO_COLOR: "true" }, terminal)).toBe(true);
    expect(plainByDefault({}, { isTTY: false })).toBe(true);

    // A pipe turns it on in the entry; --no-plain turns it back off, and no flag keeps the entry's choice.
    const { dispatchCli } = await import("./index");
    try {
      setCliPlainOverride(plainByDefault({}, { isTTY: false }));
      await dispatchCli([]);
      expect(cliPlainEnabled()).toBe(true);
      await dispatchCli(["--no-plain"]);
      expect(cliPlainEnabled()).toBe(false);
      await dispatchCli(["--plain"]);
      expect(cliPlainEnabled()).toBe(true);
    } finally {
      setCliPlainOverride(null);
      setCliColorEnabledOverride(null);
      setCliWidthOverride(null);
    }
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

  test("takes --width as a column count for every command except shot, whose --width is pixels", () => {
    expect(parseCliGlobalArgs(["quote", "AAPL", "TSLA", "--width", "80"])).toMatchObject({ args: ["quote", "AAPL", "TSLA"], options: { width: 80 } });
    expect(parseCliGlobalArgs(["fn", "WEI", "--width=72"]).options.width).toBe(72);
    expect(parseCliGlobalArgs(["--width", "60", "indices"])).toMatchObject({ args: ["indices"], options: { width: 60 } });
    expect(parseCliGlobalArgs(["quote", "AAPL"]).options.width).toBeUndefined();
    for (const command of ["shot", "screenshot", "--json shot", "--limit 3 shot"]) {
      const raw = [...command.split(" "), "HP", "AAPL", "--width", "1600"];
      const parsed = parseCliGlobalArgs(raw);
      expect(parsed.options.width).toBeUndefined();
      expect(parsed.args).toContain("1600");
    }
    // Arguments after -- are never options.
    expect(parseCliGlobalArgs(["notes", "--", "--width", "5"]).args).toEqual(["notes", "--width", "5"]);
    for (const bad of ["x", "10", "80.5", "-5"]) {
      expect(() => parseCliGlobalArgs(["quote", "AAPL", "--width", bad])).toThrow("--width must be a whole number of columns");
    }
    expect(() => parseCliGlobalArgs(["quote", "AAPL", "--width"])).toThrow("--width must be");
  });

  test("takes --tail like --limit, and rejects bad counts or both together", () => {
    expect(parseCliGlobalArgs(["history", "ZAR=X", "--tail", "2"]).options).toMatchObject({ tail: 2 });
    expect(parseCliGlobalArgs(["history", "ZAR=X", "--tail=5"]).options.limit).toBeUndefined();
    expect(() => parseCliGlobalArgs(["quote", "AAPL", "--limit=0"])).toThrow("--limit");
    expect(() => parseCliGlobalArgs(["history", "AAPL", "--tail", "x"])).toThrow("--tail must be a positive integer");
    expect(() => parseCliGlobalArgs(["history", "AAPL", "--tail", "2", "--limit", "2"])).toThrow("not both");
  });
});
