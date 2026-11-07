import { expect, test } from "bun:test";
import { treasuryAuctionsSettings } from "../../plugins/builtin/treasury-auctions/index";
import type { PaneSettingField } from "../../types/plugin";
import { paneSettingValue, stepPaneSettingSelect, summarizePaneSettingValue } from "./value";

test("an unset select reads as its default option, in the summary and where the picker starts", () => {
  const history = treasuryAuctionsSettings().fields[0] as Extract<PaneSettingField, { type: "select" }>;
  // The pane's window was "Unset" with the picker on 30 days while it read 120.
  expect(paneSettingValue(history, {})).toBe("120");
  expect(summarizePaneSettingValue(history, paneSettingValue(history, {}))).toBe("120 days (default)");
  expect(stepPaneSettingSelect(history, paneSettingValue(history, {}), 1)).toBe("365");
  // A chosen value is the value; a select without a default and the other kinds stay as stored.
  expect(paneSettingValue(history, { historyDays: "3650" })).toBe("3650");
  const plain = { key: "region", label: "Region", type: "select" as const, options: [{ value: "us", label: "US" }] };
  expect(paneSettingValue(plain, {})).toBeUndefined();
  expect(paneSettingValue({ key: "lock", label: "Lock", type: "toggle" }, {})).toBeUndefined();
});
