import { join } from "path";
import { handleRequest } from "../../src/renderers/cloudflare/worker";
import { isLocalRequest, isOwnPageSocket } from "./local-guard";
import { installWarmStartNetwork } from "./network";

export interface WarmStartWebServer {
  origin: string;
  setDelay(ms: number): void;
  requests(): Record<string, number>;
  stop(): void;
}

/**
 * The web build served by the Worker's own request handler (static files,
 * `/api` to the data service, the plugin HTTP proxy), on 127.0.0.1, with the
 * benchmark's network under the handler's `fetch`. The quote stream is relayed as is.
 * The build is served from its root as the Worker serves it (its API and
 * assets are at absolute paths), so instead of a secret folder only requests
 * that name the server as 127.0.0.1:<port> and come from no other page get an
 * answer, and only the page's own socket is relayed (local-guard.ts).
 */
export async function startWarmStartWebServer({ webRoot, networkDir }: { webRoot: string; networkDir: string }): Promise<WarmStartWebServer> {
  const counts: Record<string, number> = { kept: 0, fetched: 0, refused: 0, streamed: 0 };
  const replayOnly = process.env.WARM_START_REPLAY_ONLY === "1";
  const network = installWarmStartNetwork({ dir: networkDir, extraDelayMs: 0, replayOnly, log: (event) => { counts[event] = (counts[event] ?? 0) + 1; } });
  const assets = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname === "/" || !url.pathname.includes(".") ? "/index.html" : url.pathname;
      const file = Bun.file(join(webRoot, path));
      if (!(await file.exists())) return new Response("", { status: 404 });
      const body = file.type.includes("text/html") ? await file.text() : file;
      return new Response(body, {
        headers: {
          "content-type": file.type,
          "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    },
  };
  type SocketData = { upstream: WebSocket | null; queued: Array<string | Uint8Array<ArrayBuffer>> };
  const toWsPayload = (message: string | Buffer): string | Uint8Array<ArrayBuffer> =>
    typeof message === "string" ? message : new Uint8Array(message);
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bun) {
      if (!isLocalRequest(request, bun.port)) return new Response("Forbidden", { status: 403 });
      const url = new URL(request.url);
      if (url.pathname === "/api/cloud/ws") {
        if (!isOwnPageSocket(request, bun.port)) return new Response("Forbidden", { status: 403 });
        if (replayOnly) return new Response(null, { status: 503 });
        if (bun.upgrade(request, { data: { upstream: null, queued: [] } })) return undefined as unknown as Response;
      }
      return handleRequest(request, { ASSETS: assets }, (upstream) => fetch(upstream));
    },
    websocket: {
      open(socket) {
        const upstream = new WebSocket("wss://api.gloom.sh/cloud/ws");
        socket.data.upstream = upstream;
        upstream.addEventListener("open", () => { for (const message of socket.data.queued.splice(0)) upstream.send(message); });
        upstream.addEventListener("message", (event) => socket.send(event.data as string));
        upstream.addEventListener("close", () => socket.close());
      },
      message(socket, message) {
        const payload = toWsPayload(message);
        const upstream = socket.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(payload);
        else socket.data.queued.push(payload);
      },
      close(socket) {
        socket.data.upstream?.close();
      },
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    setDelay: (ms) => network.setExtraDelay(ms),
    requests: () => { const taken = { ...counts }; for (const key of Object.keys(counts)) counts[key] = 0; return taken; },
    stop: () => server.stop(true),
  };
}
