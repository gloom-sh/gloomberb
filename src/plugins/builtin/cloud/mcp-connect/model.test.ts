import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../../api-client/errors";
import { mcpClientSetup, mcpEndpointUrl, mcpKeyFailure } from "./model";

const PUBLIC = "https://api.gloom.sh/mcp";

describe("the MCP endpoint", () => {
  test("follows the configured API, so a dev or staging build shows its own server", () => {
    expect(mcpEndpointUrl("https://api.gloom.sh", null)).toBe(PUBLIC);
    expect(mcpEndpointUrl("http://127.0.0.1:3355/", null)).toBe("http://127.0.0.1:3355/mcp");
    expect(mcpEndpointUrl("https://staging.example/api", "https://term.gloom.sh")).toBe("https://staging.example/api/mcp");
  });

  test("is the public API from the web app, whose /api path is a proxy an MCP client cannot use", () => {
    expect(mcpEndpointUrl("https://term.gloom.sh/api", "https://term.gloom.sh")).toBe(PUBLIC);
    expect(mcpEndpointUrl("http://localhost:8787/api", "http://localhost:8787")).toBe(PUBLIC);
  });
});

describe("client snippets", () => {
  // The commands gloom.sh/docs/mcp gives, which these must not drift from.
  test("sign in from the client where it can, with no key in sight", () => {
    expect(mcpClientSetup("claude-code", PUBLIC, null).text).toBe("claude mcp add --transport http gloom https://api.gloom.sh/mcp");
    expect(JSON.parse(mcpClientSetup("json", PUBLIC, null).text)).toEqual({ mcpServers: { gloom: { url: PUBLIC } } });
    expect(mcpClientSetup("other", PUBLIC, null).text).toBe(PUBLIC);
    // Codex takes its token from an environment variable, so it waits for a key.
    const codex = mcpClientSetup("codex", PUBLIC, null);
    expect(codex.needsKey).toBe(true);
    expect(codex.text).toBe(
      "export GLOOM_MCP_KEY=gloom_mcp_...\ncodex mcp add gloom --url https://api.gloom.sh/mcp \\\n  --bearer-token-env-var GLOOM_MCP_KEY",
    );
  });

  test("fill a created key in as a bearer token", () => {
    const key = "gloom_mcp_abc123";
    expect(mcpClientSetup("claude-code", PUBLIC, key).text).toBe(
      `claude mcp add --transport http gloom ${PUBLIC} \\\n  --header "Authorization: Bearer ${key}"`,
    );
    expect(mcpClientSetup("codex", PUBLIC, key)).toMatchObject({ needsKey: false });
    expect(mcpClientSetup("codex", PUBLIC, key).text).toStartWith(`export GLOOM_MCP_KEY=${key}\n`);
    expect(JSON.parse(mcpClientSetup("json", PUBLIC, key).text)).toEqual({
      mcpServers: { gloom: { url: PUBLIC, headers: { Authorization: `Bearer ${key}` } } },
    });
    expect(mcpClientSetup("other", PUBLIC, key).text).toBe(`${PUBLIC}\nAuthorization: Bearer ${key}`);
  });
});

test("a failed key says why in one line, and anything without an answer reads as unreachable", () => {
  expect(mcpKeyFailure(new ApiRequestError("The Gloom MCP server is part of Gloom Pro.", 402)).kind).toBe("pro");
  expect(mcpKeyFailure(new ApiRequestError("Unauthorized", 401)).kind).toBe("signin");
  expect(mcpKeyFailure(new ApiRequestError("You already have 10 MCP keys. Revoke one first.", 409))).toEqual({
    kind: "refused",
    message: "You already have 10 MCP keys. Revoke one first.",
  });
  for (const error of [new TypeError("fetch failed"), new ApiRequestError("Bad gateway", 502)]) {
    expect(mcpKeyFailure(error).kind).toBe("offline");
  }
});
