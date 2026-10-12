import { expect, test } from "bun:test";
import { earningsCallsHeadless } from "../../plugins/builtin/earnings-calls/headless";
import { createDefaultConfig } from "../../types/config";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";
import { parsePaneFunctionArgs } from "./options";
import { resolvePaneFunction, UnknownPaneFunctionError } from "./resolver";

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
  await expect(fn(["WEI", "--section", "Europe"], false)).rejects.toThrow("WEI does not support --section");
});

test("an option or argument a function refuses names the function code, never its template or pane id", async () => {
  const refused = await fn(["WEI", "--range", "1Y"], false).catch((error: Error) => error.message);
  expect(refused).toBe("WEI does not support --range. It has no options.");
  expect(refused).not.toContain("world-indices");
  const strict = await resolvePaneFunction(
    registry, context, { ...parsePaneFunctionArgs(["CALLS"]), requireBotSafe: true }, { strictHeadlessOptions: true },
  ).catch((error: Error) => error.message);
  expect(strict).toBe("CALLS requires exactly one ticker.");
});

test("a name that opens nothing lists the closest functions and where to search, never an alphabetical list", async () => {
  const surface: PaneTemplateDef = {
    ...template("OVDV", "vol-surface", indices),
    label: "Volatility Surface",
    description: "Implied volatility surface and smiles.",
  };
  const withSurface: PaneFunctionCatalog = {
    ...registry,
    panes: new Map([...registry.panes, ["vol-surface", pane("vol-surface")]]),
    paneTemplates: new Map([...registry.paneTemplates, ["vol-surface-pane", surface]]),
  };
  const unknown = (name: string) => resolvePaneFunction(withSurface, context, parsePaneFunctionArgs([name, "SPY"]))
    .then(() => null, (error: unknown) => error as UnknownPaneFunctionError);

  const close = await unknown("volsurf");
  expect(close).toBeInstanceOf(UnknownPaneFunctionError);
  expect(close?.message).toBe('Unknown function or pane "volsurf".');
  expect(close?.details).toBe("Closest matches:\n  OVDV  Volatility Surface\nSearch the catalog: gloomberb catalog volsurf");
  expect((await unknown("zzqxvb"))?.details).toBe("Search the catalog: gloomberb catalog zzqxvb");
});
