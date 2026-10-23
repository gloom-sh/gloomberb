import { expect, test } from "bun:test";
import { centralBankRatesModule } from "../../plugins/builtin/central-bank-rates";
import { chartComposerModule } from "../../plugins/builtin/chart-composer";
import { creditBoardsModule } from "../../plugins/builtin/credit-boards";
import { ivHistoryModule } from "../../plugins/builtin/iv-history";
import { volSurfaceModule } from "../../plugins/builtin/vol-surface";
import { earningsCallsHeadless } from "../../plugins/builtin/earnings-calls/headless";
import { ipoCalendarPlugin } from "../../plugins/builtin/ipo-calendar";
import { ratePathModule } from "../../plugins/builtin/rate-path";
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
  expect(close?.details).toBe("Closest matches:\n  OVDV  Volatility Surface\nSearch the catalog: gloom catalog volsurf");
  // Near no code and found by no search: said plainly, with the whole catalog to look in.
  expect((await unknown("zzqxvb"))?.details).toBe("No function code is close to zzqxvb. List every function: gloom catalog");
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
    expect(error?.details).toBe("Run: gloom fn RDCF PLTR");
  }
  // Two letters off, or a name too short to tell, is no suggestion.
  expect((await unknown(["RDXX", "PLTR"]))?.message).toBe('Unknown function or pane "RDXX".');
  expect((await unknown(["WE", "PLTR"]))?.message).toBe('Unknown function or pane "WE".');
});

test("a bank figure typed as a function (NIM, one slip from NI) is pointed at the Bank section and EQS, not at NI", async () => {
  const news: PaneTemplateDef = { ...template("NI", "topic-news", indices), label: "Topic News" };
  const withNews: PaneFunctionCatalog = {
    ...registry,
    panes: new Map([...registry.panes, ["topic-news", pane("topic-news")]]),
    paneTemplates: new Map([...registry.paneTemplates, ["topic-news-pane", news]]),
  };
  for (const name of ["NIM", "deposits", "CRE"]) {
    const error = await resolvePaneFunction(withNews, context, parsePaneFunctionArgs([name, "jpm"])).then(() => null, (failure: unknown) => failure as UnknownPaneFunctionError);
    expect(error?.message, name).toBe(`${name} is not a function: a bank's figures are in the Bank section of fundamentals.`);
    expect(error?.details.split("\n"), name).toEqual([
      "Deposits, uninsured share, CRE / capital and the lead bank: gloom fundamentals JPM",
      "Net interest margin (Pro): gloom fn EQS --metric kpiNimPercent --definition "
        + `'{"version":1,"currency":null,"criteria":[{"field":"symbol","op":"in","value":["JPM"]}],"sort":{"field":"symbol","direction":"asc"}}'`,
    ]);
  }
  expect((await resolvePaneFunction(withNews, context, parsePaneFunctionArgs(["NIX", "JPM"])).catch((failure: Error) => failure))?.message)
    .toBe('Unknown function or pane "NIX". Did you mean NI (Topic News)?');
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
  expect(await shot("IPO", "pending")).toEqual({ params: expect.objectContaining({ search: "pending" }), binding: { kind: "none" } });
});

test("an implied-vol word that is no code (IVOL, OVOL, IV) names HIVG and OVDV and runs each on the argument", async () => {
  const modules = [ivHistoryModule, volSurfaceModule];
  const vol: PaneFunctionCatalog = {
    panes: new Map(modules.flatMap((module) => module.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map(modules.flatMap((module) => module.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const unknown = (args: string[]) => resolvePaneFunction(vol, context, parsePaneFunctionArgs(args))
    .then(() => null, (error: unknown) => error as UnknownPaneFunctionError);
  for (const word of ["IVOL", "ovol", "IV"]) {
    const error = await unknown([word, "SPY"]);
    expect(error?.message).toBe(`Unknown function or pane "${word}". Did you mean HIVG (Implied Volatility History) or OVDV (Volatility Surface)?`);
    expect(error?.details.split("\n").slice(0, 2)).toEqual(["Run: gloom fn HIVG SPY", "     gloom fn OVDV SPY"]);
  }
  // With no argument, the one each takes.
  expect((await unknown(["IVOL"]))?.details).toBe("Run: gloom fn HIVG <ticker>\n     gloom fn OVDV <ticker>");
});

test("a central bank's name or short form typed as a function points to CBR, and a function that owns the word keeps it", async () => {
  const modules = [centralBankRatesModule, ratePathModule];
  const banks: PaneFunctionCatalog = {
    panes: new Map(modules.flatMap((module) => module.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map(modules.flatMap((module) => module.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const resolve = (args: string[]) => resolvePaneFunction(banks, context, parsePaneFunctionArgs(args));
  for (const word of ["ECB", "BOJ", "boe", "RBA", "BoC", "SNB", "Bank of Japan", "Federal Reserve"]) {
    const error = await resolve([word]).then(() => null, (failure: unknown) => failure as UnknownPaneFunctionError);
    expect(error?.message).toBe(`Unknown function or pane "${word}". Did you mean CBR (Central Bank Rates)?`);
    expect(error?.details.split("\n")[0]).toBe("Run: gloom fn CBR");
  }
  // FOMC is one of WIRP's own words, so it opens the rate path as before.
  expect((await resolve(["FOMC"])).token).toBe("WIRP");
});

test("CMP of one ticker says it needs two or more and how to ask, before any chart is built", async () => {
  const charts: PaneFunctionCatalog = {
    panes: new Map((chartComposerModule.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map((chartComposerModule.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const refusal = (command: "fn" | "shot", args: string[]) => resolvePaneFunction(charts, context, parsePaneFunctionArgs(args), { command })
    .then(() => null, (error: Error) => error.message);
  expect(await refusal("fn", ["CMP", "SPY"])).toBe("CMP needs two or more tickers: fn CMP SPY,QQQ");
  expect(await refusal("shot", ["CMP", "aapl"])).toBe("CMP needs two or more tickers: shot CMP AAPL,SPY");
  expect(await refusal("fn", ["CMP", "SPY,QQQ"])).toBeNull();
});
