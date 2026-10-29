import { copyFile, mkdir, rm } from "fs/promises";
import { dirname, join, resolve } from "path";

export const FIXTURE = join(import.meta.dir, "fixture.tsx");

/**
 * Stands in for the native side of the desktop window. The renderer host
 * posts window moves through `__electrobunInternalBridge`; every message lands
 * in `__paneChromeBridge` for the checks to read.
 */
const BRIDGE_RECORDER = `
  window.__electrobunWindowId = 7;
  window.__paneChromeBridge = [];
  window.__electrobunInternalBridge = {
    postMessage(packet) {
      for (const message of JSON.parse(packet)) window.__paneChromeBridge.push(JSON.parse(message));
    },
  };
`;

export interface FixturePage {
  url: URL;
  /** True when this is the checkout's own fixture, not the one in this tree (see `ownFixtureFallback`). */
  ownFixture: boolean;
  /** Requests the page made for anything but its own files; the fixture should make none. */
  strayRequests: string[];
  close(): Promise<void>;
}

const FIXTURE_PATH = "scripts/pane-chrome/fixture.tsx";

/** A build failure with what the bundler said (Bun throws "Bundle failed" and keeps the messages in `errors`). */
function describeFailure(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map((detail) => String(detail?.message ?? detail))].join("\n");
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bundles `fixture` into `outdir` with the build of `root`, against its own
 * sources and node_modules. The fixture imports `../../src`, so one from
 * another tree is copied to the same place in `root` for the build.
 */
export async function buildFixture(root: string, fixture: string, outdir: string): Promise<void> {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const inPlace = resolve(dirname(fixture)) === join(root, dirname(FIXTURE_PATH));
  const entrypoint = inPlace ? fixture : join(root, dirname(FIXTURE_PATH), ".fixture-build.tsx");
  if (!inPlace) {
    await mkdir(dirname(entrypoint), { recursive: true });
    await copyFile(fixture, entrypoint);
  }
  // The build reads the view and DOM renderer folders from the working directory.
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const { writeElectrobunViewPage } = await import(join(root, "src/renderers/dom/build-assets.ts"));
    await writeElectrobunViewPage({
      entrypoint,
      outdir,
      // The desktop UI host imports the Electrobun RPC client; the screenshot stub
      // answers nothing and opens no socket.
      aliasRules: [["backend-rpc", "native-stubs/backend-rpc.ts"]],
      failureMessage: "Could not build the pane chrome fixture page",
      missingEntryMessage: "The pane chrome fixture build produced no script",
      title: "Pane chrome fixture",
      loadingText: "Loading",
      bootstrapScript: BRIDGE_RECORDER,
    });
  } finally {
    process.chdir(cwd);
    if (!inPlace) await rm(entrypoint, { force: true });
  }
}

/**
 * Builds the fixture page from the sources of `root` (this checkout or a base
 * branch next to it) into `outdir` and serves it on a local port.
 *
 * The fixture of this tree is built against `root`, so two checkouts draw the
 * same panes. When that fails (a change that adds source the fixture imports
 * leaves a base branch without it), `ownFixtureFallback` builds `root` from the
 * fixture it has itself instead, and the page says so in `ownFixture`.
 */
export async function serveFixturePage(root: string, outdir: string, { ownFixtureFallback = false } = {}): Promise<FixturePage> {
  root = resolve(root);
  let ownFixture = false;
  try {
    await buildFixture(root, FIXTURE, outdir);
  } catch (error) {
    const failure = describeFailure(error);
    const own = join(root, FIXTURE_PATH);
    if (!ownFixtureFallback || own === FIXTURE) throw error;
    if (!await Bun.file(own).exists()) throw new Error(`${failure}\n${root} has no ${FIXTURE_PATH} to build its page from instead.`);
    console.error(`The fixture of this checkout does not build against ${root}; building it from its own ${FIXTURE_PATH}.\n${failure}`);
    try {
      await buildFixture(root, own, outdir);
    } catch (ownError) {
      throw new Error(`The pane chrome fixture builds neither from this checkout nor from ${root}.\nThis checkout's fixture: ${failure}\nIts own fixture: ${describeFailure(ownError)}`);
    }
    ownFixture = true;
  }

  const strayRequests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const file = Bun.file(join(outdir, pathname === "/" ? "index.html" : pathname.slice(1)));
      if (!pathname.includes("..") && await file.exists()) return new Response(file);
      if (pathname !== "/favicon.ico") strayRequests.push(`${request.method} ${pathname}`);
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    url: new URL(`http://127.0.0.1:${server.port}/`),
    ownFixture,
    strayRequests,
    async close() {
      server.stop(true);
      await rm(outdir, { recursive: true, force: true });
    },
  };
}
