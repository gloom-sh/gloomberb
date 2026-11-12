import type { Ref } from "react";
import { Button, FieldLabel } from "../../../components";
import { terminalButtonColumns } from "../../../components/ui/button";
import type { ReferralInvite } from "../../../api-client";
import { t, tf } from "../../../i18n";
import { colors } from "../../../theme/colors";
import { Box, Text, type BoxRenderable } from "../../../ui";
import { displayWidth } from "../../../utils/format";

/** The link as people read it, without the scheme; Copy gives the whole URL. */
function inviteLinkText(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * The Pro tab's Invite row: the account's invite link, selectable, a Copy
 * button beside it (under it when the pane is too narrow for both), and the
 * free months the link has earned so far.
 */
export function InviteRow({
  invite,
  active,
  width,
  labelWidth,
  nodeRef,
  onCopy,
  onFocus,
}: {
  invite: ReferralInvite;
  active: boolean;
  width: number;
  labelWidth: number;
  nodeRef: Ref<BoxRenderable>;
  onCopy: () => void;
  onFocus: () => void;
}) {
  const link = inviteLinkText(invite.url);
  const copyLabel = t("Copy");
  const besideLink = displayWidth(link) + 1 + terminalButtonColumns({ label: copyLabel }) <= width - labelWidth - 1;
  return (
    <Box ref={nodeRef} flexDirection="row" gap={1} onMouseDown={onFocus}>
      <FieldLabel label={t("Invite")} active={active} width={labelWidth} />
      <Box flexDirection="column" flexShrink={1}>
        <Box flexDirection={besideLink ? "row" : "column"} gap={besideLink ? 1 : 0} alignItems={besideLink ? "center" : "flex-start"}>
          <Text selectable fg={colors.text}>{link}</Text>
          <Button label={copyLabel} active={active} onPress={onCopy} />
        </Box>
        <Text fg={colors.textDim}>
          {tf("Free months earned: {earned} of {cap}", { earned: invite.earned, cap: invite.cap })}
        </Text>
      </Box>
    </Box>
  );
}
