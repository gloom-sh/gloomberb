import { expect, test } from "bun:test";
import { debugLog, type LogEntry } from "../../utils/debug-log";
import type { LoadedExternalPlugin } from "../loader";
import { activateInstalledPlugin } from "./activation";
import type { MarketplaceHost, PluginManager } from "./store";

test("a host registration failure is logged without replacing the original plugin load failure", async () => {
  const loaded: LoadedExternalPlugin = {
    plugin: { id: "broken-plugin", name: "Broken plugin", version: "1.0.0" },
    directory: "broken-plugin",
    path: "broken-plugin",
    error: "Plugin setup failed",
  };
  const recorded: LoadedExternalPlugin[] = [];
  const entries: LogEntry[] = [];
  const unsubscribe = debugLog.subscribe((entry) => {
    if (entry.source === "plugin-activation") entries.push(entry);
  });
  try {
    const outcome = await activateInstalledPlugin("broken-plugin", {
      activate: async (entry: LoadedExternalPlugin) => {
        recorded.push(entry);
        throw new Error("Registration failed");
      },
    } as MarketplaceHost, {
      load: async () => loaded,
      activate: async () => { throw new Error("A failed plugin must not reach backend activation"); },
    } as PluginManager);

    expect(outcome).toEqual({ ok: false, error: loaded.error, name: loaded.plugin.name });
    expect(recorded).toEqual([loaded]);
    expect(entries.map((entry) => entry.source)).toEqual(["plugin-activation"]);
  } finally {
    unsubscribe();
  }
});

test("a rejected pending-restart registration reports activation failure and logs it", async () => {
  const loaded: LoadedExternalPlugin = {
    plugin: { id: "updated-plugin", name: "Updated plugin", version: "2.0.0" },
    directory: "updated-plugin",
    path: "updated-plugin",
    needsRestart: true,
  };
  const failure = new Error("Could not record pending restart");
  const entries: LogEntry[] = [];
  const unsubscribe = debugLog.subscribe((entry) => {
    if (entry.source === "plugin-activation") entries.push(entry);
  });
  try {
    const outcome = await activateInstalledPlugin(loaded.directory, {
      activate: async () => { throw failure; },
    } as unknown as MarketplaceHost, {
      load: async () => loaded,
      activate: async () => { throw new Error("A pending restart must not reach backend activation"); },
    } as PluginManager);

    expect(outcome).toEqual({ ok: false, error: failure.message, name: loaded.plugin.name });
    expect(entries.map((entry) => entry.source)).toEqual(["plugin-activation"]);
  } finally {
    unsubscribe();
  }
});
