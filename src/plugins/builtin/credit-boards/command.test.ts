import { describe, expect, test } from "bun:test";
import { createDefaultConfig, type LayoutConfig } from "../../../types/config";
import type { PaneTemplateContext, PaneTemplateDef } from "../../../types/plugin";
import { shortInterestModule } from "../short-interest";
import { creditBoardsModule } from "./index";

function context(layout: LayoutConfig, activeTicker: string | null = null): PaneTemplateContext {
  const config = createDefaultConfig("/tmp/fold-tabs");
  return { config: { ...config, layout }, layout, focusedPaneId: null, activeTicker, activeCollectionId: null };
}

const empty: LayoutConfig = { dockRoot: null, instances: [], floating: [], detached: [] };

function open(templates: readonly PaneTemplateDef[] | undefined, id: string): NonNullable<PaneTemplateDef["createInstance"]> {
  const create = templates?.find((entry) => entry.id === id)?.createInstance;
  if (!create) throw new Error(`missing ${id}`);
  return create;
}

describe("folded pane commands", () => {
  test("SI and SIV open one short interest pane on the tab the command names", async () => {
    const si = open(shortInterestModule.paneTemplates, "short-interest-pane");
    const siv = open(shortInterestModule.paneTemplates, "short-volume-pane");
    const interest = await si(context(empty), { symbol: "AAPL" });
    const volume = await siv(context(empty), { symbol: "AAPL" });
    expect(interest).toMatchObject({
      instanceId: "short-interest:AAPL",
      binding: { kind: "fixed", symbol: "AAPL" },
      params: { tab: "interest" },
    });
    expect(volume).toMatchObject({
      instanceId: "short-interest:AAPL",
      binding: { kind: "fixed", symbol: "AAPL" },
      params: { tab: "volume" },
    });
    expect(interest?.params?.tabAt).toMatch(/^\d+$/);
    expect(volume?.params?.tabAt).toMatch(/^\d+$/);
  });

  test("SOVR reuses an open CDS board, and the first one takes a stable id", async () => {
    const cdx = open(creditBoardsModule.paneTemplates, "cdx-pane");
    const sovr = open(creditBoardsModule.paneTemplates, "sovr-pane");
    const first = await cdx(context(empty));
    expect(first).toMatchObject({ instanceId: "cdx-board", params: { tab: "index" } });
    expect(first?.params?.tabAt).toMatch(/^\d+$/);

    const openBoard: LayoutConfig = {
      dockRoot: null,
      instances: [{ instanceId: "cdx-1", paneId: "cdx-board", binding: { kind: "none" } }],
      floating: [],
      detached: [],
    };
    const sovereign = await sovr(context(openBoard));
    expect(sovereign).toMatchObject({ instanceId: "cdx-1", params: { tab: "sovereign" } });
    expect(sovereign?.params?.tabAt).toMatch(/^\d+$/);
  });
});
