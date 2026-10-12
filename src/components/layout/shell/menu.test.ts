import { describe, expect, test } from "bun:test";
import { displayWidth } from "../../../utils/format";
import { getLanguage, setLanguage, t } from "../../../i18n";
import { withPluginContextMenuItems } from "../../../ui/context-menu";
import { actionMenuWidth, menuForPane } from "./menu";

describe("pane action menu", () => {
  test("toggles the pane lock and names the item for the next state", async () => {
    const layout = {
      dockRoot: { kind: "pane", instanceId: "chart-1" },
      instances: [{ instanceId: "chart-1", paneId: "chart-composer" }],
      floating: [],
      detached: [],
    } as any;
    const persisted: any[] = [];
    const buildMenu = (locked: boolean) => menuForPane(
      {
        instance: { ...layout.instances[0], locked: locked || undefined },
        def: { defaultPosition: "right" },
        floating: false,
      } as any,
      { ...layout, instances: [{ ...layout.instances[0], locked: locked || undefined }] },
      120,
      40,
      { hasPaneSettings: () => false, openWindowMode: () => {} } as any,
      (nextLayout: any) => { persisted.push(nextLayout); },
      () => {},
      () => {},
    );

    const lock = buildMenu(false).find((item) => item.type !== "divider" && item.id === "toggle-pane-lock");
    expect(lock?.label).toBe("Lock Pane");
    await lock?.onSelect?.();
    expect(persisted.at(-1)?.instances[0]?.locked).toBe(true);

    const unlock = buildMenu(true).find((item) => item.type !== "divider" && item.id === "toggle-pane-lock");
    expect(unlock?.label).toBe("Unlock Pane");
    await unlock?.onSelect?.();
    expect(persisted.at(-1)?.instances[0]?.locked).toBeUndefined();
  });
});

describe("plugin items in the pane menu", () => {
  test("sit with Share Pane and Export CSV, and leave nothing behind when there are none", () => {
    const pane = { instance: { instanceId: "chart-1", paneId: "chart-composer" }, def: { defaultPosition: "right" }, floating: false } as any;
    const layout = { dockRoot: { kind: "pane", instanceId: "chart-1" }, instances: [pane.instance], floating: [], detached: [] } as any;
    const items = menuForPane(
      pane, layout, 120, 40,
      { hasPaneSettings: () => false, openWindowMode: () => {} } as any,
      () => {}, () => {}, () => {}, undefined, undefined,
      () => {},
      [],
      () => {},
    );
    const context = { kind: "pane" as const, paneId: "chart-1", paneType: "chart-composer", title: "Chart", floating: false };
    const ids = (registryItems: Array<{ id: string; label: string }>) => withPluginContextMenuItems(context, items, {
      getContextMenuItems: () => registryItems,
    } as any).map((item) => (item.type === "divider" ? "-" : item.id));

    const withPlugin = ids([{ id: "share-pane-to-chat", label: "Share to Chat" }]);
    expect(withPlugin.slice(withPlugin.indexOf("share-pane"), withPlugin.indexOf("share-pane") + 4))
      .toEqual(["share-pane", "export-csv", "share-pane-to-chat", "float"]);
    const without = ids([]);
    expect(without.slice(without.indexOf("export-csv"), without.indexOf("export-csv") + 2)).toEqual(["export-csv", "float"]);
  });
});

describe("action menu sizing", () => {
  test("uses translated terminal display width", () => {
    const previousLanguage = getLanguage();
    try {
      setLanguage("ja");
      const translatedWidth = displayWidth(t("Dock Pane")) + 2;

      expect(actionMenuWidth([{ label: "Dock Pane" }], 44)).toBe(translatedWidth);
      expect(translatedWidth).toBeGreaterThan(18);
    } finally {
      setLanguage(previousLanguage);
    }
  });
});
