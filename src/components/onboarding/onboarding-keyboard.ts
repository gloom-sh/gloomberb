import type { Dispatch, SetStateAction } from "react";
import type { AppConfig, OnboardingProgress, OnboardingStage } from "../../types/config";
import type { BrokerConfigField } from "../../types/broker";
import { useShortcut, type KeyEventLike } from "../../react/input";
import { matchKeybinding, matchesKeybindingAction, type ResolvedKeybindings } from "../../app/keybindings";
import { isPlainKey } from "../../utils/keyboard";
import { keepEscapeFromClosing } from "../../utils/double-escape-close";
import { isCopyShortcut, isPasteShortcut } from "../../utils/selection-clipboard";
import type { CloudBillingInterval } from "../../account/billing";
import type { usePlanAccess } from "../../api-client/plan-access";
import type { ListViewItem } from "../ui";
import type { PortfolioSub } from "./onboarding-steps";
import { BROKER_GUIDE_KEY } from "./portfolio-step/broker-setup-panel";
import { REMOVE_POSITION_KEY } from "./portfolio-step/positions-panel";
import type { OnboardingSectionId } from "./onboarding-frame";
import type { useOnboardingAccount } from "./wizard-account";
import { POSITION_FIELDS, type useOnboardingPositions } from "./wizard-positions";
import { toggleDeskChoice } from "./desks-step";
import { DESKS, type DeskKey } from "../../layout/desks";
import type { OnboardingTickersState } from "./wizard-tickers";
import type { TickerPick } from "./tickers-step-model";

/**
 * Card keys, shown on the buttons they press. Letters only act while no field
 * is being typed in (Esc leaves the field first), and Tab from a field reaches
 * the buttons too. F10, the old skip key, leaves setup wherever it can be left
 * (a run from Settings, the later steps). On the first run's portfolio step,
 * holding nothing, it presses Skip instead, the key that button shows while a
 * field has the keyboard.
 */
export const SKIP_SETUP_KEY = "s";
export const KEEP_FREE_KEY = "f";
export const CONNECT_BROKER_KEY = "b";
export const BROWSER_SIGN_IN_KEY = "b";
export const SKIP_DESKS_KEY = "s";
/**
 * "Which tickers do you follow?" opens in its search field, where a letter is
 * typed: Esc skips it once the search is empty (the first Esc clears a typed
 * search, as in the app's other search fields), and F10 skips it at once.
 */
export const SKIP_TICKERS_KEY = "Esc";
export const SKIP_PORTFOLIO_KEY = "s";
/** What presses the first run's portfolio Skip while a field is being typed in, where its letter is typed. */
export const SKIP_IN_FIELD_KEY = "F10";
/** The portfolio step's buttons Tab reaches from its fields, in the order they are drawn. */
export type PositionsButton = "broker" | "skip" | "continue";
/** Each step's primary button (Continue, Start exploring) and its Back. */
export const CONTINUE_KEY = "Enter";
export const BACK_KEY = "Esc";

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
  continueFromPositions, skipPositions, openBrokerConnect, movePositionCursor, removePositionAtCursor, submitBrokerField,
  submitAccountField, backPortfolio, continuePortfolio, setPortfolioOptionIdx, activeBrokerFields,
  brokerFieldIdx, setBrokerSelectIdx, brokerChoices, openBrokerGuide, chosenDesks, finishDesks,
  setDeskCursor, deskCursor, setChosenDesks, continueAccount, skipSetup, primaryUpgradeAction,
  setBillingInterval, keybindings, dialogOpen, commandBarOpen, saveProgressInBackground, goBack, coachAside = false,
  inputCaptured = false, positionsButtons = [], positionsButton = null, setPositionsButton = () => {},
  tickers, finishTickers = () => {}, buildingWorkspace = false,
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
  skipPositions: () => void;
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
  /** Back on the card: to the step the user came from. */
  goBack: () => void;
  /** The workspace coach has stepped aside for a pane opened after it, and takes no keys. */
  coachAside?: boolean;
  /** A pane holds the keyboard (SET_INPUT_CAPTURED): the research coach takes none of its keys. */
  inputCaptured?: boolean;
  /** The portfolio step's buttons that can be pressed now, as drawn: Tab moves from its fields to them and back. */
  positionsButtons?: readonly PositionsButton[];
  /** The one Tab put the keyboard on, which Enter presses. */
  positionsButton?: PositionsButton | null;
  setPositionsButton?: (button: PositionsButton | null) => void;
  /** "Which tickers do you follow?": its search, rows and picks. */
  tickers?: OnboardingTickersState;
  /** Leaves it with the picks, or with none when skipped. */
  finishTickers?: (picks: readonly TickerPick[], skipped: boolean) => void;
  /** The workspace is being built: the step's keys wait. */
  buildingWorkspace?: boolean;
}) {
  const activeSection: OnboardingSectionId = stage === "portfolio" || stage === "desks" || stage === "tickers"
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
        // "Which tickers do you follow?" is skipped from its search field too.
        if (stage === "tickers") {
          if (!buildingWorkspace) finishTickers([], true);
          return true;
        }
        // The first run, holding nothing: F10 presses the portfolio step's Skip, the key it shows while the Ticker field has the keyboard.
        if (stage === "portfolio" && portfolioSub === "positions" && positionCount === 0 && !isBrokerCommitting && !progress.rerun) {
          skipPositions();
          return true;
        }
        // The first run needs a holding; a run from Settings can be left as it was.
        if (isBrokerCommitting || ((stage === "portfolio" || stage === "desks") && !progress.rerun)) return true;
        if (stage === "upgrade" && !planAccess.hasProAccess) continueFree();
        else void finish(true);
        return true;
      }

      if (sectionDigit) {
        if (sectionDigit !== activeSection && sectionAvailability[sectionDigit]) goToSection(sectionDigit);
        return true;
      }

      if (stage === "portfolio" && portfolioSub === "positions") {
        const lastField = POSITION_FIELDS.length - 1;
        if (editingField) {
          if (enter) {
            // A holding is listed and nothing more is typed: Enter is the Continue button.
            if (positionCount > 0 && positions.onEmptyTicker) continueFromPositions();
            else positions.submitField();
          } else if (tab) {
            // Past the last field Tab reaches the buttons (Skip, Continue), and Shift+Tab before the first: a way
            // out of the Ticker field in a terminal that sends no F10.
            const leaving = event.shift ? positions.fieldIdx <= 0 : positions.fieldIdx >= lastField;
            if (leaving && positionsButtons.length > 0) {
              setEditingField(false);
              setPositionsButton(event.shift ? positionsButtons[positionsButtons.length - 1]! : positionsButtons[0]!);
            } else {
              positions.setFieldIdx((index) => (event.shift ? Math.max(0, index - 1) : Math.min(lastField, index + 1)));
            }
          } else if (!chord && name === "escape") {
            setEditingField(false);
          } else {
            return false;
          }
          return true;
        }
        // A button Tab reached: Enter presses it, Tab and Shift+Tab move on, and past either end go back into the fields.
        const button = positionsButton && positionsButtons.includes(positionsButton) ? positionsButton : null;
        if (button) {
          setPositionsButton(null);
          if (enter) {
            if (button === "skip") skipPositions();
            else if (button === "broker") openBrokerConnect();
            else continueFromPositions();
            return true;
          }
          if (tab) {
            const next = positionsButtons.indexOf(button) + (event.shift ? -1 : 1);
            if (next >= 0 && next < positionsButtons.length) setPositionsButton(positionsButtons[next]!);
            else positions.focusField(event.shift ? lastField : 0);
            return true;
          }
          if (!chord && name === "escape") return true;
        }
        if (enter) {
          if (positionCount > 0) continueFromPositions();
          else positions.focusField(0);
        } else if (letter("a") || tab) {
          // Tab from the list goes back into the form, at its far end for Shift+Tab.
          positions.focusField(tab && event.shift ? POSITION_FIELDS.length - 1 : 0);
        } else if (letter(CONNECT_BROKER_KEY) && positionCount > 0) {
          openBrokerConnect();
        } else if (letter(SKIP_PORTFOLIO_KEY) && positionCount === 0) {
          skipPositions();
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
          // Nothing ticked yet: Enter ticks the highlighted desk, as Space does, rather than
          // doing nothing while Continue waits for one. The next Enter continues.
          const desk = DESKS[deskCursor];
          if (chosenDesks.length > 0) finishDesks(chosenDesks);
          else if (desk) setChosenDesks((current) => toggleDeskChoice(current, desk.key));
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

      if (stage === "tickers") {
        if (!tickers || buildingWorkspace) return true;
        // The search field has the keyboard: letters, digits and Backspace are typed.
        const typed = tickers.query.trim().length > 0;
        if (enter) {
          // Typed, Enter picks the highlighted result. Otherwise it continues once a name is
          // ticked, and before that ticks the highlighted one, as on the Desks step.
          if (!typed && tickers.picks.length > 0) finishTickers(tickers.picks, false);
          else tickers.toggleRow(tickers.cursor);
        } else if (!chord && name === "escape") {
          // A typed search is cleared first; the next Esc skips.
          if (tickers.query) tickers.setQuery("");
          else finishTickers([], true);
        } else if (!chord && name === "up") {
          tickers.moveCursor(-1);
        } else if (!chord && name === "down") {
          tickers.moveCursor(1);
        } else if (!typed && !chord && (name === "space" || event.sequence === " ")) {
          tickers.toggleRow(tickers.cursor);
        } else if (tab) {
          // Nothing to move to: the field keeps the keyboard.
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
          else goBack();
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
          goBack();
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
        else if (escape) goBack();
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
   * could want. It answers the notification keys, like a toast that stays up:
   * after a toast's own (the shell's handler is older and runs first), and
   * before the focused pane, so the key its buttons show acts on the card
   * only, never on the pane under it. Never in a field or while a pane holds
   * the keyboard: there Alt+Backspace deletes a word, as it should.
   */
  useShortcut((event) => {
    // A terminal reports Alt as meta, which reaches a handler even in a field: the field keeps it.
    if (event.targetEditable === true) return;
    const connect = matchesKeybindingAction(keybindings, "notification-action", event);
    const dismiss = matchesKeybindingAction(keybindings, "notification-dismiss", event) || isPlainKey(event, "f10");
    if (!connect && !dismiss) return;
    event.preventDefault();
    event.stopPropagation();
    if (connect) saveProgressInBackground({ stage: "account" });
    else void finish();
  }, {
    phase: "before",
    enabled: stage === "research" && !helpFocused && !coachAside && !inputCaptured && !dialogOpen && !commandBarOpen,
  });

  // Esc puts the card away, as it closes any card. Scoped, so it runs ahead
  // of the shell's double-Esc arming: this Esc is not half of closing the
  // pane under the card.
  useShortcut((event) => {
    if (event.targetEditable === true || !isPlainKey(event, "escape", "esc")) return;
    keepEscapeFromClosing(event);
    event.preventDefault();
    event.stopPropagation();
    void finish();
  }, {
    phase: "before",
    scope: "onboarding:research",
    enabled: stage === "research" && !helpFocused && !coachAside && !inputCaptured && !dialogOpen && !commandBarOpen,
  });
}
