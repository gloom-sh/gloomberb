import type {
  DesktopHttpStreamOpenRequest,
  DesktopHttpStreamOpenResponse,
  DesktopHttpStreamRequest,
} from "../../shared/protocol";
import {
  collectResponseHeaders,
  normalizeHttpFetchHeaders,
  reportCloudRequest,
  requireProxyableUrl,
} from "./http-fetch";

interface DesktopHttpStreamRpc {
  send: {
    "http.stream.chunk": (payload: {
      streamId: string;
      chunk?: string;
      done?: boolean;
      error?: string;
    }) => void;
  };
}

interface DesktopHttpStreamBridgeOptions<Rpc extends DesktopHttpStreamRpc> {
  getWindowKey: (rpc: Rpc) => string | null | undefined;
  /** Overridable so tests do not reach the network. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Keeps a proxied response body open and forwards it to the view as it
 * arrives.
 *
 * The desktop cannot fetch Gloom Cloud from the webview: cookies and `Origin`
 * are headers a browser owns, so every call goes through the Bun process. The
 * buffered `http.fetch` path is fine for JSON, but a server-sent event stream
 * never ends on its own, which is why Ask Gloom reported that this window
 * could not stream. This is the streaming half of that bridge.
 */
export class DesktopHttpStreamBridge<Rpc extends DesktopHttpStreamRpc> {
  private readonly streams = new Map<string, AbortController>();
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: DesktopHttpStreamBridgeOptions<Rpc>) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  disposeAll(): void {
    for (const controller of this.streams.values()) controller.abort();
    this.streams.clear();
  }

  /** A closed window leaves no reader, so its streams stop costing bandwidth. */
  disposeWindow(windowKey: string): void {
    const prefix = `${windowKey}:`;
    for (const [id, controller] of this.streams) {
      if (!id.startsWith(prefix)) continue;
      controller.abort();
      this.streams.delete(id);
    }
  }

  async handle(rpc: Rpc, request: DesktopHttpStreamRequest): Promise<unknown> {
    switch (request.method) {
      case "http.stream.open":
        return this.open(rpc, request.payload);
      case "http.stream.cancel": {
        const scopedId = this.scopeStreamId(rpc, request.payload.streamId);
        this.streams.get(scopedId)?.abort();
        this.streams.delete(scopedId);
        return null;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown http stream method: ${String(exhaustive)}`);
      }
    }
  }

  private async open(
    rpc: Rpc,
    payload: DesktopHttpStreamOpenRequest,
  ): Promise<DesktopHttpStreamOpenResponse> {
    if (typeof payload.streamId !== "string" || !payload.streamId) {
      throw new Error("http.stream.open requires a stream id.");
    }
    const url = requireProxyableUrl(payload.url, "http.stream.open");
    const scopedId = this.scopeStreamId(rpc, payload.streamId);
    // A reused id can only mean the view lost track of the old stream.
    this.streams.get(scopedId)?.abort();

    const init = payload.init ?? {};
    const method = init.method?.trim().toUpperCase() || "GET";
    const controller = new AbortController();
    this.streams.set(scopedId, controller);

    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.fetch(url, {
        method,
        headers: normalizeHttpFetchHeaders(init.headers),
        ...(typeof init.body === "string" && method !== "GET" && method !== "HEAD"
          ? { body: init.body }
          : {}),
        signal: controller.signal,
      });
    } catch (error) {
      this.streams.delete(scopedId);
      reportCloudRequest(url, method, performance.now() - startedAt, false, error);
      throw error;
    }
    reportCloudRequest(
      url,
      method,
      performance.now() - startedAt,
      response.ok,
      response.ok ? undefined : new Error(`${response.status} ${response.statusText}`.trim()),
    );

    const { headers, setCookie } = collectResponseHeaders(response);
    const head: DesktopHttpStreamOpenResponse = {
      status: response.status,
      statusText: response.statusText,
      headers,
      setCookie,
    };
    // The view decides what a refusal means, so its body is delivered the same
    // way a successful one is rather than thrown from here.
    void this.pump(rpc, payload.streamId, scopedId, response, controller);
    return head;
  }

  private async pump(
    rpc: Rpc,
    streamId: string,
    scopedId: string,
    response: Response,
    controller: AbortController,
  ): Promise<void> {
    const send = (payload: { chunk?: string; done?: boolean; error?: string }) => {
      if (this.streams.get(scopedId) !== controller) return false;
      try {
        rpc.send["http.stream.chunk"]({ streamId, ...payload });
        return true;
      } catch {
        // A window torn down mid-answer has nothing left to read the rest.
        controller.abort();
        this.streams.delete(scopedId);
        return false;
      }
    };

    const body = response.body;
    if (!body) {
      send({ done: true });
      this.streams.delete(scopedId);
      return;
    }

    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        if (text && !send({ chunk: text })) return;
      }
      const tail = decoder.decode();
      if (tail) send({ chunk: tail });
      send({ done: true });
    } catch (error) {
      if (controller.signal.aborted) return;
      send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.streams.get(scopedId) === controller) this.streams.delete(scopedId);
      try {
        reader.releaseLock();
      } catch {
        // A reader cancelled mid-read cannot release its lock.
      }
    }
  }

  private scopeStreamId(rpc: Rpc, streamId: string): string {
    return `${this.options.getWindowKey(rpc) ?? "window"}:${streamId}`;
  }
}
