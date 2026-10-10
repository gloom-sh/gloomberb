import { mkdir, rename, rm } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * Chrome for Testing's headless shell, pinned so a browser update never changes
 * a result. CI caches the download by this version. To move it, take a version
 * from https://googlechromelabs.github.io/chrome-for-testing/ and the sha256 of
 * each zip.
 */
const CHROME_VERSION = "155.0.8059.39";
const CHROME_DOWNLOADS: Record<string, { platform: string; sha256: string }> = {
  "linux-x64": { platform: "linux64", sha256: "39dcb8c46550632a3d911850ab3b8af840b4e3f6d8622faa2018eb8756278786" },
  "darwin-arm64": { platform: "mac-arm64", sha256: "b3e093c06001c41e68decbc8dd4a62f9efe4bf4e4dd247a686ea531863448d75" },
  "darwin-x64": { platform: "mac-x64", sha256: "6338a784c691f42dd1ed6aeeef650171c7d72cf74bdb8450d0079864e72a8074" },
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where downloads, profiles and builds go: `PANE_CHROME_CACHE`, or ~/.cache/gloomberb-pane-chrome. */
export function cacheDir(...parts: string[]): string {
  return join(process.env.PANE_CHROME_CACHE ?? join(homedir(), ".cache", "gloomberb-pane-chrome"), ...parts);
}

/** `CHROME_PATH` when set, otherwise the pinned headless shell, downloaded on first use. */
async function chromeExecutable(): Promise<string> {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const download = CHROME_DOWNLOADS[`${process.platform}-${process.arch}`];
  if (!download) throw new Error(`No pinned Chrome for ${process.platform}-${process.arch}; set CHROME_PATH to a Chrome or Chromium binary.`);
  const dir = cacheDir(`chrome-headless-shell-${CHROME_VERSION}`);
  const executable = join(dir, `chrome-headless-shell-${download.platform}`, "chrome-headless-shell");
  if (await Bun.file(executable).exists()) return executable;

  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${download.platform}/chrome-headless-shell-${download.platform}.zip`;
  console.error(`Downloading Chrome ${CHROME_VERSION} headless shell...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Chrome download failed: ${response.status} ${url}`);
  const zip = new Uint8Array(await response.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
  if (sha256 !== download.sha256) throw new Error(`Chrome download ${url} has sha256 ${sha256}, expected ${download.sha256}`);
  const staging = `${dir}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await Bun.write(join(staging, "chrome.zip"), zip);
  const unzip = Bun.spawnSync(["unzip", "-q", join(staging, "chrome.zip"), "-d", staging]);
  if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr.toString()}`);
  await rm(join(staging, "chrome.zip"));
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  return executable;
}

type Pending = { resolve(value: any): void; reject(error: Error): void };

/** The DevTools protocol over one page's WebSocket. */
export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: any) => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = message.id ? this.pending.get(message.id) : undefined;
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("DevTools connection closed"));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolves with the next event of this name. */
  once<T = any>(method: string, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(method) ?? new Set();
      this.listeners.set(method, listeners);
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`No ${method} within ${timeoutMs} ms`)); }, timeoutMs);
      const listener = (params: T) => { clearTimeout(timer); listeners.delete(listener); resolve(params); };
      listeners.add(listener);
    });
  }

  on(method: string, listener: (params: any) => void): void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  close(): void {
    this.ws.close();
  }
}

export interface Browser {
  cdp: Cdp;
  close(): Promise<void>;
}

/**
 * Starts the headless shell with one page of a fixed size. No network beyond
 * this machine: every host but 127.0.0.1 fails to resolve.
 */
export async function launchBrowser(name: string, width: number, height: number): Promise<Browser> {
  const executable = await chromeExecutable();
  const profile = cacheDir("profiles", `${name}-${process.pid}-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const proc = Bun.spawn([
    executable,
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ], { stdout: "ignore", stderr: "pipe" });

  try {
    const port = await readDevToolsPort(proc.stderr);
    let pageUrl = "";
    for (let attempt = 0; attempt < 100 && !pageUrl; attempt += 1) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json() as Promise<any[]>).catch(() => []);
      pageUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl ?? "";
      if (!pageUrl) await sleep(50);
    }
    if (!pageUrl) throw new Error("Chrome started without a page");
    const cdp = await Cdp.connect(pageUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    return {
      cdp,
      async close() {
        cdp.close();
        proc.kill();
        await proc.exited;
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    proc.kill();
    await proc.exited;
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

/** Chrome prints "DevTools listening on ws://127.0.0.1:<port>/..." once it is up. */
async function readDevToolsPort(stderr: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text);
    if (match) {
      // Keep draining so Chrome never blocks on a full pipe.
      void (async () => { while (!(await reader.read()).done) {} })().catch(() => {});
      return Number(match[1]);
    }
  }
  throw new Error(`Chrome did not start:\n${text.slice(-2000)}`);
}

/** Runs `expression` in the page and returns its value; a thrown error or rejection fails the call. */
export async function evaluate<T = any>(cdp: Cdp, expression: string, timeoutMs = 30_000): Promise<T> {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(`Page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result?.value as T;
}

/** Resolves after `count` animation frames in the page. */
export function frames(cdp: Cdp, count = 1): Promise<void> {
  return evaluate(cdp, `new Promise((done) => { let left = ${count}; const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })`);
}

/**
 * Waits, a frame at a time, until `predicate` (a page expression) is truthy,
 * and returns its value; returns the last value after `timeoutMs`.
 */
export function waitFor<T = any>(cdp: Cdp, predicate: string, timeoutMs = 3_000): Promise<T> {
  return evaluate(cdp, `new Promise((done) => {
    const until = performance.now() + ${timeoutMs};
    const check = () => {
      let value;
      try { value = (${predicate}); } catch { value = undefined; }
      if (value || performance.now() > until) done(value ?? null);
      else requestAnimationFrame(check);
    };
    check();
  })`, timeoutMs + 5_000);
}

type MouseType = "mouseMoved" | "mousePressed" | "mouseReleased";

export function mouse(cdp: Cdp, type: MouseType, x: number, y: number, held: boolean): Promise<void> {
  return cdp.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" && !held ? "none" : "left",
    buttons: held ? 1 : 0,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

export interface Point { x: number; y: number }

/** A left click: press and release in place, then a frame for the result to draw. */
export async function click(cdp: Cdp, at: Point): Promise<void> {
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  await mouse(cdp, "mousePressed", at.x, at.y, true);
  await mouse(cdp, "mouseReleased", at.x, at.y, false);
  await frames(cdp, 2);
}

/**
 * Presses at `from`, moves to each waypoint in `steps` moves with a frame
 * after each (what a pointer at display rate does), and releases at the last.
 */
export async function drag(cdp: Cdp, from: Point, waypoints: Point[], steps = 12): Promise<void> {
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  await frames(cdp);
  let at = from;
  for (const to of waypoints) {
    for (let step = 1; step <= steps; step += 1) {
      await mouse(cdp, "mouseMoved", at.x + ((to.x - at.x) * step) / steps, at.y + ((to.y - at.y) * step) / steps, true);
      await frames(cdp);
    }
    at = to;
  }
  await mouse(cdp, "mouseReleased", at.x, at.y, false);
  await frames(cdp, 2);
}
