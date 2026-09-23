import { describe, expect, test } from "bun:test";
import type { ApplicationMenuItemConfig } from "electrobun/bun";
import { buildDesktopApplicationMenu, ELECTROBUN_APPLICATION_MENU_ACTION } from "./index";
import { applicationMenuCommand } from "./click";

function menuCommands(items: ApplicationMenuItemConfig[]): unknown[] {
  return items.flatMap((item) => {
    const entry = item as { action?: string; data?: unknown; submenu?: ApplicationMenuItemConfig[] };
    return [
      ...(entry.action === ELECTROBUN_APPLICATION_MENU_ACTION ? [entry.data] : []),
      ...(entry.submenu ? menuCommands(entry.submenu) : []),
    ];
  });
}

describe("applicationMenuCommand", () => {
  // A menu item whose command the click handler drops does nothing, by mouse
  // or by keyboard menu navigation.
  test("passes through every command the menu bar sends", () => {
    const commands = menuCommands(buildDesktopApplicationMenu("darwin"));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(applicationMenuCommand({
        data: { action: ELECTROBUN_APPLICATION_MENU_ACTION, data: command },
      })).toEqual(command as never);
    }
  });

  test("ignores events for other actions", () => {
    expect(applicationMenuCommand({
      data: {
        action: "gloom.other-action",
        data: { type: "open-command-bar", query: "DES " },
      },
    })).toBeNull();
  });

  test("ignores unknown command types", () => {
    expect(applicationMenuCommand({
      data: {
        action: ELECTROBUN_APPLICATION_MENU_ACTION,
        data: { type: "unknown-command" },
      },
    })).toBeNull();
  });

  test("ignores plugin workflow commands without a command id", () => {
    expect(applicationMenuCommand({
      data: {
        action: ELECTROBUN_APPLICATION_MENU_ACTION,
        data: { type: "open-plugin-workflow" },
      },
    })).toBeNull();
  });
});
