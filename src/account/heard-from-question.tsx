import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiClient } from "../api-client";
import {
  HEARD_FROM_ANSWERS,
  HEARD_FROM_NOTE_MAX_LENGTH,
  type HeardFromAnswer,
  heardFromAsksForNote,
} from "../api-client/heard-from";
import { useKeybindings } from "../app/keybindings";
import {
  OnboardingActions,
  OnboardingButton,
  OnboardingChoiceList,
  OnboardingModal,
  OnboardingTitle,
} from "../components/onboarding/onboarding-frame";
import { keyReachesPastOnboardingModal } from "../components/onboarding/onboarding-keyboard";
import { setupCardOpen, subscribeSetupCards } from "../components/onboarding/setup-cards";
import { TextField } from "../components/ui/fields";
import { t } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { useShortcut } from "../react/input";
import { Box, useUiCapabilities, type InputRenderable } from "../ui";
import { useDialogState } from "../ui/dialog";
import { useOptionalAppSelector } from "../state/app/context";
import { isPlainKey } from "../utils/keyboard";
import {
  type HeardFromChoice,
  heardFromDueAccount,
  runHeardFromQuestion,
  subscribeHeardFromDue,
  takeHeardFromDue,
} from "./heard-from";

/** The services keep their own names in every language. */
const LABELS: Record<HeardFromAnswer, string> = {
  search: "Search",
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  x: "X",
  reddit: "Reddit",
  ai_assistant: "AI assistant",
  friend: "Friend or colleague",
  article: "Article or newsletter",
  other: "Other",
};
const UNTRANSLATED: ReadonlySet<HeardFromAnswer> = new Set(["youtube", "tiktok", "instagram", "x", "reddit"]);
const OTHER_INDEX = HEARD_FROM_ANSWERS.indexOf("other");
const CARD_WIDTH = 56;

function choiceLabel(answer: HeardFromAnswer): string {
  return UNTRANSLATED.has(answer) ? LABELS[answer] : t(LABELS[answer]);
}

/**
 * "Where did you hear about Gloom?" on the card the app's other one-question
 * steps use. One row is one answer: a click, or Enter on the highlighted
 * row. Other opens a short note under the list, sent with Enter (empty is
 * fine). Esc, or Skip, skips; from the note, Esc (Back) goes back to the
 * list. The card holds the keyboard while it is up, as setup does.
 *
 * Social and AI assistant answers with a follow-up are kept when picked
 * (`onPicked`), then ask the optional follow-up under the list: Enter
 * sends the note (empty is fine), Esc or Skip closes the card. Either way the
 * answer is already kept.
 */
function HeardFromCard({ onShown, onPicked, onDone }: {
  onShown: () => void;
  onPicked: (answer: HeardFromAnswer) => void;
  onDone: (choice: HeardFromChoice) => void;
}) {
  useAppLanguage();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const keybindings = useKeybindings();
  const [cursor, setCursor] = useState(0);
  const [noteOpen, setNoteOpen] = useState(false);
  const [kept, setKept] = useState<HeardFromAnswer | null>(null);
  const keptRef = useRef<HeardFromAnswer | null>(null);
  const [note, setNote] = useState("");
  const noteRef = useRef<InputRenderable>(null);
  // Enter can arrive with the typing, ahead of the render that holds it.
  const noteValue = useRef("");
  const cursorRef = useRef(0);
  const closed = useRef(false);

  const moveCursor = useCallback((next: number) => {
    cursorRef.current = next;
    setCursor(next);
  }, []);

  const done = useCallback((choice: HeardFromChoice) => {
    if (closed.current) return;
    closed.current = true;
    onDone(choice);
  }, [onDone]);

  const choose = useCallback((index: number) => {
    const answer = HEARD_FROM_ANSWERS[index];
    if (!answer || keptRef.current) return;
    moveCursor(index);
    if (answer === "other") {
      setNoteOpen(true);
      return;
    }
    if (heardFromAsksForNote(answer)) {
      keptRef.current = answer;
      noteValue.current = "";
      setNote("");
      setNoteOpen(false);
      setKept(answer);
      onPicked(answer);
      return;
    }
    done({ answer });
  }, [done, moveCursor, onPicked]);

  const sendNote = useCallback(() => {
    const answer = keptRef.current ?? "other";
    const text = noteValue.current.trim();
    done(text ? { answer, note: text } : { answer });
  }, [done]);

  // Closes the card: after a kept answer that keeps it, from Other's note it
  // goes back to the list, and from the list it skips.
  const back = useCallback(() => {
    if (keptRef.current) done({ answer: keptRef.current });
    else if (noteOpen) setNoteOpen(false);
    else done(null);
  }, [done, noteOpen]);

  const fieldOpen = noteOpen || kept !== null;
  const noteLabel = kept === "ai_assistant"
    ? t("Which AI, and what did you ask?")
    : kept ? t("Which account or post?") : t("Where?");

  const shownRef = useRef(onShown);
  useEffect(() => shownRef.current(), []);

  useEffect(() => {
    if (!fieldOpen) return;
    const timer = setTimeout(() => noteRef.current?.focus?.(), 10);
    return () => clearTimeout(timer);
  }, [fieldOpen]);

  useShortcut((event) => {
    const handled = ((): boolean => {
      if (fieldOpen) {
        if (isPlainKey(event, "enter", "return")) { sendNote(); return true; }
        if (isPlainKey(event, "escape")) { back(); return true; }
        return false;
      }
      const last = HEARD_FROM_ANSWERS.length - 1;
      if (isPlainKey(event, "down")) { moveCursor(Math.min(last, cursorRef.current + 1)); return true; }
      if (isPlainKey(event, "up")) { moveCursor(Math.max(0, cursorRef.current - 1)); return true; }
      if (isPlainKey(event, "enter", "return")) { choose(cursorRef.current); return true; }
      if (isPlainKey(event, "escape")) { done(null); return true; }
      return false;
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (keyReachesPastOnboardingModal(event, keybindings)) return;
    event.stopPropagation();
  }, { phase: "before", allowEditable: true, scope: "heard-from" });

  const items = HEARD_FROM_ANSWERS.map((answer) => ({ id: answer, label: choiceLabel(answer) }));
  const selectedIndex = kept ? HEARD_FROM_ANSWERS.indexOf(kept) : noteOpen ? OTHER_INDEX : cursor;
  return (
    <OnboardingModal width={CARD_WIDTH} height={18 + (fieldOpen ? 2 : 0)} desktopWidth="min(440px, 100%)">
      <OnboardingTitle standalone title={t("Where did you hear about Gloom?")} />
      <Box flexDirection="column" style={desktop ? { marginTop: 14 } : undefined} paddingTop={desktop ? undefined : 1}>
        <OnboardingChoiceList
          items={items}
          selectedIndex={selectedIndex}
          onSelect={moveCursor}
          onActivate={choose}
        />
      </Box>
      {fieldOpen ? (
        <Box flexDirection="column" style={desktop ? { marginTop: 10 } : undefined} paddingTop={desktop ? undefined : 1}>
          <TextField
            inputRef={noteRef}
            value={note}
            placeholder={noteLabel}
            maxLength={HEARD_FROM_NOTE_MAX_LENGTH}
            focused
            width={desktop ? undefined : CARD_WIDTH - 6}
            onChange={(value) => {
              noteValue.current = value;
              setNote(value);
            }}
          />
        </Box>
      ) : null}
      {desktop ? null : <Box height={1} />}
      <OnboardingActions>
        {/* From Other's note, Esc goes back to the list; from the list it skips; after a kept answer it closes. */}
        <OnboardingButton
          label={noteOpen ? "Back" : "Skip"}
          variant="ghost"
          shortcut="Esc"
          onPress={back}
        />
        <OnboardingButton
          label={fieldOpen ? "Send" : "Continue"}
          variant="primary"
          shortcut="Enter"
          onPress={() => (fieldOpen ? sendNote() : choose(cursorRef.current))}
        />
      </OnboardingActions>
    </OnboardingModal>
  );
}

function currentAccountId(): string | null {
  return apiClient.getCurrentUser()?.id ?? null;
}

/**
 * Asks the account marked due (account/heard-from.ts) once nothing else is
 * up: no dialog, no setup card ("Which companies do you follow?" goes
 * first) and no open command bar, whose typing the card would take. Mounted
 * by the app only while setup and the sign-in gate are closed, so the first
 * run never shows it.
 */
export function HeardFromQuestionHost() {
  const dialogOpen = useDialogState((state) => state.isOpen);
  const commandBarOpen = useOptionalAppSelector((state) => state.commandBarOpen, false);
  const cardOpen = useSyncExternalStore(subscribeSetupCards, setupCardOpen, setupCardOpen);
  const due = useSyncExternalStore(subscribeHeardFromDue, heardFromDueAccount, heardFromDueAccount);
  const account = useSyncExternalStore(
    (onChange) => apiClient.subscribeCurrentUser(onChange),
    currentAccountId,
    currentAccountId,
  );
  const [asking, setAsking] = useState<{
    shown: () => void;
    picked: (answer: HeardFromAnswer) => void;
    resolve: (choice: HeardFromChoice) => void;
  } | null>(null);
  // Drawn once nothing else is up, and kept up from then on (it is a setup card itself).
  const [drawn, setDrawn] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    // Signed out, or another account since: the mark waits for its own account.
    if (!due || due !== account || dialogOpen || cardOpen || commandBarOpen || busy.current) return;
    if (!takeHeardFromDue(due)) return;
    busy.current = true;
    const finished = () => {
      busy.current = false;
      setAsking(null);
      setDrawn(false);
    };
    runHeardFromQuestion({
      getState: () => apiClient.getHeardFrom(),
      reportShown: () => apiClient.reportHeardFromShown(),
      answer: (answer, note) => apiClient.answerHeardFrom(answer, note),
      skip: () => apiClient.skipHeardFrom(),
      ask: (shown, picked) => new Promise<HeardFromChoice>((resolve) => setAsking({ shown, picked, resolve })),
    }).then(finished, finished);
  }, [account, cardOpen, commandBarOpen, dialogOpen, due]);

  // The read takes a moment: a card, dialog or command bar that opened
  // meanwhile (the companies to follow, after a sign-up) goes first.
  useEffect(() => {
    if (asking && !drawn && !dialogOpen && !cardOpen && !commandBarOpen) setDrawn(true);
  }, [asking, cardOpen, commandBarOpen, dialogOpen, drawn]);

  if (!asking || !drawn) return null;
  return <HeardFromCard onShown={asking.shown} onPicked={asking.picked} onDone={asking.resolve} />;
}
