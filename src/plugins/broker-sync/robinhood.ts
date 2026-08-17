import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { BrokerAdapter, BrokerConnectionStatus } from "../../types/broker";
import type { BrokerInstanceConfig } from "../../types/config";
import type { GloomPlugin } from "../../types/plugin";
import { normalizeRobinhoodSnapshot, type BrokerPortfolioSnapshot } from "./normalize";

const ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading";
export const ROBINHOOD_POSITION_TOOLS = Object.freeze(["get_accounts", "get_equity_positions"]);

interface ListedRobinhoodTool {
  name: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

export function requireRobinhoodPositionTools(tools: ListedRobinhoodTool[]): Map<string, ListedRobinhoodTool> {
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  for (const toolName of ROBINHOOD_POSITION_TOOLS) {
    const tool = available.get(toolName);
    if (!tool || tool.annotations?.readOnlyHint === false) {
      throw new Error(`Robinhood did not expose the read-only ${toolName} tool.`);
    }
  }
  return new Map(ROBINHOOD_POSITION_TOOLS.map((toolName) => [toolName, available.get(toolName)!]));
}

interface RobinhoodOAuthData {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

const pendingOAuth = new Map<string, RobinhoodOAuthData>();
const statuses = new Map<string, BrokerConnectionStatus>();
const statusListeners = new Map<string, Set<() => void>>();

function setStatus(instanceId: string, state: BrokerConnectionStatus["state"], message?: string): void {
  statuses.set(instanceId, { state, message, mode: "oauth", updatedAt: Date.now() });
  for (const listener of statusListeners.get(instanceId) ?? []) listener();
}

function cloneOAuth(value: unknown): RobinhoodOAuthData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return structuredClone(value) as RobinhoodOAuthData;
}

async function openExternal(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  const processHandle = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) throw new Error("Gloomberb could not open the Robinhood sign-in page.");
}

class RobinhoodOAuthProvider implements OAuthClientProvider {
  constructor(
    readonly redirectUrl: string,
    private readonly oauth: RobinhoodOAuthData,
    private readonly oauthState: string,
  ) {}

  get clientMetadata() {
    return {
      client_name: "Gloomberb Robinhood Position Sync",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  state() { return this.oauthState; }
  clientInformation() { return this.oauth.clientInformation; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.oauth.clientInformation = value; }
  tokens() { return this.oauth.tokens; }
  saveTokens(value: OAuthTokens) { this.oauth.tokens = value; }
  async redirectToAuthorization(url: URL) { await openExternal(url.toString()); }
  saveCodeVerifier(value: string) { this.oauth.codeVerifier = value; }
  codeVerifier() {
    if (!this.oauth.codeVerifier) throw new Error("The Robinhood OAuth verifier is missing.");
    return this.oauth.codeVerifier;
  }
  saveDiscoveryState(value: OAuthDiscoveryState) { this.oauth.discoveryState = value; }
  discoveryState() { return this.oauth.discoveryState; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.oauth.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.oauth.tokens;
    if (scope === "all" || scope === "verifier") delete this.oauth.codeVerifier;
    if (scope === "all" || scope === "discovery") delete this.oauth.discoveryState;
  }
}

interface OAuthCallback {
  redirectUrl: string;
  code: Promise<string>;
  close(): Promise<void>;
}

async function startOAuthCallback(expectedState: string): Promise<OAuthCallback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let server: Server;
  const finish = (action: () => void) => {
    if (settled) return;
    settled = true;
    action();
  };
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found.");
      return;
    }
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const authorizationCode = url.searchParams.get("code");
    if (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Robinhood sign-in failed. Return to Gloomberb.");
      finish(() => rejectCode(new Error(`Robinhood sign-in failed: ${error}.`)));
      return;
    }
    if (!authorizationCode || state !== expectedState) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Gloomberb could not verify this Robinhood sign-in.");
      finish(() => rejectCode(new Error("Gloomberb could not verify the Robinhood sign-in response.")));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Robinhood is connected. You can close this page and return to Gloomberb.");
    finish(() => resolveCode(authorizationCode));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Gloomberb could not start the Robinhood sign-in callback.");
  }
  const timeout = setTimeout(() => {
    finish(() => rejectCode(new Error("Robinhood sign-in timed out.")));
  }, 5 * 60_000);
  return {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    code,
    close: async () => {
      clearTimeout(timeout);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectMcp(provider: RobinhoodOAuthProvider, callback: OAuthCallback): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const makeConnection = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(ROBINHOOD_MCP_URL), { authProvider: provider });
    const client = new Client({ name: "gloomberb-robinhood-sync", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return { client, transport };
  };
  const transport = new StreamableHTTPClientTransport(new URL(ROBINHOOD_MCP_URL), { authProvider: provider });
  const client = new Client({ name: "gloomberb-robinhood-sync", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      await client.close().catch(() => {});
      throw error;
    }
    const authorizationCode = await callback.code;
    await transport.finishAuth(authorizationCode);
    await client.close().catch(() => {});
    return makeConnection();
  }
}

function toolPayload(result: unknown): unknown {
  const value = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  const text = value.content
    ?.filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (value.isError) throw new Error(text || "Robinhood returned an error.");
  if (!text) return value.structuredContent ?? result;
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Robinhood returned an invalid tool response.");
  }
}

function accountIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const item = value as Record<string, unknown>;
    for (const key of ["accountId", "account_id", "accountNumber", "account_number"]) {
      if (typeof item[key] === "string" && item[key]) ids.add(item[key]);
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(payload);
  return [...ids];
}

function positionArguments(inputSchema: unknown, accountId: string): Record<string, string> {
  if (!inputSchema || typeof inputSchema !== "object") return {};
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  const accountKey = Object.keys(properties).find((key) => /account/i.test(key));
  return accountKey ? { [accountKey]: accountId } : {};
}

export async function loadRobinhoodPortfolio(instance: BrokerInstanceConfig): Promise<BrokerPortfolioSnapshot> {
  setStatus(instance.id, "connecting", "Waiting for Robinhood");
  const oauth = cloneOAuth(pendingOAuth.get(instance.id) ?? instance.config.oauth);
  const oauthState = randomBytes(24).toString("hex");
  const callback = await startOAuthCallback(oauthState);
  const provider = new RobinhoodOAuthProvider(callback.redirectUrl, oauth, oauthState);
  let connection: Awaited<ReturnType<typeof connectMcp>> | null = null;
  try {
    connection = await connectMcp(provider, callback);
    const listed = await connection.client.listTools();
    pendingOAuth.set(instance.id, oauth);
    const tools = requireRobinhoodPositionTools(listed.tools);
    const accountsPayload = toolPayload(await connection.client.callTool({ name: "get_accounts", arguments: {} }));
    const ids = accountIds(accountsPayload);
    const positionTool = tools.get("get_equity_positions")!;
    const positionPayloads = ids.length > 0
      ? await Promise.all(ids.map((accountId) => connection!.client.callTool({
        name: "get_equity_positions",
        arguments: positionArguments(positionTool.inputSchema, accountId),
      }).then(toolPayload)))
      : [toolPayload(await connection.client.callTool({ name: "get_equity_positions", arguments: {} }))];
    const snapshot = normalizeRobinhoodSnapshot(accountsPayload, positionPayloads);
    setStatus(instance.id, "connected", "Read-only OAuth connection");
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Robinhood sync failed.";
    setStatus(instance.id, "error", message);
    throw new Error(`Gloomberb could not sync Robinhood. ${message}`);
  } finally {
    await connection?.client.close().catch(() => {});
    await callback.close();
  }
}

export const robinhoodBroker: BrokerAdapter = {
  id: "robinhood",
  name: "Robinhood",
  configSchema: [{
    key: "connectionMode",
    label: "Connection",
    type: "select",
    required: true,
    defaultValue: "oauth",
    options: [{
      label: "Robinhood sign-in (read-only sync)",
      value: "oauth",
      description: "Gloomberb opens Robinhood in your browser.",
    }],
  }],

  async validate(instance) {
    return instance.config.connectionMode === "oauth";
  },

  async importPositions(instance) {
    return (await loadRobinhoodPortfolio(instance)).positions;
  },

  async importPortfolioSnapshot(instance) {
    return loadRobinhoodPortfolio(instance);
  },

  async listAccounts(instance) {
    return (await loadRobinhoodPortfolio(instance)).accounts;
  },

  async connect(instance) {
    await loadRobinhoodPortfolio(instance);
  },

  async disconnect(instance) {
    pendingOAuth.delete(instance.id);
    setStatus(instance.id, "disconnected");
  },

  getStatus(instance) {
    return statuses.get(instance.id) ?? {
      state: instance.config.oauth ? "connected" : "disconnected",
      message: instance.config.oauth ? "Read-only OAuth connection" : "Sign in during the first sync",
      mode: "oauth",
      updatedAt: 0,
    };
  },

  subscribeStatus(instance, listener) {
    const listeners = statusListeners.get(instance.id) ?? new Set();
    listeners.add(listener);
    statusListeners.set(instance.id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) statusListeners.delete(instance.id);
    };
  },

  getPersistedConfigUpdate(instance) {
    const oauth = pendingOAuth.get(instance.id);
    if (!oauth) return null;
    pendingOAuth.delete(instance.id);
    return { connectionMode: "oauth", oauth };
  },

  toConfigValues() {
    return { connectionMode: "oauth" };
  },

  fromConfigValues(_values, previous) {
    return {
      connectionMode: "oauth",
      ...(previous?.config.oauth ? { oauth: previous.config.oauth } : {}),
    };
  },
};

export const robinhoodPlugin: GloomPlugin = {
  id: "robinhood",
  name: "Robinhood",
  version: "1.0.0",
  description: "Read-only account and position sync through Robinhood Trading MCP.",
  toggleable: true,
  broker: robinhoodBroker,
};
