import { copyFile, mkdir, rm } from "fs/promises";
import { dirname, join, resolve } from "path";

const FIXTURE = join(import.meta.dir, "fixture.tsx");

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
  /** Requests the page made for anything but its own files; the fixture should make none. */
  strayRequests: string[];
  close(): Promise<void>;
}

/**
 * Builds the fixture page from the sources of `root` (this checkout or a base
 * branch next to it) into `outdir` and serves it on a local port.
 */
export async function serveFixturePage(root: string, outdir: string): Promise<FixturePage> {
  root = resolve(root);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  // The fixture imports `../../src`, so another checkout builds it from the
  // same place in its own tree, against its own sources and node_modules.
  const ownTree = resolve(import.meta.dir, "../..") === root;
  const entrypoint = ownTree ? FIXTURE : join(root, "scripts/pane-chrome/.fixture-build.tsx");
  if (!ownTree) {
    await mkdir(dirname(entrypoint), { recursive: true });
    await copyFile(FIXTURE, entrypoint);
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
    if (!ownTree) await rm(entrypoint, { force: true });
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
    strayRequests,
    async close() {
      server.stop(true);
      await rm(outdir, { recursive: true, force: true });
    },
  };
}
