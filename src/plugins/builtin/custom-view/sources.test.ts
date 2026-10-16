import { expect, test } from "bun:test";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../../../types/plugin";
import { describeViewSources, listViewSources, nearViewSources, type ViewSourceCatalog } from "./sources";

const headless = (kind: HeadlessPaneDefinition["argument"]["kind"], optional = false): HeadlessPaneDefinition => ({
  shape: "rows", argument: { kind, optional }, options: [], load: async () => ({ rows: [] }),
});
const pane = (id: string, def: Partial<PaneDef> = {}): PaneDef => ({ id, name: id, component: () => null, defaultPosition: "right", ...def });
const template = (prefix: string, label: string, def: Partial<PaneTemplateDef> = {}): PaneTemplateDef => ({
  id: `${prefix.toLowerCase()}-pane`, paneId: prefix.toLowerCase(), label, description: label,
  shortcut: { prefix, argPlaceholder: "", argKind: "text" }, ...def,
});

const catalog: ViewSourceCatalog = {
  panes: new Map([
    ["most", pane("most")],
    ["qq", pane("qq")],
    ["eqs", pane("eqs")],
    ["help", pane("help")],
    ["bare-feed", pane("bare-feed", { headless: headless("free-text", true) })],
  ]),
  paneTemplates: new Map([
    ["most-pane", template("MOST", "Market Movers")],
    ["qq-pane", template("QQ", "Quote Monitor", { headless: headless("tickers") })],
    ["eqs-pane", template("EQS", "Equity Screener", { keywords: ["screen", "screener"], headless: headless("none") })],
    ["help-pane", template("HELP", "Help")],
  ]),
};

test("the sources are the registry's headless functions, by what each takes, never a pane that only renders", () => {
  expect(listViewSources(catalog).map((source) => source.token)).toEqual(["EQS", "QQ", "bare-feed"]);
  expect(describeViewSources(catalog)).toContain("no argument: EQS; tickers: QQ; optional text: bare-feed.");
  expect(describeViewSources({ panes: new Map(), paneTemplates: new Map() })).toBe("");
});

test("an invented name is matched to the functions that share a word with it", () => {
  const sources = listViewSources(catalog);
  expect(nearViewSources(sources, "market_screener").map((source) => source.token)).toEqual(["EQS"]);
  expect(nearViewSources(sources, "zzqxvb")).toEqual([]);
});
