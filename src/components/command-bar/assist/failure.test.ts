import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../utils/debug-log";
import { buildAssistCommandInventory } from "./inventory";

test("argument options that throw are left out and logged without the error", () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "command-bar.assist") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const inventory = buildAssistCommandInventory({
      commands: [{
        id: "th", prefix: "TH", label: "Change Theme", description: "A command", category: "Config",
        hasArg: true, argPlaceholder: "theme name",
        argOptions: () => { throw new Error("account=private token=private"); },
      }],
      pluginCommands: [],
      paneTemplates: [],
    });
    expect(inventory).toEqual([{ prefix: "TH", name: "Change Theme", description: "A command", arg: { kind: "text", placeholder: "theme name" } }]);
    expect(logged).toEqual([["warn", expect.stringMatching(/^Read command argument options failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
