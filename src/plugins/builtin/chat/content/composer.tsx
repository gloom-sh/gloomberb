import { Box, Text, TextAttributes, type TextareaRenderable } from "../../../../ui";
import { getMessageComposerBlockHeight, MessageComposer } from "../../../../components/ui";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { truncateToDisplayWidth } from "../../../../utils/format";
import type { ChatMessage } from "../../../../api-client";
import { InlineAuthActions } from "../../cloud/auth-actions";
import { ChatActionChip } from "../message/action-chip";
import { COMPOSER_ACTION_WIDTH } from "../layout";
import type { ChatMentionSuggestion } from "./mentions";

const DESKTOP_CHAT_INPUT_TOP_MARGIN_PX = 6;

interface MutableRef<T> {
  current: T;
}

interface ChatComposerAreaProps {
  canSend: boolean;
  cancelEditMessage: () => void;
  clearReplyTarget: () => void;
  commitLocalDraft: (draft: string) => void;
  composerHeight: number;
  composerWidth: number;
  contentWidth: number;
  focused: boolean;
  focusComposer: () => void;
  hasSavedSession: boolean;
  inputFocused: boolean;
  inputPlaceholder: string;
  inputRef: MutableRef<TextareaRenderable | null>;
  inputValueRef: MutableRef<string>;
  nativePaneChrome: boolean | undefined;
  editingMessage: ChatMessage | null;
  editingPreview: string;
  replyPreview: string;
  replyTo: ChatMessage | null;
  sendMessage: () => void;
  mentionSuggestions: ChatMentionSuggestion[];
  mentionSelectedIndex: number;
  onMentionCursorChange: () => void;
  onMentionSelect: (index?: number) => boolean;
  user: { id: string; username: string; emailVerified: boolean } | null;
}

function ChatMentionSuggestions({
  contentWidth,
  nativePaneChrome,
  onSelect,
  selectedIndex,
  suggestions,
}: {
  contentWidth: number;
  nativePaneChrome: boolean | undefined;
  onSelect: (index?: number) => boolean;
  selectedIndex: number;
  suggestions: ChatMentionSuggestion[];
}) {
  if (suggestions.length === 0) return null;
  const width = Math.max(18, Math.min(contentWidth, 44));
  const menuStyle = nativePaneChrome
    ? {
      marginBottom: 4,
      border: `1px solid ${colors.border}`,
      borderRadius: 6,
      overflow: "hidden",
    }
    : undefined;

  return (
    <Box
      width={width}
      height={suggestions.length}
      flexDirection="column"
      backgroundColor={nativePaneChrome ? colors.panel : colors.bg}
      style={menuStyle}
    >
      {suggestions.map((suggestion, index) => {
        const selected = index === selectedIndex;
        return (
          <Box
            key={suggestion.username}
            height={1}
            width={width}
            flexDirection="row"
            backgroundColor={selected ? colors.selected : "transparent"}
            onMouseDown={() => { onSelect(index); }}
            style={{
              cursor: "pointer",
              paddingInline: nativePaneChrome ? 8 : undefined,
            }}
          >
            <Text
              fg={selected ? colors.selectedText : colors.positive}
              attributes={selected ? TextAttributes.BOLD : 0}
            >
              {`@${suggestion.username}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function ChatComposerArea({
  canSend,
  cancelEditMessage,
  clearReplyTarget,
  commitLocalDraft,
  composerHeight,
  composerWidth,
  contentWidth,
  focused,
  focusComposer,
  hasSavedSession,
  inputFocused,
  inputPlaceholder,
  inputRef,
  inputValueRef,
  nativePaneChrome,
  editingMessage,
  editingPreview,
  replyPreview,
  replyTo,
  sendMessage,
  mentionSuggestions,
  mentionSelectedIndex,
  onMentionCursorChange,
  onMentionSelect,
  user,
}: ChatComposerAreaProps) {
  if (!canSend) {
    const fitLine = (value: string) => truncateToDisplayWidth(t(value), contentWidth);
    return (
      <Box width={contentWidth} height={2} flexDirection="column">
        {!user && !hasSavedSession ? (
          <>
            <Text fg={colors.textDim}>{fitLine("Read-only chat. Log in or sign up to send.")}</Text>
            <InlineAuthActions />
          </>
        ) : !user ? (
          <>
            <Text fg={colors.positive}>{fitLine("Saved login found. Log in again to send.")}</Text>
            <InlineAuthActions showSignup={false} />
          </>
        ) : (
          <>
            <Text fg={colors.positive}>{fitLine("Verify your email to send messages.")}</Text>
            <Text fg={colors.textDim}>{fitLine("Ctrl+P, then Resend Verification Email")}</Text>
          </>
        )}
      </Box>
    );
  }

  return (
    <>
      {nativePaneChrome && (
        <Box
          width={composerWidth}
          style={{
            flex: `0 0 ${DESKTOP_CHAT_INPUT_TOP_MARGIN_PX}px`,
            height: DESKTOP_CHAT_INPUT_TOP_MARGIN_PX,
            minHeight: DESKTOP_CHAT_INPUT_TOP_MARGIN_PX,
          }}
        />
      )}

      {editingMessage && (
        <Box height={1} width={contentWidth} flexDirection="row">
          <Text fg={colors.textMuted}>{` ${t("editing")} `}</Text>
          <Text fg={colors.textDim}>{editingPreview ? `: ${editingPreview}` : ""}</Text>
          <Box flexGrow={1} />
          <ChatActionChip
            label={t("Cancel")}
            width={COMPOSER_ACTION_WIDTH}
            onPress={cancelEditMessage}
          />
        </Box>
      )}

      {!editingMessage && replyTo && (
        <Box height={1} width={contentWidth} flexDirection="row">
          <Text fg={colors.textMuted}>{` ${t("replying to")} `}</Text>
          <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{`@${replyTo.user.username}`}</Text>
          <Text fg={colors.textDim}>{replyPreview ? `: ${replyPreview}` : ""}</Text>
          <Box flexGrow={1} />
          <ChatActionChip
            label={t("Cancel")}
            width={COMPOSER_ACTION_WIDTH}
            onPress={clearReplyTarget}
          />
        </Box>
      )}

      <ChatMentionSuggestions
        contentWidth={contentWidth}
        nativePaneChrome={nativePaneChrome}
        onSelect={onMentionSelect}
        selectedIndex={mentionSelectedIndex}
        suggestions={mentionSuggestions}
      />

      <MessageComposer
        inputRef={inputRef}
        initialValue={inputValueRef.current}
        focused={inputFocused && focused}
        placeholder={inputPlaceholder}
        terminalPrefix=" > "
        width={composerWidth}
        height={composerHeight}
        onFocusRequest={focusComposer}
        onInput={commitLocalDraft}
        onCursorChange={onMentionCursorChange}
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "linefeed", action: "submit" },
          { name: "return", shift: true, action: "newline" },
          { name: "linefeed", shift: true, action: "newline" },
          { name: "return", meta: true, action: "submit" },
          { name: "linefeed", meta: true, action: "submit" },
        ]}
        onSubmit={() => {
          if (onMentionSelect()) return;
          if (inputValueRef.current.trim()) {
            sendMessage();
          }
        }}
        wrapText
      />
    </>
  );
}

export function getChatComposerAreaHeight({
  canSend,
  composerHeight,
  editingMessage,
  nativePaneChrome,
  replyTo,
  mentionSuggestionCount,
}: {
  canSend: boolean;
  composerHeight: number;
  editingMessage: ChatMessage | null;
  nativePaneChrome: boolean | undefined;
  replyTo: ChatMessage | null;
  mentionSuggestionCount?: number;
}) {
  if (!canSend) return 2;
  return getMessageComposerBlockHeight({ height: composerHeight, nativePaneChrome })
    + (editingMessage || replyTo ? 1 : 0)
    + Math.max(0, mentionSuggestionCount ?? 0);
}
