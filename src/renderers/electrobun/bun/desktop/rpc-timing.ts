import { measurePerf } from "../../../../utils/perf-marks";

interface RpcPacket {
  type?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface RpcTransport {
  send?(packet: RpcPacket): void;
  registerHandler?(handler: (packet: RpcPacket) => unknown): void;
  unregisterHandler?(): void;
}

/** Answers waiting for their request's name; past this the oldest is forgotten. */
const MAX_OPEN_REQUESTS = 500;

/** A request or message name as a stall report keeps it: lower-case words, dotted. */
function sectionPart(name: unknown): string {
  if (typeof name !== "string") return "unknown";
  const part = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return part || "unknown";
}

/** What a window asked for: the backend's own method inside the one Electrobun request. */
function requestName(packet: RpcPacket): string {
  const params = packet.params as { method?: unknown } | null | undefined;
  return sectionPart(packet.method === "backend.request" ? params?.method : packet.method);
}

/**
 * Names every turn a window's channel takes on this process: the part of a
 * request answered before its first wait (`rpc.request.<method>`), a message
 * from the window (`rpc.message.<name>`), and the encoding, encryption and
 * sending of an answer (`rpc.respond.<method>`) or a message to the window
 * (`rpc.send.<name>`). A stall that follows one then says which, where the
 * report would otherwise name whatever was last measured minutes before.
 * Call before the channel's window is created: Electrobun hands it the
 * transport then.
 */
export function measureRpcTraffic(rpc: { setTransport(transport: RpcTransport): void }): void {
  const setTransport = rpc.setTransport;
  const openRequests = new Map<unknown, string>();

  const incoming = (packet: RpcPacket): string => {
    if (!packet || typeof packet !== "object") return "rpc.unknown";
    if (packet.type === "request") {
      const name = requestName(packet);
      openRequests.set(packet.id, name);
      if (openRequests.size > MAX_OPEN_REQUESTS) openRequests.delete(openRequests.keys().next().value);
      return `rpc.request.${name}`;
    }
    if (packet.type === "message") return `rpc.message.${sectionPart(packet.id)}`;
    return "rpc.response";
  };

  const outgoing = (packet: RpcPacket): string => {
    if (!packet || typeof packet !== "object") return "rpc.unknown";
    if (packet.type === "response") {
      const name = openRequests.get(packet.id) ?? "unknown";
      openRequests.delete(packet.id);
      return `rpc.respond.${name}`;
    }
    if (packet.type === "message") return `rpc.send.${sectionPart(packet.id)}`;
    return `rpc.ask.${sectionPart(packet.method)}`;
  };

  rpc.setTransport = (transport) => {
    const { send, registerHandler } = transport;
    setTransport.call(rpc, {
      ...transport,
      ...(send ? { send: (packet: RpcPacket) => measurePerf(outgoing(packet), () => send.call(transport, packet)) } : {}),
      ...(registerHandler
        ? {
          registerHandler: (handler: (packet: RpcPacket) => unknown) => registerHandler.call(
            transport,
            (packet: RpcPacket) => measurePerf(incoming(packet), () => handler(packet)),
          ),
        }
        : {}),
    });
  };
}
