import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { apiClient, type ChatAccountType } from "../../../../api-client";
import { usePaneFooter } from "../../../../components";
import { Button, Notice, TextField } from "../../../../components/ui";
import { terminalButtonColumns } from "../../../../components/ui/button";
import { t, tf } from "../../../../i18n";
import { useShortcut } from "../../../../react/input";
import { blendHex, colors } from "../../../../theme/colors";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../../ui";
import { countEscapeTowardClose } from "../../../../utils/double-escape-close";
import { displayWidth } from "../../../../utils/format";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import {
  chatHandlePromptStore,
  describeHandleSaveError,
  handleProfileUpdate,
  isPlaceholderUsername,
  normalizeHandleInput,
} from "../handle-prompt";

type ChatHandleSaveResult = "saved" | "failed" | "stale";

interface PromptDraft {
  userId: string | null;
  value: string;
  error: string | null;
  saving: boolean;
}

const EMPTY_DRAFT: Omit<PromptDraft, "userId"> = { value: "", error: null, saving: false };

/** The draft of the account signed in now: a fresh one when it is not the account it was typed for. */
function draftFor(draft: PromptDraft, userId: string | null): PromptDraft {
  return draft.userId === userId ? draft : { userId, ...EMPTY_DRAFT };
}

/**
 * The first-chat handle prompt for an account still on its signup
 * placeholder. It never blocks the channel: it sits above the composer until
 * the person saves a handle or says "Not now", which this device remembers
 * for that account. Everything it holds belongs to the account it was typed
 * for, and a save that finishes after another account signed in is dropped.
 */
export function useChatHandlePrompt({
  user,
  accountType,
  refreshSession,
  onSaved,
}: {
  user: { id: string; username: string; emailVerified: boolean } | null;
  /** How chat knows the signed-in account, when it has seen it: a bot is never asked. */
  accountType?: ChatAccountType;
  refreshSession: () => Promise<void>;
  onSaved?: (username: string) => void;
}) {
  const store = useSyncExternalStore(
    (onChange) => chatHandlePromptStore.subscribe(onChange),
    () => chatHandlePromptStore.getSnapshot(),
  );
  const userId = user?.id ?? null;
  const [draft, setDraftState] = useState<PromptDraft>({ userId, ...EMPTY_DRAFT });
  // Read by Enter and Save, which can come before the render that shows the last key.
  const draftRef = useRef(draft);
  const setDraft = useCallback((update: PromptDraft | ((previous: PromptDraft) => PromptDraft)) => {
    const next = typeof update === "function" ? update(draftRef.current) : update;
    draftRef.current = next;
    setDraftState(next);
  }, []);
  // Another account starts from nothing, whatever the last one typed or awaited.
  const current = draftFor(draft, userId);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current += 1;
  }, [userId]);

  const visible = !!user
    && user.emailVerified
    && accountType !== "managed_llm"
    && accountType !== "discord"
    && isPlaceholderUsername(user.username)
    && !store.dismissed.has(user.id)
    && !store.saved.has(user.id);

  const setValue = useCallback((value: string) => {
    setDraft((previous) => {
      const base = draftFor(previous, userIdRef.current);
      return base.saving ? base : { ...base, value, error: null };
    });
  }, [setDraft]);

  const save = useCallback(async (): Promise<ChatHandleSaveResult> => {
    const startedFor = userIdRef.current;
    const { value: typed, saving } = draftFor(draftRef.current, startedFor);
    const handle = normalizeHandleInput(typed);
    if (!startedFor || saving || !handle) return "stale";
    const request = ++requestRef.current;
    // Still the account that asked: this pane, this request and the API client.
    const isCurrent = () => (
      requestRef.current === request
      && userIdRef.current === startedFor
      && apiClient.getCurrentUser()?.id === startedFor
    );
    // Only ever the asking account's draft; one signed in since keeps its own.
    const settle = (next: Omit<PromptDraft, "userId">) => {
      setDraft((previous) => (previous.userId === startedFor ? { userId: startedFor, ...next } : previous));
    };
    setDraft({ userId: startedFor, value: typed, error: null, saving: true });
    try {
      // The profile update Account Management saves through, read first for the name signup gave.
      const profile = await apiClient.getAccountProfile();
      if (!isCurrent() || profile.id !== startedFor) {
        settle({ value: typed, error: null, saving: false });
        return "stale";
      }
      const saved = await apiClient.updateAccountProfile(handleProfileUpdate(profile, handle));
      // Saved on the server either way: that account is not asked again.
      if (saved.id === startedFor) chatHandlePromptStore.markSaved(startedFor);
      settle(EMPTY_DRAFT);
      if (!isCurrent()) return "stale";
      void refreshSession().catch(() => {});
      onSaved?.(saved.username ?? handle);
      return "saved";
    } catch (error) {
      if (!isCurrent()) {
        settle({ value: typed, error: null, saving: false });
        return "stale";
      }
      settle({ value: typed, error: describeHandleSaveError(error, handle), saving: false });
      return "failed";
    }
  }, [onSaved, refreshSession, setDraft]);

  const dismiss = useCallback(() => {
    const id = userIdRef.current;
    if (!id) return;
    requestRef.current += 1;
    chatHandlePromptStore.dismiss(id);
    setDraft({ userId: id, ...EMPTY_DRAFT });
  }, [setDraft]);

  return {
    visible,
    value: current.value,
    error: current.error,
    saving: current.saving,
    canSave: !current.saving && normalizeHandleInput(current.value).length > 0,
    setValue,
    save,
    dismiss,
  };
}

type ChatHandlePromptModel = ReturnType<typeof useChatHandlePrompt>;

const FIELD_MIN_WIDTH = 10;
const FIELD_MAX_WIDTH = 24;
const SAVE_LABEL = "Save";
const DISMISS_LABEL = "Not now";

function terminalLayout(contentWidth: number) {
  const lead = ` ${t("Choose a handle")}  `;
  const buttons = terminalButtonColumns({ label: SAVE_LABEL }) + 1 + terminalButtonColumns({ label: DISMISS_LABEL });
  // "@", the field and a cell before the buttons.
  const controlsWithout = (fieldWidth: number) => 1 + 1 + fieldWidth + 1 + buttons;
  const oneRow = displayWidth(lead) + controlsWithout(FIELD_MIN_WIDTH) <= contentWidth;
  const room = contentWidth - (oneRow ? displayWidth(lead) : 0) - controlsWithout(0);
  return { lead, oneRow, fieldWidth: Math.max(4, Math.min(FIELD_MAX_WIDTH, room)) };
}

/** Terminal rows the prompt takes: its controls, the title when they do not share a row, and an error. */
export function chatHandlePromptRows(prompt: Pick<ChatHandlePromptModel, "visible" | "error">, contentWidth: number): number {
  if (!prompt.visible) return 0;
  return (terminalLayout(contentWidth).oneRow ? 1 : 2) + (prompt.error ? 1 : 0);
}

/**
 * Above the composer: a title, the handle field and Save / Not now. Enter in
 * the field saves, Esc leaves it. The pane's `@` key and its menu reach both
 * from the keyboard.
 */
export function ChatHandlePrompt({
  prompt,
  contentWidth,
  nativePaneChrome,
  focused,
  fieldFocused,
  inputRef,
  onFocusField,
  onLeaveField,
  onBlurField,
  onSave,
  onDismiss,
}: {
  prompt: ChatHandlePromptModel;
  contentWidth: number;
  nativePaneChrome: boolean | undefined;
  /** The chat pane has the keyboard. */
  focused: boolean;
  fieldFocused: boolean;
  inputRef: RefObject<InputRenderable | null>;
  onFocusField: () => void;
  onLeaveField: () => void;
  /** The field lost focus without the chat moving it. */
  onBlurField: () => void;
  onSave: () => void;
  onDismiss: () => void;
}) {
  usePaneFooter("chat-handle-prompt", () => (prompt.visible ? {
    info: prompt.saving ? [{ id: "handle-saving", parts: [{ text: t("saving"), tone: "muted" }] }] : [],
    hints: [{ id: "handle", key: "@", label: " handle", title: t("Choose Handle"), onPress: onFocusField }],
    menu: [{ id: "handle-not-now", label: t("Hide Handle Prompt"), onSelect: onDismiss }],
  } : null), [onDismiss, onFocusField, prompt.saving, prompt.visible]);

  useShortcut((event) => {
    if (event.name !== "escape") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    // Leaving an empty field is half of a double Esc; leaving a typed handle is not.
    if (normalizeHandleInput(prompt.value).length === 0) countEscapeTowardClose(event);
    onLeaveField();
  }, { enabled: prompt.visible && focused && fieldFocused, allowEditable: true, phase: "before" });

  if (!prompt.visible) return null;

  const field = (width: number | undefined) => (
    <TextField
      inputRef={inputRef}
      value={prompt.value}
      placeholder={t("handle")}
      focused={focused && fieldFocused}
      width={width}
      backgroundColor={colors.panel}
      onMouseDown={onFocusField}
      onChange={prompt.setValue}
      onSubmit={onSave}
      onBlur={onBlurField}
    />
  );
  const saveButton = (
    <Button
      label={SAVE_LABEL}
      variant="primary"
      disabled={!prompt.canSave}
      stopPropagation
      onPress={onSave}
    />
  );
  const dismissButton = (
    <Button
      label={DISMISS_LABEL}
      // A quiet way out beside Save on the desktop; the terminal needs its edges.
      variant={nativePaneChrome ? "plain" : "secondary"}
      disabled={prompt.saving}
      stopPropagation
      onPress={onDismiss}
    />
  );

  if (nativePaneChrome) {
    // A band on the composer's own fill, so the two read as one block under the messages.
    return (
      <Box
        flexDirection="column"
        data-gloom-role="chat-handle-prompt"
        backgroundColor={blendHex(colors.panel, colors.bg, 0.22)}
        style={{ flex: "none", padding: "8px 12px", gap: 6, borderTop: `1px solid ${colors.border}` }}
      >
        <Box flexDirection="row" alignItems="center" flexWrap="wrap" style={{ columnGap: 12, rowGap: 6 }}>
          <Text fg={colors.textBright} style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
            {t("Choose a handle")}
          </Text>
          <Box flexDirection="row" alignItems="center" style={{ gap: 8, flex: "1 1 auto", minWidth: 0 }}>
            <Box flexDirection="row" alignItems="center" style={{ gap: 4, flex: "0 1 calc(24 * var(--cell-w))", minWidth: "calc(10 * var(--cell-w))" }}>
              <Text fg={colors.textDim}>@</Text>
              <Box style={{ flex: "1 1 auto", minWidth: 0 }}>{field(undefined)}</Box>
            </Box>
            {saveButton}
            {dismissButton}
          </Box>
        </Box>
        {prompt.error ? <Notice tone="negative">{prompt.error}</Notice> : null}
      </Box>
    );
  }

  const layout = terminalLayout(contentWidth);
  const controls = (
    <Box height={1} flexDirection="row">
      {layout.oneRow ? (
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{layout.lead}</Text>
      ) : (
        <Text> </Text>
      )}
      <Text fg={colors.textDim}>@</Text>
      {field(layout.fieldWidth)}
      <Text> </Text>
      {saveButton}
      <Text> </Text>
      {dismissButton}
    </Box>
  );
  return (
    <Box flexDirection="column" width={contentWidth}>
      {!layout.oneRow && (
        <Box height={1}>
          <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
            {truncateWithEllipsis(layout.lead.trimEnd(), contentWidth)}
          </Text>
        </Box>
      )}
      {controls}
      {prompt.error ? (
        <Box height={1}>
          <Notice tone="negative">{truncateWithEllipsis(` ${prompt.error}`, contentWidth)}</Notice>
        </Box>
      ) : null}
    </Box>
  );
}

/** The toast once a handle is saved. */
export function handleSavedMessage(username: string): string {
  return tf("You're @{handle} now.", { handle: username });
}
