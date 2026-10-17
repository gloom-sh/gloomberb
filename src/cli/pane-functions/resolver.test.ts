import { expect, test } from "bun:test";
import { creditBoardsModule } from "../../plugins/builtin/credit-boards";
import { earningsCallsHeadless } from "../../plugins/builtin/earnings-calls/headless";
import { ipoCalendarPlugin } from "../../plugins/builtin/ipo-calendar";
import { paneSchemas } from "../../plugins/builtin/chart-composer/headless-schema";
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
const intraday: HeadlessPaneDefinition<"series"> = {
  shape: "series", ...paneSchemas["graph-intraday-price-pane"], load: () => ({ series: [] }),
};
const registry: PaneFunctionCatalog = {
  panes: new Map([["world-indices", pane("world-indices")], ["earnings-calls", pane("earnings-calls")], ["chart", pane("chart")]]),
  paneTemplates: new Map([
    ["world-indices-pane", template("WEI", "world-indices", indices)],
    ["earnings-calls-pane", template("CALLS", "earnings-calls", earningsCallsHeadless)],
    ["chart-pane", template("GIP", "chart", intraday)],
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

test("a bar size under a minute points at GIP's 1-minute bars for the ticker asked about", async () => {
  const pointer = "No second or tick bars; 1-minute bars: fn GIP RMS.AX; trades exist for US listings only.";
  for (const value of ["1s", "30s", "tick", "500ms"]) {
    await expect(fn(["GIP", "RMS.AX", "--chartResolution", value])).rejects
      .toThrow(`Invalid --chartResolution value "${value}". ${pointer} Use one of: auto, 1m, 5m, 15m, 1h.`);
  }
  await expect(fn(["GIP", "RMS.AX", "--resolution", "1s"])).rejects.toThrow(pointer);
  // Another interval it does not serve is only refused.
  await expect(fn(["GIP", "RMS.AX", "--chartResolution", "2m"])).rejects
    .toThrow('Invalid --chartResolution value "2m". Use one of: auto, 1m, 5m, 15m, 1h.');
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
  // Near no code and found by no search: said plainly, with the whole catalog to look in.
  expect((await unknown("zzqxvb"))?.details).toBe("No function code is close to zzqxvb. List every function: gloomberb catalog");
});

test("a code one slip from a function's (swapped, missing or extra letter) names it and the command that runs it", async () => {
  const dcf: PaneTemplateDef = { ...template("RDCF", "reverse-dcf", indices), label: "Reverse DCF" };
  const withDcf: PaneFunctionCatalog = {
    ...registry,
    panes: new Map([...registry.panes, ["reverse-dcf", pane("reverse-dcf")]]),
    paneTemplates: new Map([...registry.paneTemplates, ["reverse-dcf-pane", dcf]]),
  };
  const unknown = (args: string[]) => resolvePaneFunction(withDcf, context, parsePaneFunctionArgs(args))
    .then(() => null, (error: unknown) => error as UnknownPaneFunctionError);
  for (const typed of ["RCDF", "rdc", "RDCFF"]) {
    const error = await unknown([typed, "PLTR"]);
    expect(error?.message).toBe(`Unknown function or pane "${typed}". Did you mean RDCF (Reverse DCF)?`);
    expect(error?.details).toBe("Run: gloomberb fn RDCF PLTR");
  }
  // Two letters off, or a name too short to tell, is no suggestion.
  expect((await unknown(["RDXX", "PLTR"]))?.message).toBe('Unknown function or pane "RDXX".');
  expect((await unknown(["WE", "PLTR"]))?.message).toBe('Unknown function or pane "WE".');
});

test("shot hands CDX, SOVR (or its alias WCDS) and IPO their argument as the params their pane opens on, never as a ticker", async () => {
  const templates = [...creditBoardsModule.paneTemplates ?? [], ...ipoCalendarPlugin.paneTemplates ?? []];
  const boards: PaneFunctionCatalog = {
    panes: new Map(["fixed-income", "ipo-calendar"].map((id) => [id, pane(id)])),
    paneTemplates: new Map(templates.map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const shot = async (target: string, arg: string) => {
    const resolved = await resolvePaneFunction(boards, context, parsePaneFunctionArgs([target, arg]), { command: "shot" });
    return { params: resolved.instance.params, binding: resolved.instance.binding };
  };
  expect(await shot("CDX", "HY")).toEqual({ params: expect.objectContaining({ tab: "credit", view: "index", index: "HY" }), binding: { kind: "none" } });
  // WCDS is SOVR's alias, and the country keeps the spelling it was typed in.
  expect(await shot("WCDS", "Ivory Coast")).toEqual({ params: expect.objectContaining({ tab: "credit", view: "sovereign", country: "Ivory Coast" }), binding: { kind: "none" } });
  expect(await shot("IPO", "pending")).toEqual({ params: { search: "pending" }, binding: { kind: "none" } });
});
