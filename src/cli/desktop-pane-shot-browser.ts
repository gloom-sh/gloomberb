import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdir } from "fs/promises";
import { join } from "path";
import { logFailure } from "../utils/log-failure";

/**
 * The headless Chrome a pane capture draws in (desktop-pane-shot.ts), driven
 * over the DevTools protocol.
 *
 * On macOS and Linux the protocol runs over a pipe to the browser alone
 * (`--remote-debugging-pipe`): no local port that another program on the
 * machine could connect to, and the page's address (which carries the capture
 * server's secret folder) is sent over that pipe, never on the command line,
 * where other accounts could read it. Bun cannot hand a browser those pipes
 * on Windows yet, so there the browser listens on a local port for its
 * DevTools, as before, and is still told the page over the protocol.
 *
 * Chrome keeps its sandbox, which holds a page that goes wrong inside its
 * renderer. It runs without one only where Chrome cannot have it: as root
 * on Linux, which Chrome refuses, or on a Linux machine whose kernel does not
 * let it build one (some containers), where Chrome says so as it fails to
 * start and the capture starts it again without.
 */

/** A DevTools command sent to the capture's page, and its result. */
export interface CdpPage {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface ShotBrowser {
  page: CdpPage;
  /** Opens `url` in the page, resolving once it has loaded or once loading has run past its time. */
  open(url: string): Promise<void>;
  close(): Promise<void>;
}

const CDP_CALL_TIMEOUT_MS = 10_000;
// Chrome gets 30 s to answer at all: 8 s was not enough on a busy machine.
const CHROME_START_TIMEOUT_MS = 30_000;
const PAGE_LOAD_TIMEOUT_MS = 45_000;
const CHROME_EXIT_TIMEOUT_MS = 5_000;

type CdpMessage = {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type PendingCdpCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * One DevTools connection to the browser. Commands carry an id and, for the
 * page, its session (flat sessions); replies settle them and events wake who
 * waits on them.
 */
class CdpConnection {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingCdpCall>();
  private readonly waiters = new Set<{ method: string; sessionId?: string; settle: (seen: boolean) => void }>();

  constructor(private readonly write: (text: string) => void) {}

  receive(text: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch (error) {
      logFailure("cli.screenshot", "Decode screenshot browser response failed")(error);
      return;
    }
    if (message.id === undefined) {
      for (const waiter of this.waiters) {
        if (waiter.method === message.method && waiter.sessionId === message.sessionId) waiter.settle(true);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error([message.error.message, message.error.data].filter(Boolean).join("\n")));
    else pending.resolve(message.result);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Chrome DevTools connection closed."));
    this.pending.clear();
    for (const waiter of this.waiters) waiter.settle(false);
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs = CDP_CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Chrome DevTools connection closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Chrome DevTools method ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending.delete(id);
      }
    });
  }

  /** True once `method` arrives for the session, false when it has not within `timeoutMs` or the connection closed. */
  waitForEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.closed) return resolve(false);
      const waiter = {
        method,
        sessionId,
        settle: (seen: boolean) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(seen);
        },
      };
      const timer = setTimeout(() => waiter.settle(false), timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

const CHROME_ARGS = [
  "--headless=new",
  "--disable-gpu",
  // Software WebGL for GPU-drawn panes (the 3D volatility surface).
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-popup-blocking",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--allow-file-access-from-files",
];

const NO_SANDBOX = "--no-sandbox";
/** What Chrome prints when it cannot start with its sandbox: run as root, or no kernel support for one. */
const SANDBOX_REFUSED = /No usable sandbox|Running as root without --no-sandbox/;
/** How much of Chrome's stderr a failed start keeps to tell why. */
const STDERR_KEPT_BYTES = 16_384;

/** Whether Chrome starts without its sandbox from the outset: as root on Linux, where it refuses one. */
export function startsWithoutSandbox(platform: NodeJS.Platform, uid: number | undefined): boolean {
  return platform === "linux" && uid === 0;
}

/** Whether a Chrome that failed to start said it was for want of its sandbox. */
export function chromeSandboxRefused(stderr: string): boolean {
  return SANDBOX_REFUSED.test(stderr);
}

interface LaunchedChrome {
  connection: CdpConnection;
  stop(): Promise<void>;
  /** The start of what the browser wrote to stderr, once it has exited. */
  stderr(): Promise<string>;
}

/** Chrome with DevTools on fds 3 (to the browser) and 4 (from it): messages are JSON, each ended by a NUL. */
function launchOverPipe(chrome: string, args: string[]): LaunchedChrome {
  const child = spawn(chrome, [...args, "--remote-debugging-pipe", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  // Read to the end, so a chatty browser never blocks on a full pipe; only the start is kept.
  let stderrText = "";
  const fromStderr = child.stderr!;
  fromStderr.setEncoding("utf8");
  fromStderr.on("data", (chunk: string) => {
    if (stderrText.length < STDERR_KEPT_BYTES) stderrText += chunk.slice(0, STDERR_KEPT_BYTES - stderrText.length);
  });
  const stderrDone = new Promise<void>((resolve) => {
    fromStderr.once("close", () => resolve());
    fromStderr.once("error", () => resolve());
  });
  const toChrome = child.stdio[3] as Writable;
  const fromChrome = child.stdio[4] as Readable;
  const connection = new CdpConnection((text) => toChrome.write(`${text}\0`));
  let buffered = "";
  fromChrome.setEncoding("utf8");
  fromChrome.on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\0"); end >= 0; end = buffered.indexOf("\0")) {
      const message = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      connection.receive(message);
    }
  });
  const closed = () => connection.close();
  fromChrome.on("close", closed);
  fromChrome.on("error", closed);
  // Writes after the browser has gone fail; the connection already says it closed.
  toChrome.on("error", closed);
  child.on("error", closed);
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  child.once("exit", closed);
  return {
    connection,
    stop: async () => {
      connection.close();
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), CHROME_EXIT_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    },
    stderr: async () => {
      await exited;
      await Promise.race([stderrDone, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      return stderrText;
    },
  };
}

/** Chrome with DevTools on a local port it picks and writes to DevToolsActivePort in its profile. */
async function launchOverPort(chrome: string, args: string[], userDataDir: string): Promise<LaunchedChrome> {
  // A port picked here can be one Windows has reserved, where Chrome runs on
  // without DevTools until the wait below times out; Chrome's own pick is free.
  const proc = Bun.spawn([chrome, ...args, "--remote-debugging-port=0", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const stop = async () => {
    proc.kill();
    await proc.exited.catch(() => { /* Intentional ignore: the capture browser was killed during cleanup; the capture result stands. */ });
  };
  try {
    const endpoint = await waitForBrowserEndpoint(userDataDir);
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools.")), { once: true });
    });
    const connection = new CdpConnection((text) => socket.send(text));
    socket.addEventListener("message", (event) => {
      void messageText(event.data).then((text) => connection.receive(text));
    });
    socket.addEventListener("close", () => connection.close());
    return {
      connection,
      stop: async () => {
        connection.close();
        socket.close();
        await stop();
      },
      // Windows gives Chrome its sandbox without kernel support to miss.
      stderr: async () => "",
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The browser's DevTools socket, from the port and path Chrome writes to DevToolsActivePort once it listens. */
async function waitForBrowserEndpoint(userDataDir: string): Promise<string> {
  const deadline = Date.now() + CHROME_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const [port, path] = (await Bun.file(join(userDataDir, "DevToolsActivePort")).text()).split("\n");
      if (port && Number(port) > 0 && path?.startsWith("/devtools/browser/")) return `ws://127.0.0.1:${Number(port)}${path.trim()}`;
    } catch {
      // Intentional ignore: Chrome has not written the file yet; the deadline reports a browser that never does.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chrome DevTools.");
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}

class ChromeSandboxRefusedError extends Error {}

/**
 * Starts the capture browser with one blank page of `widthPx` by `heightPx`,
 * its profile in `userDataDir`. Nothing is loaded until `open`.
 */
export async function launchShotBrowser(
  chrome: string,
  options: { widthPx: number; heightPx: number; userDataDir: string },
): Promise<ShotBrowser> {
  await mkdir(options.userDataDir, { recursive: true });
  const args = [...CHROME_ARGS, `--user-data-dir=${options.userDataDir}`, `--window-size=${options.widthPx},${options.heightPx}`];
  if (startsWithoutSandbox(process.platform, process.getuid?.())) return startShotBrowser(chrome, [...args, NO_SANDBOX], options);
  try {
    return await startShotBrowser(chrome, args, options);
  } catch (error) {
    if (!(error instanceof ChromeSandboxRefusedError)) throw error;
    logFailure("cli.screenshot", "Chrome has no sandbox on this machine; capturing without it")(error);
    return startShotBrowser(chrome, [...args, NO_SANDBOX], options);
  }
}

async function startShotBrowser(
  chrome: string,
  args: string[],
  options: { userDataDir: string },
): Promise<ShotBrowser> {
  const launched = process.platform === "win32"
    ? await launchOverPort(chrome, args, options.userDataDir)
    : launchOverPipe(chrome, args);
  const { connection } = launched;
  try {
    // The first answer waits for the browser to start.
    try {
      await connection.send("Browser.getVersion", undefined, undefined, CHROME_START_TIMEOUT_MS);
    } catch (error) {
      await launched.stop();
      if (!args.includes(NO_SANDBOX) && chromeSandboxRefused(await launched.stderr())) {
        throw new ChromeSandboxRefusedError("Chrome could not start with its sandbox.", { cause: error });
      }
      throw error;
    }
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    const page: CdpPage = { send: (method, params) => connection.send(method, params, sessionId) };
    return {
      page,
      async open(url) {
        await page.send("Page.enable");
        const loaded = connection.waitForEvent("Page.loadEventFired", sessionId, PAGE_LOAD_TIMEOUT_MS);
        const { errorText } = await page.send("Page.navigate", { url }) as { errorText?: string };
        if (errorText) throw new Error(`Chrome could not open the capture page: ${errorText}`);
        await loaded;
      },
      close: () => launched.stop(),
    };
  } catch (error) {
    await launched.stop();
    throw error;
  }
}

/** The Chrome or Chromium a capture draws in: `CHROME_PATH`, or where each platform installs one. */
export async function findChromeExecutable(): Promise<string> {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    Bun.which("google-chrome"),
    Bun.which("google-chrome-stable"),
    Bun.which("chromium"),
    Bun.which("chromium-browser"),
    // Windows installs Chrome outside PATH, per machine or per user.
    ...["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].map((name) => {
      const dir = process.env[name];
      return dir ? join(dir, "Google", "Chrome", "Application", "chrome.exe") : null;
    }),
  ].filter((value): value is string => !!value);

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) return candidate;
  }
  throw new Error("Drawing a pane needs Google Chrome or Chromium, and neither was found. Install one, or set CHROME_PATH to its executable.");
}
