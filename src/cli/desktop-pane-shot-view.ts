import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildViewBundle, electrobunViewPath, readViewStylesheet } from "../renderers/dom/build-assets";

/**
 * The page `shot` and rendered `fn` reports draw a pane in: the view bundle,
 * the chunks it loads later (the world map's land, the docs) and the
 * stylesheet, by path under the page's root. What changes per capture, the
 * pane and its data, goes in the page's HTML instead (desktop-pane-shot.ts).
 *
 * A source checkout builds these on first use. The release binary has no
 * sources to build from, so scripts/build.ts builds them once, packs them
 * with `packShotView` and embeds the archive, which its entry hands to
 * `usePrebuiltShotView` before the CLI starts.
 */
export type ShotViewFiles = ReadonlyMap<string, string>;

const SHOT_VIEW_ENTRY = "cli-pane-shot-entry.tsx";
/** The bundle the page loads, named after its entry. */
export const SHOT_VIEW_SCRIPT = "cli-pane-shot-entry.js";
export const SHOT_VIEW_STYLESHEET = "styles.css";

const MISSING_VIEW_MESSAGE = "This copy of Gloomberb cannot draw panes: it was built without the page they are drawn in. "
  + "The standalone gloomberb binary (https://github.com/gloom-sh/gloomberb/releases/latest) has it.";

let prebuiltArchive: string | null = null;
let loading: Promise<ShotViewFiles> | null = null;

/** Builds the page's files into `outdir`, for a capture or for scripts/build.ts to embed. */
export async function buildShotView(outdir: string, apiUrl: string): Promise<void> {
  await buildViewBundle({
    entrypoint: electrobunViewPath(SHOT_VIEW_ENTRY),
    outdir,
    sourcemap: "none",
    // The page has no `process`, so the cloud endpoint is baked in.
    define: { __GLOOMBERB_API_URL__: JSON.stringify(apiUrl) },
    aliasRules: [
      ["backend-rpc", "native-stubs/backend-rpc.ts"],
    ],
    failureMessage: "Failed to build desktop pane screenshot renderer.",
    missingEntryMessage: "Desktop pane screenshot build did not produce a JavaScript entrypoint.",
  });
  await Bun.write(join(outdir, SHOT_VIEW_STYLESHEET), await readViewStylesheet());
}

async function readShotViewDir(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const path of new Bun.Glob("**/*").scan({ cwd: dir })) {
    files.set(path.replaceAll("\\", "/"), await Bun.file(join(dir, path)).text());
  }
  return files;
}

/** The files `buildShotView` wrote, as one gzipped JSON object of path to text. */
export async function packShotView(dir: string): Promise<Uint8Array> {
  const json = JSON.stringify(Object.fromEntries(await readShotViewDir(dir)));
  return Bun.gzipSync(new TextEncoder().encode(json), { level: 9 });
}

/**
 * Serve the page from the archive at `archivePath` rather than building it.
 * @knipignore Called by the entry scripts/build.ts writes for the release binary.
 */
export function usePrebuiltShotView(archivePath: string): void {
  prebuiltArchive = archivePath;
  loading = null;
}

/** The page's files, read or built once per process. */
export function loadShotView(): Promise<ShotViewFiles> {
  loading ??= (prebuiltArchive ? unpackShotView(prebuiltArchive) : buildShotViewFromSource()).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

async function unpackShotView(archivePath: string): Promise<ShotViewFiles> {
  const file = Bun.file(archivePath);
  if (!(await file.exists())) throw new Error(MISSING_VIEW_MESSAGE);
  const json = new TextDecoder().decode(Bun.gunzipSync(await file.bytes()));
  return completeShotView(new Map(Object.entries(JSON.parse(json) as Record<string, string>)));
}

async function buildShotViewFromSource(): Promise<ShotViewFiles> {
  // A bundle of the CLI without its sources, and without the page embedded.
  if (!existsSync(electrobunViewPath(SHOT_VIEW_ENTRY))) throw new Error(MISSING_VIEW_MESSAGE);
  const dir = await mkdtemp(join(tmpdir(), "gloom-pane-shot-view-"));
  try {
    await buildShotView(dir, process.env.GLOOMBERB_API_URL ?? "");
    return completeShotView(await readShotViewDir(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The page's files, once every file it needs is there: the bundle, the
 * stylesheet, and each chunk the bundle loads by path (`import("./x.chunk.js")`,
 * see build-assets.ts), which a pane would otherwise only miss when it draws.
 */
function completeShotView(files: Map<string, string>): ShotViewFiles {
  const script = files.get(SHOT_VIEW_SCRIPT);
  if (script === undefined || !files.has(SHOT_VIEW_STYLESHEET)) throw new Error(MISSING_VIEW_MESSAGE);
  for (const [, chunk] of script.matchAll(/["']\.\/([\w./-]+\.chunk\.js)["']/g)) {
    if (!files.has(chunk!)) throw new Error(MISSING_VIEW_MESSAGE);
  }
  return files;
}
