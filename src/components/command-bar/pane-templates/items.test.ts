import { expect, test } from "bun:test";
import type { PaneTemplateDef } from "../../../types/plugin";
import { recentPaneTemplateArg } from "./items";

const template = (shortcut: PaneTemplateDef["shortcut"]) => ({ id: "t", paneId: "p", label: "T", shortcut }) as PaneTemplateDef;

// Recent pane runs are saved to config.json, exported with it and synced, so
// only ticker arguments may be kept.
test("a recent pane run keeps a ticker argument and drops free text", () => {
  expect(recentPaneTemplateArg(template({ prefix: "GP", argPlaceholder: "ticker" }), " nvda ")).toBe("NVDA");
  expect(recentPaneTemplateArg(template({ prefix: "COMP", argKind: "ticker-list" }), "aapl msft")).toBe("AAPL MSFT");
  expect(recentPaneTemplateArg(template({ prefix: "ASKG", argKind: "text" }), "how exposed am I to rates")).toBeUndefined();
  expect(recentPaneTemplateArg(template({ prefix: "EXPO", argKind: "text" }), "AAPL=60% NVDA=40%")).toBeUndefined();
  expect(recentPaneTemplateArg(template({ prefix: "PORT", argKind: "text", argPlaceholder: "portfolio-id" }), "main")).toBeUndefined();
  expect(recentPaneTemplateArg(template(undefined), "anything")).toBeUndefined();
});
