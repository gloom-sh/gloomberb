import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * The network the benchmark's apps see, installed over `fetch` in the process
 * that makes the requests (the terminal, the desktop stand-in's Bun side, the
 * web server):
 *
 * - Reads go to the network once and are kept on disk; every later run gets
 *   the kept answer after the time the network took to give it, so runs are
 *   alike and the data service sees each read once, not once per launch.
 *   A read nobody kept yet goes to the network and is kept.
 * - `extraDelayMs` holds every answer that much longer: the slow network.
 * - Only GET and HEAD leave the machine. Previously recorded read-only batch
 *   POSTs can be replayed, but nothing writes to an upstream service.
 */
export interface WarmStartNetworkOptions {
  dir: string;
  extraDelayMs: number;
  replayOnly?: boolean;
  /** Counts what happened, for the report. */
  log?: (event: "kept" | "fetched" | "refused" | "streamed", url: string) => void;
}

interface KeptAnswer {
  status: number;
  headers: Record<string, string>;
  latencyMs: number;
  body: string;
}

const KEPT_HEADERS = ["content-type", "cache-control", "etag", "last-modified", "date", "x-gloom-delay-minutes"];
/** A kept answer waits at most this long for its recorded latency: a slow first fetch is not replayed as slow every time. */
const MAX_REPLAYED_LATENCY_MS = 1_500;

function isRead(method: string, url: URL): boolean {
  if (method === "GET" || method === "HEAD") return true;
  return method === "POST" && /(^|\/)market\//.test(url.pathname.replace(/^\/api\//, "/"));
}

function keyFor(method: string, url: URL, body: string): string {
  return createHash("sha1").update(`${method} ${url.href}\n${body}`).digest("hex");
}

export interface WarmStartNetworkControl {
  /** Changes the slow network's extra time for the requests that start after. */
  setExtraDelay(ms: number): void;
}

export function installWarmStartNetwork(options: WarmStartNetworkOptions): WarmStartNetworkControl {
  const installed = (globalThis as { __warmStartNetwork?: WarmStartNetworkControl }).__warmStartNetwork;
  if (installed) return installed;
  let extraDelayMs = options.extraDelayMs;
  mkdirSync(options.dir, { recursive: true });
  const realFetch = globalThis.fetch.bind(globalThis);
  const proFixture = options.replayOnly && process.env.WARM_START_PRO_FIXTURE === "1"
    ? import("./pro-fixture") : null;
  const wait = (ms: number) => ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(request);
    const method = request.method.toUpperCase();
    if (!isRead(method, url)) {
      options.log?.("refused", `${method} ${url.href}`);
      await wait(extraDelayMs);
      return new Response(JSON.stringify({ error: "The benchmark sends reads only." }), { status: 503, headers: { "content-type": "application/json" } });
    }
    if (proFixture) {
      const answer = (await proFixture).fixtureProAnswer(request, url);
      if (answer) {
        await wait(250 + extraDelayMs);
        options.log?.("kept", url.href);
        return answer;
      }
    }
    const body = method === "POST" ? await request.clone().text() : "";
    const file = join(options.dir, `${keyFor(method, url, body)}.json`);
    if (existsSync(file)) {
      try {
        const kept = JSON.parse(readFileSync(file, "utf8")) as KeptAnswer;
        await wait(Math.min(kept.latencyMs, MAX_REPLAYED_LATENCY_MS) + extraDelayMs);
        if (request.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        options.log?.("kept", url.href);
        const bytes = Buffer.from(kept.body, "base64");
        return new Response(method === "HEAD" || kept.status === 204 || kept.status === 304 ? null : bytes, { status: kept.status, headers: kept.headers });
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") throw error;
        // A kept answer that does not read is asked for again.
      }
    }
    await wait(extraDelayMs);
    if (options.replayOnly || method === "POST") {
      options.log?.("refused", `${method} ${url.href}`);
      return new Response(null, { status: 503 });
    }
    const started = performance.now();
    const response = await realFetch(request);
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("event-stream") || response.status >= 500 || response.status === 429) {
      options.log?.("streamed", url.href);
      return response;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const latencyMs = Math.round(performance.now() - started);
    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    const kept: KeptAnswer = { status: response.status, headers, latencyMs, body: Buffer.from(bytes).toString("base64") };
    try { writeFileSync(file, JSON.stringify(kept)); } catch { /* Intentional ignore: an answer that cannot be kept is fetched again next run. */ }
    options.log?.("fetched", url.href);
    return new Response(method === "HEAD" || response.status === 204 || response.status === 304 ? null : bytes, { status: response.status, headers });
  };
  globalThis.fetch = Object.assign(wrapped, { preconnect: () => {} }) as typeof fetch;
  if (options.replayOnly) {
    const Socket = globalThis.WebSocket;
    globalThis.WebSocket = class ReplaySocket extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const host = new URL(url).hostname;
        if (host !== "127.0.0.1" && host !== "localhost") throw new Error("The benchmark does not replay WebSocket streams");
        super(url, protocols);
      }
    };
  }
  const control: WarmStartNetworkControl = { setExtraDelay: (ms) => { extraDelayMs = ms; } };
  (globalThis as { __warmStartNetwork?: WarmStartNetworkControl }).__warmStartNetwork = control;
  return control;
}

/** The options a child process reads from its environment: `WARM_START_NET_DIR`, `WARM_START_NET_DELAY_MS`. */
export function warmStartNetworkFromEnv(env: NodeJS.ProcessEnv = process.env): WarmStartNetworkOptions | null {
  const dir = env.WARM_START_NET_DIR;
  if (!dir) return null;
  return { dir, extraDelayMs: Number(env.WARM_START_NET_DELAY_MS ?? 0) || 0, replayOnly: env.WARM_START_REPLAY_ONLY === "1" };
}
