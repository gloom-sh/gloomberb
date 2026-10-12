import { useEffect, useState } from "react";
import { PaneFooterScope, usePaneTabs } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { useCommandTab } from "../shared/command-tab";
import { CdxPane } from "./cdx-pane";
import { CDX_PANE_ID } from "./model";
import { SovrPane } from "./sovr-pane";

const TABS = [{ value: "index", label: "Index" }, { value: "sovereign", label: "Sovereign" }];

export function CreditBoardsPane(props: PaneProps) {
  const [tab, setTab] = useCommandTab(CDX_PANE_ID, "credit-boards:tab", ["index", "sovereign"], "index");
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([tab]));
  useEffect(() => { setMounted((current) => current.has(tab) ? current : new Set([...current, tab])); }, [tab]);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: TABS, activeValue: tab, onSelect: (value) => setTab(value === "sovereign" ? "sovereign" : "index"), focused: props.focused, dense: true,
  });
  const height = Math.max(1, props.height - tabRows);
  return <Box width={props.width} height={props.height} flexDirection="column">
    {tabStrip}
    {TABS.map(({ value }) => mounted.has(value) || value === tab ? <Box key={value} visible={value === tab} height={height} flexGrow={1} flexBasis={0} overflow="hidden">
      <PaneFooterScope active={value === tab}>
        {value === "sovereign"
          ? <SovrPane {...props} height={height} focused={props.focused && value === tab} />
          : <CdxPane {...props} height={height} focused={props.focused && value === tab} />}
      </PaneFooterScope>
    </Box> : null)}
  </Box>;
}
