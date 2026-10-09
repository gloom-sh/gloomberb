import { type AppConfig, type OnboardingProgress, type OnboardingStage } from "../../types/config";
import { type BrokerConfigField } from "../../types/broker";
import { useShortcut, type KeyEventLike } from "../../react/input";
import { matchKeybinding, matchesKeybindingAction, type ResolvedKeybindings } from "../../app/keybindings";
import { isPlainKey } from "../../utils/keyboard";
import { isCopyShortcut, isPasteShortcut } from "../../utils/selection-clipboard";
import { type CloudBillingInterval } from "../../plugins/builtin/account-management/model";
import { usePlanAccess } from "../../api-client/plan-access";
import { type ListViewItem } from "../ui";
import { type PortfolioSub } from "./onboarding-steps";
import { BROKER_GUIDE_KEY } from "./portfolio-step/broker-setup-panel";
import { REMOVE_POSITION_KEY } from "./portfolio-step/positions-panel";
import { type OnboardingSectionId } from "./onboarding-frame";
import { useOnboardingAccount } from "./wizard-account";
import { POSITION_FIELDS, useOnboardingPositions } from "./wizard-positions";
import { toggleDeskChoice } from "./desks-step";
import { DESKS, type DeskKey } from "../../layout/desks";
import type { Dispatch, SetStateAction } from "react";


/**
 * Card keys, shown on the buttons they press. Letters only act while no field
 * is being typed in (Esc leaves the field first); F10, the old skip key, still
 * works everywhere.
 */
export const SKIP_SETUP_KEY = "s";
export const KEEP_FREE_KEY = "f";
export const CONNECT_BROKER_KEY = "b";
export const BROWSER_SIGN_IN_KEY = "b";
export const SKIP_DESKS_KEY = "s";

/** Digits jump straight to a section the header would let you click. */
const SECTION_DIGITS: Record<string, OnboardingSectionId> = { "1": "portfolio", "2": "cloud", "3": "pro" };

/**
 * Whether a key the onboarding card did not use may still reach the app
 * behind it. Toasts float above the card, copy and paste work anywhere, and
 * Help is the way out (the card steps aside while Help has focus). A field
 * keeps its typing and editing keys; of the chords that reach app shortcuts
 * while typing, only the ones the app binds are held back. Everything else
 * would act on a pane hidden behind the scrim.
 */
export function keyReachesPastOnboardingModal(event: KeyEventLike, keybindings: ResolvedKeybindings): boolean {
  if (isCopyShortcut(event) || isPasteShortcut(event)) return true;
  const match = matchKeybinding(keybindings, event);
  const action = match?.kind === "action" ? match.id : null;
  if (action === "notification-action" || action === "notification-dismiss") return true;
  if (event.targetEditable) {
    const chord = event.ctrl || event.meta || event.super === true;
    return !chord || !match;
  }
  return action === "help";
}
export function useOnboardingKeyboard({
  stage, progress, account, helpFocused, editingField, isBrokerCommitting, planAccess, continueFree, finish,
  sectionAvailability, goToSection, portfolioSub, positions, setEditingField, positionCount,
  continueFromPositions, openBrokerConnect, movePositionCursor, removePositionAtCursor, submitBrokerField,
  submitAccountField, backPortfolio, continuePortfolio, setPortfolioOptionIdx, activeBrokerFields,
  brokerFieldIdx, setBrokerSelectIdx, brokerChoices, openBrokerGuide, chosenDesks, finishDesks,
  setDeskCursor, deskCursor, setChosenDesks, continueAccount, skipSetup, primaryUpgradeAction,
  setBillingInterval, keybindings, dialogOpen, commandBarOpen, saveProgressInBackground,
}: {
  stage: OnboardingStage;
  progress: OnboardingProgress;
  account: ReturnType<typeof useOnboardingAccount>;
  helpFocused: boolean;
  editingField: boolean;
  isBrokerCommitting: boolean;
  planAccess: ReturnType<typeof usePlanAccess>;
  continueFree: () => void;
  finish: (skipped?: boolean) => Promise<void>;
  sectionAvailability: Partial<Record<OnboardingSectionId, boolean>>;
  goToSection: (section: OnboardingSectionId) => void;
  portfolioSub: PortfolioSub;
  positions: ReturnType<typeof useOnboardingPositions>;
  setEditingField: Dispatch<SetStateAction<boolean>>;
  positionCount: number;
  continueFromPositions: () => void;
  openBrokerConnect: () => void;
  movePositionCursor: (delta: number) => void;
  removePositionAtCursor: () => void;
  submitBrokerField: () => void;
  submitAccountField: () => void;
  backPortfolio: () => void;
  continuePortfolio: () => void;
  setPortfolioOptionIdx: Dispatch<SetStateAction<number>>;
  activeBrokerFields: BrokerConfigField[];
  brokerFieldIdx: number;
  setBrokerSelectIdx: Dispatch<SetStateAction<number>>;
  brokerChoices: ListViewItem[];
  openBrokerGuide: () => void;
  chosenDesks: DeskKey[];
  finishDesks: (desks: readonly DeskKey[]) => void;
  setDeskCursor: Dispatch<SetStateAction<number>>;
  deskCursor: number;
  setChosenDesks: Dispatch<SetStateAction<DeskKey[]>>;
  continueAccount: () => void;
  skipSetup: () => void;
  primaryUpgradeAction: () => void;
  setBillingInterval: Dispatch<SetStateAction<CloudBillingInterval>>;
  keybindings: ResolvedKeybindings;
  dialogOpen: boolean;
  commandBarOpen: boolean;
  saveProgressInBackground: (patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">, baseConfig?: AppConfig | undefined) => void;
}) {

  const activeSection: OnboardingSectionId = stage === "portfolio" || stage === "desks"
    ? "portfolio"
    : stage === "upgrade" || (stage === "ready" && progress.accountStatus === "signed-in")
      ? "pro"
      : "cloud";
  const accountForm = account.accountSub === "signup" || account.accountSub === "login";
  const modalShown = !helpFocused && stage !== "research";

  /**
   * The card's keys. The card is modal: whatever it does not use stops here,
   * so nothing reaches the workspace behind the scrim. The scope carries the
   * stage so each step registers afresh and runs ahead of any pane that
   * mounted since (the first-run workspace mounts after the wizard).
   */
  useShortcut((event) => {
    const name = event.name ?? event.key ?? "";
    const chord = event.ctrl || event.meta || event.super === true || event.alt;
    const enter = !chord && (name === "enter" || name === "return");
    const escape = !chord && (name === "escape" || name === "backspace");
    const letter = (key: string) => !chord && !event.shift && name === key;
    const tab = !chord && name === "tab";
    const sectionDigit = !chord && !editingField && !event.targetEditable ? SECTION_DIGITS[name] : undefined;

    const handled = ((): boolean => {
      if (isPlainKey(event, "f10")) {
        if (stage === "portfolio" || stage === "desks" || isBrokerCommitting) return true;
        if (stage === "upgrade" && !planAccess.hasProAccess) continueFree();
        else void finish(true);
        return true;
      }

      if (sectionDigit) {
        if (sectionDigit !== activeSection && sectionAvailability[sectionDigit]) goToSection(sectionDigit);
        return true;
      }

      if (stage === "portfolio" && portfolioSub === "positions") {
        if (editingField) {
          if (enter) {
            positions.submitField();
          } else if (tab) {
            positions.setFieldIdx((index) => (
              event.shift ? Math.max(0, index - 1) : Math.min(POSITION_FIELDS.length - 1, index + 1)
            ));
          } else if (!chord && name === "escape") {
            setEditingField(false);
          } else {
            return false;
          }
          return true;
        }
        if (enter) {
          if (positionCount > 0) continueFromPositions();
          else positions.focusField(0);
        } else if (letter("a") || tab) {
          // Tab from the list goes back into the form, at its far end for Shift+Tab.
          positions.focusField(tab && event.shift ? POSITION_FIELDS.length - 1 : 0);
        } else if (letter(CONNECT_BROKER_KEY) && positionCount > 0) {
          openBrokerConnect();
        } else if (!chord && (name === "up" || name === "k")) {
          movePositionCursor(-1);
        } else if (!chord && (name === "down" || name === "j")) {
          movePositionCursor(1);
        } else if (letter(REMOVE_POSITION_KEY) || (!chord && name === "delete")) {
          removePositionAtCursor();
        } else {
          return false;
        }
        return true;
      }

      if (editingField && (stage === "portfolio" || (stage === "account" && accountForm))) {
        if (enter) {
          if (stage === "portfolio") submitBrokerField();
          else submitAccountField();
        } else if (!chord && name === "escape") {
          setEditingField(false);
          if (stage === "portfolio") backPortfolio();
        } else if (stage === "account" && tab) {
          account.focusAccountField(event.shift ? 0 : 1);
        } else {
          return false;
        }
        return true;
      }

      if (stage === "portfolio") {
        if (enter) {
          continuePortfolio();
        } else if (escape) {
          backPortfolio();
        } else if (!chord && (name === "up" || name === "k")) {
          if (portfolioSub === "choose") setPortfolioOptionIdx((index) => Math.max(0, index - 1));
          else if (activeBrokerFields[brokerFieldIdx]?.type === "select") setBrokerSelectIdx((index) => Math.max(0, index - 1));
        } else if (!chord && (name === "down" || name === "j")) {
          if (portfolioSub === "choose") setPortfolioOptionIdx((index) => Math.min(brokerChoices.length - 1, index + 1));
          else if (activeBrokerFields[brokerFieldIdx]?.type === "select") {
            const optionCount = activeBrokerFields[brokerFieldIdx]?.options?.length ?? 0;
            setBrokerSelectIdx((index) => Math.min(Math.max(0, optionCount - 1), index + 1));
          }
        } else if (portfolioSub === "broker-setup" && letter(BROKER_GUIDE_KEY)) {
          openBrokerGuide();
        } else {
          return false;
        }
        return true;
      }

      if (stage === "desks") {
        if (enter) {
          if (chosenDesks.length > 0) finishDesks(chosenDesks);
        } else if (letter(SKIP_DESKS_KEY)) {
          finishDesks([]);
        } else if (!chord && (name === "up" || name === "k")) {
          setDeskCursor((index) => Math.max(0, index - 1));
        } else if (!chord && (name === "down" || name === "j")) {
          setDeskCursor((index) => Math.min(DESKS.length - 1, index + 1));
        } else if (!chord && (name === "space" || event.sequence === " ")) {
          const desk = DESKS[deskCursor];
          if (desk) setChosenDesks((current) => toggleDeskChoice(current, desk.key));
        } else {
          return false;
        }
        return true;
      }

      if (stage === "account") {
        if (enter) {
          continueAccount();
        } else if (escape) {
          if (account.accountSub === "qr" || account.accountSub === "login") account.returnToAccountForm();
          else goToSection("portfolio");
        } else if (letter(BROWSER_SIGN_IN_KEY) && accountForm) {
          account.beginQrSignIn();
        } else if (letter(SKIP_SETUP_KEY)) {
          skipSetup();
        } else if (tab && accountForm) {
          account.focusAccountField(account.accountFieldIdx > 0 ? 1 : 0);
        } else {
          return false;
        }
        return true;
      }

      if (stage === "upgrade") {
        if (enter) {
          primaryUpgradeAction();
        } else if (escape) {
          goToSection("cloud");
        } else if (!planAccess.hasProAccess && letter(KEEP_FREE_KEY)) {
          continueFree();
        } else if (!planAccess.hasProAccess && (isPlainKey(event, "left") || letter("h"))) {
          setBillingInterval("month");
        } else if (!planAccess.hasProAccess && (isPlainKey(event, "right") || letter("l"))) {
          setBillingInterval("year");
        } else {
          return false;
        }
        return true;
      }

      if (stage === "ready") {
        if (enter) void finish();
        else if (escape) goToSection(progress.accountStatus === "signed-in" ? "pro" : "cloud");
        else return false;
        return true;
      }
      return false;
    })();

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (keyReachesPastOnboardingModal(event, keybindings)) return;
    // An app chord held here still must not fall through to the browser's own
    // meaning for it (Cmd+digit switches tabs in a web host).
    if (matchKeybinding(keybindings, event)) event.preventDefault();
    event.stopPropagation();
  }, {
    phase: "before",
    allowEditable: true,
    scope: `onboarding:${stage}`,
    enabled: modalShown && !dialogOpen && !commandBarOpen,
  });

  /**
   * The research coach floats over a live workspace, so it takes no key a pane
   * could want. It answers the notification keys, like a toast that stays up,
   * and only when nothing else used them.
   */
  useShortcut((event) => {
    if (event.targetEditable) return;
    const connect = matchesKeybindingAction(keybindings, "notification-action", event);
    const dismiss = matchesKeybindingAction(keybindings, "notification-dismiss", event) || isPlainKey(event, "f10");
    if (!connect && !dismiss) return;
    event.preventDefault();
    event.stopPropagation();
    if (connect) saveProgressInBackground({ stage: "account" });
    else void finish();
  }, {
    phase: "after",
    enabled: stage === "research" && !helpFocused && !dialogOpen && !commandBarOpen,
  });
}
