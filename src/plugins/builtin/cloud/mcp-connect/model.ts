/**
 * What the "Connect an AI assistant" dialog shows for each MCP client: the
 * endpoint this build talks to, and the one command or config snippet the
 * client needs. The commands are the ones gloom.sh/docs/mcp gives; change them
 * there first.
 */
import { ApiRequestError } from "../../../../api-client/errors";
import { DEFAULT_API_URL, getCloudApiBaseUrl } from "../../../../api-client/request";

const MCP_ENDPOINT_PATH = "/mcp";
/** What a snippet shows until a key is created; the docs use the same stand-in. */
const MCP_KEY_PLACEHOLDER = "gloom_mcp_...";
export const MCP_DOCS_URL = "https://gloom.sh/docs/mcp";

export type McpClientId = "claude-code" | "codex" | "json" | "other";

export interface McpClient {
  id: McpClientId;
  label: string;
  /** The key's name in Cloud settings, so it can be told apart and revoked later. */
  keyName: string;
}

export const MCP_CLIENTS: readonly McpClient[] = [
  { id: "claude-code", label: "Claude Code", keyName: "Claude Code" },
  { id: "codex", label: "Codex", keyName: "Codex" },
  { id: "json", label: "Cursor / JSON", keyName: "Cursor" },
  { id: "other", label: "Other", keyName: "MCP client" },
];

/**
 * The MCP endpoint next to the API this build is configured for, so a dev or
 * staging build shows its own server. The web app reaches the API through its
 * own `/api` path, which only forwards to the public API and which an MCP
 * client outside the browser cannot use, so it gets the public endpoint.
 */
export function mcpEndpointUrl(apiBaseUrl: string, pageOrigin: string | null): string {
  const base = apiBaseUrl.trim().replace(/\/+$/, "");
  if (pageOrigin && base === `${pageOrigin}/api`) return `${DEFAULT_API_URL}${MCP_ENDPOINT_PATH}`;
  return `${base}${MCP_ENDPOINT_PATH}`;
}

export function currentMcpEndpointUrl(): string {
  const origin = typeof location !== "undefined" && typeof location.origin === "string" ? location.origin : null;
  return mcpEndpointUrl(getCloudApiBaseUrl(), origin);
}

export interface McpKeyFailure {
  /**
   * `pro`: the account needs Pro. `signin`: the session is gone. `refused`: the
   * server said no and why (the key limit). `offline`: no answer from the server.
   */
  kind: "pro" | "signin" | "offline" | "refused";
  message: string;
}

/**
 * Why creating a key failed, in one calm line. A refusal the server explains
 * (the key limit) keeps the server's words; anything without an answer from
 * the server reads as unreachable.
 */
export function mcpKeyFailure(error: unknown): McpKeyFailure {
  if (error instanceof ApiRequestError && error.status !== undefined) {
    if (error.status === 402) return { kind: "pro", message: "The MCP server is part of Gloom Pro." };
    if (error.status === 401) return { kind: "signin", message: "Sign in to Gloom Cloud again." };
    if (error.status === 429) return { kind: "refused", message: "Too many requests. Try again in a moment." };
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && error.message.trim()) {
      return { kind: "refused", message: error.message.trim() };
    }
  }
  return { kind: "offline", message: "Gloom Cloud can't be reached right now. Try again in a moment." };
}

export interface McpClientSetup {
  /** What Copy puts on the clipboard, exactly as shown. */
  text: string;
  /** One line on where it goes. */
  hint: string;
  /** The client connects only with a key, and none was created yet. */
  needsKey: boolean;
}

/**
 * The snippet for one client. Without a key, clients that sign in through the
 * browser (Claude Code, Cursor and most recent clients) only need the
 * endpoint; Codex takes a bearer token from an environment variable, so it
 * shows the docs' placeholder until a key exists.
 */
export function mcpClientSetup(client: McpClientId, endpoint: string, key: string | null): McpClientSetup {
  const token = key ?? MCP_KEY_PLACEHOLDER;
  switch (client) {
    case "claude-code":
      return key
        ? {
          text: `claude mcp add --transport http gloom ${endpoint} \\\n  --header "Authorization: Bearer ${key}"`,
          hint: "Run it in a terminal.",
          needsKey: false,
        }
        : {
          text: `claude mcp add --transport http gloom ${endpoint}`,
          hint: "Run it in a terminal. Claude Code signs in through your browser.",
          needsKey: false,
        };
    case "codex":
      return {
        text: `export GLOOM_MCP_KEY=${token}\ncodex mcp add gloom --url ${endpoint} \\\n  --bearer-token-env-var GLOOM_MCP_KEY`,
        hint: key ? "Run it in a terminal." : "Codex connects with a key. Create one below.",
        needsKey: !key,
      };
    case "json": {
      const server = key
        ? `{\n      "url": ${JSON.stringify(endpoint)},\n      "headers": { "Authorization": ${JSON.stringify(`Bearer ${key}`)} }\n    }`
        : `{ "url": ${JSON.stringify(endpoint)} }`;
      return {
        text: `{\n  "mcpServers": {\n    "gloom": ${server}\n  }\n}`,
        hint: key
          ? "Add it to the client's MCP config."
          : "Add it to the client's MCP config. The client signs in on first use.",
        needsKey: false,
      };
    }
    case "other":
      return key
        ? {
          text: `${endpoint}\nAuthorization: Bearer ${token}`,
          hint: "The endpoint, and the header that sends the key.",
          needsKey: false,
        }
        : {
          text: endpoint,
          hint: "The endpoint. Clients sign in on first use, or send a key as a bearer token.",
          needsKey: false,
        };
  }
}
