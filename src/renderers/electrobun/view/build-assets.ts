import { readFile, writeFile } from "fs/promises";
import { join, relative } from "path";
import { TITLEBAR_OVERLAY_HEIGHT_PX } from "../../../components/layout/titlebar-overlay";

export type AliasRule = readonly [string, string] | readonly [string, string, string];
type PageOptions = {
  entrypoint: string;
  outdir: string;
  pluginName: string;
  extraAliasRules?: AliasRule[];
  failureMessage: string;
  missingEntryMessage: string;
  title: string;
  loadingText: string;
  bootstrapScript: string;
};

const ELECTROBUN_VIEW_DIR = join(process.cwd(), "src", "renderers", "electrobun", "view");
const COMMON_ALIAS_RULES: AliasRule[] = [
  ["notes-files", "notes-files.ts"],
  ["./files", "plugins/builtin/notes/index.tsx", "notes-files.ts"],
  ["native/kitty/support", "native-stubs/chart/kitty-support.ts"],
  ["./kitty/support", "components/chart/native/renderer-selection.ts", "native-stubs/chart/kitty-support.ts"],
  ["native/surface/manager", "native-stubs/chart/surface-manager.ts"],
  ["native/surface/sync", "native-stubs/chart/surface-sync.ts"],
  ["./native-loader", "plugins/broker-sync/robinhood.ts", "native-stubs/broker-sync-native-loader.ts"],
  ["./native-loader", "plugins/broker-sync/simplefin.ts", "native-stubs/broker-sync-native-loader.ts"],
];

export function electrobunViewPath(...parts: string[]): string {
  return join(ELECTROBUN_VIEW_DIR, ...parts);
}

export async function writeElectrobunViewPage(options: PageOptions): Promise<string> {
  const { entrySrc, stylesheet } = await buildElectrobunViewBundle(options);
  const htmlPath = join(options.outdir, "index.html");
  await writeFile(htmlPath, renderElectrobunViewHtml({ ...options, stylesheet, entrySrc }));
  return htmlPath;
}

async function buildElectrobunViewBundle({
  entrypoint,
  outdir,
  pluginName,
  extraAliasRules = [],
  failureMessage,
  missingEntryMessage,
}: PageOptions): Promise<{ entrySrc: string; stylesheet: string }> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    minify: true,
    define: {
      "process.env.NODE_ENV": "\"production\"",
      // The webview has no `process`, so the cloud endpoint override the terminal
      // already reads from the environment is baked in at build time.
      __GLOOMBERB_API_URL__: JSON.stringify(process.env.GLOOMBERB_API_URL ?? ""),
    },
    plugins: [electrobunViewAliasPlugin(pluginName, extraAliasRules)],
  });

  if (!result.success) {
    const details = result.logs.map((log) => log.message).filter(Boolean).join("\n");
    throw new Error(details ? `${failureMessage}\n${details}` : failureMessage);
  }

  const entry = result.outputs.find((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
  if (!entry) throw new Error(missingEntryMessage);

  return {
    entrySrc: `./${relative(outdir, entry.path).replaceAll("\\", "/")}`,
    stylesheet: (await readFile(electrobunViewPath("styles.css"), "utf8"))
      .replaceAll("__TITLEBAR_OVERLAY_HEIGHT_PX__", String(TITLEBAR_OVERLAY_HEIGHT_PX)),
  };
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

export function electrobunViewAliasPlugin(name: string, extraAliasRules: AliasRule[] = []) {
  return {
    name,
    setup(build: { onResolve(options: { filter: RegExp }, callback: (args: { path: string; importer?: string }) => unknown): void }) {
      const aliasRules = [...extraAliasRules, ...COMMON_ALIAS_RULES];
      build.onResolve({ filter: /.*/ }, (args) => resolveAlias(args, aliasRules));
    },
  };
}

function resolveAlias(args: { path: string; importer?: string }, aliasRules: AliasRule[]) {
  const importer = args.importer?.replaceAll("\\", "/");
  for (const rule of aliasRules) {
    const target = rule.length === 2
      ? args.path.endsWith(rule[0]) && rule[1]
      : args.path === rule[0] && importer?.endsWith(rule[1]) && rule[2];
    if (target) return { path: electrobunViewPath(target) };
  }
}
