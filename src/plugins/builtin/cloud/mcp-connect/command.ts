import type { GloomPluginContext } from "../../../../types/plugin";
import { requestMcpConnectDialog } from "./dialog";

/** The words people type when they look for this, client names included. */
const MCP_CONNECT_KEYWORDS = [
  "mcp", "model context protocol", "claude", "claude code", "codex", "cursor",
  "agent", "agents", "assistant", "ai", "connect", "api key",
];

export function registerMcpConnectCommand(ctx: GloomPluginContext): void {
  ctx.registerCommand({
    id: "mcp-connect",
    label: "Connect an AI assistant (MCP)",
    description: "Claude Code, Codex, Cursor or any MCP client",
    keywords: MCP_CONNECT_KEYWORDS,
    category: "config",
    shortcut: "MCP",
    execute: () => {
      if (!requestMcpConnectDialog()) {
        ctx.notify({ body: "Assistant setup is not available right now.", type: "error" });
      }
    },
  });
}
