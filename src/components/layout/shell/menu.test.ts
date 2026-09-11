import { describe, expect, test } from "bun:test";
import { displayWidth } from "../../../utils/format";
import { getLanguage, setLanguage, t } from "../../../i18n";
import { actionMenuWidth, menuForPane } from "./menu";

describe("pane action menu", () => {
  test("offers the global share action for a portable pane", async () => {
    let shared = false;
    const items = menuForPane(
      {
        instance: { instanceId: "chart-1", paneId: "chart-composer" },
        def: { defaultPosition: "right" },
        floating: false,
      } as any,
      {
        dockRoot: { kind: "pane", instanceId: "chart-1" },
        instances: [{ instanceId: "chart-1", paneId: "chart-composer" }],
        floating: [],
        detached: [],
      },
      120,
      40,
      {
        hasPaneSettings: () => false,
        openWindowMode: () => {},
      } as any,
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      () => { shared = true; },
    );

    const share = items.find((item) => item.type !== "divider" && item.id === "share-pane");
    await share?.onSelect?.();
    expect(shared).toBe(true);
    expect(share?.accelerator).toBe("CmdOrCtrl+Shift+S");
  });

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
