import { Box, Text } from "../../../../ui";
import { t } from "../../../../i18n";
import { normalizeInlinePreview } from "../layout";
import { chatReplyQuoteText } from "../attachments/model";
import { heldMessage, isQuotedAuthorManagedBot } from "../ghost-user";
import { CHAT_PERSON_ICON_WIDTH } from "../people";
import { ChatBotIcon } from "./person-icons";
import { chatMessagePaneLinks } from "../pane-links/model";
import { useSlowPendingSend } from "./pending-send";
import { getChatMessageRenderState, type ChatMessageRenderState } from "./render-state";
import type { ChatMessageBaseProps } from "./types";

const DESKTOP_INLINE_TEXT_STYLE = { flexShrink: 0, whiteSpace: "pre" } as const;

export function useChatMessageModel(
  props: Pick<
    ChatMessageBaseProps,
    | "msg"
    | "index"
    | "messages"
    | "selectedIdx"
    | "hoveredIdx"
    | "highlighted"
    | "canSend"
    | "latestEditableMessageId"
    | "userByUsername"
  >,
  options: { host: "desktop" | "terminal"; canReact: boolean },
) {
  const slowSend = useSlowPendingSend(props.msg);
  const state = getChatMessageRenderState({
    msg: props.msg,
    index: props.index,
    messages: props.messages,
    selectedIdx: props.selectedIdx,
    hoveredIdx: props.hoveredIdx,
    highlighted: props.highlighted,
    canSend: props.canSend,
    canEdit: props.msg.id === props.latestEditableMessageId,
    canReact: options.canReact,
    slowSend,
    host: options.host,
  });
  const { links: paneLinks, content } = chatMessagePaneLinks(props.msg);
  const quotedAuthorIsBot = !!props.msg.replyTo
    && isQuotedAuthorManagedBot(props.msg.replyTo, props.userByUsername, () => heldMessage(props.messages, props.msg.replyToId));
  return { state, paneLinks, content, quotedAuthorIsBot };
}

export function ChatMessageReplyQuote({
  msg,
  state,
  quotedAuthorIsBot,
  rowProps,
  jumpToMessage,
  host,
  messageBodyWidth,
  formatTerminalQuote,
}: {
  msg: ChatMessageBaseProps["msg"];
  state: ChatMessageRenderState;
  quotedAuthorIsBot: boolean;
  rowProps: Record<string, unknown>;
  jumpToMessage: (messageId: string) => void;
  host: "desktop" | "terminal";
  messageBodyWidth?: number;
  formatTerminalQuote?: (text: string, maxWidth: number) => string;
}) {
  if (!msg.replyTo) return null;
  const desktop = host === "desktop";
  const inlineStyle = desktop ? DESKTOP_INLINE_TEXT_STYLE : undefined;
  const quoteText = chatReplyQuoteText(msg.replyTo);
  return (
    <Box
      {...rowProps}
      flexDirection="row"
      height={1}
      paddingLeft={2}
      onMouseDown={() => {
        // The thread handles background clearing in capture, before this
        // jump. Keep bubbling so the pane shell also receives the focus.
        if (msg.replyToId) jumpToMessage(msg.replyToId);
      }}
      style={desktop ? { minWidth: 0, alignItems: "flex-start", cursor: "pointer", overflow: "hidden" } : undefined}
    >
      <Text fg={state.replyMetaColor} style={inlineStyle}>{`${t("reply")} `}</Text>
      {quotedAuthorIsBot ? (
        // The bot's icon stands where the colon would.
        <>
          <Text fg={state.replyAuthorColor} style={inlineStyle}>{msg.replyTo.user.username}</Text>
          <ChatBotIcon selectedColor={state.isSelected ? state.selectedTextColor : undefined} />
          <Text fg={state.replyAuthorColor} style={inlineStyle}>{" "}</Text>
        </>
      ) : (
        <Text fg={state.replyAuthorColor} style={inlineStyle}>{`${msg.replyTo.user.username}: `}</Text>
      )}
      {desktop ? (
        <Text
          fg={state.replyMetaColor}
          data-gloom-role="chat-message-reply-quote"
          style={{
            flex: "1 1 0",
            minWidth: 0,
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {normalizeInlinePreview(quoteText)}
        </Text>
      ) : (
        <Text fg={state.replyMetaColor}>
          {(formatTerminalQuote ?? normalizeInlinePreview)(
            quoteText,
            Math.max((messageBodyWidth ?? 0) - `reply ${msg.replyTo.user.username}`.length - (quotedAuthorIsBot ? CHAT_PERSON_ICON_WIDTH + 1 : 2), 0),
          )}
        </Text>
      )}
    </Box>
  );
}
