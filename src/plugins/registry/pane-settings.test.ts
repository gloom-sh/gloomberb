import { expect, test } from "bun:test";
import { registerPaneTableExporter } from "../../state/pane-table-export-registry";
import { createDefaultConfig } from "../../types/config";
import type { AppNotificationRequest, PaneDef } from "../../types/plugin";
import { resolveRegistryPaneSettings } from "./pane-settings";

test("adds a working CSV action to exportable table panes", async () => {
  const pane = { instanceId: "prices:main", paneId: "prices", title: "Market Prices" };
  const config = createDefaultConfig("/tmp/gloomberb-pane-export-test");
  config.layout.instances = [pane];
  const filenames: string[] = [];
  const unregister = registerPaneTableExporter(pane.instanceId, async (filename) => {
    filenames.push(filename);
    return `~/Downloads/${filename}`;
  });

  try {
    const paneDef: PaneDef = {
      id: pane.paneId,
      name: "Prices",
      component: () => null,
      defaultPosition: "right",
      tableExport: true,
    };
    const resolved = resolveRegistryPaneSettings({
      config,
      getConfigState: () => null,
      getPaneRuntimeState: () => null,
      layout: config.layout,
      paneDefs: new Map([[pane.paneId, paneDef]]),
      paneOwners: new Map(),
      resolvePaneTarget: () => pane.instanceId,
      requestedPaneId: pane.instanceId,
    });
    const field = resolved?.settingsDef.fields[0];
    expect(field).toMatchObject({ type: "action", label: "Export CSV", disabled: false });
    if (!field || field.type !== "action" || !resolved) throw new Error("Missing export action");

    const notifications: AppNotificationRequest[] = [];
    await field.action({
      ...resolved.context,
      surface: "pane-dialog",
      close: () => {},
      openCommandBar: () => {},
      notify: (notification) => notifications.push(notification),
    });

    expect(filenames[0]).toMatch(/^Market-Prices-.*\.csv$/);
    expect(notifications[0]).toMatchObject({ type: "success" });
  } finally {
    unregister();
  }
});
