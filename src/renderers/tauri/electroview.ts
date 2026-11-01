/**
 * Prototype: `electrobun/view` for a page in a Tauri window. The page talks
 * Electrobun's RPC to the Bun sidecar over a WebSocket on 127.0.0.1; the
 * port, a token and the window's id are set by the window's init script
 * (src/renderers/tauri/electrobun-bun.ts).
 */
import { defineElectrobunRPC } from "../../../node_modules/electrobun/dist/api/shared/rpc";

declare global {
  interface Window {
    __gloomTauriRpc?: { port: number; token: string };
    __electrobunWindowId?: number;
  }
}

type Transport = {
  send(message: unknown): void;
  registerHandler(handler: (message: unknown) => void): void;
  unregisterHandler(): void;
};
type RpcLike = { setTransport(transport: Transport): void };

export class Electroview<T extends RpcLike> {
  bunSocket?: WebSocket;
  rpc?: T;
  private handler: ((message: unknown) => void) | null = null;
  private readonly queue: string[] = [];

  constructor(config: { rpc: T }) {
    this.rpc = config.rpc;
    this.connect();
    config.rpc.setTransport({
      send: (message) => {
        const text = JSON.stringify(message);
        if (this.bunSocket?.readyState === WebSocket.OPEN) this.bunSocket.send(text);
        else this.queue.push(text);
      },
      registerHandler: (handler) => { this.handler = handler; },
      unregisterHandler: () => { this.handler = null; },
    });
  }

  private connect(): void {
    const settings = window.__gloomTauriRpc;
    if (!settings) throw new Error("This page was not opened by the Tauri shell");
    const socket = new WebSocket(`ws://127.0.0.1:${settings.port}/rpc?window=${window.__electrobunWindowId}&token=${settings.token}`);
    this.bunSocket = socket;
    socket.onopen = () => {
      while (this.queue.length) socket.send(this.queue.shift()!);
    };
    socket.onmessage = (event) => {
      try { this.handler?.(JSON.parse(String(event.data))); } catch (error) { console.error("[electroview] bad message", error); }
    };
    socket.onclose = () => {
      setTimeout(() => this.connect(), 250);
    };
  }

  static defineRPC(config: Parameters<typeof defineElectrobunRPC>[1]) {
    return defineElectrobunRPC("webview", config);
  }
}
