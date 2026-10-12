import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import type { ResolvedPane } from "../../../../layout/pane-manager";
import type { PluginRegistry } from "../../../../plugins/registry";
import type { LayoutConfig } from "../../../../types/config";
import type { DesktopWindowBridge } from "../../../../types/desktop-window";
import type { RendererHost } from "../../../../ui";
import { registerPaneTableExporter } from "../../../../state/pane-table-export-registry";
import { ONE_SHOT_COOLDOWN_MS } from "../../../../utils/one-shot";
import { useShellPaneActions } from "./actions";

const tui = createOpenTuiTestHarness({ width: 20, height: 4 });

afterEach(() => setSystemTime());

const layout: LayoutConfig = {
  dockRoot: { kind: "pane", instanceId: "a" },
  instances: [{ instanceId: "a", paneId: "chart" }],
  floating: [],
} as unknown as LayoutConfig;

type Actions = ReturnType<typeof useShellPaneActions>;

async function mountActions(options: { desktopWindowBridge?: DesktopWindowBridge } = {}) {
  const notes: string[] = [];
  const closes: string[] = [];
  const result = {} as { current: Actions };
  function Probe() {
    result.current = useShellPaneActions({
      closePaneMenu: () => { closes.push("menu"); },
      contentHeight: 20,
      desktopWindowBridge: options.desktopWindowBridge,
      focusedPaneId: "a",
      focusPane: () => {},
      nativePaneChrome: true,
      paneMap: new Map([["a", { def: { name: "Chart", tableExport: true }, instance: { instanceId: "a" } } as unknown as ResolvedPane]]),
      persistLayout: () => {},
      previousFocusedPaneId: null,
      pluginRegistry: { notify: (note: { body: string }) => { notes.push(note.body); } } as unknown as PluginRegistry,
      // Nothing to paint in a terminal test, so every capture ends in one error note: a note counts a run.
      rendererHost: { copyPngImage: async () => {} } as unknown as RendererHost,
      visibleLayout: layout,
      width: 80,
    });
    return null;
  }
  await tui.render(<Probe />, { width: 20, height: 4 });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return { actions: () => result.current, notes, closes, settle };
}

describe("pane actions with a side effect", () => {
  test("Copy Screenshot captures once while triggers pile up, and again for a later press", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const { actions, notes, settle } = await mountActions();

    // A burst in one turn, as a held accelerator delivers it.
    for (let index = 0; index < 20; index += 1) actions().copyFocusedPaneScreenshot();
    await settle();
    expect(notes).toHaveLength(1);

    // The capture is over but the key may still be down.
    setSystemTime(new Date(Date.now() + 100));
    actions().copyFocusedPaneScreenshot();
    await settle();
    expect(notes).toHaveLength(1);

    setSystemTime(new Date(Date.now() + ONE_SHOT_COOLDOWN_MS + 1));
    actions().copyFocusedPaneScreenshot();
    await settle();
    expect(notes).toHaveLength(2);
  });

  test("Copy Screenshot from the menu is held to the same cooldown, and still closes the menu", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const { actions, notes, closes, settle } = await mountActions();

    void actions().copyPaneScreenshot("a");
    void actions().copyPaneScreenshot("a");
    await settle();

    expect(notes).toHaveLength(1);
    expect(closes).toHaveLength(2);
  });

  test("Export CSV writes one file for a burst of triggers, and another for a later press", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const files: string[] = [];
    const unregister = registerPaneTableExporter("a", async (filename) => {
      files.push(filename);
      return "/exports";
    });
    try {
      const { actions, settle } = await mountActions();

      for (let index = 0; index < 20; index += 1) actions().exportFocusedPaneCsv();
      await settle();
      setSystemTime(new Date(Date.now() + 100));
      actions().exportFocusedPaneCsv();
      await settle();
      expect(files).toHaveLength(1);

      setSystemTime(new Date(Date.now() + ONE_SHOT_COOLDOWN_MS + 1));
      actions().exportFocusedPaneCsv();
      await settle();
      expect(files).toHaveLength(2);
    } finally {
      unregister();
    }
  });

  test("Pop Out opens one window until the first request is answered and a cooldown after", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const pending = Promise.withResolvers<void>();
    let requests = 0;
    const bridge = {
      kind: "main",
      popOutPane: () => {
        requests += 1;
        return pending.promise;
      },
    } as unknown as DesktopWindowBridge;
    const { actions, settle } = await mountActions({ desktopWindowBridge: bridge });

    expect(actions().popOutFocusedPane()).toBe(true);
    setSystemTime(new Date(Date.now() + 5_000));
    expect(actions().popOutFocusedPane()).toBe(true);
    expect(requests).toBe(1);

    pending.resolve();
    await settle();
    setSystemTime(new Date(Date.now() + 100));
    expect(actions().popOutFocusedPane()).toBe(true);
    expect(requests).toBe(1);

    setSystemTime(new Date(Date.now() + ONE_SHOT_COOLDOWN_MS + 1));
    expect(actions().popOutFocusedPane()).toBe(true);
    expect(requests).toBe(2);
  });
});
