// Load Electrobun's actual transport core without starting its window/socket entrypoint.
const { createRPC } = await import(new URL("../shared/rpc.ts", import.meta.resolve("electrobun/view")).href);

/**
 * Sends a "backend.request" from an Electrobun RPC client to a server that answers with `handle`,
 * JSON-cloning every packet the way the desktop transport does.
 */
export function createRpcLoopback(handle: (request: unknown) => unknown): (request: unknown) => Promise<unknown> {
  let receiveClient: (packet: unknown) => void;
  let receiveServer: (packet: unknown) => void;
  const client = createRPC({ maxRequestTime: 1000 });
  const server = createRPC({ requestHandler: { "backend.request": handle } });
  client.setTransport({
    registerHandler: (handler: typeof receiveClient) => { receiveClient = handler; },
    send: (packet: unknown) => { queueMicrotask(() => receiveServer(JSON.parse(JSON.stringify(packet)))); },
  });
  server.setTransport({
    registerHandler: (handler: typeof receiveServer) => { receiveServer = handler; },
    send: (packet: unknown) => { queueMicrotask(() => receiveClient(JSON.parse(JSON.stringify(packet)))); },
  });
  return (request) => client.request["backend.request"](request);
}
