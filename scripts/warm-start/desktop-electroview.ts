/**
 * Stands in for `electrobun/view` in the desktop view the warm-start
 * benchmark builds: the view's own RPC client (backend-rpc.ts) runs as it
 * does in the app, over a WebSocket to the stand-in Bun process
 * (desktop-backend.ts) instead of Electrobun's socket. Requests are
 * `{ type: "request", id, name, params }`, answered with `{ id, result }` or
 * `{ id, error }`; the Bun process sends `{ type: "message", name, payload }`.
 */

interface RpcConfig {
  handlers?: {
    requests?: Record<string, (params: unknown) => unknown>;
    messages?: Record<string, (payload: unknown) => void>;
  };
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

function createRpc(config: RpcConfig) {
  // Beside the page, under the launch's secret folder the page was opened at.
  const socket = new WebSocket(new URL("__desktop-rpc", location.href).href.replace(/^http/, "ws"));
  const pending = new Map<number, Pending>();
  const queued: string[] = [];
  let nextId = 1;
  socket.addEventListener("open", () => { for (const packet of queued.splice(0)) socket.send(packet); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; id?: number; result?: unknown; error?: string; name?: string; payload?: unknown };
    if (message.type === "message" && message.name) {
      config.handlers?.messages?.[message.name]?.(message.payload);
      return;
    }
    const waiting = message.id ? pending.get(message.id) : undefined;
    if (!waiting) return;
    pending.delete(message.id!);
    if (message.error !== undefined) waiting.reject(new Error(message.error));
    else waiting.resolve(message.result);
  });
  const post = (packet: string) => socket.readyState === WebSocket.OPEN ? socket.send(packet) : queued.push(packet);
  const request = new Proxy({}, {
    get: (_target, name: string) => (params: unknown) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post(JSON.stringify({ type: "request", id, name, params }));
    }),
  });
  const send = new Proxy({}, {
    get: (_target, name: string) => (payload: unknown) => post(JSON.stringify({ type: "send", name, payload })),
  });
  return { request, send, socket };
}

export class Electroview {
  static defineRPC(config: RpcConfig) {
    return createRpc(config);
  }

  readonly hostSocket: WebSocket;

  constructor({ rpc }: { rpc: ReturnType<typeof createRpc> }) {
    this.hostSocket = rpc.socket;
  }
}

export default { Electroview };
