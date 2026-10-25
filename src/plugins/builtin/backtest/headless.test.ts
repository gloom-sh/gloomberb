import { expect, test } from "bun:test";
import { getPaneFunctionCapability, normalizeCapabilityOptions } from "../../../cli/pane-functions/capabilities";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { backtestHeadless } from "./headless";
import { backtestModule } from "./index";
import { resolveRules } from "./presets";

const ENTRY = "close > sma(50)";
const EXIT = "close < sma(50)";

/** The options `fn BT` passes the load for what was typed, as the resolver normalizes them. */
function typed(options: Record<string, string>) {
  return normalizeCapabilityOptions(getPaneFunctionCapability(backtestModule.paneTemplates![0]!, backtestModule.panes![0]!), options);
}

// `fn BT XLI --entry ... --exit ...` ran the golden cross: the preset's default filled in for the option left out.
test("rules typed without --preset are tested as custom; nothing typed is the golden cross", () => {
  const rules = typed({ entry: ENTRY, exit: EXIT });
  expect(rules.preset).toBeUndefined();
  expect(resolveRules(rules.preset as string | undefined, String(rules.entry), String(rules.exit)))
    .toEqual({ entry: ENTRY, exit: EXIT, label: "Custom rules" });
  const none = typed({});
  expect(resolveRules(none.preset as string | undefined, String(none.entry), String(none.exit)).label).toBe("Golden cross (50/200)");
  // A chosen preset tests its own rules, and custom the typed ones.
  expect(resolveRules("trend-200", "", "").entry).toBe("close > sma(200)");
  expect(resolveRules("custom", ENTRY, EXIT).label).toBe("Custom rules");
});

test("rules typed beside another preset are refused, naming both, before any data is asked for", async () => {
  const unasked = createTestHeadlessContext({
    marketData: new Proxy({} as never, { get: () => { throw new Error("asked for data"); } }),
  });
  const load = (options: Record<string, string>) => backtestHeadless.load(
    createTestHeadlessArgs({ rawArgument: "XLI", argument: "XLI", symbols: ["XLI"], options: typed(options) }), unasked);
  await expect(load({ preset: "golden-cross", entry: ENTRY, exit: EXIT }))
    .rejects.toThrow("--entry and --exit are custom rules, but --preset golden-cross tests its own. Leave out --preset to test the typed rules, or give --preset custom.");
  await expect(load({ preset: "rsi-reversion", exit: EXIT })).rejects.toThrow("--exit is a custom rule, but --preset rsi-reversion tests its own.");
  // Custom and the typed rules agree: the load goes on to ask for history.
  await expect(load({ preset: "custom", entry: ENTRY, exit: EXIT })).rejects.toThrow("asked for data");
});
