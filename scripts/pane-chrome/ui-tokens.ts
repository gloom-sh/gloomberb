import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir } from "./browser";
import { readPluginLock } from "./plugin-lock";
import type { AuditElement, AuditMeasure, AuditTextRun } from "./ui-audit-measure";
import { FITTED } from "./ui-audit-report";

/**
 * The design system, held on every view (docs/pane-conventions.md, "Holding
 * the line"). The UI audit (ui-audit.ts) opens every function, the bundled
 * plugins' panes and the registry's on the real web build, docked, at 640 and
 * 1280 px, with its detail and each tab, and measures what is drawn. This
 * fails when a text's size or weight, the corner of an element of a kit
 * family, or a pane body's left inset is outside the tokens, unless
 * `src/architecture/ui-tokens-allowlist.json` covers it with a written why.
 *
 * The page reads Gloom Cloud only from a kept snapshot (`--replay`, offline:
 * web-app.ts), so a run draws the same views every time; with no snapshot
 * every pane draws its offline state, which is checked the same way. The
 * registry's plugins build at the commits the snapshot's lock pins
 * (plugin-lock.ts).
 *
 * `--record` makes the snapshot: CI does it on main once a week. It opens
 * every view once live, keeping what each reads and pinning the registry's
 * plugins, then checks from what it kept, offline, as a pull request will.
 * What it finds in a registry plugin's views is the plugin's own: it warns,
 * and it is kept with the snapshot (`ui-tokens-known.json`). A pull request
 * on that snapshot fails on a registry plugin's view only for a value the
 * recording did not have: the plugin's code and data are the same, so the
 * change under check made it. With no recording to compare with, a registry
 * plugin's values warn. Built-in panes and the plugins bundled by `bun.lock`
 * always fail.
 *
 *   bun run check:ui-tokens [--shard 0/4] [--only DOCS,LAY] [--widths 640,1280] [--replay <dir>]
 *                           [--record] [--out <dir>] [--web <dir>] [--no-build] [--root <checkout>]
 *   bun run check:ui-tokens --results <run>[,<run>] [--replay <dir>]    check runs already made
 *
 * The static half, literals in the code, is src/architecture/ui-literals.test.ts.
 */

/** The type scale (`--gloom-type-*`), px at the default font scale. */
export const TOKEN_FONT_SIZES = [10, 12, 14, 16, 20] as const;
/** The two weights (`--gloom-weight-*`). */
export const TOKEN_WEIGHTS = [400, 700] as const;
/** Bars and tables 0, then `--gloom-radius-sm`, `-md`, `-lg`, `-full`. */
export const TOKEN_RADII = [0, 3, 6, 8, 999] as const;
/** `--gloom-inset`: no text of a pane's body sits closer than this to its left edge. */
export const PANE_INSET = 8;
/** Subpixel layout and rounding: 7.6 is the inset, 7 is not. */
const TOLERANCE = 0.5;

export type TokenMeasure = "font size" | "font weight" | "radius" | "inset";

export interface TokenViolation {
  view: string;
  /** The function, or the shell view, the view belongs to. */
  token: string;
  /** The plugin whose pane it is, for a plugin's view. */
  plugin?: string;
  width: number;
  measure: TokenMeasure;
  value: number;
  component: string;
  chain: string;
  sample: string;
}

export interface ResultLine {
  id: string;
  kind: "pane" | "shell";
  token: string;
  plugin?: string;
  view: string;
  width: number;
  measure: AuditMeasure;
}

export interface TokenAllowance {
  measure: TokenMeasure;
  /** The value allowed; without one, any value of the measure. */
  value?: number;
  /** The component that draws it; without one, any. */
  component?: string;
  why: string;
}

export type TokenAllowlist = Record<string, TokenAllowance[]>;

/** Labels a heat map, treemap or map fits to its own shapes: sized by the data, not the scale (docs). */
function fitted(run: { chain: string; roles: string }): boolean {
  return FITTED.test(run.chain) && !/legend|axis/i.test(run.roles);
}

/**
 * Text a pane's left inset does not apply to: a chart's labels sit on its
 * plot (an axis, a legend, a fitted label), and a spinner's glyph turns, so
 * its box swings past where it stands.
 */
function outsideInset(run: AuditTextRun): boolean {
  return fitted(run)
    || /axis|legend|composite-chart|chart|surface|heat|geo|treemap|spinner/.test(run.roles)
    || /Chart|Axis|Legend|Treemap|Heat|Spinner/.test(run.component);
}

const near = (value: number, allowed: readonly number[]) => allowed.some((token) => Math.abs(value - token) < 0.05);

/** The radii an element's shape records: one value, or one per corner. */
function radiiOf(element: AuditElement): number[] {
  const radius = /radius=([\d. ]+?)(?= (?:shadow|outline|font|icon|fill)|$)/.exec(element.shape)?.[1]?.trim();
  return radius ? radius.split(/\s+/).map(Number).filter((value) => Number.isFinite(value)) : [];
}

/** Every value of one measured view outside the tokens, one per measure, value and component. */
export function violationsOf(result: ResultLine): TokenViolation[] {
  const found = new Map<string, TokenViolation>();
  const add = (measure: TokenMeasure, value: number, component: string, chain: string, sample: string) => {
    const key = `${measure}|${value}|${component}`;
    if (!found.has(key)) found.set(key, { view: result.id, token: result.token, ...(result.plugin ? { plugin: result.plugin } : {}), width: result.width, measure, value, component, chain, sample });
  };
  for (const run of result.measure.texts ?? []) {
    if (fitted(run)) continue;
    if (!near(run.fontSize, TOKEN_FONT_SIZES)) add("font size", run.fontSize, run.component, run.chain, run.sample);
    if (!near(run.fontWeight, TOKEN_WEIGHTS)) add("font weight", run.fontWeight, run.component, run.chain, run.sample);
    if (result.kind === "pane" && run.region === "pane-body" && !outsideInset(run) && run.left < PANE_INSET - TOLERANCE) {
      add("inset", Math.round(run.left * 10) / 10, run.component, run.chain, run.sample);
    }
  }
  for (const element of result.measure.elements ?? []) {
    if (FITTED.test(element.chain)) continue;
    for (const radius of radiiOf(element)) {
      if (!near(radius, TOKEN_RADII)) add("radius", radius, element.component, element.chain, element.text ?? "");
    }
  }
  return [...found.values()];
}

export function allows(entry: TokenAllowance, violation: TokenViolation): boolean {
  return entry.measure === violation.measure
    && (entry.value === undefined || Math.abs(entry.value - violation.value) < 0.05)
    && (entry.component === undefined || entry.component === violation.component);
}

/**
 * How a registry plugin's values are held: the plugins built (the lock's
 * ids), and what the snapshot's recording found in their views, or null when
 * there is no recording to compare with.
 */
export interface RegistryPolicy {
  plugins: ReadonlySet<string>;
  known: KnownValues | null;
}

/** A recording's registry plugin views (`view|width`) and the values off the tokens it found in them. */
export interface KnownValues {
  views: string[];
  values: string[];
}

/** A view at a width: a result line's id, or a violation's view. */
export const viewKey = (id: string, width: number) => `${id}|${width}`;
export const valueKey = (violation: TokenViolation) => `${violation.view}|${violation.width}|${violation.measure}|${violation.value}|${violation.component}`;

export interface TokenCheck {
  failing: TokenViolation[];
  allowed: TokenViolation[];
  /** A registry plugin's own values: warned, not failed. */
  warned: TokenViolation[];
  /** Entries of measured functions that matched nothing (`function: index`). */
  unused: string[];
}

/** Whether a value off the tokens in a registry plugin's view is the plugin's own (warned) rather than the change's. */
function pluginsOwn(violation: TokenViolation, registry: RegistryPolicy | undefined): boolean {
  if (!registry || !violation.plugin || !registry.plugins.has(violation.plugin)) return false;
  if (!registry.known) return true;
  // A view the recording did not measure has nothing to compare with.
  if (!registry.known.views.includes(viewKey(violation.view, violation.width))) return true;
  return registry.known.values.includes(valueKey(violation));
}

export function checkTokens(results: ResultLine[], allowlist: TokenAllowlist, registry?: RegistryPolicy): TokenCheck {
  const used = new Set<string>();
  const failing: TokenViolation[] = [];
  const allowed: TokenViolation[] = [];
  const warned: TokenViolation[] = [];
  for (const result of results) {
    for (const violation of violationsOf(result)) {
      const entries = allowlist[violation.token] ?? [];
      const index = entries.findIndex((entry) => allows(entry, violation));
      if (index >= 0) {
        used.add(`${violation.token}: ${index}`);
        allowed.push(violation);
      } else if (pluginsOwn(violation, registry)) {
        warned.push(violation);
      } else {
        failing.push(violation);
      }
    }
  }
  const measured = new Set(results.map((result) => result.token));
  const unused = Object.entries(allowlist).flatMap(([token, entries]) => measured.has(token)
    ? entries.map((_, index) => `${token}: ${index}`).filter((key) => !used.has(key))
    : []);
  return { failing, allowed, warned, unused };
}

/** The allowlist as it is kept: functions sorted, two-space JSON, a newline at the end. */
export function formatTokenAllowlist(allowlist: TokenAllowlist): string {
  const sorted = Object.fromEntries(Object.keys(allowlist).sort().map((token) => [token, allowlist[token]!]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

const HOW = {
  "font size": `the type scale: ${TOKEN_FONT_SIZES.join(", ")}px (var(--gloom-type-caption|ui|body|heading|title))`,
  "font weight": `${TOKEN_WEIGHTS.join(" or ")} (var(--gloom-weight-regular|bold))`,
  radius: `${TOKEN_RADII.join(", ")}px (0 for bars and tables, var(--gloom-radius-sm|md|lg|full))`,
  inset: `at least ${PANE_INSET}px from the pane's left edge (var(--gloom-inset); the kit's states, rows and readers take it)`,
} satisfies Record<TokenMeasure, string>;

export function describe(violation: TokenViolation): string {
  const unit = violation.measure === "font weight" ? "" : "px";
  const sample = violation.sample ? ` "${violation.sample.slice(0, 40)}"` : "";
  return `${violation.view} at ${violation.width}px: ${violation.measure} ${violation.value}${unit} from ${violation.component || "?"}${sample} (${violation.chain.split("<").slice(0, 4).join(" < ")}); the token set is ${HOW[violation.measure]}`;
}

async function readResults(dir: string): Promise<ResultLine[]> {
  const file = join(dir, "results.jsonl");
  if (!existsSync(file)) return [];
  return (await Bun.file(file).text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as ResultLine);
}

async function readFailedViews(dir: string): Promise<string[]> {
  const file = join(dir, "views.jsonl");
  if (!existsSync(file)) return [];
  return (await Bun.file(file).text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; view: string })
    .filter((view) => view.view === "failed").map((view) => view.id.replace(/--failed$/, ""));
}

export const ALLOWLIST_PATH = join(import.meta.dir, "../../src/architecture/ui-tokens-allowlist.json");
/** What the snapshot's recording found in the registry plugins' views, kept beside it. */
export const KNOWN_FILE = "ui-tokens-known.json";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resultsArg = takeOption(args, "--results");
  const replayArg = takeOption(args, "--replay");
  const replayDir = resolve(replayArg ?? cacheDir("ui-tokens-replay"));
  const record = args.includes("--record");
  let dirs: string[];
  if (resultsArg) {
    dirs = resultsArg.split(",").map((dir) => resolve(dir));
  } else {
    const out = resolve(takeOption(args, "--out") ?? cacheDir("ui-tokens"));
    const shard = takeOption(args, "--shard");
    const only = takeOption(args, "--only");
    const root = takeOption(args, "--root");
    const widths = takeOption(args, "--widths") ?? "640,1280";
    const web = resolve(takeOption(args, "--web") ?? cacheDir("ui-tokens-web"));
    const build = !args.includes("--no-build");
    const audit = (pass: { out: string; offline: boolean; build: boolean }) => {
      const command = [
        "bun", join(import.meta.dir, "ui-audit.ts"), "--registry", "--no-shots", "--no-report", "--themes", "white",
        "--widths", widths,
        "--out", pass.out,
        "--web", web,
        "--replay", replayDir,
        ...(pass.offline ? ["--offline"] : []),
        ...(pass.build ? ["--build"] : []),
        ...(shard ? ["--shard", shard] : []),
        ...(only ? ["--only", only] : []),
        ...(root ? ["--root", resolve(root)] : []),
      ];
      const run = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
      if (run.exitCode !== 0) throw new Error(`The UI audit stopped (exit ${run.exitCode})`);
    };
    await mkdir(out, { recursive: true });
    if (record) {
      // Live once, keeping every read and pinning the registry's plugins; then checked from what
      // was kept, as a pull request reads it, so what this finds is what a pull request finds.
      console.log("Recording: every view once, live.");
      audit({ out: `${out}-recording`, offline: false, build });
      console.log("Checking from the recording, offline.");
      audit({ out, offline: true, build: false });
    } else {
      audit({ out, offline: true, build });
    }
    dirs = [out];
  }
  const results = (await Promise.all(dirs.map(readResults))).flat();
  const failedViews = (await Promise.all(dirs.map(readFailedViews))).flat();
  if (!results.length) throw new Error(`No measured views in ${dirs.join(", ")}`);
  const allowlist: TokenAllowlist = await Bun.file(ALLOWLIST_PATH).json();
  const lock = resultsArg && !replayArg ? null : await readPluginLock(replayDir);
  const knownFile = join(replayDir, KNOWN_FILE);
  const registry: RegistryPolicy | undefined = lock ? {
    plugins: new Set(lock.plugins.map((plugin) => plugin.id)),
    known: !record && existsSync(knownFile) ? await Bun.file(knownFile).json() as KnownValues : null,
  } : undefined;
  const { failing, allowed, warned, unused } = checkTokens(results, allowlist, registry);
  if (record && registry) {
    const views = results.filter((result) => result.plugin && registry.plugins.has(result.plugin)).map((result) => viewKey(result.id, result.width));
    const known: KnownValues = { views: [...new Set(views)].sort(), values: [...new Set(warned.map(valueKey))].sort() };
    await Bun.write(knownFile, `${JSON.stringify(known, null, 1)}\n`);
  }

  const views = new Set(results.map((result) => result.id));
  const functions = new Set(results.map((result) => result.token));
  const recorded = registry?.known ? "values the snapshot's recording had" : record ? "recorded with this snapshot" : "no recording to compare with";
  const lines = [
    `## UI tokens`,
    "",
    `${views.size} views of ${functions.size} functions and shell views, at ${[...new Set(results.map((result) => result.width))].join(" and ")}px.`,
    failing.length
      ? `**${failing.length} values outside the tokens.** Use the design system's tokens (docs/pane-conventions.md, "Design system"), or add an entry with its reason to \`src/architecture/ui-tokens-allowlist.json\`:`
      : `Every value is on the tokens or allowed (${allowed.length} allowed by \`src/architecture/ui-tokens-allowlist.json\`).`,
    ...failing.map((violation) => `- ${describe(violation)}${violation.plugin && registry?.plugins.has(violation.plugin) ? " (a registry plugin's view: its code and data are the snapshot's, and the recording did not have this value)" : ""}`),
    ...(warned.length ? ["", `Warnings, not failures: ${warned.length} values in registry plugins' views are the plugins' own (${recorded}). Their authors fix them in the plugins' repos:`, ...warned.map((violation) => `- ${describe(violation)}`)] : []),
    ...(failedViews.length ? ["", `Not measured (the function did not open): ${failedViews.join(", ")}.`] : []),
    ...(unused.length ? ["", `Allowlist entries nothing matched this run (an offline run draws less): ${unused.join(", ")}.`] : []),
  ];
  const summary = lines.join("\n");
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (const violation of warned) console.log(`::warning title=UI tokens (registry plugin ${violation.plugin})::${describe(violation)}`);
  if (failing.length) process.exitCode = 1;
}

if (import.meta.main) await main();
