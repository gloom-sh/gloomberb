import { Box, Text } from "../../../../ui";
import { Button, IconButton } from "../../../../components/ui";
import { colors } from "../../../../theme/colors";
import { t, tf } from "../../../../i18n";
import { displayWidth, truncateToDisplayWidth } from "../../../../utils/format";
import type { ChatDraftAttachment } from "../controller/attachments";
import { formatChatImageSize } from "./model";

/** The terminal's composer rows for waiting images: `image.png 1.2 MB ready  x`. */
function terminalAttachmentStatus(attachment: ChatDraftAttachment): string {
  if (attachment.status === "failed") return attachment.error ?? t("upload failed");
  if (attachment.status === "uploading") {
    // Every byte out is not done: the server still has to take the image in.
    return attachment.progress === null || attachment.progress >= 1
      ? t("uploading")
      : tf("uploading {percent}%", { percent: Math.round(attachment.progress * 100) });
  }
  return t("ready");
}

const REMOVE_WIDTH = 3;
const RETRY_WIDTH = 8;

export function TerminalChatAttachmentRows({
  attachments,
  width,
  onRemove,
  onRetry,
}: {
  attachments: ChatDraftAttachment[];
  width: number;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  return (
    <>
      {attachments.map((attachment) => {
        const failed = attachment.status === "failed";
        const size = formatChatImageSize(attachment.uploaded?.size ?? attachment.size);
        const status = terminalAttachmentStatus(attachment);
        const actionsWidth = REMOVE_WIDTH + (failed ? RETRY_WIDTH + 1 : 0);
        const textWidth = Math.max(1, width - actionsWidth - 1);
        const head = ` ${attachment.name} ${size} `;
        const label = displayWidth(head) + displayWidth(status) <= textWidth
          ? `${head}${status}`
          : truncateToDisplayWidth(`${head}${status}`, textWidth);
        return (
          <Box key={attachment.localId} width={width} height={1} flexDirection="row">
            <Box width={textWidth} height={1}>
              <Text fg={failed ? colors.negative : colors.textDim}>{label}</Text>
            </Box>
            <Box flexGrow={1} />
            {failed && (
              <Button
                label={t("Retry")}
                width={RETRY_WIDTH}
                stopPropagation
                onPress={() => onRetry(attachment.localId)}
              />
            )}
            {failed && <Box width={1} />}
            <IconButton
              icon="close"
              label={tf("Remove {name}", { name: attachment.name })}
              onPress={() => onRemove(attachment.localId)}
            />
          </Box>
        );
      })}
    </>
  );
}
