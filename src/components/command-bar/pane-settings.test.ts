import { describe, expect, test } from "bun:test";
import type { PluginRegistry } from "../../plugins/registry";
import type {
  PaneSettingActionField,
  PaneSettingActionContext,
  PaneSettingsContext,
} from "../../types/plugin";
import { activatePaneSettingFieldAction } from "./pane-settings";
import type { CommandBarRoute } from "./workflow/types";

const context = {
  paneId: "test-pane:main",
  settings: {},
} as PaneSettingsContext;

function actionField(overrides: Partial<PaneSettingActionField> = {}): PaneSettingActionField {
  return {
    key: "connection",
    label: "AI Account",
    type: "action",
    actionId: "ai.connect",
    actionLabel: "Connect",
    action: () => {},
    ...overrides,
  };
}

function registryFor(
  field: PaneSettingActionField,
  options: { openCommandBar?: (query?: string) => void } = {},
): PluginRegistry {
  return {
    resolvePaneSettings: () => ({
      paneId: context.paneId,
      pane: { title: "AI", paneId: "test-pane" },
      paneDef: { name: "AI" },
      settingsDef: { title: "AI Settings", fields: [field] },
      context,
    }),
    openCommandBar: options.openCommandBar ?? (() => {}),
    notify: () => {},
  } as unknown as PluginRegistry;
}

async function flushAction(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("pane setting actions", () => {
  test("runs the latest action callback with pane context without applying a value", async () => {
    const received: PaneSettingActionContext[] = [];
    const field = actionField({ action: (nextContext) => { received.push(nextContext); } });
    const registry = registryFor(field);
    let route: CommandBarRoute = {
      kind: "pane-settings",
      paneId: context.paneId,
      query: "",
      selectedIdx: 0,
      hoveredIdx: null,
      error: null,
      pendingFieldKey: null,
    };
    let closed = false;

    activatePaneSettingFieldAction({
      paneId: context.paneId,
      field,
      currentValue: undefined,
      keepRouteOpen: true,
      closeAll: () => { closed = true; },
      notify: () => {},
      openWorkflowRoute: () => {},
      pluginRegistry: registry,
      pushRoute: () => {},
      updateTopRoute: (updater) => { route = updater(route); },
    });

    expect(route.kind === "pane-settings" ? route.pendingFieldKey : null).toBe(field.key);
    await flushAction();

    expect(received[0]).toMatchObject({
      paneId: context.paneId,
      settings: context.settings,
      surface: "command-bar",
    });
    expect(typeof received[0]?.close).toBe("function");
    expect(typeof received[0]?.openCommandBar).toBe("function");
    expect(route.kind === "pane-settings" ? route.pendingFieldKey : "missing").toBeNull();
    expect(closed).toBe(false);
  });

  test("can close the command bar and hand off to an interactive workflow", async () => {
    const opened: Array<string | undefined> = [];
    const field = actionField({
      action: ({ openCommandBar }) => { openCommandBar("AI LOGIN"); },
    });
    const registry = registryFor(field, {
      openCommandBar: (query) => { opened.push(query); },
    });
    let closeCount = 0;

    activatePaneSettingFieldAction({
      paneId: context.paneId,
      field,
      currentValue: undefined,
      closeAll: () => { closeCount += 1; },
      notify: () => {},
      openWorkflowRoute: () => {},
      pluginRegistry: registry,
      pushRoute: () => {},
      updateTopRoute: () => {},
    });
    await flushAction();

    expect(closeCount).toBe(1);
    expect(opened).toEqual(["AI LOGIN"]);
  });
});
