import { Children, createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import type { GloomPluginContext, PaneProps } from "../../types/plugin";
import { debugLog, type LogEntry } from "../../utils/debug-log";
import { PluginRegistry } from "../registry";
import { usePluginConfigState, usePluginPaneState, usePluginState } from "../runtime";
import { usePluginRenderContext } from "../runtime/context";
import {
  composeBuiltinPlugin,
  type PluginModule,
} from "./plugin-module";

function context(): GloomPluginContext {
  return { log: debugLog.createLogger("parent") } as GloomPluginContext;
}

describe("composeBuiltinPlugin", () => {
  test("combines every declarative contribution under the parent plugin", () => {
    const first: PluginModule = {
      cliCommands: [{ name: "example", description: "Example", execute: () => {} }],
      panes: [{ id: "one", name: "One", component: () => null, defaultPosition: "right" }],
      paneTemplates: [{ id: "one-pane", paneId: "one", label: "One", description: "One" }],
      capabilities: [{ id: "capability-one" } as never],
      slots: { "status:widget": () => "one" },
    };
    const second: PluginModule = {
      panes: [{ id: "two", name: "Two", component: () => null, defaultPosition: "left" }],
      slots: { "status:widget": () => "two" },
    };

    const plugin = composeBuiltinPlugin({
      id: "parent",
      name: "Parent",
      version: "1.0.0",
      modules: [first, second],
    });

    expect(plugin.cliCommands?.map((command) => command.name)).toEqual(["example"]);
    expect(plugin.panes?.map((pane) => pane.id)).toEqual(["one", "two"]);
    expect(plugin.paneTemplates?.map((template) => template.id)).toEqual(["one-pane"]);
    expect(plugin.capabilities?.map((capability) => capability.id)).toEqual(["capability-one"]);

    const slotOutput = plugin.slots?.["status:widget"]?.({});
    expect(isValidElement(slotOutput)).toBe(true);
    expect(Children.count((slotOutput as ReactElement<{ children: unknown }>).props.children)).toBe(2);
  });

  test("isolates setup failures and disposes every started module in reverse order", async () => {
    const lifecycle: string[] = [];
    const errors: LogEntry[] = [];
    const plugin = composeBuiltinPlugin({
      id: "parent",
      name: "Parent",
      version: "1.0.0",
      modules: [
        {
          setup: () => { lifecycle.push("setup:first"); },
          dispose: () => { lifecycle.push("dispose:first"); },
        },
        {
          setup: () => {
            lifecycle.push("setup:second");
            throw new Error("setup failed");
          },
          dispose: () => { lifecycle.push("dispose:second"); },
        },
        {
          setup: () => { lifecycle.push("setup:third"); },
          dispose: () => { lifecycle.push("dispose:third"); },
        },
      ],
    });

    const unsubscribe = debugLog.subscribe((entry) => { if (entry.level === "error") errors.push(entry); });
    try {
      await plugin.setup?.(context());
    } finally {
      unsubscribe();
    }
    plugin.dispose?.();

    expect(errors[0]).toMatchObject({ source: "parent", data: { error: "setup failed" } });
    expect(lifecycle).toEqual([
      "setup:first",
      "setup:second",
      "setup:third",
      "dispose:third",
      "dispose:second",
      "dispose:first",
    ]);
  });

  test("a module that moved plugins keeps reading the state saved under its old namespace", async () => {
    const persistence = new AppPersistence(":memory:");
    const registry = new PluginRegistry(createTestDataProvider(), new TickerRepository(persistence.tickers), persistence);
    try {
      const state = createInitialState({
        ...createDefaultConfig("/tmp/gloomberb-module-namespace-test"),
        pluginConfig: { legacy: { unit: "bp" } },
      });
      state.paneState["moved:main"] = { pluginState: { legacy: { mode: "curve" } } };
      registry.bindHost({ getConfig: () => state.config });
      persistence.pluginState.set("legacy", "cache", "warm");
      persistence.pluginState.set("legacy", "resume:view", "spread");

      let cached: unknown = null;
      const moved: PluginModule = {
        panes: [{
          id: "moved",
          name: "Moved",
          defaultPosition: "right",
          component: () => {
            const [mode] = usePluginPaneState("mode", "none");
            const [view] = usePluginState("view", "none");
            const [unit] = usePluginConfigState("unit", "none");
            return `${mode}/${view}/${unit}`;
          },
        }],
        setup(ctx) {
          cached = ctx.persistence.getState("cache");
          ctx.registerTickerResearchTab({ id: "moved-tab", name: "Moved", order: 1, component: () => usePluginRenderContext().pluginId });
        },
      };
      const stays: PluginModule = {
        panes: [{ id: "stays", name: "Stays", defaultPosition: "right", component: () => usePluginRenderContext().pluginId }],
      };
      await registry.register(composeBuiltinPlugin({
        id: "successor",
        name: "Successor",
        version: "1.0.0",
        modules: [stays, { module: moved, stateId: "legacy" }],
      }));

      const render = (component: (props: never) => unknown, paneId: string) => renderToStaticMarkup(
        createElement(AppContext, { value: createStaticAppStore(state) }, createElement(PaneInstanceProvider, {
          paneId,
          children: createElement(component as (props: PaneProps) => null, {
            paneId, paneType: paneId.split(":")[0]!, focused: true, width: 80, height: 20,
          }),
        })),
      );
      expect(render(registry.panes.get("moved")!.component, "moved:main")).toBe("curve/spread/bp");
      expect(render(registry.tickerResearchTabs.get("moved-tab")!.component, "ticker-detail:main")).toBe("legacy");
      expect(cached).toBe("warm");
      // Everything else is still the successor's: its toggle, and the module beside it.
      expect(registry.getPanePluginId("moved")).toBe("successor");
      expect(render(registry.panes.get("stays")!.component, "stays:main")).toBe("successor");
    } finally {
      registry.destroy();
      persistence.close();
    }
  });
});
