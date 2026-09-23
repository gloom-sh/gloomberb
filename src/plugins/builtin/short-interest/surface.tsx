import { useEffect, useState } from "react";
import { Box, useUiCapabilities } from "../../../ui";
import { PaneFooterScope, QueryBar, Tabs, usePaneHeaderTabs } from "../../../components";
import { usePluginPaneState } from "../../../public/react";
import type { PaneProps } from "../../../types/plugin";
import { ShortVolumePane } from "../short-volume/pane";
import { ShortInterestView } from "./pane";

const TABS = [{ value: "interest", label: "Interest" }, { value: "volume", label: "Daily volume" }];
export function ShortInterestSurface(props: Pick<PaneProps, "width" | "height" | "focused">) {
  const { nativePaneChrome } = useUiCapabilities();
  const [tab, setTab] = usePluginPaneState("short-interest:tab", "interest");
  const [mounted, setMounted] = useState(() => new Set([tab]));
  useEffect(() => { setMounted((current) => current.has(tab) ? current : new Set([...current, tab])); }, [tab]);
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused: props.focused });
  const tabRows = tabsInHeader ? 0 : 1;
  const height = Math.max(1, props.height - tabRows);
  return <Box width={props.width} height={props.height} flexDirection="column">
    {/* Nested in Ticker Research the title bar belongs to the research tabs, so the desktop switches views from the query bar. */}
    {!tabsInHeader && (nativePaneChrome
      ? <QueryBar width={props.width} view={{ value: tab, options: TABS, onChange: setTab }} />
      : <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} focused={props.focused} dense />)}
    {TABS.map(({ value }) => mounted.has(value) || value === tab ? <Box key={value} visible={value === tab} height={height} flexGrow={1} flexBasis={0} overflow="hidden">
      <PaneFooterScope active={value === tab}>
        {value === "volume" ? <ShortVolumePane {...props} height={height} focused={props.focused && value === tab} />
          : <ShortInterestView {...props} height={height} focused={props.focused && value === tab} />}
      </PaneFooterScope>
    </Box> : null)}
  </Box>;
}
