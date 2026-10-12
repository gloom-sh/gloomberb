import { Box, Text, TextAttributes } from "../../../../ui";
import { Badge, Button, IconButton } from "../../../../components";
import { useThemeColors } from "../../../../theme/theme-context";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import { attachedPaneLabel, type ASKGAttachedPane } from "./pane-attachment";

/** The keys a pending attach answers, as a tool approval's do. */
export const ATTACH_PANE_KEY = "y";
export const LEAVE_OUT_PANE_KEY = "n";

/** Rows the block takes above the composer: the chip, or the question about a pane's contents. */
export function attachedPaneBlockHeight(attached: ASKGAttachedPane | null): number {
  if (!attached) return 0;
  return attached.consent === "pending" ? 4 : 1;
}

/**
 * The pane a conversation is about, above the composer: a chip with its
 * function, and an x that takes it off. A pane that declares personal data
 * asks first whether what it shows may go with the question.
 */
export function AttachedPaneBlock({
  attached,
  width,
  onAttach,
  onLeaveOut,
  onRemove,
}: {
  attached: ASKGAttachedPane;
  width: number;
  onAttach: () => void;
  onLeaveOut: () => void;
  onRemove: () => void;
}) {
  const colors = useThemeColors();
  const textWidth = Math.max(10, width - 2);
  const label = truncateWithEllipsis(attachedPaneLabel(attached.pane), Math.max(8, Math.min(48, width - 12)));

  if (attached.consent === "pending") {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} height={attachedPaneBlockHeight(attached)} backgroundColor={colors.panel}>
        <Box flexDirection="row" height={1}>
          <Text fg={colors.warning} attributes={TextAttributes.BOLD}>
            {truncateWithEllipsis(`Attach what ${label} shows?`, textWidth)}
          </Text>
        </Box>
        <Box height={1}>
          <Text fg={colors.textDim}>
            {truncateWithEllipsis("It shows your own data. Only what is on screen goes, as text.", textWidth)}
          </Text>
        </Box>
        <Box flexDirection="row" height={2} paddingTop={1}>
          <Button label="Attach" variant="primary" shortcut={ATTACH_PANE_KEY} onPress={onAttach} />
          <Box width={2} />
          <Button label="Leave out" shortcut={LEAVE_OUT_PANE_KEY} onPress={onLeaveOut} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" flexShrink={0} height={1} paddingX={1} alignItems="center" data-gloom-role="askg-attached-pane">
      <Badge label={label} tone="accent" />
      {attached.consent === "declined" ? <Text fg={colors.textMuted}>{"  without what it shows"}</Text> : null}
      <Box width={1} />
      <IconButton icon="close" label="Remove the pane" onPress={onRemove} />
    </Box>
  );
}
