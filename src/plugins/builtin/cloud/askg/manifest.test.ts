import { describe, expect, test } from "bun:test";
import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import type {
  HeadlessPaneArgumentDef,
  HeadlessPaneDefinition,
  PaneDef,
  PaneTemplateDef,
} from "../../../../types/plugin";
import {
  buildASKGToolManifests,
  hashASKGToolManifests,
} from "./manifest";
import type { ClientToolManifest } from "./protocol";

function headless(argument: HeadlessPaneArgumentDef): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument,
    options: [{
      key: "limit",
      description: "Maximum rows.",
      type: "integer",
      minimum: 1,
      maximum: 100,
      defaultValue: 10,
      settingKey: "limit",
      pluginState: { pluginId: "test" },
    }],
    columns: [{ key: "value", header: "Value", format: String }],
    load: () => ({ rows: [] }),
  };
}

function pane(id: string): PaneDef {
  return {
    id,
    name: id,
    component: () => null,
    defaultPosition: "left",
  };
}

function template(
  id: string,
  paneId: string,
  prefix: string,
  argument: HeadlessPaneArgumentDef,
): PaneTemplateDef {
  return {
    id,
    paneId,
    label: id,
    description: `Read ${id}.`,
    shortcut: { prefix, argKind: "text" },
    headless: headless(argument),
  };
}

function registry(templates: PaneTemplateDef[]): PaneFunctionCatalog {
  return {
    panes: new Map(templates.map(({ paneId }) => [paneId, pane(paneId)])),
    paneTemplates: new Map(templates.map((entry) => [entry.id, entry])),
    destroy() {},
  };
}

function headlessTools(catalog: PaneFunctionCatalog): ClientToolManifest[] {
  return buildASKGToolManifests(catalog).tools.filter(({ source }) => source === "headless");
}

describe("ASKG client manifest", () => {
  test("projects every headless argument kind and strips renderer-only fields", () => {
    const tools = headlessTools(registry([
      template("none", "pane-none", "NON", { kind: "none" }),
      template("ticker", "pane-ticker", "TIK", { kind: "ticker", placeholder: "symbol" }),
      template("tickers", "pane-tickers", "TKS", { kind: "tickers", minimum: 2, maximum: 4 }),
      template("symbols", "pane-symbols", "SYM", { kind: "symbol-list", optional: true }),
      template("text", "pane-text", "TXT", { kind: "free-text", description: "Search phrase." }),
    ]));

    expect(tools.map(({ name, argument }) => [name, argument?.kind])).toEqual([
      ["non", "none"],
      ["sym", "symbol-list"],
      ["tik", "ticker"],
      ["tks", "tickers"],
      ["txt", "free-text"],
    ]);
    expect(tools[0]?.options?.[0]).toEqual({
      key: "limit",
      description: "Maximum rows.",
      type: "integer",
      minimum: 1,
      maximum: 100,
      defaultValue: 10,
    });
    expect(tools[0]?.columns).toEqual([{ key: "value", header: "Value" }]);
    expect(tools.every(({ writeTier, confirm }) => writeTier === "read" && confirm === "never")).toBe(true);
  });

  test("projects remote operation schemas and confirmation tiers", () => {
    const { tools } = buildASKGToolManifests(registry([]));
    const notify = tools.find(({ name }) => name === "app.notify");
    const deleteLayout = tools.find(({ name }) => name === "layout.delete");

    expect(notify).toMatchObject({
      source: "remote-op",
      writeTier: "ui-write",
      confirm: "never",
      inputSchema: { required: ["body"] },
    });
    expect(deleteLayout).toMatchObject({
      source: "remote-op",
      writeTier: "user-data",
      confirm: "always",
      inputSchema: { required: ["index"] },
    });
  });

  test("hash is order-independent and changes with the surface", async () => {
    const tools = headlessTools(registry([
      template("valuation", "pane-valuation", "VAL", { kind: "none" }),
      template("fear", "pane-fear", "FNG", { kind: "none" }),
    ]));
    const reversed = [...tools].reverse();
    const changed = tools.map((tool, index) => index === 0
      ? { ...tool, description: `${tool.description} Changed.` }
      : tool);

    expect(await hashASKGToolManifests(tools)).toBe(await hashASKGToolManifests(reversed));
    expect(await hashASKGToolManifests(changed)).not.toBe(await hashASKGToolManifests(tools));
  });

  test("skips illegal and ambiguous names instead of rewriting them", () => {
    const catalog = registry([
      // Short and digit leading tokens are legal: the terminal's own shortcuts
      // include N, SI and 13F, and a tool the model cannot name is a tool the
      // model cannot use.
      template("short", "pane-short", "N", { kind: "none" }),
      template("numeric", "pane-numeric", "13F", { kind: "none" }),
      template("bad", "pane-bad", "BAD/TOKEN", { kind: "none" }),
      template("first", "pane-first", "VAL", { kind: "none" }),
      template("second", "pane-second", "val", { kind: "none" }),
    ]);
    const { tools, skipped } = buildASKGToolManifests(catalog);

    expect(tools.filter(({ source }) => source === "headless").map(({ name }) => name))
      .toEqual(["13f", "n"]);
    expect(skipped.map(({ token }) => token)).toEqual(["BAD/TOKEN", "VAL", "val"]);
    expect(skipped.filter(({ token }) => token.toLowerCase() === "val").every(({ reason }) => (
      reason.includes("Duplicate tool name")
    ))).toBe(true);
  });
});
