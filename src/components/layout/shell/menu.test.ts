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
