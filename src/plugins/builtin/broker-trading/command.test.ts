import { expect, test } from "bun:test";
import { buildPluginCommandItem } from "../../../components/command-bar/commands/plugin/items";
import { parseRootShortcutIntent } from "../../../components/command-bar/routes/root/shortcuts";
import type { PluginRegistry } from "../../../plugins/registry";
import type { PinTickerOptions } from "../../../types/plugin";
import { createTradeCommand, createTradeIntent, parseTradeShortcut, takeTradeIntent } from "./command";

test("trade arguments preserve decimal quantity and optional limit without inferring a ticker", () => {
  expect(parseTradeShortcut("  aapl  10 ")).toEqual({ symbol: "AAPL", quantity: "10" });
  expect(parseTradeShortcut("brk.b .5 336.50")).toEqual({ symbol: "BRK.B", quantity: "0.5", limitPrice: "336.5" });
  for (const arg of ["", "AAPL", "10 150", "AAPL 0", "AAPL -1", "AAPL NaN", "AAPL Infinity", "AAPL 1e2", "AAPL 1,000", "AAPL 1 0", "AAPL 1 -1", "AAPL 1 NaN", "AAPL 1 0x10", "AAPL 1 150 extra"]) {
    expect(() => parseTradeShortcut(arg)).toThrow();
  }
});

test("BUY and SELL root shortcuts route to an editable ticket with a one-use intent", () => {
  for (const action of ["BUY", "SELL"] as const) {
    const pins: { symbol: string; options?: PinTickerOptions }[] = [];
    const command = createTradeCommand({ pinTicker: (symbol, options) => pins.push({ symbol, options }) }, action);
    for (const suffix of ["AAPL 10", "AAPL 10 150.25"]) {
      const intent = parseRootShortcutIntent({ query: `${action.toLowerCase()} ${suffix}`, commands: [], pluginCommands: [command], paneTemplates: [], activeTicker: "MSFT" });
      expect(intent.kind).toBe("complete");
      if (intent.kind === "none" || intent.source !== "plugin-command") throw new Error("Expected a plugin shortcut");
      const notifications: string[] = [];
      const item = buildPluginCommandItem({ command: intent.command, shortcutArg: intent.argText, activeTicker: "MSFT",
        pluginRegistry: { getCommandPluginId: () => "broker", allPlugins: new Map() } as unknown as PluginRegistry,
        openPluginCommandWorkflow: () => { throw new Error("No separate command form"); },
        resolvePluginCommandConfirm: () => { throw new Error("No order confirmation in the command bar"); },
        openInlineConfirm: () => { throw new Error("No order confirmation in the command bar"); },
        runPluginCommandDirect: (cmd, values) => { void cmd.execute(values); }, notify: (message) => notifications.push(message),
      });
      item.action?.();
      expect(notifications).toEqual([]);
      const pin = pins.at(-1)!;
      expect(pin.symbol).toBe("AAPL");
      expect(pin.options?.tabId).toBe("broker-trade");
      expect(Object.keys(pin.options?.tabState ?? {})).toEqual(["brokerTradeIntent"]);
      const token = pin.options!.tabState!.brokerTradeIntent as string;
      expect(takeTradeIntent(token)).toEqual({ action, quantity: 10, ...(suffix.endsWith("150.25") ? { limitPrice: 150.25 } : {}) });
      expect(takeTradeIntent(token)).toBeUndefined();
    }
    expect(() => command.execute({ symbol: "AAPL", quantity: "-5" })).toThrow();
    expect(pins).toHaveLength(2);
  }
});

test("pending trade intents copy their inputs and cannot replay persisted tokens", () => {
  const draft = { action: "SELL" as const, quantity: 4, limitPrice: 300 };
  const token = createTradeIntent(draft);
  draft.quantity = 50;
  expect(takeTradeIntent("old-session-token")).toBeUndefined();
  expect(takeTradeIntent(token)).toEqual({ action: "SELL", quantity: 4, limitPrice: 300 });
  expect(takeTradeIntent(token)).toBeUndefined();
});
