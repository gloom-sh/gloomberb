import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDataDir, saveConfig, watchExternalConfigChanges } from "./index";
import { createBlankLayout, createDefaultConfig, getPlacedPaneInstanceIds, type AppConfig, type LayoutConfig } from "../../../types/config";
import { buildSplitAroundNode } from "../../../layout/pane-manager/dock-tree";

const tempDirs: string[] = [];
const originalHome = process.env.GLOOMBERB_HOME;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.GLOOMBERB_HOME;
  else process.env.GLOOMBERB_HOME = originalHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Runs `change` on the saved config in another process, as a `gloom` command run beside the app does. */
async function writeFromAnotherProgram(dataDir: string, change: string): Promise<void> {
  const store = JSON.stringify(join(import.meta.dir, "node.ts"));
  const script = `
    const { loadConfig, saveConfig } = await import(${store});
    const config = await loadConfig(${JSON.stringify(dataDir)});
    await saveConfig((${change})(config));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, GLOOMBERB_HOME: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
}

function priceAlerts(config: AppConfig): unknown[] {
  return JSON.parse(String(config.pluginConfig.alerts?.alerts ?? "[]")) as unknown[];
}

describe("config.json shared with another program", () => {
  test.each([
    { start: "empty", id: "home" },
    { start: "docked", id: "home" },
    { start: "docked, legacy tab", id: undefined },
  ])("overlapping dock additions survive a stale save and reload ($start)", async ({ start, id }) => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-shared-layout-"));
    tempDirs.push(dataDir);
    process.env.GLOOMBERB_HOME = dataDir;
    const add = (layout: LayoutConfig, paneId: string): LayoutConfig => ({
      ...layout,
      instances: [...layout.instances, { instanceId: paneId, paneId }],
      dockRoot: layout.dockRoot ? buildSplitAroundNode(layout.dockRoot, paneId, "right") : { kind: "pane", instanceId: paneId },
    });
    const empty = createBlankLayout();
    const base = start === "empty" ? empty : add(empty, "help");
    const workspace = (config: AppConfig, layout: LayoutConfig) => ({ ...config, layout, layouts: [{ id, name: "Home", layout }] });
    await saveConfig(workspace(createDefaultConfig(dataDir), base));
    let app: AppConfig = workspace(await initDataDir(dataDir), add(base, "world-indices"));
    const pending = app;
    const external = add(base, "econ-calendar");
    const stop = watchExternalConfigChanges(dataDir, (change) => { app = change.apply(app); });
    try {
      await writeFromAnotherProgram(dataDir, `(config) => ({ ...config, layout: ${JSON.stringify(external)}, layouts: [{ ...config.layouts[0], layout: ${JSON.stringify(external)} }] })`);
      await saveConfig(pending);
      const disk = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as AppConfig;
      const expected = [...getPlacedPaneInstanceIds(base), "econ-calendar", "world-indices"].sort();
      for (const config of [disk, app, await initDataDir(dataDir)]) {
        for (const layout of [config.layout, config.layouts[0]!.layout]) {
          expect(layout.instances.map((instance) => instance.instanceId).sort()).toEqual(expected);
          expect(getPlacedPaneInstanceIds(layout).sort()).toEqual(expected);
        }
      }
    } finally {
      stop();
    }
  });

  test("an alert a command adds while the app runs survives the app's next save and reaches the app", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-shared-config-"));
    tempDirs.push(dataDir);
    process.env.GLOOMBERB_HOME = dataDir;
    let app = await initDataDir(dataDir);
    const stop = watchExternalConfigChanges(dataDir, (change) => { app = change.apply(app); });
    try {
      // A change in the app, saved after the command wrote: built before it, as a save waiting on its timer is.
      app = { ...app, theme: "nord" };
      const pendingSave = app;
      await writeFromAnotherProgram(dataDir, `(config) => ({
        ...config,
        pluginConfig: { ...config.pluginConfig, alerts: { alerts: JSON.stringify([{ id: "from-cli", symbol: "Z74" }]) } },
      })`);
      await saveConfig(pendingSave);

      const saved = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as AppConfig;
      expect(saved.theme).toBe("nord");
      expect(priceAlerts(saved)).toEqual([{ id: "from-cli", symbol: "Z74" }]);
      expect(priceAlerts(app)).toEqual([{ id: "from-cli", symbol: "Z74" }]);
      expect(app.theme).toBe("nord");
      expect((await readdir(dataDir)).filter((name) => name.startsWith("config.json."))).toEqual([]);

      // Deleted in the app once it holds the alert: the deletion is not undone.
      app = { ...app, pluginConfig: { ...app.pluginConfig, alerts: { alerts: "[]" } } };
      await saveConfig(app);
      const after = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as AppConfig;
      expect(priceAlerts(after)).toEqual([]);
      expect(after.theme).toBe("nord");
    } finally {
      stop();
    }
  });

  test("a lock a program left behind when it stopped is taken over, and the save takes and frees its own", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-shared-config-"));
    tempDirs.push(dataDir);
    process.env.GLOOMBERB_HOME = dataDir;
    const lock = join(dataDir, "config.json.lock");
    await writeFile(lock, "4242:1:stopped");
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lock, longAgo, longAgo);

    const startedAt = Date.now();
    await saveConfig({ ...createDefaultConfig(dataDir), theme: "nord" });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect((JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as AppConfig).theme).toBe("nord");
    expect((await readdir(dataDir)).filter((name) => name.startsWith("config.json."))).toEqual([]);
  });

  test("a lock another program holds is waited on for two seconds at most, and left to it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-shared-config-"));
    tempDirs.push(dataDir);
    process.env.GLOOMBERB_HOME = dataDir;
    const lock = join(dataDir, "config.json.lock");
    await writeFile(lock, "4242:1:holding");

    const startedAt = Date.now();
    await saveConfig({ ...createDefaultConfig(dataDir), theme: "nord" });
    const waited = Date.now() - startedAt;
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(5_000);
    // The save went ahead, and the lock it never took is still the other program's.
    expect((JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as AppConfig).theme).toBe("nord");
    expect(await readFile(lock, "utf-8")).toBe("4242:1:holding");
  });
});
