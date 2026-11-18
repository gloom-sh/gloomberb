import { existsSync, readFileSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { testAppEnv } from "../test-app-env";
import type { ProbeEntry } from "./web-server";

export interface DesktopStandIn {
  origin: string;
  pagePath: string;
  /** Starts the Bun side for one launch, with the slow network's extra time. */
  restart(delayMs: number): Promise<void>;
  onProbe(listener: ((entry: ProbeEntry) => void) | null): void;
  requests(): Record<string, number>;
  /** Ends the Bun side, as quitting the app does. */
  stopBackend(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The desktop app for the benchmark: its view, built from `app` with
 * desktop-electroview.ts standing in for Electrobun's view module, in
 * headless Chromium, and its Bun side (desktop-backend.ts) started per launch
 * on the same port, so the page's origin and storage stay put between
 * launches as the app's do.
 */
export async function startDesktopStandIn({ checkout, app, home, viewDir, networkDir }: { checkout: string; app: string; home: string; viewDir: string; networkDir: string }): Promise<DesktopStandIn> {
  await buildView(app, join(checkout, "scripts/warm-start/desktop-electroview.ts"), viewDir);
  // One port per profile: the page's storage belongs to its origin.
  const port = 41_000 + Number(BigInt(Bun.hash(home)) % 2000n);
  const probeFile = join(home, "probe.jsonl");
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let listener: ((entry: ProbeEntry) => void) | null = null;
  let read = 0;
  let requests: Record<string, number> = {};
  let polling: ReturnType<typeof setInterval> | null = null;

  const poll = () => {
    if (!existsSync(probeFile)) return;
    const text = readFileSync(probeFile, "utf8");
    const end = text.lastIndexOf("\n") + 1;
    for (const line of text.slice(read, end).split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ProbeEntry & { network?: Record<string, number> };
        if (entry.network) requests = entry.network;
        listener?.(entry);
      } catch { /* Intentional ignore: a report cut short is dropped. */ }
    }
    read = end;
  };

  const stopBackend = async () => {
    if (polling) clearInterval(polling);
    polling = null;
    poll();
    if (!child) return;
    child.kill("SIGKILL");
    await child.exited;
    child = null;
  };

  return {
    origin: `http://127.0.0.1:${port}`,
    pagePath: "/",
    async restart(delayMs) {
      await stopBackend();
      await rm(probeFile, { force: true });
      read = 0;
      requests = {};
      child = Bun.spawn(["bun", join(checkout, "scripts/warm-start/desktop-backend.ts")], {
        cwd: app,
        env: testAppEnv({
          GLOOMBERB_HOME: home,
          WARM_DESKTOP_APP: app,
          WARM_DESKTOP_VIEW: viewDir,
          WARM_DESKTOP_PORT: String(port),
          WARM_START_PROBE_OUT: probeFile,
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
      polling = setInterval(poll, 100);
    },
    onProbe(next) { listener = next; },
    requests: () => requests,
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
