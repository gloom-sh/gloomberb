import { readFile, writeFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import type { BunPlugin } from "bun";
import { TITLEBAR_OVERLAY_HEIGHT_PX } from "../../components/layout/titlebar-overlay";
import { getThemeColors } from "../../theme/colors";
import { themeCssVariables } from "../../theme/ui-tokens";
import { DEFAULT_THEME } from "../../theme/themes";
import { bootFrameBuildId, bootFrameScript } from "./boot-frame-page";

/** Imports whose path ends with the first entry resolve to the second, relative to the view directory. */
type AliasRule = readonly [string, string];
type PageOptions = {
  entrypoint: string;
  outdir: string;
  aliasRules?: AliasRule[];
  failureMessage: string;
  missingEntryMessage: string;
  title: string;
  /** Text the page shows until its script draws, for a page with no launch frame. */
  loadingText?: string;
  bootstrapScript: string;
  /** Draw the launch frame (boot-frame.ts) from where this host keeps it. */
  bootFrame?: PageBootFrame;
};

/** Where a page reads its launch frame from: JavaScript expressions run before its script loads. */
export interface PageBootFrame {
  source: string;
  skip?: string;
}

interface ViewBundleOptions {
  entrypoint: string;
  outdir: string;
  sourcemap: "external" | "none";
  /** Build-time constants; `process.env.NODE_ENV` is always production. */
  define?: Record<string, string>;
  aliasRules?: AliasRule[];
  failureMessage: string;
  missingEntryMessage: string;
  /**
   * Leave identifiers unminified (whitespace and syntax still are), so the
   * components keep their names and a page audit can say which one drew an
   * element (`scripts/pane-chrome/ui-audit.ts`). Bun's `keepNames` alone did
   * not keep them.
   */
  keepNames?: boolean;
}

/** Bun's minify setting: everything, or everything but identifiers when names are kept. */
function minifyOption(keepNames: boolean | undefined) {
  return keepNames ? { whitespace: true, syntax: true, identifiers: false } : true;
}

// From this file rather than the working directory, so a build started from
// any folder (`gloom shot` run from a checkout or a package install) finds
// the sources.
const ELECTROBUN_VIEW_DIR = join(import.meta.dir, "..", "electrobun", "view");

/**
 * Where the world map finds its land data, relative to the map's
 * `basemap.ts`. Only view bundles define it, so the terminal binary, which
 * never draws that map, leaves the data out.
 */
export const WORLD_MAP_DATA_SPECIFIER = "./natural-earth/index.chunk.js";
const DOM_RENDERER_DIR = import.meta.dir;

export function electrobunViewPath(...parts: string[]): string {
  return join(ELECTROBUN_VIEW_DIR, ...parts);
}

function withTitlebarOverlayHeight(css: string): string {
  return css.replaceAll("__TITLEBAR_OVERLAY_HEIGHT_PX__", String(TITLEBAR_OVERLAY_HEIGHT_PX));
}

/**
 * Bundles a DOM renderer entry for the browser. Returns the emitted script and,
 * when the entry imports styles, the stylesheet, already sized for the titlebar.
 */
export async function buildViewBundle({
  entrypoint,
  outdir,
  sourcemap,
  define = {},
  aliasRules = [],
  failureMessage,
  missingEntryMessage,
  keepNames,
}: ViewBundleOptions): Promise<{ script: string; stylesheet: string | null }> {
  const chunks = new Map<string, string>();
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    format: "esm",
    splitting: false,
    sourcemap,
    minify: minifyOption(keepNames),
    define: {
      "process.env.NODE_ENV": "\"production\"",
      __GLOOM_WORLD_MAP_DATA__: JSON.stringify(WORLD_MAP_DATA_SPECIFIER),
      ...define,
    },
    plugins: [
      lazyChunkPlugin(outdir, outdir, chunks),
      ...(aliasRules.length > 0 ? [electrobunViewAliasPlugin(aliasRules)] : []),
      ...(process.env.GLOOM_DESKTOP_SHELL === "tauri" ? [tauriViewPlugin()] : []),
    ],
  });

  if (!result.success) {
    const details = result.logs.map((log) => log.message).filter(Boolean).join("\n");
    throw new Error(details ? `${failureMessage}\n${details}` : failureMessage);
  }

  const script = result.outputs.find((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
  if (!script) throw new Error(missingEntryMessage);
  await buildLazyChunks(outdir, chunks, failureMessage, keepNames);

  const stylesheet = result.outputs.find((output) => output.path.endsWith(".css"))?.path ?? null;
  if (stylesheet) await writeFile(stylesheet, withTitlebarOverlayHeight(await readFile(stylesheet, "utf8")));
  return { script: script.path, stylesheet };
}

export async function writeElectrobunViewPage(options: PageOptions): Promise<string> {
  const { script, stylesheet: bundledStylesheet } = await buildViewBundle({
    entrypoint: options.entrypoint,
    outdir: options.outdir,
    aliasRules: options.aliasRules,
    failureMessage: options.failureMessage,
    missingEntryMessage: options.missingEntryMessage,
    sourcemap: "external",
    define: {
      // The webview has no `process`, so the cloud endpoint override the terminal
      // already reads from the environment is baked in at build time.
      __GLOOMBERB_API_URL__: JSON.stringify(process.env.GLOOMBERB_API_URL ?? ""),
    },
  });
  const stylesheet = await readViewStylesheet();
  const entrySrc = `./${relative(options.outdir, script).replaceAll("\\", "/")}`;
  const htmlPath = join(options.outdir, "index.html");
  const bootFrame = options.bootFrame
    ? { ...options.bootFrame, build: await pageBuildId(script, bundledStylesheet ?? null, stylesheet) }
    : undefined;
  await writeFile(htmlPath, renderElectrobunViewHtml({ ...options, stylesheet, entrySrc, bootFrame }));
  return htmlPath;
}

/** Names a page's build for its launch frame, from the files that draw it. */
export async function pageBuildId(script: string, stylesheetPath: string | null, inlineStylesheet = ""): Promise<string> {
  const css = (stylesheetPath ? await readFile(stylesheetPath, "utf8") : "") + inlineStylesheet;
  return bootFrameBuildId(await readFile(script), css);
}

/** The launch frame's inline script, with the default theme's colours for the bare shell. */
export function pageBootFrameScript(bootFrame: PageBootFrame & { build: string }): string {
  const shellStyle = themeCssVariables(getThemeColors(DEFAULT_THEME)).map(([name, value]) => `${name}: ${value};`).join(" ");
  return bootFrameScript({ ...bootFrame, shellStyle });
}

/** The DOM renderer's stylesheet, sized for the titlebar, which a view page inlines. */
export async function readViewStylesheet(): Promise<string> {
  return withTitlebarOverlayHeight(await readFile(join(DOM_RENDERER_DIR, "styles.css"), "utf8"));
}

/**
 * A view page: the stylesheet inline, the bootstrap script, the launch frame
 * when the page has one, then the bundle at `entrySrc`.
 */
export function renderElectrobunViewHtml({
  title,
  loadingText,
  stylesheet,
  bootstrapScript,
  bootFrame,
  entrySrc,
}: Pick<PageOptions, "title" | "loadingText" | "bootstrapScript"> & {
  stylesheet: string;
  entrySrc: string;
  bootFrame?: PageBootFrame & { build: string };
}): string {
  const loading = loadingText ? `<div class="gloom-loading">${loadingText}</div>` : "";
  const frameScript = bootFrame ? `\n    <script>\n${pageBootFrameScript(bootFrame)}\n    </script>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>${stylesheet}</style>
  </head>
  <body style="margin:0;background:#000;">
    <div id="root">${loading}</div>
    <script>
${bootstrapScript}
    </script>${frameScript}
    <script type="module" src="${entrySrc}"></script>
  </body>
</html>
`;
}

/**
 * The view bundle is one file (no splitting), so a module reached through
 * `import()` would land in it. A module named `*.chunk.ts` and imported as
 * `import("./path/name.chunk.js")` instead ships as its own file at that path
 * next to the importing bundle, fetched the first time it is asked for: large
 * data only some panes draw, such as the world map's coastlines. The terminal
 * and the tests run the source, where the same `import()` loads the module.
 */
function lazyChunkPlugin(rootOutdir: string, emitDir: string, chunks: Map<string, string>): BunPlugin {
  return {
    name: "lazy-chunks",
    setup(build) {
      build.onResolve({ filter: /\.chunk(\.js|\.ts)?$/ }, (args) => {
        if (args.kind.startsWith("entry-point") || /[\\/]node_modules[\\/]/.test(args.importer)) return undefined;
        if (args.kind !== "dynamic-import") {
          throw new Error(`${args.path} is a lazy chunk; load it with import() (from ${args.importer})`);
        }
        if (!args.path.startsWith("./") || !args.path.endsWith(".chunk.js")) {
          throw new Error(`Lazy chunk ${args.path} must be imported as "./<path>.chunk.js" (from ${args.importer})`);
        }
        const source = resolve(dirname(args.importer), args.path.replace(/\.js$/, ".ts"));
        const output = resolve(emitDir, args.path);
        if (relative(rootOutdir, output).startsWith("..")) throw new Error(`Lazy chunk ${args.path} would land outside ${rootOutdir}`);
        const existing = chunks.get(output);
        if (existing && existing !== source) throw new Error(`Two lazy chunks emit ${output}: ${existing} and ${source}`);
        chunks.set(output, source);
        return { path: args.path, external: true };
      });
    },
  };
}

/** Builds each lazy chunk on its own, and the chunks those load in turn. */
async function buildLazyChunks(rootOutdir: string, chunks: Map<string, string>, failureMessage: string, keepNames?: boolean): Promise<void> {
  const built = new Set<string>();
  let pending = [...chunks.entries()];
  while (pending.length) {
    const nested = new Map<string, string>();
    for (const [output, source] of pending) {
      if (built.has(output)) continue;
      built.add(output);
      const result = await Bun.build({
        entrypoints: [source],
        outdir: dirname(output),
        naming: relative(dirname(output), output),
        target: "browser",
        format: "esm",
        splitting: false,
        sourcemap: "none",
        minify: minifyOption(keepNames),
        plugins: [lazyChunkPlugin(rootOutdir, dirname(output), nested)],
      });
      if (!result.success) {
        const details = result.logs.map((log) => log.message).filter(Boolean).join("\n");
        throw new Error(`${failureMessage}: lazy chunk ${source}\n${details}`);
      }
    }
    pending = [...nested.entries()];
  }
}

/** Prototype: the desktop view in a Tauri window talks RPC through its own stand-in. */
function tauriViewPlugin() {
  return {
    name: "tauri-view",
    setup(build: { onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void }) {
      build.onResolve({ filter: /^electrobun\/view$/ }, () => ({ path: join(import.meta.dir, "..", "tauri", "electroview.ts") }));
    },
  };
}

function electrobunViewAliasPlugin(aliasRules: AliasRule[]) {
  return {
    name: "electrobun-view-aliases",
    setup(build: { onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void }) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const rule = aliasRules.find(([suffix]) => args.path.endsWith(suffix));
        return rule ? { path: electrobunViewPath(rule[1]) } : undefined;
      });
    },
  };
}
