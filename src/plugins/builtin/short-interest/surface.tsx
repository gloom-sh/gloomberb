import { useEffect, useState } from "react";
import { Box } from "gloomberb/ui";
import { PaneFooterScope, Tabs } from "gloomberb/components";
import { usePluginPaneState } from "gloomberb/react";
import type { PaneProps } from "../../../types/plugin";
import { ShortVolumePane } from "../short-volume/pane";
import { ShortInterestView } from "./pane";

const TABS = [{ value: "interest", label: "Interest" }, { value: "volume", label: "Daily volume" }];
export function ShortInterestSurface(props: Pick<PaneProps, "width" | "height" | "focused">) {
  const [tab, setTab] = usePluginPaneState("short-interest:tab", "interest");
  const [mounted, setMounted] = useState(() => new Set([tab]));
  useEffect(() => { setMounted((current) => current.has(tab) ? current : new Set([...current, tab])); }, [tab]);
  const height = Math.max(1, props.height - 1);
  return <Box width={props.width} height={props.height} flexDirection="column">
    <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} focused={props.focused} dense />
    {TABS.map(({ value }) => mounted.has(value) || value === tab ? <Box key={value} visible={value === tab} height={height} flexGrow={1} flexBasis={0} overflow="hidden">
      <PaneFooterScope active={value === tab}>
        {value === "volume" ? <ShortVolumePane {...props} height={height} focused={props.focused && value === tab} />
          : <ShortInterestView {...props} height={height} focused={props.focused && value === tab} />}
      </PaneFooterScope>
    </Box> : null)}
  </Box>;
}
