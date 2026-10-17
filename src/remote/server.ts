import { randomUUID } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { RemoteAppKind, RemoteControlRequest, RemoteControlResponse, RemoteEndpoint } from "./types";
import { REMOTE_CONTROL_PROTOCOL_VERSION } from "./types";
import { removeRemoteEndpointFiles, writeRemoteEndpointFiles } from "./endpoint";

export interface RemoteControlServerOptions {
  dataDir: string;
  appKind: RemoteAppKind;
  handle: (request: RemoteControlRequest) => Promise<RemoteControlResponse>;
}

export interface RemoteControlServer {
  endpoint: RemoteEndpoint;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function startRemoteControlServer(options: RemoteControlServerOptions): Promise<RemoteControlServer> {
  const token = randomUUID();
  const httpServer = createServer((request, response) => {
    void handleHttpRequest(options.handle, token, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("Remote control server did not bind to a TCP port.");
  }

  const endpoint: RemoteEndpoint = {
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    appKind: options.appKind,
    pid: process.pid,
    port: address.port,
    token,
    startedAt: new Date().toISOString(),
  };
  try {
    await writeRemoteEndpointFiles(options.dataDir, endpoint);
  } catch (error) {
    await closeHttpServer(httpServer);
    await removeRemoteEndpointFiles(options.dataDir, endpoint).catch(() => { /* Intentional ignore: Remove partial endpoint files while preserving the startup error rethrown below. */ });
    throw error;
  }

  return {
    endpoint,
    close: async () => {
      await closeHttpServer(httpServer);
      await removeRemoteEndpointFiles(options.dataDir, endpoint);
    },
  };
}

async function closeHttpServer(httpServer: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
  });
}

async function handleHttpRequest(
  handle: RemoteControlServerOptions["handle"],
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || request.url !== "/rpc") {
      sendJson(response, 404, { ok: false, error: { code: "not_found", message: "Unknown remote control endpoint." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { ok: false, error: { code: "unauthorized", message: "Invalid remote control token." } });
      return;
    }

    const body = await readBody(request);
    const remoteRequest = JSON.parse(body) as RemoteControlRequest;
    sendJson(response, 200, await handle(remoteRequest));
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: {
        code: "remote_transport_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let total = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    const bytes = chunk instanceof Uint8Array ? new Uint8Array(chunk) : new TextEncoder().encode(String(chunk));
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("Remote control request is too large.");
    chunks.push(bytes);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
