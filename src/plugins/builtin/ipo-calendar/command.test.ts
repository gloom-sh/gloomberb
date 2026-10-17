import { expect, test } from "bun:test";
import { findReusablePaneInstance, retargetPaneInstance } from "../../../components/command-bar/workflow/pane-reuse";
import type { LayoutConfig, PaneInstanceConfig } from "../../../types/config";
import type { PaneTemplateContext } from "../../../types/plugin";
import { ipoCalendarPlugin } from "./index";
import { IPO_CALENDAR_PANE_ID } from "./model";

const template = ipoCalendarPlugin.paneTemplates![0]!;

const pane = (instanceId: string, params?: Record<string, string>): PaneInstanceConfig => (
  { instanceId, paneId: IPO_CALENDAR_PANE_ID, binding: { kind: "none" }, ...(params ? { params } : {}) }
);

/** What typing `IPO <arg>` does with the panes open: the spec the template builds, the pane reused for it and what that pane is then asked for. */
async function type(instances: PaneInstanceConfig[], arg?: string, focusedPaneId: string | null = null) {
  const layout: LayoutConfig = { dockRoot: null, instances, floating: [], detached: [] };
  const spec = (await template.createInstance!({ layout, focusedPaneId } as unknown as PaneTemplateContext, arg === undefined ? undefined : { arg }))!;
  const reused = findReusablePaneInstance(instances, template, new Map([[template.id, template]]), spec);
  return { spec, reused, retargeted: reused ? retargetPaneInstance(reused, spec) : null };
}

test("IPO japan then IPO europe is one pane: the open one, which the second request replaces the search of", async () => {
  const first = await type([], "japan");
  expect(first.spec.instanceId).toBe(IPO_CALENDAR_PANE_ID);
  expect(first.reused).toBeNull();

  const open = pane(first.spec.instanceId!, first.spec.params);
  await Bun.sleep(2);
  const second = await type([open], "europe");
  expect(second.reused).toBe(open);
  expect(second.retargeted?.params).toMatchObject({ search: "europe" });
  expect(second.retargeted?.params?.tabAt).not.toBe(open.params?.tabAt);
  // The same search asked for again is a newer request too.
  await Bun.sleep(2);
  expect((await type([open], "japan")).retargeted?.params?.tabAt).not.toBe(open.params?.tabAt);
});

test("a bare IPO focuses the open pane as it is, a pane saved under another id is the one reused, and the focused one wins", async () => {
  const open = pane(IPO_CALENDAR_PANE_ID, { search: "japan", tabAt: "1" });
  const bare = await type([open]);
  expect(bare.spec.params).toBeUndefined();
  expect(bare.reused).toBe(open);
  expect(bare.retargeted).toBeNull();
  expect((await type([], undefined)).spec).toMatchObject({ instanceId: IPO_CALENDAR_PANE_ID });

  const saved = [pane("ipo-calendar:4"), pane("ipo-calendar:9")];
  expect((await type(saved, "europe")).reused?.instanceId).toBe("ipo-calendar:4");
  expect((await type(saved, "europe", "ipo-calendar:9")).reused?.instanceId).toBe("ipo-calendar:9");
});
