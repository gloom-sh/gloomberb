import { afterEach, expect, spyOn, test } from "bun:test";
import { printCliError } from "./errors";
import { DEFAULT_CLI_OPTIONS } from "./options";
import { withSearchHints } from "./not-a-ticker";
import { printCliResult } from "./result";
import { setCliColorEnabledOverride } from "../utils/cli-output";

afterEach(() => setCliColorEnabledOverride(null));

test("the search hint repeats the user's own spelling, one hint per symbol", () => {
  expect(withSearchHints("Not a ticker: APPLE.", ["Apple"])).toBe("Not a ticker: APPLE. Try `gloomberb search Apple`.");
  expect(withSearchHints("Not a ticker: ZZZZQ.", ["zzzzq", "--json"])).toBe("Not a ticker: ZZZZQ. Try `gloomberb search zzzzq`.");
  // A comma list, a $ prefix and a venue are all read from the argument that named the symbol.
  expect(withSearchHints("Not a ticker: FOO.\nNot a ticker: BAR:NYSE.", ["Foo,$Bar:NYSE"]))
    .toBe("Not a ticker: FOO. Try `gloomberb search Foo`.\nNot a ticker: BAR:NYSE. Try `gloomberb search Bar`.");
  expect(withSearchHints("Not a ticker: APPLE INC.", ["Apple Inc"])).toBe("Not a ticker: APPLE INC. Try `gloomberb search \"Apple Inc\"`.");
  // No argument names it (a function's own default): the symbol as the router wrote it. A dotted symbol keeps its dot.
  expect(withSearchHints("apple-ohlcv: Not a ticker: BRK.B.", [])).toBe("apple-ohlcv: Not a ticker: BRK.B. Try `gloomberb search BRK.B`.");
  // Styled lines, and text that already carries the hint or none of this, come through intact.
  expect(withSearchHints("\u001b[33mErrors: Not a ticker: APPLE.\u001b[0m", ["Apple"]))
    .toBe("\u001b[33mErrors: Not a ticker: APPLE. Try `gloomberb search Apple`.\u001b[0m");
  const hinted = "Not a ticker: APPLE. Try `gloomberb search Apple`.";
  expect(withSearchHints(hinted, ["Apple"])).toBe(hinted);
  expect(withSearchHints("No quote provider available for APPLE", ["Apple"])).toBe("No quote provider available for APPLE");
});

test("an error and a warning in text carry the hint, and JSON keeps the router's own words", () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    setCliColorEnabledOverride(false);
    printCliError(new Error("Not a ticker: APPLE."), DEFAULT_CLI_OPTIONS, { command: "history", args: ["Apple"] });
    printCliError(new Error("Not a ticker: APPLE."), { ...DEFAULT_CLI_OPTIONS, format: "json" }, { command: "history", args: ["Apple"] });
    printCliResult({ data: [], warnings: ["Not a ticker: APPLE."] }, DEFAULT_CLI_OPTIONS, {}, ["Apple"]);
    printCliResult({ data: [], warnings: ["Not a ticker: APPLE."] }, { ...DEFAULT_CLI_OPTIONS, format: "json" }, {}, ["Apple"]);
    const lines = spy.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toBe("error: Not a ticker: APPLE. Try `gloomberb search Apple`.");
    expect(JSON.parse(lines[1]!).error.message).toBe("Not a ticker: APPLE.");
    expect(lines[2]).toBe("warning: Not a ticker: APPLE. Try `gloomberb search Apple`.");
    expect(lines).toHaveLength(3);
  } finally {
    spy.mockRestore();
    write.mockRestore();
  }
});
