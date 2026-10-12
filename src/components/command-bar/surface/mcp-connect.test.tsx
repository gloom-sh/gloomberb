import { describe, expect, test } from "bun:test";
import { registerMcpConnectCommand } from "../../../plugins/builtin/cloud/mcp-connect/command";
import { McpConnectDialogHost } from "../../../plugins/builtin/cloud/mcp-connect/dialog";
import type { PluginRegistry } from "../../../plugins/registry";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { CommandDef, GloomPluginContext } from "../../../types/plugin";
import { CommandBarHarness } from "./test-harness";

const tui = createOpenTuiTestHarness();
const LABEL = "Connect an AI assistant (MCP)";

function mcpCommand(): CommandDef {
  let registered: CommandDef | null = null;
  registerMcpConnectCommand({
    registerCommand: (command: CommandDef) => { registered = command; },
    notify: () => {},
  } as unknown as GloomPluginContext);
  return registered!;
}

function withMcpCommand(registry: PluginRegistry): void {
  (registry.commands as Map<string, CommandDef>).set("mcp-connect", mcpCommand());
}

describe("finding the assistant setup in the command bar", () => {
  test("by the words people type for it", async () => {
    for (const query of ["mcp", "claude", "codex", "cursor", "agent", "assistant", "connect"]) {
      await tui.render(<CommandBarHarness query={query} configurePluginRegistry={withMcpCommand} />, { width: 100, height: 30 });
      await tui.waitForFrameToContain(LABEL).catch(() => {
        throw new Error(`"${query}" did not find the assistant setup:\n${tui.frame()}`);
      });
    }
  });

  test("MCP and Enter open the dialog", async () => {
    await tui.render(
      <>
        <CommandBarHarness query="MCP" live configurePluginRegistry={withMcpCommand} />
        <McpConnectDialogHost />
      </>,
      { width: 110, height: 44 },
    );
    await tui.waitForFrameToContain(LABEL);
    await tui.emitKeypress({ name: "return" });
    const frame = await tui.waitForFrameToContain("Gloom's research tools in Claude Code");
    expect(frame).toContain("claude mcp add --transport http gloom");
  });
});
