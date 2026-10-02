import { readFile, writeFile } from "fs/promises";
import { join, relative } from "path";
import { TITLEBAR_OVERLAY_HEIGHT_PX } from "../../components/layout/titlebar-overlay";

/** Imports whose path ends with the first entry resolve to the second, relative to the view directory. */
type AliasRule = readonly [string, string];
type PageOptions = {
  entrypoint: string;
  outdir: string;
  aliasRules?: AliasRule[];
  failureMessage: string;
  missingEntryMessage: string;
  title: string;
  loadingText: string;
  bootstrapScript: string;
};

interface ViewBundleOptions {
  entrypoint: string;
  outdir: string;
  sourcemap: "external" | "none";
  /** Build-time constants; `process.env.NODE_ENV` is always production. */
  define?: Record<string, string>;
  aliasRules?: AliasRule[];
  failureMessage: string;
  missingEntryMessage: string;
}

const ELECTROBUN_VIEW_DIR = join(process.cwd(), "src", "renderers", "electrobun", "view");
const DOM_RENDERER_DIR = join(process.cwd(), "src", "renderers", "dom");

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
}: ViewBundleOptions): Promise<{ script: string; stylesheet: string | null }> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    format: "esm",
    splitting: false,
    sourcemap,
    minify: true,
    define: { "process.env.NODE_ENV": "\"production\"", ...define },
    plugins: aliasRules.length > 0 ? [electrobunViewAliasPlugin(aliasRules)] : [],
  });

  if (!result.success) {
    const details = result.logs.map((log) => log.message).filter(Boolean).join("\n");
    throw new Error(details ? `${failureMessage}\n${details}` : failureMessage);
  }

  const script = result.outputs.find((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
  if (!script) throw new Error(missingEntryMessage);

  const stylesheet = result.outputs.find((output) => output.path.endsWith(".css"))?.path ?? null;
  if (stylesheet) await writeFile(stylesheet, withTitlebarOverlayHeight(await readFile(stylesheet, "utf8")));
  return { script: script.path, stylesheet };
}

export async function writeElectrobunViewPage(options: PageOptions): Promise<string> {
  const { script } = await buildViewBundle({
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
  const stylesheet = withTitlebarOverlayHeight(await readFile(join(DOM_RENDERER_DIR, "styles.css"), "utf8"));
  const entrySrc = `./${relative(options.outdir, script).replaceAll("\\", "/")}`;
  const htmlPath = join(options.outdir, "index.html");
  await writeFile(htmlPath, renderElectrobunViewHtml({ ...options, stylesheet, entrySrc }));
  return htmlPath;
}

function renderElectrobunViewHtml({
  title,
  loadingText,
  stylesheet,
  bootstrapScript,
  entrySrc,
}: PageOptions & { stylesheet: string; entrySrc: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>${stylesheet}</style>
  </head>
  <body style="margin:0;background:#000;">
    <div id="root"><div class="gloom-loading">${loadingText}</div></div>
    <script>
${bootstrapScript}
    </script>
    <script type="module" src="${entrySrc}"></script>
  </body>
</html>
`;
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
