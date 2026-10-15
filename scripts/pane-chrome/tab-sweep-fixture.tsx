import { useState } from "react";
import { Tabs } from "../../src/components/ui/tabs";
import { SegmentedControl } from "../../src/components/ui/toggle";
import { Box, Text } from "../../src/ui";

/**
 * What the layout sweep's tab visits are checked against (`scenario=tab-sweep`,
 * tab-visits.ts): 25 tabs in a strip too narrow to show them, a disabled one at
 * its end and one that ignores a press, a segmented choice whose first label
 * repeats a tab's, a choice that only shows under Tab 05, and one more under
 * that. The line under them says what is showing.
 */

export const TAB_SWEEP_TABS = Array.from({ length: 25 }, (_, index) => `Tab ${String(index + 1).padStart(2, "0")}`);
/** Pressing it changes nothing: the sweep must say the switch did not happen. */
export const TAB_SWEEP_STUCK = "Tab 13";
/** Shows the inner choice. */
export const TAB_SWEEP_REVEALS = "Tab 05";

export function TabSweepFixture() {
  const [tab, setTab] = useState("Tab 01");
  const [other, setOther] = useState("other");
  const [inner, setInner] = useState("inner-1");
  const [deep, setDeep] = useState("deep-1");
  return (
    <Box flexDirection="column" width="100%" height="100%" data-gloom-pane-id="tab-sweep" style={{ padding: 24, gap: 12 }}>
      <Box style={{ width: 240, height: "var(--chrome-h)" }}>
        <Tabs
          tabs={[...TAB_SWEEP_TABS.map((label) => ({ label, value: label })), { label: "Locked", value: "locked", disabled: true }]}
          activeValue={tab}
          onSelect={(value) => { if (value !== TAB_SWEEP_STUCK) setTab(value); }}
          focused
        />
      </Box>
      <SegmentedControl options={[{ label: "Tab 01", value: "first" }, { label: "Other", value: "other" }]} value={other} onChange={setOther} focused />
      {tab === TAB_SWEEP_REVEALS ? (
        <SegmentedControl options={[{ label: "Inner 1", value: "inner-1" }, { label: "Inner 2", value: "inner-2" }]} value={inner} onChange={setInner} focused />
      ) : null}
      {tab === TAB_SWEEP_REVEALS && inner === "inner-2" ? (
        <SegmentedControl options={[{ label: "Deep 1", value: "deep-1" }, { label: "Deep 2", value: "deep-2" }]} value={deep} onChange={setDeep} focused />
      ) : null}
      <Box data-sweep-shows=""><Text>{`tab=${tab} other=${other} inner=${tab === TAB_SWEEP_REVEALS ? inner : "-"}`}</Text></Box>
    </Box>
  );
}
