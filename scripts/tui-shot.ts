/**
 * Runs the terminal app in tmux under a theme, captures the screen with its
 * colours, and renders that capture to a PNG through headless Chrome. The
 * OpenTUI test harness gives a character frame; this is the only way to see
 * what a style does with colour and attributes on the real grid.
 *
 *   bun run scripts/tui-shot.ts --theme phosphor-amber --output /tmp/tui.png
 *   bun run scripts/tui-shot.ts --theme nord --cols 160 --rows 45 --keys "C-p" --type "theme"
 *
 * The app runs against a copy of the real ~/.gloomberb so the capture has the
 * user's portfolio in it, and the copy is deleted afterwards. Needs `tmux` and
 * Chrome or Chromium (or CHROME_PATH).
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { buildPriceChartPreset } from "../src/plugins/builtin/chart-composer/presets";
import { resolvePresetSelection } from "../src/theme/presets";
import { getTheme } from "../src/theme/schemes";
import { CHART_COMPOSER_PANE_ID, DEFAULT_PORTFOLIO_COLUMN_IDS, type LayoutConfig } from "../src/types/config";

/**
 * The same four panes `gloomberb shot workspace` renders, so the two renderers
 * can be compared side by side: a dense table, a quote board, a chart, a list.
 */
function workspaceLayout(): LayoutConfig {
  return {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.46,
      first: {
        kind: "split",
        axis: "vertical",
        ratio: 0.56,
        first: { kind: "pane", instanceId: "portfolio-list:shot" },
        second: { kind: "pane", instanceId: "world-indices:shot" },
      },
      second: {
        kind: "split",
        axis: "vertical",
        ratio: 0.6,
        first: { kind: "pane", instanceId: "chart-composer:shot" },
        second: { kind: "pane", instanceId: "news-top:shot" },
      },
    },
    instances: [
      {
        instanceId: "portfolio-list:shot",
        paneId: "portfolio-list",
        params: { collectionId: "main" },
        settings: { columnIds: [...DEFAULT_PORTFOLIO_COLUMN_IDS], collectionScope: "all", visibleCollectionIds: [], viewMode: "table" },
        binding: { kind: "none" },
      },
      { instanceId: "world-indices:shot", paneId: "world-indices", binding: { kind: "none" } },
      {
        instanceId: "chart-composer:shot",
        paneId: CHART_COMPOSER_PANE_ID,
        title: "GP AAPL",
        settings: { chartSpec: buildPriceChartPreset("AAPL") },
        binding: { kind: "fixed", symbol: "AAPL" },
      },
      { instanceId: "news-top:shot", paneId: "news-top", binding: { kind: "none" } },
    ],
    floating: [],
    detached: [],
  };
}

interface Args {
  theme: string | null;
  output: string;
  cols: number;
  rows: number;
  wait: number;
  keys: string[];
  type: string | null;
  scale: number;
  font: string;
  /** Also write the raw ANSI capture here, for inspecting what the app emitted. */
  dump: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    theme: null,
    output: resolve(process.cwd(), "gloomberb-tui.png"),
    cols: 160,
    rows: 44,
    wait: 8,
    keys: [],
    type: null,
    scale: 2,
    font: '"JetBrains Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace',
    dump: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const value = argv[index + 1];
    switch (token) {
      case "--theme": args.theme = value ?? null; index += 1; break;
      case "--output": args.output = resolve(process.cwd(), value ?? args.output); index += 1; break;
      case "--cols": args.cols = Number(value); index += 1; break;
      case "--rows": args.rows = Number(value); index += 1; break;
      case "--wait": args.wait = Number(value); index += 1; break;
      case "--keys": args.keys.push(...(value ?? "").split(/\s+/).filter(Boolean)); index += 1; break;
      case "--type": args.type = value ?? null; index += 1; break;
      case "--scale": args.scale = Number(value); index += 1; break;
      case "--font": args.font = value ?? args.font; index += 1; break;
      case "--dump": args.dump = resolve(process.cwd(), value ?? "capture.ansi"); index += 1; break;
      default: throw new Error(`Unknown argument ${token}`);
    }
  }
  return args;
}

async function run(cmd: string[], options: { env?: Record<string, string> } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...options.env } });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${stderr || stdout}`);
  return stdout;
}

const sleep = (seconds: number) => new Promise((done) => setTimeout(done, seconds * 1000));

/* -------------------------------------------------------------------------- */
/* ANSI to HTML                                                               */
/* -------------------------------------------------------------------------- */

const ANSI_16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function ansi256(index: number): string {
  if (index < 16) return ANSI_16[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const value = index - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(value / 36)]},${steps[Math.floor((value % 36) / 6)]},${steps[value % 6]})`;
}

interface Pen {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
}

const DEFAULT_PEN: Pen = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, reverse: false };

function applySgr(pen: Pen, params: number[]): Pen {
  const next = { ...pen };
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]!;
    if (code === 0) Object.assign(next, DEFAULT_PEN);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.reverse = true;
    else if (code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.reverse = false;
    else if (code === 39) next.fg = null;
    else if (code === 49) next.bg = null;
    else if (code >= 30 && code <= 37) next.fg = ANSI_16[code - 30]!;
    else if (code >= 90 && code <= 97) next.fg = ANSI_16[code - 90 + 8]!;
    else if (code >= 40 && code <= 47) next.bg = ANSI_16[code - 40]!;
    else if (code >= 100 && code <= 107) next.bg = ANSI_16[code - 100 + 8]!;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      if (params[index + 1] === 2) {
        next[target] = `rgb(${params[index + 2] ?? 0},${params[index + 3] ?? 0},${params[index + 4] ?? 0})`;
        index += 4;
      } else if (params[index + 1] === 5) {
        next[target] = ansi256(params[index + 2] ?? 0);
        index += 2;
      }
    }
  }
  return next;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function spanStyle(pen: Pen): string {
  let fg = pen.fg ?? "var(--fg)";
  let bg = pen.bg ?? "var(--bg)";
  if (pen.reverse) [fg, bg] = [bg, fg];
  const parts = [`color:${fg}`, `background:${bg}`];
  if (pen.bold) parts.push("font-weight:700");
  if (pen.dim) parts.push("opacity:.6");
  if (pen.italic) parts.push("font-style:italic");
  if (pen.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

function ansiToHtml(capture: string, cols: number): string {
  const lines: string[] = [];
  for (const rawLine of capture.split("\n")) {
    let pen = { ...DEFAULT_PEN };
    let html = "";
    let run = "";
    let width = 0;
    const flush = () => {
      if (run) html += `<span style="${spanStyle(pen)}">${escapeHtml(run)}</span>`;
      run = "";
    };
    const pattern = /\x1b\[([0-9;]*)m/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(rawLine)) !== null) {
      const text = rawLine.slice(last, match.index);
      if (text) { run += text; width += [...text].length; }
      flush();
      pen = applySgr(pen, match[1] === "" ? [0] : match[1]!.split(";").map((value) => Number(value)));
      last = match.index + match[0].length;
    }
    const tail = rawLine.slice(last);
    if (tail) { run += tail; width += [...tail].length; }
    flush();
    // Pad every row to the full width so the default background fills the grid.
    if (width < cols) html += `<span style="${spanStyle(DEFAULT_PEN)}">${" ".repeat(cols - width)}</span>`;
    lines.push(html);
  }
  return lines.join("\n");
}

/** Cells the app never painted show the terminal's own colours: the scheme's. */
function defaultColorsOf(schemeId: string): { fg: string; bg: string } {
  const scheme = getTheme(schemeId);
  return { bg: scheme.bg, fg: scheme.text };
}

function pageHtml(body: string, cols: number, rows: number, font: string, colors: { fg: string; bg: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; background: ${colors.bg}; }
    pre {
      --fg: ${colors.fg}; --bg: ${colors.bg};
      margin: 0; padding: 0;
      font-family: ${font};
      font-size: 14px; line-height: 20px;
      width: ${cols}ch; height: ${rows * 20}px;
      overflow: hidden; white-space: pre;
      -webkit-font-smoothing: antialiased;
      font-variant-ligatures: none;
    }
    span { display: inline-block; height: 20px; }
  </style></head><body><pre>${body}</pre></body></html>`;
}

async function findChrome(): Promise<string> {
  const candidates = [
    process.env.CHROME_PATH,
    Bun.which("google-chrome"),
    Bun.which("chromium"),
    Bun.which("chromium-browser"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((value): value is string => !!value);
  for (const candidate of candidates) if (await Bun.file(candidate).exists()) return candidate;
  throw new Error("Chrome or Chromium is needed to render the capture; set CHROME_PATH.");
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(import.meta.dir, "..");
const session = `gloom-tui-shot-${process.pid}`;
const home = await mkdtemp(join(tmpdir(), "gloom-tui-shot-home-"));
const sourceDir = join(process.env.HOME || homedir(), ".gloomberb");
const dataDir = join(home, ".gloomberb");

try {
  await mkdir(dataDir, { recursive: true });
  for (const entry of ["config.json", ".gloomberb-cache.db", "plugins"]) {
    const source = join(sourceDir, entry);
    if (await Bun.file(source).exists().catch(() => false) || entry === "plugins") {
      await cp(source, join(dataDir, entry), { recursive: true }).catch(() => {});
    }
  }
  const configPath = join(dataDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.dataDir = dataDir;
  const layout = workspaceLayout();
  config.layout = layout;
  config.layouts = [{
    name: "Workspace",
    layout,
    paneState: {},
    focusedPaneId: "chart-composer:shot",
    activePanel: "right",
  }];
  config.activeLayoutIndex = 0;
  config.onboardingComplete = true;
  let styleEnv: Record<string, string> = {};
  let schemeId = typeof config.theme === "string" ? config.theme : "amber";
  if (args.theme) {
    const selection = resolvePresetSelection(args.theme);
    if (!selection?.schemeId) throw new Error(`Unknown theme "${args.theme}".`);
    schemeId = selection.schemeId;
    config.theme = selection.schemeId;
    config.themeStyle = selection.styleId;
    // Experimental styles are refused from the file, so the env opt-in carries them.
    styleEnv = { GLOOMBERB_THEME_STYLE: selection.styleId };
  }
  await writeFile(configPath, JSON.stringify(config, null, 2));

  await run(["tmux", "kill-session", "-t", session]).catch(() => {});
  await run([
    "tmux", "new-session", "-d", "-s", session, "-x", String(args.cols), "-y", String(args.rows),
    `cd ${repoRoot} && HOME=${home} ${Object.entries(styleEnv).map(([key, value]) => `${key}=${value}`).join(" ")} bun src/index.tsx 2>/dev/null`,
  ]);
  // The app reads its own colours into a true-colour terminal; tell tmux so.
  await run(["tmux", "set-option", "-t", session, "-g", "default-terminal", "tmux-256color"]).catch(() => {});
  await sleep(args.wait);
  for (const key of args.keys) {
    await run(["tmux", "send-keys", "-t", session, key]);
    await sleep(0.6);
  }
  if (args.type) {
    await run(["tmux", "send-keys", "-t", session, "-l", args.type]);
    await sleep(1.2);
  }
  const capture = await run(["tmux", "capture-pane", "-e", "-p", "-t", session]);
  await run(["tmux", "kill-session", "-t", session]).catch(() => {});
  if (args.dump) await writeFile(args.dump, capture);

  const colors = defaultColorsOf(schemeId);
  const html = pageHtml(ansiToHtml(capture, args.cols), args.cols, args.rows, args.font, colors);
  const htmlPath = join(home, "capture.html");
  await writeFile(htmlPath, html);
  await mkdir(resolve(args.output, ".."), { recursive: true });

  const chrome = await findChrome();
  // `ch` units are only known after layout, so measure the page first.
  const widthPx = Math.ceil(args.cols * 8.4) + 2;
  const heightPx = args.rows * 20;
  await run([
    chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    `--force-device-scale-factor=${args.scale}`,
    `--window-size=${widthPx},${heightPx}`,
    `--screenshot=${args.output}`,
    `file://${htmlPath}`,
  ]);
  console.log(`Saved terminal screenshot to ${args.output}`);
} finally {
  await run(["tmux", "kill-session", "-t", session]).catch(() => {});
  await rm(home, { recursive: true, force: true });
}
