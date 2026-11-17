import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiClient } from "../api-client";
import { HEARD_FROM_ANSWERS, type HeardFromAnswer } from "../api-client/heard-from";
import { ChoiceDialog } from "../components/ui/choice-dialog";
import { TextPromptDialog } from "../components/ui/text-prompt-dialog";
import { t } from "../i18n";
import { type DialogApi, type PromptContext, useDialog, useDialogState } from "../ui/dialog";
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

function heardFromChoiceLabel(answer: HeardFromAnswer): string {
  return UNTRANSLATED.has(answer) ? LABELS[answer] : t(LABELS[answer]);
}

/**
 * The question as the app's one-question dialogs ask: the choices, Enter
 * answers, Esc (or the close button) skips. Other asks for a short note next;
 * leaving that empty, or closing it, still answers Other.
 */
async function askHeardFrom(dialog: DialogApi): Promise<HeardFromChoice> {
  const title = t("Where did you hear about Gloom?");
  const picked = await dialog.prompt<string>({
    content: (context) => (
      <ChoiceDialog
        {...(context as PromptContext<string>)}
        title={title}
        choices={HEARD_FROM_ANSWERS.map((id) => ({ id, label: heardFromChoiceLabel(id) }))}
        footer={t("Enter answer · Esc skip")}
      />
    ),
  });
  const answer = HEARD_FROM_ANSWERS.find((id) => id === picked);
  if (!answer) return null;
  if (answer !== "other") return { answer };
  const note = await dialog.prompt<string>({
    content: (context) => (
      <TextPromptDialog
        {...(context as PromptContext<string>)}
        title={title}
        placeholder="Where?"
        confirmLabel="Send"
        allowEmpty
        width={56}
      />
    ),
  });
  return note ? { answer, note } : { answer };
}

function currentAccountId(): string | null {
  return apiClient.getCurrentUser()?.id ?? null;
}

/**
 * Asks the account marked due (account/heard-from.ts) once nothing else is
 * on screen. Mounted by the app only while setup and the sign-in gate are
 * closed, so the first run never shows it; it waits out any open dialog.
 */
export function HeardFromQuestionHost() {
  const dialog = useDialog();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const due = useSyncExternalStore(subscribeHeardFromDue, heardFromDueAccount, heardFromDueAccount);
  const account = useSyncExternalStore(
    (onChange) => apiClient.subscribeCurrentUser(onChange),
    currentAccountId,
    currentAccountId,
  );
  const asking = useRef(false);

  useEffect(() => {
    // Signed out, or another account since: the mark waits for its own account.
    if (!due || due !== account || dialogOpen || asking.current) return;
    if (!takeHeardFromDue(due)) return;
    asking.current = true;
    const done = () => {
      asking.current = false;
    };
    runHeardFromQuestion({
      getState: () => apiClient.getHeardFrom(),
      reportShown: () => apiClient.reportHeardFromShown(),
      answer: (answer, note) => apiClient.answerHeardFrom(answer, note),
      skip: () => apiClient.skipHeardFrom(),
      ask: () => askHeardFrom(dialog),
    }).then(done, done);
  }, [account, dialog, dialogOpen, due]);

  return null;
}
