import { mkdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { testAppEnv } from "../test-app-env";
import { newLaunchSecret } from "./local-guard";

export interface DesktopStandIn {
  origin: string;
  /** The page, under this launch's secret folder: read after `restart`. */
  readonly pagePath: string;
  /** One of the Bun side's own endpoints (`__warm-heap`), under the same folder. */
  endpoint(name: string): string;
  /** Starts the Bun side for one launch, with the slow network's extra time. */
  restart(delayMs: number): Promise<void>;
  requests(): Promise<Record<string, number>>;
  /** Ends the Bun side, as quitting the app does. */
  stopBackend(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The desktop app for the benchmark: its view, built from `app` with
 * desktop-electroview.ts standing in for Electrobun's view module, in
 * headless Chromium, and its Bun side (desktop-backend.ts) started per launch
 * on the same port, so the page's origin and storage stay put between
 * launches as the app's do. Each launch serves under a secret folder of its
 * own (local-guard.ts), which only the browser it opens is given.
 */
export async function startDesktopStandIn({ checkout, app, home, viewDir, networkDir }: { checkout: string; app: string; home: string; viewDir: string; networkDir: string }): Promise<DesktopStandIn> {
  await buildView(app, join(checkout, "scripts/warm-start/desktop-electroview.ts"), viewDir);
  // One port per profile: the page's storage belongs to its origin.
  const port = 41_000 + Number(BigInt(Bun.hash(home)) % 2000n);
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let secret = newLaunchSecret();
  const endpoint = (name: string) => `http://127.0.0.1:${port}/${secret}/${name}`;

  const stopBackend = async () => {
    if (!child) return;
    child.kill("SIGKILL");
    await child.exited;
    child = null;
  };

  return {
    origin: `http://127.0.0.1:${port}`,
    get pagePath() { return `/${secret}/`; },
    endpoint,
    async restart(delayMs) {
      await stopBackend();
      secret = newLaunchSecret();
      child = Bun.spawn(["bun", join(checkout, "scripts/warm-start/desktop-backend.ts")], {
        cwd: app,
        env: testAppEnv({
          GLOOMBERB_HOME: home,
          WARM_DESKTOP_APP: app,
          WARM_DESKTOP_VIEW: viewDir,
          WARM_DESKTOP_PORT: String(port),
          WARM_DESKTOP_SECRET: secret,
          WARM_START_NET_DIR: networkDir,
          WARM_START_NET_DELAY_MS: String(delayMs),
        }),
        stdout: "pipe",
        stderr: Bun.file(join(home, "desktop-backend.log")),
      });
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const deadline = Date.now() + 60_000;
      let text = "";
      while (!text.includes("ready")) {
        if (Date.now() > deadline) throw new Error("The desktop stand-in did not start");
        const { value, done } = await reader.read();
        if (done) throw new Error(`The desktop stand-in exited: see ${join(home, "desktop-backend.log")}`);
        text += new TextDecoder().decode(value);
      }
      void (async () => { while (!(await reader.read()).done) { /* drain */ } })().catch(() => {});
    },
    async requests() {
      const response = await fetch(endpoint("__warm-requests"), { signal: AbortSignal.timeout(3_000) }).catch(() => null);
      return response?.ok ? await response.json() as Record<string, number> : {};
    },
    stopBackend,
    async stop() { await stopBackend(); },
  };
}

async function buildView(app: string, electroview: string, outdir: string): Promise<void> {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const cwd = process.cwd();
  // The build reads the view and DOM renderer folders from the working directory.
  process.chdir(app);
  try {
    const { electrobunViewPath, writeElectrobunViewPage } = await import(join(app, "src/renderers/dom/build-assets.ts"));
    await writeElectrobunViewPage({
      entrypoint: electrobunViewPath("main.tsx"),
      outdir,
      aliasRules: [["electrobun/view", relative(electrobunViewPath(""), electroview)]],
      failureMessage: "Could not build the desktop view for the warm-start benchmark",
      missingEntryMessage: "The desktop view build produced no script",
      title: "Gloom",
      bootstrapScript: "window.__electrobunWindowId = 1; window.__electrobunInternalBridge = { postMessage() {} };",
    });
  } finally {
    process.chdir(cwd);
  }
  await writeFile(join(outdir, ".built"), new Date().toISOString());
}
