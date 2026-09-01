import type { BrokerConfigField } from "../../types/broker";
import type { IbkrGatewayConfig, ResolvedIbkrGatewayConnection } from "./gateway/service";

export const LEGACY_IBKR_STATEMENT_URL = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest";
export const IBKR_STATEMENT_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";

type IbkrConnectionMode = "flex" | "gateway";
type IbkrGatewaySetupMode = "auto" | "manual";

export interface FlexQueryConfig {
  token: string;
  queryId: string;
  endpoint?: string;
}

export interface IbkrConfig {
  connectionMode: IbkrConnectionMode;
  gatewaySetupMode: IbkrGatewaySetupMode;
  flex: FlexQueryConfig;
  gateway: IbkrGatewayConfig;
}

const DEFAULT_FLEX_CONFIG: FlexQueryConfig = {
  token: "",
  queryId: "",
  endpoint: IBKR_STATEMENT_URL,
};

const DEFAULT_GATEWAY_HOST = "127.0.0.1";

const DEFAULT_GATEWAY_CONFIG: IbkrGatewayConfig = {
  host: DEFAULT_GATEWAY_HOST,
  marketDataType: "auto",
};

export const IBKR_CONFIG_FIELDS: BrokerConfigField[] = [
  {
    key: "connectionMode",
    label: "Connection Mode",
    type: "select",
    required: true,
    options: [
      { label: "Flex (read-only)", value: "flex", description: "Syncs via IBKR's Flex API. No software needed." },
      { label: "Gateway / TWS", value: "gateway", description: "Use IB Gateway or TWS for live data and trading." },
    ],
  },
  {
    key: "token",
    label: "Flex Token",
    type: "password",
    required: true,
    placeholder: "Your Flex Web Service token",
    dependsOn: { key: "connectionMode", value: "flex" },
  },
  {
    key: "queryId",
    label: "Query ID",
    type: "text",
    required: true,
    placeholder: "Numeric Flex Query ID",
    dependsOn: { key: "connectionMode", value: "flex" },
  },
  {
    key: "endpoint",
    label: "Endpoint",
    type: "text",
    required: false,
    placeholder: IBKR_STATEMENT_URL,
    dependsOn: { key: "connectionMode", value: "flex" },
  },
  {
    key: "gatewaySetupMode",
    label: "Connection Setup",
    type: "select",
    required: true,
    defaultValue: "auto",
    options: [
      {
        label: "Automatic",
        value: "auto",
        description: "Detect the local IBKR API port and choose a client ID automatically.",
      },
      {
        label: "Manual",
        value: "manual",
        description: "Specify the host and socket port yourself.",
      },
    ],
    dependsOn: { key: "connectionMode", value: "gateway" },
  },
  {
    key: "host",
    label: "Gateway Host",
    type: "text",
    required: true,
    placeholder: DEFAULT_GATEWAY_HOST,
    defaultValue: DEFAULT_GATEWAY_HOST,
    dependsOn: { key: "gatewaySetupMode", value: "manual" },
  },
  {
    key: "port",
    label: "Gateway Port",
    type: "number",
    required: true,
    placeholder: "4001, 4002, 7496, or 7497",
    dependsOn: { key: "gatewaySetupMode", value: "manual" },
  },
];

function coerceOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function coerceString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeFlexEndpoint(value: unknown): string {
  const endpoint = coerceString(value, DEFAULT_FLEX_CONFIG.endpoint).trim();
  if (!endpoint || endpoint === LEGACY_IBKR_STATEMENT_URL) return IBKR_STATEMENT_URL;
  return endpoint;
}

function getMode(value: unknown): IbkrConnectionMode {
  return value === "gateway" ? "gateway" : "flex";
}

function getGatewaySetupMode(value: unknown): IbkrGatewaySetupMode | undefined {
  return value === "manual" || value === "auto" ? value : undefined;
}

function inferGatewaySetupMode(
  connectionMode: IbkrConnectionMode,
  input: Record<string, unknown>,
  nestedGateway: Record<string, unknown>,
): IbkrGatewaySetupMode {
  if (connectionMode !== "gateway") return "auto";

  const explicit = getGatewaySetupMode(input.gatewaySetupMode ?? nestedGateway.setupMode);
  if (explicit) return explicit;

  const rawHost = coerceString(nestedGateway.host ?? input.host, DEFAULT_GATEWAY_HOST);
  const rawPort = coerceOptionalNumber(nestedGateway.port ?? input.port);
  const rawClientId = coerceOptionalNumber(nestedGateway.clientId ?? input.clientId);

  return rawHost !== DEFAULT_GATEWAY_HOST || rawPort != null || rawClientId != null
    ? "manual"
    : "auto";
}

export function normalizeIbkrConfig(raw?: Record<string, unknown>): IbkrConfig {
  const input = raw ?? {};
  const nestedFlex = typeof input.flex === "object" && input.flex ? input.flex as Record<string, unknown> : {};
  const nestedGateway = typeof input.gateway === "object" && input.gateway ? input.gateway as Record<string, unknown> : {};
  const inferredMode = input.connectionMode
    ?? (input.host || input.port || input.clientId || nestedGateway.host || nestedGateway.port || nestedGateway.clientId
      ? "gateway"
      : "flex");
  const connectionMode = getMode(inferredMode);
  const gatewaySetupMode = inferGatewaySetupMode(connectionMode, input, nestedGateway);
  const host = coerceString(nestedGateway.host ?? input.host, DEFAULT_GATEWAY_HOST);
  const port = coerceOptionalNumber(nestedGateway.port ?? input.port);
  const clientId = coerceOptionalNumber(nestedGateway.clientId ?? input.clientId);

  return {
    connectionMode,
    gatewaySetupMode,
    flex: {
      token: coerceString(nestedFlex.token ?? input.token),
      queryId: coerceString(nestedFlex.queryId ?? input.queryId),
      endpoint: normalizeFlexEndpoint(nestedFlex.endpoint ?? input.endpoint),
    },
    gateway: {
      host,
      port: gatewaySetupMode === "manual" ? port : undefined,
      clientId: gatewaySetupMode === "manual" ? clientId : undefined,
      lastSuccessfulPort: coerceOptionalNumber(nestedGateway.lastSuccessfulPort ?? input.lastSuccessfulPort),
      lastSuccessfulClientId: coerceOptionalNumber(nestedGateway.lastSuccessfulClientId ?? input.lastSuccessfulClientId),
      marketDataType: coerceString(
        nestedGateway.marketDataType ?? input.marketDataType,
        DEFAULT_GATEWAY_CONFIG.marketDataType,
      ) as IbkrGatewayConfig["marketDataType"],
    },
  };
}

export function buildIbkrConfigFromValues(values: Record<string, unknown>): IbkrConfig {
  const normalized = normalizeIbkrConfig(values);
  return {
    connectionMode: normalized.connectionMode,
    gatewaySetupMode: normalized.gatewaySetupMode,
    flex: normalized.flex,
    gateway: normalized.gateway,
  };
}

export function getGatewayConfig(raw?: Record<string, unknown>): IbkrGatewayConfig {
  return normalizeIbkrConfig(raw).gateway;
}

export function isGatewayConfigured(raw?: Record<string, unknown>): boolean {
  const config = normalizeIbkrConfig(raw);
  return config.connectionMode === "gateway"
    && !!config.gateway.host
    && (config.gatewaySetupMode !== "manual" || Number.isFinite(config.gateway.port));
}

export function isFlexConfigured(raw?: Record<string, unknown>): boolean {
  const config = normalizeIbkrConfig(raw);
  return config.connectionMode === "flex"
    && !!config.flex.token
    && !!config.flex.queryId;
}

export function buildPersistedIbkrGatewayConfig(
  raw: Record<string, unknown> | undefined,
  resolved: ResolvedIbkrGatewayConnection,
): Record<string, unknown> | null {
  const normalized = normalizeIbkrConfig(raw);
  if (normalized.connectionMode !== "gateway") return null;

  if (
    normalized.gateway.lastSuccessfulPort === resolved.port
    && normalized.gateway.lastSuccessfulClientId === resolved.clientId
  ) {
    return null;
  }

  const gateway: Record<string, unknown> = {
    host: normalized.gateway.host,
    marketDataType: normalized.gateway.marketDataType,
    lastSuccessfulPort: resolved.port,
    lastSuccessfulClientId: resolved.clientId,
  };

  if (normalized.gateway.port != null) gateway.port = normalized.gateway.port;
  if (normalized.gateway.clientId != null) gateway.clientId = normalized.gateway.clientId;

  return {
    connectionMode: normalized.connectionMode,
    gatewaySetupMode: normalized.gatewaySetupMode,
    flex: normalized.flex,
    gateway,
  };
}
