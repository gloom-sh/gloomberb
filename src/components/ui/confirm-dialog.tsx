import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Box, Text, TextAttributes, useUiHost } from "../../ui";
import { colors } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../../ui/dialog";
import type { InputRenderable } from "../../ui/host";
import type { KeyEventLike } from "../../react/input";
import { isPlainKey } from "../../utils/keyboard";
import { Button, type ButtonVariant } from "./button";
import { DialogActions } from "./dialog-actions";
import { TextField } from "./fields";
import { DialogFrame, fitDialogWidth } from "./frame";
import { ListView, listCursorMove, type ListViewItem } from "./list-view";
import { logFailure } from "../../utils/log-failure";
import { sliceWholeCharacters } from "../../utils/untrusted-text";

/**
 * An optional question a confirm asks under its body, such as why: one of a
 * few choices and a short note. Nothing in it is required and it adds no
 * step: the buttons and keys answer the dialog as they do without it.
 */
export interface ConfirmDialogQuestion {
  /** Over the choices, e.g. "What made you decide to cancel? (optional)". */
  label: string;
  choices: ReadonlyArray<{ id: string; label: string }>;
  /** The note field's placeholder; left out, the dialog asks for no note. */
  notePlaceholder?: string;
  /** The most characters the note takes. */
  noteMaxLength?: number;
}

/** What a confirm's question got: the choice picked and the note, trimmed, when there was one. */
export interface ConfirmDialogAnswer {
  choice?: string;
  note?: string;
}

export interface ConfirmDialogProps extends PromptContext<boolean> {
  title: string;
  body: ReactNode | string | string[];
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  width?: number;
  /**
   * The terminal's key-hint line under the buttons; an empty string leaves it
   * out, and the keys off the desktop buttons too.
   */
  footer?: string;
  /** A line under the body: the work the confirm started, or why it failed. */
  status?: ReactNode;
  /** While the confirmed work runs: the buttons are off and only Esc answers. */
  busy?: boolean;
  /** Adds the desktop close button beside the title. */
  onClose?: () => void;
  /**
   * Lays the buttons out as a form's Cancel and Submit: Cancel, then the
   * action, at the right. By default the action comes first, at the left.
   */
  formButtons?: boolean;
  /**
   * How long after opening Enter and `y` do not confirm, for a confirm that
   * opens on its own while the person may be typing. Esc and `n` always answer.
   */
  keyGraceMs?: number;
  /**
   * What Enter answers. `cancel` is for an opt-in a stray Enter must not
   * accept: Enter takes the cancel button, which is drawn as the primary one,
   * and only `y` or the confirm button confirms.
   */
  defaultAction?: "confirm" | "cancel";
  /**
   * Asks an optional question under the body. The arrows pick a choice, and
   * Space or a click on the picked one clears it. Tab moves into the note and
   * back; while the note has the keys, what is typed goes there, Enter leaves
   * it and only Esc answers the dialog.
   */
  question?: ConfirmDialogQuestion;
  /** With `question`: what it got, called as the dialog confirms. */
  onAnswer?: (answer: ConfirmDialogAnswer) => void;
}

export function ConfirmDialog({
  resolve,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmVariant = "danger",
  width = 52,
  footer,
  status,
  busy = false,
  onClose,
  formButtons = false,
  keyGraceMs = 0,
  defaultAction = "confirm",
  question,
  onAnswer,
}: ConfirmDialogProps) {
  const enterCancels = defaultAction === "cancel";
  const desktop = useUiHost().kind === "desktop-web";
  const openedAt = useRef(Date.now());
  const answer = useQuestionAnswer(question);
  const confirm = useCallback(() => {
    if (question) onAnswer?.(answer.read());
    resolve(true);
  }, [answer, onAnswer, question, resolve]);
  const cancel = useCallback(() => resolve(false), [resolve]);

  // Every key, even with a field focused under the dialog: a confirm has
  // nothing to type into but its own note, so nothing below should take one.
  useDialogKeyboard((event) => {
    // The note takes what is typed, `y` and `n` included. Stopping a key here
    // would keep it from the note too, so only the dialog's own keys stop.
    if (question && answer.noteHasKeys(event) && event.name !== "escape") {
      answer.handleNoteKey(event);
      return;
    }
    event.stopPropagation();
    if (event.name === "escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (busy) {
      event.preventDefault();
      return;
    }
    const enter = event.name === "enter" || event.name === "return";
    if (question && answer.handleKey(event)) return;
    if (enter && enterCancels) {
      event.preventDefault();
      cancel();
      return;
    }
    if (enter || isPlainKey(event, "y")) {
      event.preventDefault();
      if (Date.now() - openedAt.current < keyGraceMs) return;
      confirm();
      return;
    }
    if (isPlainKey(event, "n")) {
      event.preventDefault();
      cancel();
      return;
    }
    // Two buttons and nothing to type (a note takes Tab above): Tab has nowhere to go.
    if (event.name === "tab") event.preventDefault();
  }, { allowEditable: true });

  // The desktop shows the keys on the buttons instead of a footer line; a
  // confirm with no key line keeps its buttons plain there too.
  // One primary button, the one Enter answers.
  const keys = footer !== "";
  const confirmButton = (
    <Button
      label={confirmLabel}
      variant={enterCancels && confirmVariant === "primary" ? "secondary" : confirmVariant}
      disabled={busy}
      desktopShortcut={keys ? (enterCancels ? "Y" : "Enter") : undefined}
      onPress={confirm}
    />
  );
  const cancelButton = <Button label={cancelLabel} variant={enterCancels ? "primary" : "secondary"} disabled={busy} desktopShortcut={keys ? (enterCancels ? "Enter" : "Esc") : undefined} onPress={cancel} />;
  const noteKey = question?.notePlaceholder !== undefined;
  const keyLine = enterCancels
    ? noteKey
      ? tf("y {action} · Tab note · Enter or Esc {cancel}", { action: t(confirmLabel).toLowerCase(), cancel: t(cancelLabel).toLowerCase() })
      : tf("y {action} · Enter or Esc {cancel}", { action: t(confirmLabel).toLowerCase(), cancel: t(cancelLabel).toLowerCase() })
    : tf("Enter {action} · Esc cancel", { action: t(confirmLabel).toLowerCase() });
  return (
    <DialogFrame
      title={title}
      footer={footer ?? keyLine}
      desktopFooter={null}
      onClose={onClose}
    >
      <Box flexDirection="column" {...(desktop ? { style: { width: fitDialogWidth(width) } } : { width })}>
        {renderBody(body)}
        {question && (
          <>
            <Box height={1} />
            <QuestionFields question={question} answer={answer} width={width} disabled={busy} />
          </>
        )}
        {status && (
          <>
            <Box height={1} />
            {status}
          </>
        )}
        <Box height={1} />
        <DialogActions
          alignEnd={formButtons}
          hints={question && keys ? { keys: [{ key: "↑↓", label: "choose" }, ...noteKey ? [{ key: "Tab", label: "note" }] : []] } : undefined}
        >
          {formButtons ? cancelButton : confirmButton}
          {formButtons ? confirmButton : cancelButton}
        </DialogActions>
      </Box>
    </DialogFrame>
  );
}

interface QuestionAnswer {
  items: ListViewItem[];
  choiceIndex: number;
  note: string;
  noteFocused: boolean;
  noteInputRef: RefObject<InputRenderable | null>;
  /** A click or Space on a choice: picks it, or clears it when it was the one picked. */
  toggle(index: number): void;
  setNote(note: string): void;
  /** Moves the keyboard into the note or out of it, the field's own focus with it. */
  focusNote(focused: boolean): void;
  read(): ConfirmDialogAnswer;
  /**
   * Whether the note has the keys, ahead of the render that shows it. Only the
   * note itself: a field under the dialog that kept the focus takes nothing
   * from the dialog, which answers `y` and Enter as it does without a note.
   */
  noteHasKeys(event: KeyEventLike): boolean;
  /** A key while the note has the keys: Tab and Enter leave it; the rest is typing. */
  handleNoteKey(event: KeyEventLike): void;
  /**
   * A key while the note does not have them: the arrows pick, Space clears
   * the choice or picks it back, Tab enters the note. True when it was one.
   */
  handleKey(event: KeyEventLike): boolean;
}

function isTabKey(event: KeyEventLike): boolean {
  return event.name === "tab" && !event.ctrl && !event.meta && !event.alt;
}

function useQuestionAnswer(question: ConfirmDialogQuestion | undefined): QuestionAnswer {
  const items = useMemo<ListViewItem[]>(() => (question?.choices ?? []).map(({ id, label }) => ({ id, label: t(label) })), [question?.choices]);
  const [choiceIndex, setChoiceIndex] = useState(-1);
  const [note, setNoteState] = useState("");
  const [noteFocused, setNoteFocused] = useState(false);
  // Terminal input can deliver a pick, the note and `y` before React renders.
  const choiceRef = useRef(-1);
  // The choice last picked, where the arrows and Space go on from once it is cleared.
  const cursorRef = useRef(-1);
  const noteRef = useRef("");
  const noteFocusedRef = useRef(false);
  const noteInputRef = useRef<InputRenderable | null>(null);
  const hasNote = question?.notePlaceholder !== undefined;
  const setChoice = (index: number) => {
    if (index < -1 || index >= items.length) return;
    if (index >= 0) cursorRef.current = index;
    choiceRef.current = index;
    setChoiceIndex(index);
  };
  // No reason stays a choice: the picked one clears.
  const toggle = (index: number) => setChoice(index === choiceRef.current ? -1 : index);
  const setNote = (next: string) => {
    noteRef.current = next;
    setNoteState(next);
  };
  const focusNote = (focused: boolean) => {
    const next = focused && hasNote;
    noteFocusedRef.current = next;
    setNoteFocused(next);
    // Now, not on the render the flag makes: the next key must find the field
    // that has it, and a note left must not take Enter or `y` as typing.
    if (next) noteInputRef.current?.focus?.();
    else noteInputRef.current?.blur?.();
  };
  return {
    items,
    choiceIndex,
    note,
    noteFocused,
    noteInputRef,
    toggle,
    setNote,
    focusNote,
    read: () => {
      const choice = question?.choices[choiceRef.current]?.id;
      const trimmed = sliceWholeCharacters(noteRef.current.trim(), question?.noteMaxLength ?? Infinity);
      return { ...(choice ? { choice } : {}), ...(hasNote && trimmed ? { note: trimmed } : {}) };
    },
    noteHasKeys: (event) => {
      if (!noteFocusedRef.current) return false;
      if (event.targetEditable === true && noteInputRef.current?.focused === true) return true;
      // The note lost the keys without saying so: they are the dialog's, and the note stops showing them.
      focusNote(false);
      return false;
    },
    handleNoteKey: (event) => {
      if (!isTabKey(event) && event.name !== "enter" && event.name !== "return") return;
      event.preventDefault();
      event.stopPropagation();
      focusNote(false);
    },
    handleKey: (event) => {
      if (hasNote && isTabKey(event)) {
        event.preventDefault();
        focusNote(true);
        return true;
      }
      if (isPlainKey(event, "space")) {
        event.preventDefault();
        if (cursorRef.current >= 0) toggle(cursorRef.current);
        return true;
      }
      const move = listCursorMove(event, items.length);
      if (!move) return false;
      event.preventDefault();
      setChoice(move(items, choiceRef.current >= 0 ? choiceRef.current : cursorRef.current));
      return true;
    },
  };
}

function QuestionFields({
  question,
  answer,
  width,
  disabled,
}: {
  question: ConfirmDialogQuestion;
  answer: QuestionAnswer;
  width: number;
  disabled: boolean;
}) {
  const desktop = useUiHost().kind === "desktop-web";
  const label = t(question.label);
  return (
    <Box flexDirection="column">
      {/* A form label, as a TextField draws its own: bold and a row above its control on the desktop. */}
      <Box height={1}>
        <Text fg={colors.textDim} attributes={desktop ? TextAttributes.BOLD : 0}>{label}</Text>
      </Box>
      {desktop && <Box height={1} />}
      <ListView
        items={answer.items}
        selectedIndex={answer.choiceIndex}
        remoteLabel={label}
        rowGap={0}
        surface="framed"
        height={answer.items.length}
        // Enter answers the dialog, a focused choice too: Space picks or clears it.
        checkboxRows
        onSelect={(index) => {
          if (disabled) return;
          answer.focusNote(false);
          answer.toggle(index);
        }}
      />
      {question.notePlaceholder !== undefined && (
        <>
          <Box height={1} />
          <TextField
            accessibleLabel={t(question.notePlaceholder)}
            value={answer.note}
            placeholder={t(question.notePlaceholder)}
            maxLength={question.noteMaxLength}
            focused={answer.noteFocused}
            inputRef={answer.noteInputRef}
            disabled={disabled}
            width={desktop ? undefined : width}
            onMouseDown={() => answer.focusNote(true)}
            onBlur={() => answer.focusNote(false)}
            onChange={answer.setNote}
          />
        </>
      )}
    </Box>
  );
}

export type ConfirmDialogOptions = Omit<ConfirmDialogProps, keyof PromptContext<boolean>> & {
  /** A click on the backdrop cancels. On by default. */
  closeOnClickOutside?: boolean;
};

/**
 * Asks in a ConfirmDialog and resolves true only when the person confirms;
 * Cancel, Esc, a click outside or a failed dialog all resolve false.
 */
export async function confirmDialog(
  dialog: DialogApi,
  { closeOnClickOutside = true, ...props }: ConfirmDialogOptions,
): Promise<boolean> {
  const confirmed = await dialog.prompt<boolean>({
    closeOnClickOutside,
    content: (context) => <ConfirmDialog {...context} {...props} />,
  }).catch(logFailure("ui.confirm-dialog", "Open confirm dialog failed", false));
  return confirmed === true;
}

/**
 * A confirmDialog that asks `question` under its body: the answer when the
 * person confirms, empty when they skipped the question, and null when they
 * cancelled (Cancel, Esc, a click outside or a failed dialog).
 */
export async function confirmDialogWithAnswer(
  dialog: DialogApi,
  { closeOnClickOutside = true, ...props }: ConfirmDialogOptions & { question: ConfirmDialogQuestion },
): Promise<ConfirmDialogAnswer | null> {
  let answer: ConfirmDialogAnswer = {};
  const confirmed = await dialog.prompt<boolean>({
    closeOnClickOutside,
    content: (context) => <ConfirmDialog {...context} {...props} onAnswer={(next) => { answer = next; }} />,
  }).catch(logFailure("ui.confirm-dialog", "Open confirm dialog failed", false));
  return confirmed === true ? answer : null;
}

function renderBody(body: ReactNode | string | string[]): ReactNode {
  if (Array.isArray(body)) {
    return body.map((line, index) => (
      <Text key={`${line}:${index}`} fg={index === 0 ? colors.text : colors.textDim} wrapText>{t(line)}</Text>
    ));
  }
  if (typeof body === "string") {
    return <Text fg={colors.text} wrapText>{body}</Text>;
  }
  return body;
}
