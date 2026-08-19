import { Box, Text, TextAttributes } from "../../../../ui";
import { Tabs } from "../../../../components";
import { colors } from "../../../../theme/colors";
import type {
  BuildoutList,
  BuildoutTabId,
} from "../model/types";
import { truncate } from "../format";
import { tabs } from "../table-model";

interface BuildoutPaneHeaderProps {
  activeTab: BuildoutTabId;
  focused: boolean;
  selectedList: BuildoutList | null;
  width: number;
  onCloseCompanyList: () => void;
  onSelectTab: (tab: BuildoutTabId) => void;
}

export function BuildoutPaneHeader({
  activeTab,
  focused,
  selectedList,
  width,
  onCloseCompanyList,
  onSelectTab,
}: BuildoutPaneHeaderProps) {
  const showCompanyListCrumb = selectedList && activeTab === "companies";
  return (
    <Box flexDirection="column" height={showCompanyListCrumb ? 2 : 1}>
      <Tabs
        tabs={tabs}
        activeValue={activeTab}
        onSelect={(value) => onSelectTab(value as BuildoutTabId)}
        compact
        variant="bare"
        focused={focused}
      />
      {showCompanyListCrumb ? (
        <Box height={1} flexDirection="row" paddingX={1}>
          <Box
            style={{ cursor: "pointer" }}
            onMouseDown={(event: any) => {
              event.preventDefault();
              onCloseCompanyList();
            }}
          >
            <Text fg={colors.borderFocused} attributes={TextAttributes.BOLD}>{"< Lists"}</Text>
          </Box>
          <Text fg={colors.textMuted}>  /  </Text>
          <Text fg={colors.text}>{truncate(selectedList.name, Math.max(0, width - 14))}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
