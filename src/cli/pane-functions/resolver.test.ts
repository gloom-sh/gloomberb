import { expect, test } from "bun:test";
import { earningsCallsHeadless } from "../../plugins/builtin/earnings-calls/headless";
import { createDefaultConfig } from "../../types/config";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";
import { parsePaneFunctionArgs } from "./options";
import { resolvePaneFunction } from "./resolver";

const pane = (id: string): PaneDef => ({ id, name: id, component: () => null, defaultPosition: "right" });
const template = (prefix: string, paneId: string, headless: HeadlessPaneDefinition): PaneTemplateDef => ({
  id: `${paneId}-pane`, paneId, label: prefix, description: prefix, shortcut: { prefix, argPlaceholder: "", argKind: "ticker" }, headless,
});
const indices: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "none" }, options: [], load: () => ({ sections: [] }),
};
const registry: PaneFunctionCatalog = {
  panes: new Map([["world-indices", pane("world-indices")], ["earnings-calls", pane("earnings-calls")]]),
  paneTemplates: new Map([
    ["world-indices-pane", template("WEI", "world-indices", indices)],
    ["earnings-calls-pane", template("CALLS", "earnings-calls", earningsCallsHeadless)],
  ]),
  destroy: () => {},
};
const context = { config: createDefaultConfig("/tmp/gloomberb-resolver-test") } as MarketContext;
const fn = (args: string[], tableSection = true) => resolvePaneFunction(
  registry, context, parsePaneFunctionArgs(args), { strictHeadlessOptions: true, tableSection },
);

test("--section picks a report table, unless the function has a section option of its own", async () => {
  const board = await fn(["WEI", "--section", "Europe"]);
  expect(board.tableSection).toBe("Europe");
  expect(board.options).not.toHaveProperty("section");
  // CALLS reads --section as the transcript part, as before.
  const transcript = await fn(["CALLS", "NVDA", "--section", "q&a"]);
  expect(transcript.tableSection).toBeUndefined();
  expect(transcript.options.section).toBe("qa");
  await expect(fn(["CALLS", "NVDA", "--section", "bogus"])).rejects.toThrow("Invalid --section value");
  // Screenshots have no tables to pick from.
  await expect(fn(["WEI", "--section", "Europe"], false)).rejects.toThrow("does not support --section");
});
