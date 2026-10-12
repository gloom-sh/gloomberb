import { describe, expect, test } from "bun:test";
import { personalDataContext } from "../shares/test-fixture";
import { buildAskGloomPaneAttachment } from "./pane-context";

const registry = { panes: new Map(), paneTemplates: new Map(), brokers: new Map(), getPanePluginId: () => undefined, getBrokerPluginId: () => undefined };

function attach(def: Parameters<typeof buildAskGloomPaneAttachment>[0]["def"]) {
  return buildAskGloomPaneAttachment({ registry, def, context: personalDataContext("notes"), title: "Notes", visibleText: "a line" });
}

describe("what Ask Gloom is told about a pane", () => {
  test("it is personal when its pane declares personal data, and when its rule cannot be read", () => {
    expect(attach({ personalData: "messages" }).personal).toBe(true);
    expect(attach({ personalData: () => null }).personal).toBe(false);
    expect(attach({ personalData: () => { throw new Error("no channel list yet"); } }).personal).toBe(true);
  });
});
