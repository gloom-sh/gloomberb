import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDataDir, saveConfig, watchExternalConfigChanges } from "./index";
import { createBlankLayout, createDefaultConfig, getPlacedPaneInstanceIds, type AppConfig, type DockLayoutNode, type LayoutConfig } from "../../../types/config";
import { buildSplitAroundNode, getDockedInstanceIds } from "../../../layout/pane-manager/dock-tree";

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

function workspace(layouts: AppConfig["layouts"], activeLayoutIndex: number) {
  return { layouts, activeLayoutIndex, layout: layouts[activeLayoutIndex]!.layout };
}

function docked(dockRoot: DockLayoutNode | null): LayoutConfig {
  return { ...createBlankLayout(), dockRoot, instances: getDockedInstanceIds(dockRoot).map((paneId) => ({ paneId, instanceId: paneId })) };
}

type Workspace = ReturnType<typeof workspace> & Partial<Pick<AppConfig, "theme">>;

async function checkStaleSave(base: Workspace, first: Workspace, last: Workspace, expected: Workspace) {
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-shared-tabs-"));
  tempDirs.push(dataDir);
  process.env.GLOOMBERB_HOME = dataDir;
  await saveConfig({ ...createDefaultConfig(dataDir), ...base });
  const pending = { ...await initDataDir(dataDir), ...last };
  await writeFromAnotherProgram(dataDir, `(config) => ({ ...config, ...${JSON.stringify(first)} })`);
  await saveConfig(pending);
  const raw = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")) as AppConfig;
  for (const config of [raw, await initDataDir(dataDir)]) {
    expect(config.layouts.map(({ id, name }) => [id, name])).toEqual(expected.layouts.map(({ id, name }) => [id, name]));
    expect(config.activeLayoutIndex).toBe(expected.activeLayoutIndex);
    if (expected.theme !== undefined) expect(config.theme).toBe(expected.theme);
    const layouts = [config.layout, ...config.layouts.map((tab) => tab.layout)];
    [expected.layout, ...expected.layouts.map((tab) => tab.layout)].forEach((wanted, index) => {
      const actual = layouts[index]!;
      expect(actual.dockRoot).toEqual(wanted.dockRoot);
      expect(actual.instances.map(({ instanceId }) => instanceId).sort()).toEqual(getDockedInstanceIds(wanted.dockRoot).sort());
      expect(actual.floating).toEqual([]);
      expect(actual.detached).toEqual([]);
    });
  }
}

const leaf = (instanceId: string): DockLayoutNode => ({ kind: "pane", instanceId });

for (const structureFirst of [true, false]) {
  test.each(["settings", "pane content"])(`insert and reorder tabs beside a %s edit (structural save ${structureFirst ? "first" : "last"})`, async (edit) => {
    const home = { id: "home", name: "Home", layout: docked(leaf("help")) };
    const legacy = { name: "Legacy", layout: docked(leaf("news")) };
    const added = { id: "new", name: "New", layout: docked(leaf("world-indices")) };
    const base = { ...workspace([home, legacy], 0), theme: "white" };
    const structural = workspace([legacy, added, home], 1);
    const changedHome = edit === "pane content" ? { ...home, layout: docked(buildSplitAroundNode(leaf("help"), "econ-calendar", "above")) } : home;
    const other = { ...workspace([changedHome, legacy], 0), theme: edit === "settings" ? "nord" : base.theme };
    const expected = { ...workspace([legacy, added, changedHome], 1), theme: other.theme };
    await checkStaleSave(base, structureFirst ? structural : other, structureFirst ? other : structural, expected);
  });
}

for (const renameFirst of [true, false]) {
  describe(`stale legacy tab save (rename ${renameFirst ? "first" : "last"})`, () => {
    const home = { id: "home", name: "Home", layout: docked(leaf("help")) };
    const legacy = { name: "Legacy", layout: docked(leaf("news")) };
    const base = workspace([home, legacy], 0);
    const research = { ...legacy, name: "Research" };
    const renamed = workspace([home, research], 0);

    test.each(["switch", "reorder"])("a %s follows the renamed tab", async (edit) => {
      const other = edit === "switch" ? workspace([home, legacy], 1) : workspace([legacy, home], 1);
      const expected = workspace(edit === "switch" ? [home, research] : [research, home], 1);
      await checkStaleSave(base, renameFirst ? renamed : other, renameFirst ? other : renamed, expected);
    });

    test("a moved and renamed tab keeps a concurrent split around its original pane", async () => {
      const split = docked(buildSplitAroundNode(leaf("news"), "world-indices", "above"));
      const opened = workspace([home, { ...legacy, layout: split }], 0);
      const moved = workspace([research, home], 0);
      const expected = workspace([{ ...research, layout: split }, home], 0);
      await checkStaleSave(base, renameFirst ? moved : opened, renameFirst ? opened : moved, expected);
    });

    test("competing replacements leave one complete tab in the vacated slot", async () => {
      const first = workspace([home, { name: "Research", layout: docked(leaf("world-indices")) }], 1);
      const second = workspace([home, { name: "Markets", layout: docked(leaf("econ-calendar")) }], 1);
      const last = renameFirst ? second : first;
      await checkStaleSave(base, renameFirst ? first : second, last, last);
    });
  });
}

for (const addFirst of [true, false]) {
  describe(`stale workspace save (pane addition ${addFirst ? "first" : "last"})`, () => {
    const verify = (base: Workspace, add: Workspace, other: Workspace, expected: Workspace) =>
      checkStaleSave(base, addFirst ? add : other, addFirst ? other : add, expected);

    test.each(["rename", "reorder"])("an unrelated legacy tab %s keeps an identified tab's split", async (edit) => {
      const legacy = { name: "Legacy", layout: docked(null) };
      const work = { id: "w", name: "Work", layout: docked(leaf("news")) };
      const opened = { ...work, layout: docked(buildSplitAroundNode(leaf("news"), "help", "above")) };
      const edited = (tab: typeof work) => edit === "rename"
        ? workspace([{ ...legacy, name: "Renamed" }, tab], 0) : workspace([tab, legacy], 1);
      await verify(workspace([legacy, work], 0), workspace([legacy, opened], 0), edited(work), edited(opened));
    });

    test.each([
      { kind: "new name and panes", original: null, name: "Other", replacement: leaf("news") },
      { kind: "renamed empty slot", original: null, name: "Other", replacement: null },
      { kind: "reused name with disjoint panes", original: leaf("news"), name: "Legacy", replacement: leaf("econ-calendar") },
    ])("a replacement legacy tab does not inherit its predecessor's pane ($kind)", async ({ original, name, replacement }) => {
      const legacy = { name: "Legacy", layout: docked(original) };
      const work = { id: "w", name: "Work", layout: docked(null) };
      const opened = { ...legacy, layout: docked(original ? buildSplitAroundNode(original, "help", "above") : leaf("help")) };
      const replaced = workspace([{ name, layout: docked(replacement) }, work], 0);
      await verify(workspace([legacy, work], 0), workspace([opened, work], 0), replaced, replaced);
    });

    test("switching tabs selects the merged saved layout without moving panes between tabs", async () => {
      const home = { id: "a", name: "A", layout: docked(null) };
      const news = { id: "b", name: "B", layout: docked(leaf("news")) };
      const opened = { ...home, layout: docked(leaf("help")) };
      await verify(workspace([home, news], 0), workspace([opened, news], 0), workspace([home, news], 1), workspace([opened, news], 1));
    });

    test("closing a sibling promotes the surviving new split with its geometry", async () => {
      const home = (root: DockLayoutNode) => workspace([{ id: "home", name: "Home", layout: docked(root) }], 0);
      const right = leaf("news");
      const root = { kind: "split", axis: "horizontal", ratio: 0.6, first: leaf("help"), second: right } as const;
      const subtree = { kind: "split", axis: "vertical", ratio: 0.35, first: leaf("world-indices"), second: right } as const;
      await verify(home(root), home({ ...root, second: subtree }), home(right), home(subtree));
    });
  });
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
