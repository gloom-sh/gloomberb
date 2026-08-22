import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { TITLEBAR_OVERLAY_HEIGHT_PX } from "../src/components/layout/titlebar-overlay";
import {
  electrobunViewAliasPlugin,
} from "../src/renderers/electrobun/view/build-assets";

const root = process.cwd();
const outdir = join(root, "dist", "web");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await writeFile(join(outdir, "favicon.svg"), await readFile(join(root, "src/assets/gloomberb-logo.svg")));

async function buildPage(name: string, entrypoint: string, title: string, loadingText: string, htmlName: string) {
  const assetsDir = join(outdir, "assets", name);
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: assetsDir,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: true,
    sourcemap: "none",
    define: {
      "process.env.NODE_ENV": '"production"',
      __GLOOMBERB_API_URL__: "location.origin",
    },
    plugins: [electrobunViewAliasPlugin(`browser-${name}-native-stubs`)],
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const script = result.outputs.find((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
  const stylesheet = result.outputs.find((output) => output.path.endsWith(".css"));
  if (!script || !stylesheet) throw new Error(`${name} build did not emit JavaScript and CSS`);
  const css = (await readFile(stylesheet.path, "utf8"))
    .replaceAll("__TITLEBAR_OVERLAY_HEIGHT_PX__", String(TITLEBAR_OVERLAY_HEIGHT_PX));
  await writeFile(stylesheet.path, css);
  const href = (path: string) => `/${relative(outdir, path).replaceAll("\\", "/")}`;
  await writeFile(join(outdir, htmlName), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${href(stylesheet.path)}">
</head>
<body>
  <div id="root"><div class="gloom-loading">${loadingText}</div></div>
  <script type="module" src="${href(script.path)}"></script>
</body>
</html>\n`);
}

await buildPage("app", join(root, "src/renderers/browser/main.tsx"), "Gloomberb", "Loading Gloomberb...", "index.html");
await buildPage("share", join(root, "src/renderers/share/main.tsx"), "Gloomberb Share", "Loading shared view...", "share.html");
