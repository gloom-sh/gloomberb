import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, test } from "bun:test";
import type { BrokerAdapter } from "../../types/broker";
import type { GloomPluginContext } from "../../types/plugin";
import { debugLog, type LogEntry } from "../../utils/debug-log";
import {
  composeBuiltinPlugin,
  type PluginModule,
} from "./plugin-module";

function broker(id: string): BrokerAdapter {
  return { id } as BrokerAdapter;
}

function context(registerBroker: (value: BrokerAdapter) => void = () => {}): GloomPluginContext {
  return { registerBroker } as GloomPluginContext;
}

describe("composeBuiltinPlugin", () => {
  test("combines every declarative contribution under the parent plugin", async () => {
    const registeredBrokers: string[] = [];
    const first: PluginModule = {
      cliCommands: [{ name: "example", description: "Example", execute: () => {} }],
      panes: [{ id: "one", name: "One", component: () => null, defaultPosition: "right" }],
      paneTemplates: [{ id: "one-pane", paneId: "one", label: "One", description: "One" }],
      capabilities: [{ id: "capability-one" } as never],
      broker: broker("broker-one"),
      slots: { "status:widget": () => "one" },
    };
    const second: PluginModule = {
      panes: [{ id: "two", name: "Two", component: () => null, defaultPosition: "left" }],
      broker: broker("broker-two"),
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

    await plugin.setup?.(context((value) => registeredBrokers.push(value.id)));
    expect(registeredBrokers).toEqual(["broker-one", "broker-two"]);
    plugin.dispose?.();
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

    expect(errors[0]?.data).toEqual({ pluginId: "parent", error: "setup failed" });
    expect(lifecycle).toEqual([
      "setup:first",
      "setup:second",
      "setup:third",
      "dispose:third",
      "dispose:second",
      "dispose:first",
    ]);
  });
});
