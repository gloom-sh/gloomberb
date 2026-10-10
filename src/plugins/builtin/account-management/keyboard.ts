import type { RefObject } from "react";
import { useFieldRing, type FieldRing } from "../../../components";
import { useShortcut } from "../../../react/input";
import type { ScrollBoxRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import type { AccountDraft, AccountFieldKey } from "./model";

const SCOPE = "account-management:fields";

/** Checkboxes: Enter or Space flips them. */
const TOGGLE_FIELDS = [
  "profilePublic",
  "acceptUnknownDms",
  "weeklyRoundupEnabled",
  "chatEmailNotificationsEnabled",
  "positionAlertsEnabled",
] as const satisfies readonly (AccountFieldKey & keyof AccountDraft)[];

export function useAccountManagementKeyboard({
  activeField,
  cyclePortfolio,
  draftRef,
  fieldOrder,
  focused,
  openAssistants,
  openPasswordDialog,
  openPortfolioDialog,
  openUpgrade,
  saveProfile,
  scrollRef,
  setActiveField,
  setDraftValue,
  deleteAccount,
  turnOffEmailAlerts,
}: {
  activeField: AccountFieldKey;
  cyclePortfolio: (delta: number) => void;
  draftRef: { current: AccountDraft };
  /** The active tab's ring, in reading order. */
  fieldOrder: readonly AccountFieldKey[];
  focused: boolean;
  openAssistants: () => void;
  openPasswordDialog: () => void;
  openPortfolioDialog: () => Promise<void>;
  openUpgrade: () => void;
  saveProfile: () => Promise<void>;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  setActiveField: (field: AccountFieldKey) => void;
  setDraftValue: <K extends keyof AccountDraft>(key: K, value: AccountDraft[K]) => void;
  deleteAccount: () => Promise<void>;
  turnOffEmailAlerts: () => Promise<void>;
}): FieldRing<AccountFieldKey> {
  const actions: Partial<Record<AccountFieldKey, () => void>> = {
    sharedPortfolioId: () => { void openPortfolioDialog(); },
    passwordAction: openPasswordDialog,
    upgradeAction: openUpgrade,
    assistantsAction: openAssistants,
    deleteAccountAction: () => { void deleteAccount(); },
    emailAlertsOffAction: () => { void turnOffEmailAlerts(); },
  };
  for (const key of TOGGLE_FIELDS) actions[key] = () => setDraftValue(key, !draftRef.current[key]);

  const ring = useFieldRing({
    ids: fieldOrder,
    activeId: activeField,
    onActivate: setActiveField,
    enabled: focused,
    scope: SCOPE,
    actions,
    scrollRef,
  });

  useShortcut((event) => {
    const consume = () => {
      event.preventDefault?.();
      event.stopPropagation?.();
    };
    if (event.ctrl && event.name === "s") {
      consume();
      void saveProfile();
      return;
    }
    if (event.targetEditable || activeField !== "sharedPortfolioId") return;
    if (isPlainKey(event, "left", "h", "[")) {
      consume();
      cyclePortfolio(-1);
    } else if (isPlainKey(event, "right", "l", "]")) {
      consume();
      cyclePortfolio(1);
    }
  }, { allowEditable: true, phase: "before", scope: SCOPE, enabled: focused });

  return ring;
}
