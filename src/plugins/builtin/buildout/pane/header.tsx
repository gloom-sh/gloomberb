import { Box } from "../../../../ui";
import { Tabs } from "../../../../components";
import type { BuildoutTabId } from "../model/types";
import { tabs } from "../table-model";

interface BuildoutPaneHeaderProps {
  activeTab: BuildoutTabId;
  focused: boolean;
  onSelectTab: (tab: BuildoutTabId) => void;
}

/** The tab strip. A list opened from Companies is a stack level, not a crumb. */
export function BuildoutPaneHeader({
  activeTab,
  focused,
  onSelectTab,
}: BuildoutPaneHeaderProps) {
  return (
    <Box height={1}>
      <Tabs
        tabs={tabs}
        activeValue={activeTab}
        onSelect={(value) => onSelectTab(value as BuildoutTabId)}
        compact
        variant="bare"
        focused={focused}
      />
    </Box>
  );
}
