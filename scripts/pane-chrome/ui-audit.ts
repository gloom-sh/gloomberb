import { appendFile, mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir, click, evaluate, launchBrowser, sleep, waitFor, type Browser, type Cdp } from "./browser";
import { checkoutPlugin, pluginLock } from "./plugin-lock";
import { pathName, visitAlternatives } from "./tab-visits";
import { UI_AUDIT_MEASURE, type AuditMeasure } from "./ui-audit-measure";
import { writeAuditReport } from "./ui-audit-report";
import {
  createReplay, discover, fallbackInstance, key, loadLayout, readCatalog, routeDirectReads,
  runCommand, serveWebApp, settle, shot, type CatalogEntry, type SeedOptions,
} from "./web-app";

/**
 * The UI audit: every view of the desktop and web app, measured. For each
 * function in the catalog, the panes of the plugins the web app bundles and,
 * with `--registry`, of every plugin the registry lists (at the commits the
 * replay folder's lock pins: plugin-lock.ts), it opens the pane
 * docked on the real web build at each width, then its detail (Enter) and
 * each of its tabs, each opened from the pane as it first shows and measured
 * only once the page says it is selected (tab-visits.ts; a tab it could not
 * open is listed in `views.jsonl` as unmeasured, with why), and records with ui-audit-measure.ts every run of text
 * (size, line height, weight, colour, where it sits against the pane's edge,
 * and the component that drew it), every element of a design-system family
 * (buttons, tabs, chips, fields, rows, headings, cards, states, pane chrome,
 * dialogs, menus, chart chrome) with its shape and colours, and the rows of
 * tables and lists. The first time a variant of a family shows, it is
 * pictured as drawn and, for the interactive ones, under the pointer
 * (`variants/`). The shell is measured too: the app header and status bar,
 * the command bar, a dialog, a pane's menu and the first-run guide.
 *
 *   bun run audit:ui [--only TOP,CHG] [--widths 640,1280] [--themes white,paper]
 *                    [--registry] [--build] [--no-shots] [--resume] [--list]
 *                    [--out <dir>] [--web <dir>] [--replay <dir>] [--root <checkout>]
 *                    [--offline] [--shard 0/4] [--no-report] [--no-variants]
 *
 * `--offline` reads only what the replay kept (web-app.ts); `--shard i/n`
 * takes the functions whose token hashes to `i` of `n` (the shell views go
 * with shard 0), so shards stay put as functions come and go; `--no-report`
 * skips the report, for the checks that read `results.jsonl` themselves
 * (ui-tokens.ts, ui-benchmark.ts); `--no-variants` skips the pictures of
 * each variant, which only the report shows.
 *
 * It builds its own copy of the web app (`build-web.ts --keep-names`, so the
 * components keep their names) under the cache folder, and reads Gloom Cloud
 * signed out as web-app.ts describes, from its own replay folder: a second run
 * draws the same data. Measures are taken in the first theme; every theme gets
 * a picture of each view, under `shots/<theme>/<width>/`. `views.jsonl` lists
 * every view with the pane instance and steps that open it, so another
 * browser can draw the same views. At the end ui-audit-report.ts writes
 * `report.md` and `report.json`: the variants of each family with a picture
 * grid, the type, insets and row heights in use, colours against the theme,
 * and a scan of the code for literals that bypass the theme and the kit. Run
 * it again with `--sheets` for contact sheets of every view.
 */

const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const only = takeOption(args, "--only")?.split(",");
const widths = (takeOption(args, "--widths") ?? "640,1280").split(",").map(Number);
const height = Number(takeOption(args, "--height") ?? 800);
const themes = (takeOption(args, "--themes") ?? "white,paper").split(",");
const out = resolve(takeOption(args, "--out") ?? cacheDir("ui-audit"));
const web = resolve(takeOption(args, "--web") ?? cacheDir("ui-audit-web"));
const replayDir = resolve(takeOption(args, "--replay") ?? cacheDir("ui-audit-replay"));
const replay = createReplay(replayDir, { offline: args.includes("--offline") });
const shard = parseShard(takeOption(args, "--shard"));
const report = !args.includes("--no-report");
const shots = !args.includes("--no-shots");
const variants = shots && !args.includes("--no-variants");
const resume = args.includes("--resume");
const withRegistry = args.includes("--registry");
/** Families whose look under the pointer is pictured too. */
const HOVERED = new Set(["button", "tab", "link", "chip", "toggle", "input", "select", "menu-item", "keycap", "list-row", "table-row"]);

/** What makes a variant worth its own picture: the family, its shape, the component and its state. */
function variantKeyOf(element: { family: string; shape: string; component: string; state: string }): string {
  return [element.family, element.shape, element.component, element.state].join("|");
}
/**
 * How long one function may take before it counts as stuck. T measures 34
 * views at two widths and pictures them in two themes; on a busy host that
 * passed six minutes without anything being stuck.
 */
const ENTRY_TIMEOUT_MS = 12 * 60_000;
const debug = process.env.UI_AUDIT_DEBUG ? (message: string) => console.log(`  ${(performance.now() / 1000).toFixed(1)}s ${message}`) : () => {};

interface AuditEntry extends CatalogEntry {
  /** The registry or bundled plugin a pane comes from; built-in panes have none. */
  plugin?: string;
}

/** One view of the app: what it is, and how to open it again. */
interface AuditView {
  id: string;
  kind: "pane" | "shell";
  token: string;
  paneId?: string;
  plugin?: string;
  instance?: Record<string, unknown>;
  /** Root, detail (Enter on the root), a tab of the root by its label, or a tab not measured (`unmeasured`, `skipped`) with why. */
  view: string;
  tab?: string;
  reason?: string;
}

interface AuditResult extends AuditView {
  width: number;
  height: number;
  theme: string;
  measure: AuditMeasure;
}

/** `i/n`, or every function. */
function parseShard(value: string | undefined): { index: number; count: number } {
  if (!value) return { index: 0, count: 1 };
  const [index, count] = value.split("/").map(Number) as [number, number];
  if (!(count >= 1) || !(index >= 0 && index < count)) throw new Error(`--shard takes i/n with 0 <= i < n, not ${value}`);
  return { index, count };
}

/** The shard a function belongs to: by its token, so adding a function moves no other. */
export function shardOf(token: string, count: number): number {
  return Number.parseInt(new Bun.CryptoHasher("sha1").update(token).digest("hex").slice(0, 8), 16) % count;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "tab";

/**
 * Registry plugins that are not built in, checked out at the commits the
 * replay folder's lock pins (plugin-lock.ts) and installed beside each other.
 */
async function registryPluginDirs(builtIn: Set<string>): Promise<string[]> {
  const { linkHostPackages } = await import("../../src/plugins/host-link");
  const { WEB_BUNDLED_PLUGIN_PACKAGES } = await import("../../src/plugins/web-bundled");
  const pluginsDir = cacheDir("ui-audit-plugins");
  await mkdir(pluginsDir, { recursive: true });
  const lock = await pluginLock(replayDir, pluginsDir);
  const dirs: string[] = [];
  for (const plugin of lock.plugins) {
    if (builtIn.has(plugin.id)) continue;
    if ((WEB_BUNDLED_PLUGIN_PACKAGES as readonly string[]).includes(plugin.repo.split("/")[1]!)) continue;
    const dir = await checkoutPlugin(plugin, pluginsDir);
    if (!dir) { console.warn(`Left out ${plugin.id}: could not fetch ${plugin.repo}@${plugin.commit.slice(0, 12)}`); continue; }
    dirs.push(dir);
  }
  // Linked once every plugin is checked out: a plugin's peer (ibkr-gateway's ibkr) may come after it.
  for (const dir of dirs) linkHostPackages(dir, undefined, pluginsDir);
  return dirs;
}

/** The web app with component names kept, and the registry's plugins when asked. */
async function buildWeb(pluginDirs: string[]): Promise<void> {
  const build = Bun.spawnSync(["bun", "scripts/build-web.ts", "--out", web, "--keep-names", ...pluginDirs.flatMap((dir) => ["--plugin", dir])], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error("The audit's web build failed");
}

/** The functions of the plugins compiled into the audit's build, read from the compiled modules. */
async function pluginEntries(): Promise<AuditEntry[]> {
  const { installPluginHostModules } = await import("../../src/plugins/host-modules");
  const { pluginFromModule } = await import("../../src/plugins/plugin-export");
  await installPluginHostModules();
  const entries: AuditEntry[] = [];
  const dir = join(web, "assets", "plugins");
  for (const name of existsSync(dir) ? await readdir(dir) : []) {
    const files = (await readdir(join(dir, name))).filter((file) => file.endsWith(".js"));
    for (const file of files) {
      const plugin = await import(join(dir, name, file)).then(pluginFromModule).catch(() => null);
      if (!plugin) continue;
      const templated = new Set<string>();
      for (const template of plugin.paneTemplates ?? []) {
        // One function per pane: a plugin that lists a template per report (FXMD) draws them in one pane.
        if (templated.has(template.paneId)) continue;
        templated.add(template.paneId);
        const token = template.shortcut?.prefix ?? template.id;
        entries.push({ token, paneId: template.paneId, argKind: template.shortcut?.argKind ?? null, plugin: plugin.id });
      }
      for (const pane of plugin.panes ?? []) {
        if (!templated.has(pane.id)) entries.push({ token: pane.id, paneId: pane.id, plugin: plugin.id });
      }
    }
  }
  return entries;
}

const dock = (instance: Record<string, unknown>) => ({ dockRoot: { kind: "pane", instanceId: instance.instanceId }, instances: [instance], floating: [], detached: [] });
const EMPTY_LAYOUT = { dockRoot: null, instances: [], floating: [], detached: [] };
const SAMPLE_PANE = { instanceId: "world-indices:audit", paneId: "world-indices", binding: { kind: "none" } };
const COMMAND_BAR = "[data-gloom-role=command-bar-panel]";

/**
 * The shell around the panes: views with no pane of their own to scope to.
 * `surface` is what opening the view must put on the page; a view whose
 * surface is not there fails the run instead of measuring the page under it.
 * Not here: the onboarding, which the web build always marks done
 * (renderers/browser/config-host.ts), and the title bar's right-click menu,
 * which is the desktop's native menu and draws nothing in the page.
 */
const SHELL_VIEWS: Array<{ id: string; layout: object; focused?: string; seed?: SeedOptions; surface?: string; open(cdp: Cdp): Promise<void> }> = [
  { id: "shell", layout: EMPTY_LAYOUT, async open() {} },
  { id: "command-bar", layout: dock(SAMPLE_PANE), focused: SAMPLE_PANE.instanceId, surface: COMMAND_BAR, async open(cdp) { await key(cdp, "p", "KeyP", 80, 2); } },
  { id: "command-bar-search", layout: dock(SAMPLE_PANE), focused: SAMPLE_PANE.instanceId, surface: COMMAND_BAR, async open(cdp) { await runCommand(cdp, "apple", { submit: false }); } },
  // "TH" and a space is the theme list; Enter would pick the highlighted theme and close it.
  { id: "theme-picker", layout: dock(SAMPLE_PANE), focused: SAMPLE_PANE.instanceId, surface: '[aria-label="Theme picker"]', async open(cdp) { await runCommand(cdp, "TH ", { submit: false }); } },
  { id: "feedback-dialog", layout: dock(SAMPLE_PANE), focused: SAMPLE_PANE.instanceId, surface: ".gloom-dialog", async open(cdp) { await runCommand(cdp, "FB"); } },
  { id: "pane-settings-dialog", layout: dock(SAMPLE_PANE), focused: SAMPLE_PANE.instanceId, surface: ".gloom-dialog [data-gloom-role=pane-setting-row]", async open(cdp) { await runCommand(cdp, "PS"); } },
  {
    id: "pane-menu",
    layout: dock(SAMPLE_PANE),
    focused: SAMPLE_PANE.instanceId,
    surface: ".gloom-menu, [role=menu]",
    // The pane's actions button (its "more" icon) opens the pane menu, once the pane has drawn it.
    async open(cdp) {
      const at = await waitFor<{ x: number; y: number } | null>(cdp, `(() => { const r = document.querySelector("[data-gloom-role=pane-action] > *")?.getBoundingClientRect(); return r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`, 6_000);
      if (!at) return;
      await click(cdp, at);
    },
  },
];

async function writeLine(file: string, value: unknown): Promise<void> {
  await appendFile(file, `${JSON.stringify(value)}\n`);
}

async function readLines<T>(file: string): Promise<T[]> {
  if (!await Bun.file(file).exists()) return [];
  return (await Bun.file(file).text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function main(): Promise<void> {
  const catalog: AuditEntry[] = readCatalog(root, cacheDir("ui-audit-home"));
  const builtIn = new Set(catalog.map((entry) => entry.paneId));
  if (args.includes("--build") || !await Bun.file(join(web, "index.html")).exists()) {
    await buildWeb(withRegistry ? await registryPluginDirs(builtIn) : []);
  }
  const entries = [...catalog, ...(await pluginEntries()).filter((entry) => !builtIn.has(entry.paneId))]
    .filter((entry) => !only || only.includes(entry.token))
    .filter((entry) => shardOf(entry.token, shard.count) === shard.index);
  const shells = SHELL_VIEWS.filter((view) => (!only || only.includes(view.id)) && shard.index === 0);
  if (args.includes("--list")) {
    for (const entry of entries) console.log(`${entry.token}\t${entry.paneId}\t${entry.plugin ?? ""}`);
    for (const shell of shells) console.log(`${shell.id}\tshell`);
    return;
  }

  await mkdir(out, { recursive: true });
  const resultsFile = join(out, "results.jsonl");
  const viewsFile = join(out, "views.jsonl");
  const done = new Set<string>();
  if (resume) for (const view of await readLines<AuditView>(viewsFile)) done.add(view.token);
  else { await rm(resultsFile, { force: true }); await rm(viewsFile, { force: true }); }

  const app = serveWebApp(web, replay);
  let browser: Browser = await launchBrowser("ui-audit", widths[0]!, height);
  const start = async () => {
    await routeDirectReads(browser.cdp, replay);
    await browser.cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  };
  await start();

  /** Pictures of each variant the first time it is seen: as drawn, and under the pointer for the interactive ones. */
  const variantsFile = join(out, "variants.jsonl");
  const pictured = new Set<string>();
  if (resume) for (const line of await readLines<{ key: string }>(variantsFile)) pictured.add(line.key);
  const pictureVariants = async (view: AuditView, width: number, value: AuditMeasure) => {
    const cdp = browser.cdp;
    const dir = join(out, "variants");
    await mkdir(dir, { recursive: true });
    for (const element of value.elements) {
      if (!element.sample) continue;
      const variantKey = variantKeyOf(element);
      if (pictured.has(variantKey)) continue;
      pictured.add(variantKey);
      const file = `${new Bun.CryptoHasher("sha1").update(variantKey).digest("hex").slice(0, 16)}`;
      const { x, y, width: w, height: h } = element.sample;
      const clip = { x: Math.max(0, x - 4), y: Math.max(0, y - 4), width: Math.min(w + 8, width - Math.max(0, x - 4)), height: Math.min(h + 8, height - Math.max(0, y - 4)), scale: 1 };
      const grab = async (name: string) => {
        const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip });
        await Bun.write(join(dir, name), Buffer.from(data, "base64"));
      };
      await grab(`${file}.png`);
      let hover: string | null = null;
      if (HOVERED.has(element.family)) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + w / 2, y: y + h / 2, button: "none", buttons: 0 });
        await sleep(160);
        hover = `${file}-hover.png`;
        await grab(hover);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: width - 2, y: height - 2, button: "none", buttons: 0 });
        await sleep(60);
      }
      await writeLine(variantsFile, { key: variantKey, family: element.family, shape: element.shape, component: element.component, state: element.state, token: view.token, view: view.id, width, file: `variants/${file}.png`, hover: hover ? `variants/${hover}` : null });
    }
  };

  const record = async (view: AuditView, scope: string | null, width: number, theme: string, measure: boolean) => {
    const cdp = browser.cdp;
    debug(`record ${view.id} ${width} ${theme}`);
    if (measure) {
      const value = await evaluate<AuditMeasure>(cdp, UI_AUDIT_MEASURE(scope), 60_000);
      debug(`measured ${value.texts?.length ?? 0} runs, ${value.elements?.length ?? 0} elements`);
      if (value.missing) return false;
      const result: AuditResult = { ...view, width, height, theme, measure: value };
      await writeLine(resultsFile, result);
      if (variants) await pictureVariants(view, width, value);
    }
    if (shots) {
      const dir = join(out, "shots", theme, String(width));
      await mkdir(dir, { recursive: true });
      await shot(cdp, null, join(dir, `${view.id}.jpg`));
    }
    return true;
  };

  const viewport = async (width: number) => {
    await browser.cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  };

  try {
    for (const shell of shells) {
      if (done.has(shell.id)) continue;
      const view: AuditView = { id: shell.id, kind: "shell", token: shell.id, view: "root" };
      let unopened: string | null = null;
      for (const width of widths) {
        if (unopened) break;
        await viewport(width);
        for (const [index, theme] of themes.entries()) {
          // Opened from a fresh page up to three times: on a busy machine a key typed before the
          // command bar has focus goes to the pane, and the surface never opens.
          let opened = false;
          for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
            await loadLayout(browser.cdp, app.url, replay, shell.layout, shell.focused, { theme, ...shell.seed });
            await settle(browser.cdp, "body", 700, 6_000);
            await shell.open(browser.cdp);
            await settle(browser.cdp, "body", 600, 4_000);
            opened = !shell.surface || !!await waitFor<boolean>(browser.cdp, `!!document.querySelector(${JSON.stringify(shell.surface)})`, 2_000);
            if (!opened) console.warn(`${shell.id}: not open at ${width}px in ${theme} (try ${attempt + 1} of 3)`);
          }
          if (!opened) {
            unopened = `${shell.surface} is not on the page at ${width}px in ${theme}`;
            break;
          }
          await record(view, null, width, theme, index === 0);
          await key(browser.cdp, "Escape", "Escape", 27);
        }
      }
      if (unopened) {
        // Measuring the page under a surface that did not open would pass for a measure of it.
        console.error(`${shell.id}: did not open: ${unopened}`);
        await writeLine(viewsFile, { id: `${shell.id}--failed`, kind: "shell", token: shell.id, view: "failed" });
        process.exitCode = 1;
        continue;
      }
      await writeLine(viewsFile, view);
      console.log(`${shell.id}: measured`);
    }

    for (const entry of entries) {
      if (done.has(entry.token)) continue;
      const started = Date.now();
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const views = await Promise.race([
          auditPane(entry).finally(() => clearTimeout(timer)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ENTRY_TIMEOUT_MS / 1000}s`)), ENTRY_TIMEOUT_MS); }),
        ]);
        for (const view of views) await writeLine(viewsFile, view);
        console.log(`${entry.token}: ${views.length} views in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (error) {
        console.warn(`${entry.token}: ${error instanceof Error ? error.message : error}`);
        await writeLine(viewsFile, { id: `${entry.token}--failed`, kind: "pane", token: entry.token, paneId: entry.paneId, plugin: entry.plugin, view: "failed" });
        // A page that hung or a browser that died: start a fresh one.
        await browser.close().catch(() => {});
        browser = await launchBrowser("ui-audit", widths[0]!, height);
        await start();
      }
    }
  } finally {
    await browser.close().catch(() => {});
    app.stop();
  }

  async function auditPane(entry: AuditEntry): Promise<AuditView[]> {
    const cdp = browser.cdp;
    await viewport(widths[widths.length - 1]!);
    const instance = await discover(cdp, app.url, replay, entry) ?? fallbackInstance(entry);
    const id = instance.instanceId as string;
    const scope = `[data-gloom-pane-id="${id}"]`;
    const base = { kind: "pane" as const, token: entry.token, paneId: entry.paneId, ...(entry.plugin ? { plugin: entry.plugin } : {}), instance };
    const views = new Map<string, AuditView>();
    const paneText = () => evaluate<string>(cdp, `document.querySelector(${JSON.stringify(scope)})?.innerText ?? ""`);
    const open = async (theme: string) => {
      debug(`open ${theme}`);
      await loadLayout(cdp, app.url, replay, dock(instance), id, { theme });
      await settle(cdp, scope);
      debug("settled");
    };
    for (const width of widths) {
      await viewport(width);
      for (const [index, theme] of themes.entries()) {
        const measure = index === 0;
        await open(theme);
        const rootView: AuditView = { ...base, id: `${entry.token}--root`, view: "root" };
        if (!await record(rootView, id, width, theme, measure)) continue;
        views.set(rootView.id, rootView);
        // The detail Enter opens from the root.
        const before = await paneText();
        await key(cdp, "Enter", "Enter", 13);
        await settle(cdp, scope, 700, 6_000);
        if (await paneText() !== before) {
          const detail: AuditView = { ...base, id: `${entry.token}--detail`, view: "detail" };
          await record(detail, id, width, theme, measure);
          views.set(detail.id, detail);
        }
        // Each tab from the pane as it first shows, measured only once the page says it is the selected one (tab-visits.ts).
        const visits = await visitAlternatives({
          cdp,
          scope,
          selector: "[role=tab]",
          depth: 1,
          reset: () => open(theme),
          settle: () => settle(cdp, scope, 700, 6_000),
          record: async (path) => {
            const name = pathName(path);
            const tab: AuditView = { ...base, id: `${entry.token}--tab-${slug(name)}`, view: "tab", tab: name };
            if (!await record(tab, id, width, theme, measure)) return false;
            views.set(tab.id, tab);
            return true;
          },
        });
        for (const visit of visits) {
          if (visit.status === "measured") continue;
          const name = pathName(visit.path);
          const missed: AuditView = { ...base, id: `${entry.token}--tab-${slug(name)}`, view: visit.status, tab: name, reason: visit.reason };
          if (!views.has(missed.id)) views.set(missed.id, missed);
        }
      }
    }
    return [...views.values()];
  }

  if (!report) return;
  const pluginsDir = cacheDir("ui-audit-plugins");
  const extraDirs = withRegistry && existsSync(pluginsDir)
    ? (await readdir(pluginsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(pluginsDir, entry.name))
    : [];
  await writeAuditReport(out, { root, extraDirs });
  console.log(`\n${join(out, "report.md")}`);
}

if (import.meta.main) await main();
