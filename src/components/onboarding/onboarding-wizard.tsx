import { useCallback, useEffect, useRef, useState } from "react";
import { recordResearchActivity, type ResearchActivity } from "../../api-client/research-activity";
import type { AppBrokerImportRuntime } from "../../app/runtime/broker-import";
import { type AppConfig, findPaneInstance, type OnboardingStage } from "../../types/config";
import { useViewport } from "../../react/input";
import { useKeybindings } from "../../app/keybindings";
import { useAppDispatch, useAppSelector, useAppStateRef } from "../../state/app/context";
import {
  Box,
  Text,
  useActionShortcut,
  useCommandBarShortcut,
  useRendererHost,
  useUiCapabilities,
  type InputRenderable,
} from "../../ui";
import { useDialogState } from "../../ui/dialog";
import { useThemeColors } from "../../theme/theme-context";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import type { PluginRegistry } from "../../plugins/registry";
import { formatCloudPrice, monthsFreeYearly } from "../../plugins/builtin/account-management/model";
import { proStepCopy, proStepRealtimeTitle } from "../../plugins/builtin/cloud/upgrade-dialog";
import { Button, SegmentedControl, terminalButtonColumns } from "../ui";
import { AccountStep, PortfolioStep } from "./onboarding-steps";
import {
  ONBOARDING_DESKTOP,
  OnboardingActions,
  OnboardingButton,
  OnboardingCoach,
  OnboardingFeature,
  OnboardingHeader,
  OnboardingModal,
  OnboardingTitle,
  TERMINAL_CARD_INSET,
  terminalCardSize,
  type OnboardingSectionId,
} from "./onboarding-frame";
import { planProStep } from "./pro-step-layout";
import { useOnboardingAccount } from "./wizard-account";
import { useOnboardingBrokerSync } from "./wizard-broker-sync";
import { useOnboardingPositions } from "./wizard-positions";
import { DesksStep, toggleDeskChoice } from "./desks-step";
import { getOnboardingProgress } from "./wizard-model";
import {
  useOnboardingKeyboard,
  SKIP_SETUP_KEY,
  KEEP_FREE_KEY,
  CONNECT_BROKER_KEY,
  BROWSER_SIGN_IN_KEY,
  SKIP_DESKS_KEY,
} from "./onboarding-keyboard";
import { useOnboardingBrokerFields, useOnboardingBrokerForm } from "./use-onboarding-broker-form";
import { useOnboardingProgress, useOnboardingWorkspace, useOnboardingCompletion } from "./use-onboarding-progress";
import { useOnboardingUpgrade } from "./use-onboarding-upgrade";

export { keyReachesPastOnboardingModal } from "./onboarding-keyboard";

interface OnboardingWizardProps {
  pluginRegistry: PluginRegistry;
  importBrokerPositions: AppBrokerImportRuntime["importBrokerPositions"];
  onComplete: (config: AppConfig) => void | Promise<void>;
}

/** One funnel milestone per stage the user reaches; the account step reports sign-in itself. */
const STAGE_ACTIVITY: Partial<Record<OnboardingStage, ResearchActivity>> = {
  portfolio: "onboarding_started",
  research: "onboarding_research_opened",
  account: "onboarding_account_viewed",
  upgrade: "onboarding_pro_viewed",
};
function useOnboardingWizard({ pluginRegistry, importBrokerPositions, onComplete }: OnboardingWizardProps) {
  const language = useAppLanguage();
  const colors = useThemeColors();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const rendererHost = useRendererHost();
  const commandBarShortcut = useCommandBarShortcut();
  const notificationActionShortcut = useActionShortcut("notification-action");
  const notificationDismissShortcut = useActionShortcut("notification-dismiss");
  const keybindings = useKeybindings();
  const dialogOpen = useDialogState((dialog) => dialog.isOpen);
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const { width: viewportWidth, height: viewportHeight } = useViewport();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const config = useAppSelector((state) => state.config);
  const progress = getOnboardingProgress(config);
  const stage = progress.stage;
  const researchOpenedRef = useRef<string | null>(null);
  const [editingField, setEditingField] = useState(false);
  /** The added position the keyboard acts on once no field is being typed in. */
  const [positionCursorSymbol, setPositionCursorSymbol] = useState<string | null>(null);
  const inputRef = useRef<InputRenderable>(null);
  const {
    portfolioSub, setPortfolioSub, portfolioOptionIdx, setPortfolioOptionIdx, brokerValues, setBrokerValues,
    selectedBrokerId, setSelectedBrokerId, brokerFieldIdx, setBrokerFieldIdx, brokerSelectIdx,
    setBrokerSelectIdx, brokerOptions, brokerChoices, activeBrokerFields,
  } = useOnboardingBrokerFields({
    pluginRegistry, language,
  });
  const {
    persistenceError, setPersistenceError, isFinishing, setIsFinishing, progressSaveQueueRef, finishingRef,
    persistProgress, saveProgressInBackground,
  } = useOnboardingProgress({
    stateRef, dispatch,
  });

  // Pro follows sign-in directly. Email verification continues in the status
  // bar, so an unread inbox never stalls the first session.
  const account = useOnboardingAccount({
    nextStep: () => {
      recordResearchActivity("onboarding_signed_in");
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
    },
    setEditingField,
  });

  const positions = useOnboardingPositions({ pluginRegistry, onFieldEditing: setEditingField });
  const positionCount = positions.positions.length;
  // The cursor rests on the newest row until the keyboard moves it; it only
  // shows once the fields let go of the keyboard.
  const cursorMatch = positions.positions.findIndex((row) => row.symbol === positionCursorSymbol);
  const positionCursorIndex = cursorMatch >= 0 ? cursorMatch : positionCount - 1;
  const selectedPositionSymbol = !editingField && positionCursorIndex >= 0
    ? positions.positions[positionCursorIndex]!.symbol
    : null;

  useEffect(() => {
    const activity = STAGE_ACTIVITY[stage];
    if (activity) recordResearchActivity(activity);
  }, [stage]);

  useEffect(() => {
    if (stage === "portfolio" && positionCount > 0) recordResearchActivity("onboarding_position_added");
  }, [positionCount, stage]);

  // The portfolio step opens straight into the ticker field.
  useEffect(() => {
    if (stage === "portfolio" && portfolioSub === "positions") setEditingField(true);
  }, [portfolioSub, stage]);
  const {
    chosenDesks, setChosenDesks, deskCursor, setDeskCursor, buildingDesks, continueFromPositions,
    finishDesks, handleBrokerSynced,
  } = useOnboardingWorkspace({
    stateRef, pluginRegistry, dispatch, positions, setEditingField, saveProgressInBackground,
    setPersistenceError, finishingRef, brokerOptions, selectedBrokerId, setPortfolioSub,
  });

  const {
    isBrokerSyncing,
    isBrokerCommitting,
    brokerSyncError,
    resetBrokerSync,
    syncSelectedBroker,
    connectSignedInBroker,
  } = useOnboardingBrokerSync({
    config,
    brokerOptions,
    brokerValues,
    selectedBrokerId,
    importBrokerPositions,
    getConfig: () => stateRef.current.config,
    createBrokerInstance: (brokerType, label, values) => pluginRegistry.createBrokerInstance(brokerType, label, values),
    onSynced: handleBrokerSynced,
    setEditingField,
    setPortfolioSub,
  });
  const {
    finish, skipSetup,
  } = useOnboardingCompletion({
    finishingRef, resetBrokerSync, setIsFinishing, setPersistenceError, progressSaveQueueRef, stateRef,
    dispatch, onComplete,
  });
  const {
    setBrokerFieldValue, chooseBroker, openBrokerConnect, submitBrokerField, continuePortfolio,
    backPortfolio, openBrokerGuide,
  } = useOnboardingBrokerForm({
    selectedBrokerId, activeBrokerFields, brokerFieldIdx, brokerValues, setBrokerSelectIdx, resetBrokerSync,
    setBrokerValues, setSelectedBrokerId, setBrokerFieldIdx, brokerOptions, setEditingField,
    connectSignedInBroker, setPortfolioSub, portfolioOptionIdx, brokerChoices, setPortfolioOptionIdx,
    isBrokerSyncing, syncSelectedBroker, brokerSelectIdx, portfolioSub, continueFromPositions,
    brokerSyncError, rendererHost,
  });

  useEffect(() => {
    if (!editingField) return;
    const timer = setTimeout(() => inputRef.current?.focus?.(), 10);
    return () => clearTimeout(timer);
  }, [account.accountFieldIdx, account.accountSub, brokerFieldIdx, editingField, portfolioSub, positions.fieldIdx]);

  useEffect(() => {
    if (stage !== "account") return;
    account.syncExistingAccountSession();
  }, [account.syncExistingAccountSession, stage]);

  useEffect(() => {
    if (stage !== "research" || !progress.tickerSymbol || researchOpenedRef.current === progress.tickerSymbol) return;
    researchOpenedRef.current = progress.tickerSymbol;
    recordResearchActivity("ticker_saved");
  }, [stage, progress.tickerSymbol]);
  const movePositionCursor = useCallback((delta: number) => {
    if (positionCursorIndex < 0) return;
    const next = Math.max(0, Math.min(positionCount - 1, positionCursorIndex + delta));
    setPositionCursorSymbol(positions.positions[next]?.symbol ?? null);
  }, [positionCount, positionCursorIndex, positions.positions]);

  /** Removes the row under the cursor; the cursor moves to the row that takes its place. */
  const removePositionAtCursor = useCallback(() => {
    if (!selectedPositionSymbol) return;
    const neighbour = positions.positions[positionCursorIndex + 1] ?? positions.positions[positionCursorIndex - 1];
    setPositionCursorSymbol(neighbour?.symbol ?? null);
    void positions.removePosition(selectedPositionSymbol);
  }, [positionCursorIndex, positions, selectedPositionSymbol]);

  const submitAccountField = useCallback(() => {
    setEditingField(false);
    account.submitAccountField();
  }, [account.submitAccountField]);

  const continueAccount = useCallback(() => {
    // The QR panel owns enter (retry after a denial); approval advances itself.
    if (account.accountSub === "qr") return;
    if (account.accountSub === "signed-in") {
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
      return;
    }
    submitAccountField();
  }, [account.accountSub, saveProgressInBackground, submitAccountField]);

  // The account step opens on the email form with the cursor in it.
  useEffect(() => {
    if (stage === "account" && (account.accountSub === "signup" || account.accountSub === "login")) setEditingField(true);
  }, [account.accountSub, stage]);

  const focusedPaneId = useAppSelector((state) => state.focusedPaneId);
  const focusedInstance = focusedPaneId
    ? findPaneInstance(config.layout, focusedPaneId)
    : null;
  const helpFocused = focusedInstance?.paneId === "help";
  const {
    offer, pricing, billingInterval, setBillingInterval, planAccess, primaryUpgradeAction, continueFree, personalTickers,
  } = useOnboardingUpgrade({
    stage, progress, saveProgressInBackground, persistProgress,
    shown: !helpFocused && !dialogOpen && !commandBarOpen,
  });

  const goToSection = useCallback((section: OnboardingSectionId) => {
    if (finishingRef.current || isBrokerCommitting) return;
    setEditingField(false);
    if (section === "portfolio") {
      setPortfolioSub("positions");
      saveProgressInBackground({ stage: "portfolio" });
      return;
    }
    if (section === "cloud") {
      saveProgressInBackground({ stage: "account" });
      return;
    }
    if (planAccess.signedIn) {
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
    }
  }, [isBrokerCommitting, planAccess.signedIn, saveProgressInBackground]);

  const sectionAvailability: Partial<Record<OnboardingSectionId, boolean>> = {
    portfolio: !isBrokerCommitting,
    // The workspace is built when the desks are picked, so that step comes first.
    cloud: !isBrokerCommitting && stage !== "desks" && (stage === "account" || stage === "upgrade" || stage === "ready" || !!progress.tickerSymbol),
    pro: !isBrokerCommitting && planAccess.signedIn && (
      stage === "upgrade"
      || stage === "ready"
      || progress.accountStatus === "signed-in"
    ),
  };
  // Enter inside every form is handled once, by the shortcut below: the
  // fields deliberately get no onSubmit, because the host input fires it in
  // the same keystroke and the two paths used to submit twice.
  useOnboardingKeyboard({
    stage, progress, account, helpFocused, editingField, isBrokerCommitting, planAccess, continueFree,
    finish, sectionAvailability, goToSection, portfolioSub, positions, setEditingField, positionCount,
    continueFromPositions, openBrokerConnect, movePositionCursor, removePositionAtCursor, submitBrokerField,
    submitAccountField, backPortfolio, continuePortfolio, setPortfolioOptionIdx, activeBrokerFields,
    brokerFieldIdx, setBrokerSelectIdx, brokerChoices, openBrokerGuide, chosenDesks, finishDesks,
    setDeskCursor, deskCursor, setChosenDesks, continueAccount, skipSetup, primaryUpgradeAction,
    setBillingInterval, keybindings, dialogOpen, commandBarOpen, saveProgressInBackground,
  });

  return {
    helpFocused, stage, progress, notificationDismissShortcut, finish, notificationActionShortcut,
    saveProgressInBackground, colors, commandBarShortcut, selectedBrokerId, brokerOptions, portfolioSub,
    sectionAvailability, goToSection, skipSetup, isFinishing, isBrokerCommitting, desktop, positions,
    inputRef, editingField, selectedPositionSymbol, brokerChoices, portfolioOptionIdx, setPortfolioOptionIdx,
    chooseBroker, activeBrokerFields, brokerFieldIdx, brokerSelectIdx, setBrokerSelectIdx, brokerValues,
    setBrokerFieldValue, isBrokerSyncing, brokerSyncError, persistenceError, positionCount,
    openBrokerConnect, continueFromPositions, backPortfolio, continuePortfolio, chosenDesks, deskCursor,
    setDeskCursor, setChosenDesks, buildingDesks, finishDesks, account, viewportWidth, viewportHeight, continueAccount,
    offer, planAccess, pricing, billingInterval, setBillingInterval, continueFree, primaryUpgradeAction,
    personalTickers,
  };
}

export function OnboardingWizard(props: OnboardingWizardProps) {
  const {
    helpFocused, stage, progress, notificationDismissShortcut, finish, notificationActionShortcut,
    saveProgressInBackground, colors, commandBarShortcut, selectedBrokerId, brokerOptions, portfolioSub,
    sectionAvailability, goToSection, skipSetup, isFinishing, isBrokerCommitting, desktop, positions,
    inputRef, editingField, selectedPositionSymbol, brokerChoices, portfolioOptionIdx, setPortfolioOptionIdx,
    chooseBroker, activeBrokerFields, brokerFieldIdx, brokerSelectIdx, setBrokerSelectIdx, brokerValues,
    setBrokerFieldValue, isBrokerSyncing, brokerSyncError, persistenceError, positionCount,
    openBrokerConnect, continueFromPositions, backPortfolio, continuePortfolio, chosenDesks, deskCursor,
    setDeskCursor, setChosenDesks, buildingDesks, finishDesks, account, viewportWidth, viewportHeight, continueAccount,
    offer, planAccess, pricing, billingInterval, setBillingInterval, continueFree, primaryUpgradeAction,
    personalTickers,
  } = useOnboardingWizard(props);

  if (helpFocused) {
    return null;
  }

  if (stage === "research") {
    const ticker = progress.tickerSymbol ?? t("your company");
    return <OnboardingCoach step={t("YOUR WORKSPACE")}
      title={tf("Built around {ticker}", { ticker })}
      actions={<>
        {/* The card has no room for both keys: like a toast, the dismiss key
            is in the desktop tooltip. F10 also dismisses it. */}
        <OnboardingButton
          label="Keep exploring"
          variant="ghost"
          title={notificationDismissShortcut ? `${t("Keep exploring")} (${notificationDismissShortcut})` : undefined}
          onPress={() => { void finish(); }}
        />
        <OnboardingButton
          label="Connect free Cloud"
          variant="primary"
          shortcut={notificationActionShortcut || undefined}
          onPress={() => saveProgressInBackground({ stage: "account" })}
        />
      </>}>
      <Text fg={colors.textDim} wrapText>{tf(progress.desks?.length
        ? "Your holdings as a heatmap, a watchlist, and {ticker} charted. Your desks are tabs at the bottom; {shortcut} adds more."
        : "Your holdings as a heatmap, a watchlist, and {ticker} charted. Every pane moves; {shortcut} adds more.", {
        ticker,
        shortcut: commandBarShortcut,
      })}</Text>
    </OnboardingCoach>;
  }

  if (stage === "portfolio") {
    const selectedBroker = selectedBrokerId
      ? brokerOptions.find((option) => option.id === selectedBrokerId)
      : null;
    const selectedBrokerName = selectedBroker?.name;
    const portfolioModalHeight = portfolioSub === "positions"
      ? 22
      : portfolioSub === "choose"
        ? 16
        : portfolioSub === "broker-setup"
          ? 21
          : portfolioSub === "broker-sync"
            ? 14
            : 20;
    const title = portfolioSub === "positions"
      ? t("What do you hold?")
      : portfolioSub === "choose"
        ? t("Connect a broker")
        : selectedBrokerName
          ? tf("Connect {broker}", { broker: selectedBrokerName })
          : t("Set up a portfolio");
    // A signed-in broker keeps its credentials with the broker, so the line is left out.
    const description = portfolioSub === "positions"
      ? undefined
      : portfolioSub === "choose"
        ? brokerOptions.some((option) => option.signedIn) ? undefined : t("Credentials stay on this device.")
        : selectedBroker?.signedIn
          ? undefined
          : t("Enter the connection details for this broker. Credentials stay on this device.");
    return (
      <OnboardingModal width={76} height={portfolioModalHeight} desktopWidth="min(620px, 100%)">
        <OnboardingHeader
          active="portfolio"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={skipSetup}
          dismissing={isFinishing}
          dismissDisabled={isBrokerCommitting}
          showDismiss={false}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("PORTFOLIO")}
          title={title}
          description={description}
        />
        <Box minHeight={0}>
          <PortfolioStep
            sub={portfolioSub}
            positions={positions}
            positionsInputRef={inputRef}
            positionsEditing={editingField}
            selectedPositionSymbol={selectedPositionSymbol}
            commandBarShortcut={commandBarShortcut}
            choices={brokerChoices}
            optionIdx={portfolioOptionIdx}
            onOptionSelect={setPortfolioOptionIdx}
            onOptionActivate={chooseBroker}
            selectedBrokerId={selectedBrokerId}
            brokerFields={activeBrokerFields}
            brokerFieldIdx={brokerFieldIdx}
            brokerSelectIdx={brokerSelectIdx}
            onBrokerSelect={setBrokerSelectIdx}
            brokerValues={brokerValues}
            onBrokerFieldChange={setBrokerFieldValue}
            editing={editingField}
            inputRef={inputRef}
            brokerSyncing={isBrokerSyncing}
            brokerSyncError={brokerSyncError}
          />
        </Box>
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        <OnboardingActions hint={portfolioSub === "positions" && desktop ? tf("Later: {shortcut}, then AP.", { shortcut: commandBarShortcut }) : undefined}>
          {portfolioSub === "positions" ? (
            <>
              {brokerOptions.length > 0 && positionCount > 0 ? (
                <OnboardingButton label="Connect a broker" variant="ghost" shortcut={CONNECT_BROKER_KEY} onPress={openBrokerConnect} />
              ) : null}
              <OnboardingButton
                label="Continue"
                variant="primary"
                disabled={positionCount === 0 || positions.submitting}
                onPress={continueFromPositions}
              />
            </>
          ) : (
            <>
              <OnboardingButton label="Back" variant="ghost" disabled={isBrokerCommitting} onPress={backPortfolio} />
              {!desktop || portfolioSub !== "choose" ? (
                <OnboardingButton
                  label={portfolioSub === "broker-sync" ? (isBrokerSyncing ? t("Importing...") : t("Retry")) : t("Continue")}
                  variant="primary"
                  disabled={isBrokerSyncing}
                  onPress={continuePortfolio}
                />
              ) : null}
            </>
          )}
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  if (stage === "desks") {
    return (
      <OnboardingModal width={68} height={18 + (persistenceError ? 1 : 0)}>
        <OnboardingHeader
          active="portfolio"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={skipSetup}
          dismissing={isFinishing}
          showDismiss={false}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("DESKS")}
          title={t("What do you trade?")}
          description={t("Each one adds a ready-made desk as a tab.")}
        />
        {/* Not allowed to shrink: on a short window the card scrolls instead of the list running under the buttons. */}
        <DesksStep
          chosen={chosenDesks}
          cursor={deskCursor}
          onCursor={setDeskCursor}
          onToggle={(key) => setChosenDesks((current) => toggleDeskChoice(current, key))}
        />
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        <OnboardingActions>
          <OnboardingButton
            label="Skip"
            variant="ghost"
            shortcut={SKIP_DESKS_KEY}
            disabled={buildingDesks}
            onPress={() => finishDesks([])}
          />
          <OnboardingButton
            label="Continue"
            variant="primary"
            disabled={chosenDesks.length === 0 || buildingDesks}
            onPress={() => finishDesks(chosenDesks)}
          />
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  if (stage === "account") {
    const accountActionLabel = account.accountSub === "signed-in"
      ? t("See Pro plans")
      : account.accountSub === "login"
        ? t("Log in")
        : t("Continue");
    const accountTitle = account.accountSub === "signup"
      ? t("Connect Gloom Cloud")
      : account.accountSub === "login"
        ? t("Log in")
        : account.accountSub === "qr"
          ? t("Continue in browser")
          : t("Connected");
    const accountDescription = account.accountSub === "qr"
      ? t("Open the sign-in link, or scan the code with your phone.")
      : account.accountSub === "signup"
        ? t("Gloom Cloud adds the data layer: quotes, news, filings and Ask Gloom, synced to every device. Free account.")
        : account.accountSub === "login"
          ? t("Enter the password for this account.")
          : t("Next: real-time Pro data.");
    const accountStatusRows = account.accountSubmitting || account.accountValidationError || account.accountSubmitError
      ? 1
      : 0;
    // The QR grid is the tallest thing this wizard ever shows; DeviceSignInPanel
    // degrades to the code plus URL when the terminal cannot give it these rows.
    const accountModalHeight = account.accountSub === "qr"
      ? 32
      : account.accountSub === "signed-in"
        ? 12
        : 17 + (account.accountFieldIdx > 0 ? 2 : 0) + accountStatusRows;
    const browserSignIn = account.accountSub === "signup" || account.accountSub === "login";
    // OnboardingModal clamps the card to the viewport, so the panel has to size
    // off the clamped height or the QR overflows a short terminal.
    const accountPanelHeight = Math.max(4, Math.min(accountModalHeight, viewportHeight - 2) - 9);
    return (
      <OnboardingModal
        width={68}
        height={accountModalHeight}
      >
        <OnboardingHeader
          active="cloud"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={skipSetup}
          dismissShortcut={SKIP_SETUP_KEY}
          dismissing={isFinishing}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("GLOOM CLOUD")}
          title={accountTitle}
          description={accountDescription}
        />
        <Box minHeight={0}>
          <AccountStep
            sub={account.accountSub}
            email={account.accountEmail}
            password={account.accountPassword}
            fieldIdx={account.accountFieldIdx}
            editing={editingField}
            inputRef={inputRef}
            submitting={account.accountSubmitting}
            submitError={account.accountSubmitError}
            validationError={account.accountValidationError}
            outcome={account.accountOutcome}
            onEmailChange={account.setAccountEmail}
            onPasswordChange={account.setAccountPassword}
            onFieldFocus={account.focusAccountField}
            onQrApproved={account.completeQrSignIn}
            height={accountPanelHeight}
          />
        </Box>
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        {!desktop && browserSignIn ? (
          <Box height={1}>
            <Text fg={colors.textMuted}>{t("b: sign in with the browser instead")}</Text>
          </Box>
        ) : null}
        <OnboardingActions
          hint={desktop && browserSignIn ? (
            <Button label="Sign in with the browser instead" variant="plain" compact shortcut={BROWSER_SIGN_IN_KEY} onPress={account.beginQrSignIn} />
          ) : undefined}
        >
          <OnboardingButton
            label="Back"
            variant="ghost"
            onPress={account.accountSub === "qr" || account.accountSub === "login" ? account.returnToAccountForm : () => goToSection("portfolio")}
          />
          {account.accountSub !== "qr" ? (
            <OnboardingButton
              label={accountActionLabel}
              variant="primary"
              disabled={account.accountSubmitting}
              onPress={continueAccount}
            />
          ) : null}
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  if (stage === "upgrade") {
    const proCopy = proStepCopy(offer);
    const primaryLabel = planAccess.hasProAccess ? t("Continue with Pro") : proCopy.confirmLabel;
    const price = formatCloudPrice(pricing, billingInterval);
    const monthsFree = monthsFreeYearly(pricing);
    const yearlyLabel = monthsFree > 0 ? tf("Yearly, {months} months free", { months: monthsFree }) : t("Yearly");
    const priceNote = billingInterval === "year" && monthsFree > 0 ? tf("{months} months free", { months: monthsFree }) : null;
    const proNote = planAccess.hasProAccess
      ? t("This account already has real-time Cloud data.")
      : proCopy.note;
    // Ranked: the data itself first, then what reads it.
    const features = [
      { title: proStepRealtimeTitle(personalTickers), description: t("Free is 15 minutes behind on quotes and 12 hours on news.") },
      { title: t("MCP server"), description: t("Claude Code, Codex or Cursor call Gloom's research tools.") },
      { title: t("Ask Gloom"), description: t("Answers cite filings, calls and news.") },
      { title: t("Earnings calls"), description: t("Transcripts, summaries, guidance and scores.") },
      { title: t("Equity Diagnostic"), description: t("Full report: red and green flags with evidence.") },
      { title: t("Search, theses and flow"), description: t("Instant search with alerts, thesis monitoring, options flow, hiring and compensation data.") },
    ];
    // The terminal card is clamped to the viewport, so the list gets the rows
    // the card leaves it. The DOM card grows with its content instead.
    const card = terminalCardSize({ width: viewportWidth, height: viewportHeight }, 70, 28);
    const layout = desktop ? null : planProStep({
      rows: card.height - TERMINAL_CARD_INSET.rows,
      columns: card.width - TERMINAL_CARD_INSET.columns,
      note: proNote,
      interval: !planAccess.hasProAccess,
      error: persistenceError,
      actions: [
        ...(planAccess.hasProAccess ? [] : [terminalButtonColumns({ label: "Keep Free for now", shortcut: KEEP_FREE_KEY })]),
        terminalButtonColumns({ label: primaryLabel }),
      ],
      descriptions: features.map((feature) => feature.description),
    });
    return (
      <OnboardingModal width={70} height={28}>
        <OnboardingHeader
          active="pro"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={skipSetup}
          dismissing={isFinishing}
          showDismiss={false}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("GLOOM CLOUD PRO")}
          title={planAccess.hasProAccess ? t("Pro is active") : price}
          titleSuffix={!planAccess.hasProAccess && priceNote ? priceNote : undefined}
          description={proNote}
          compact={layout?.compact}
        />
        {!planAccess.hasProAccess ? (
          <Box flexDirection="row" style={desktop ? { marginTop: 12 } : undefined} paddingTop={desktop || layout?.compact ? undefined : 1}>
            <SegmentedControl
              options={[
                { label: t("Monthly"), value: "month" },
                { label: yearlyLabel, value: "year" },
              ]}
              value={billingInterval}
              onChange={(value) => setBillingInterval(value === "year" ? "year" : "month")}
              // The card's Left and Right move it on both hosts.
              focused
            />
          </Box>
        ) : null}
        <Box flexDirection="column" style={desktop ? { marginTop: ONBOARDING_DESKTOP.afterHeader, gap: 10 } : undefined}>
          {features.map((feature, index) => layout?.featureRows[index] === 0 ? null : (
            <OnboardingFeature key={index} {...feature} rows={layout?.featureRows[index]} />
          ))}
        </Box>
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        <OnboardingActions>
          {!planAccess.hasProAccess ? (
            <OnboardingButton
              label="Keep Free for now"
              variant="secondary"
              shortcut={KEEP_FREE_KEY}
              onPress={continueFree}
            />
          ) : null}
          <OnboardingButton
            label={primaryLabel}
            variant="primary"
            onPress={primaryUpgradeAction}
          />
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  const readyDescription = progress.tickerSymbol
    ? tf("{ticker} is open. {shortcut}, then AP, adds more.", {
      ticker: progress.tickerSymbol,
      shortcut: commandBarShortcut,
    })
    : t("Your local workspace is ready. You can connect Cloud or add a portfolio later.");

  return (
    <OnboardingModal width={66} height={12}>
      <OnboardingHeader
        active={progress.accountStatus === "signed-in" ? "pro" : "cloud"}
        available={sectionAvailability}
        onNavigate={goToSection}
        onDismiss={skipSetup}
        dismissing={isFinishing}
        showDismiss={false}
      />
      <OnboardingTitle
        step={desktop ? undefined : t("READY")}
        title={t("Your workspace is ready")}
        description={readyDescription}
      />
      {persistenceError ? (
        <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
          {persistenceError}
        </Text>
      ) : null}
      <OnboardingActions>
        <OnboardingButton
          label="Back"
          variant="ghost"
          onPress={() => goToSection(progress.accountStatus === "signed-in" ? "pro" : "cloud")}
        />
        <OnboardingButton
          label={isFinishing ? "Opening workspace..." : "Start exploring"}
          variant="primary"
          disabled={isFinishing}
          onPress={() => { void finish(); }}
        />
      </OnboardingActions>
    </OnboardingModal>
  );
}
