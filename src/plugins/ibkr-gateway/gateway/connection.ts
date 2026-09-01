import { createConnection } from "net";
import type { IbkrGatewayConfig, ResolvedIbkrGatewayConnection } from "../../ibkr/gateway-types";

const LOCAL_IBKR_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const COMMON_LOCAL_IBKR_PORTS = [4001, 4002, 7496, 7497] as const;
const LOCAL_TCP_PROBE_TIMEOUT_MS = 250;
const DEFAULT_AUTO_CLIENT_ID = 1;

export interface IbkrPortDiagnosticOptions {
  candidatePorts?: readonly number[];
  probePort?: (host: string, port: number) => Promise<boolean>;
}

export function buildConnectionNote(
  requestedClientId: number,
  actualClientId: number,
  requestedPort: number | undefined,
  actualPort: number,
): string | undefined {
  const notes: string[] = [];
  if (requestedPort == null || requestedPort !== actualPort) {
    notes.push(`Detected IBKR API on port ${actualPort}.`);
  }
  if (requestedClientId !== actualClientId) {
    notes.push(`Using client ID ${actualClientId} because ${requestedClientId} is already in use.`);
  }
  return notes.length > 0 ? notes.join(" ") : undefined;
}

function isLoopbackHost(host: string): boolean {
  return LOCAL_IBKR_HOSTS.has(host.trim().toLowerCase());
}

async function probeTcpPort(host: string, port: number, timeoutMs = LOCAL_TCP_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function uniquePorts(...values: Array<number | undefined | readonly number[]>): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const candidate of value) {
        if (Number.isFinite(candidate)) unique.add(candidate);
      }
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      unique.add(value);
    }
  }
  return [...unique];
}

export async function diagnoseLocalIbkrPortIssue(
  config: IbkrGatewayConfig,
  options: IbkrPortDiagnosticOptions = {},
): Promise<string | null> {
  if (typeof config.port !== "number" || !Number.isFinite(config.port)) return null;
  if (!isLoopbackHost(config.host)) return null;

  const candidatePorts = options.candidatePorts ?? COMMON_LOCAL_IBKR_PORTS;
  const probePort = options.probePort ?? ((host: string, port: number) => probeTcpPort(host, port));
  if (await probePort(config.host, config.port)) return null;

  const openAlternatives: number[] = [];
  for (const port of candidatePorts) {
    if (port === config.port) continue;
    if (await probePort(config.host, port)) openAlternatives.push(port);
  }

  if (openAlternatives.length === 0) {
    return `IBKR is not listening on ${config.host}:${config.port}. Start Gateway/TWS and confirm the API socket port in the IBKR API settings.`;
  }

  const detectedTargets = openAlternatives.map((port) => `${config.host}:${port}`).join(", ");
  return `IBKR is not listening on ${config.host}:${config.port}. Detected a local IBKR API listener on ${detectedTargets} instead. Update this profile's port to match Gateway/TWS.`;
}

export async function resolveGatewayConnection(
  config: IbkrGatewayConfig,
  options: IbkrPortDiagnosticOptions = {},
): Promise<ResolvedIbkrGatewayConnection> {
  const host = (config.host || "127.0.0.1").trim() || "127.0.0.1";
  const requestedPort = typeof config.port === "number" && Number.isFinite(config.port) ? config.port : undefined;
  const requestedClientId = typeof config.clientId === "number" && Number.isFinite(config.clientId)
    ? config.clientId
    : typeof config.lastSuccessfulClientId === "number" && Number.isFinite(config.lastSuccessfulClientId)
      ? config.lastSuccessfulClientId
      : DEFAULT_AUTO_CLIENT_ID;
  const probePort = options.probePort ?? ((candidateHost: string, candidatePort: number) => probeTcpPort(candidateHost, candidatePort));

  if (requestedPort != null) {
    const localPortIssue = await diagnoseLocalIbkrPortIssue({
      host,
      port: requestedPort,
      clientId: requestedClientId,
      marketDataType: config.marketDataType,
    }, options);
    if (localPortIssue) throw new Error(localPortIssue);
    return {
      host,
      port: requestedPort,
      clientId: requestedClientId,
      requestedPort,
      requestedClientId,
    };
  }

  if (isLoopbackHost(host)) {
    const candidatePorts = uniquePorts(config.lastSuccessfulPort, options.candidatePorts ?? COMMON_LOCAL_IBKR_PORTS);
    for (const port of candidatePorts) {
      if (await probePort(host, port)) {
        return {
          host,
          port,
          clientId: requestedClientId,
          requestedPort: typeof config.lastSuccessfulPort === "number" ? config.lastSuccessfulPort : undefined,
          requestedClientId,
        };
      }
    }

    throw new Error(
      `No local IBKR API listeners were detected on ${host}. Checked ports ${candidatePorts.join(", ")}. Start Gateway/TWS and enable socket clients in the IBKR API settings.`,
    );
  }

  const fallbackPort = typeof config.lastSuccessfulPort === "number" && Number.isFinite(config.lastSuccessfulPort)
    ? config.lastSuccessfulPort
    : COMMON_LOCAL_IBKR_PORTS[0];
  return {
    host,
    port: fallbackPort,
    clientId: requestedClientId,
    requestedPort: typeof config.lastSuccessfulPort === "number" ? config.lastSuccessfulPort : undefined,
    requestedClientId,
  };
}
