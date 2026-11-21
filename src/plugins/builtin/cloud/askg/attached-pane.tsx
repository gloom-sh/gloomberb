import { Box, Text, TextAttributes, useUiCapabilities } from "../../../../ui";
import { ClippedText } from "../../../../components/ui/display";
import { Badge, Button, IconButton } from "../../../../components";
import { RemoteUiScope } from "../../../../remote/semantic-tree";
import { useThemeColors } from "../../../../theme/theme-context";
import { ASKG_PROMPT_SCOPE } from "../terminal-relay/policy";
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

/** The question's end, which a long pane label never pushes out of view. */
const PROMPT_END = " shows?";

/**
 * The pane a conversation is about, above the composer: a chip with its
 * function, and an x that takes it off. A pane that shows personal data
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
  const { nativePaneChrome } = useUiCapabilities();
  const textWidth = Math.max(10, width - 2);
  // The chip runs at most 48 cells: the terminal cuts the label to them, the desktop and the web in CSS.
  const labelWidth = Math.max(8, Math.min(48, width - 12));
  const fullLabel = attachedPaneLabel(attached.pane);
  const label = nativePaneChrome ? fullLabel : truncateWithEllipsis(fullLabel, labelWidth);

  if (attached.consent === "pending") {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} height={attachedPaneBlockHeight(attached)} backgroundColor={colors.panel}>
        <Box flexDirection="row" height={1}>
          {/* The desktop keeps the question's end whole and lets the label give way; the terminal cut its label above. */}
          <ClippedText fg={colors.warning} attributes={TextAttributes.BOLD} text={`Attach what ${label}${PROMPT_END}`} width={textWidth} cut={truncateWithEllipsis} keepEnd={nativePaneChrome ? PROMPT_END : null} />
        </Box>
        <Box height={1}>
          <ClippedText fg={colors.textDim} text="It shows your own data. Only what is on screen goes, as text." width={textWidth} cut={truncateWithEllipsis} />
        </Box>
        {/* The person's answer: no assistant's UI call reaches it (terminal-relay/policy.ts). */}
        <RemoteUiScope scope={ASKG_PROMPT_SCOPE}>
          <Box flexDirection="row" height={2} paddingTop={1}>
            <Button label="Attach" variant="primary" shortcut={ATTACH_PANE_KEY} onPress={onAttach} />
            <Box width={2} />
            <Button label="Leave out" shortcut={LEAVE_OUT_PANE_KEY} onPress={onLeaveOut} />
          </Box>
        </RemoteUiScope>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" flexShrink={0} height={1} paddingX={1} alignItems="center" data-gloom-role="askg-attached-pane">
      <Badge label={label} tone="accent" maxWidth={labelWidth + 2} />
      {attached.consent === "declined" ? <Text fg={colors.textMuted}>{"  without what it shows"}</Text> : null}
      <Box width={1} />
      <IconButton icon="close" label="Remove the pane" onPress={onRemove} />
    </Box>
  );
}
