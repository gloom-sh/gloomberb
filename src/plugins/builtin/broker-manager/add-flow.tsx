import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { apiClient } from "../../../api-client";
import {
  brokerMethodLabel,
  brokerMethodSummary,
  buildBrokerDirectory,
  type BrokerDirectoryEntry,
  type BrokerMethod,
} from "../../../brokers/directory";
import {
  buildBrokerProfileConfig,
  createBrokerProfileDraft,
  getVisibleBrokerConfigFields,
  validateBrokerProfileValues,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { getSignedInBrokers, refreshSignedInBrokers, subscribeSignedInBrokers } from "../../../brokers/signed-in/catalog";
import type { SignedInBroker } from "../../../brokers/signed-in/client";
import { connectSignedInBrokerProfile } from "../../../brokers/signed-in/connect";
import { SIGNED_IN_BROKER_TYPE } from "../../../brokers/signed-in/profile";
import { runBrokerSignIn, type BrokerSignInOutcome } from "../../../brokers/signed-in/sign-in";
import { promptGloomSignIn, useBrokerSignInAttempt } from "../../../brokers/signed-in/sign-in-dialog";
import { Button, confirmDialog, ListView, useFieldRing } from "../../../components";
import { showCollectionInPortfolioPane } from "../../../components/command-bar/pane-actions";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { BrokerConnectView } from "../../../components/form-modal/broker-step";
import { listCursorMove, type ListViewItem } from "../../../components/ui/list-view";
import { t, tf } from "../../../i18n";
import { useShortcut, type KeyEventLike } from "../../../react/input";
import { useAppDispatch, useAppGetState } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import { Box, ScrollBox, Text, type ScrollBoxRenderable } from "../../../ui";
import { useDialog } from "../../../ui/dialog";
import { isPlainKey } from "../../../utils/keyboard";
import { usePluginAppActions, usePluginBrokerActions } from "../../runtime";
import { BrokerProfileForm, profileFieldWidth, type BrokerEditKey } from "./detail";
import { useBrokerManagerKeyboard } from "./keyboard";
import type { BrokerManagerMessage } from "./pane-actions";

/**
 * Adding a profile, one step at a time in the pane's detail: the broker, how
 * it connects when it offers both ways, then its fields on this device or the
 * connect step for signing in.
 */
export type BrokerAddStep =
  | { kind: "broker" }
  | { kind: "method"; entry: BrokerDirectoryEntry }
  | {
    kind: "device";
    entry: BrokerDirectoryEntry;
    adapter: BrokerAdapter;
    draft: BrokerProfileDraft;
    activeKey: BrokerEditKey;
  }
  | {
    kind: "sign-in";
    entry: BrokerDirectoryEntry;
    broker: SignedInBroker;
    /** The connect attempt on show; none while Gloom's own sign-in is up. */
    attempt: { id: number; write: boolean } | null;
  };

export interface BrokerAddFlowState {
  /** One per start, so work from an earlier flow leaves this one alone. */
  id: number;
  /** The brokers installed when the flow started, or when the signed-in list came in. */
  directory: BrokerDirectoryEntry[];
  step: BrokerAddStep;
  /** The row the cursor is on in the broker or method list. */
  cursor: number;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

let flowSequence = 0;
let attemptSequence = 0;

export function useBrokerAddFlow({
  setBusy,
  setMessage,
  onProfileAdded,
}: {
  setBusy: (busy: string | null) => void;
  setMessage: (message: BrokerManagerMessage | null) => void;
  /** Lands the pane on the profile the flow made, with the flow closed. */
  onProfileAdded: (instanceId: string) => void;
}) {
  const dialog = useDialog();
  const dispatch = useAppDispatch();
  const getState = useAppGetState();
  const { notify } = usePluginAppActions();
  const { listBrokerAdapters, createBrokerInstance, syncBrokerInstance } = usePluginBrokerActions();
  const [flow, setFlowState] = useState<BrokerAddFlowState | null>(null);
  // Async work reads the flow as it is now, not as it was when it started.
  const flowRef = useRef<BrokerAddFlowState | null>(null);
  // Ends the connect attempt on show: its outcome, or "cancelled" when the flow goes.
  const endAttemptRef = useRef<((outcome: BrokerSignInOutcome) => void) | null>(null);
  // From Connect, or a connected sign-in, until the pane lands on the new
  // profile: the profile is being made, and leaving would not undo that.
  const committingRef = useRef(false);

  const setFlow = useCallback((update: (current: BrokerAddFlowState | null) => BrokerAddFlowState | null) => {
    const next = update(flowRef.current);
    if (next === flowRef.current) return;
    flowRef.current = next;
    setFlowState(next);
  }, []);

  const setStep = useCallback((flowId: number, step: BrokerAddStep, cursor = 0) => {
    setFlow((current) => current?.id === flowId ? { ...current, step, cursor } : current);
  }, [setFlow]);

  // The pane going, or the flow, cancels the connect attempt: no profile is made.
  useEffect(() => () => endAttemptRef.current?.("cancelled"), []);

  const listAdaptersRef = useRef(listBrokerAdapters);
  listAdaptersRef.current = listBrokerAdapters;
  // Built when asked: brokers are installed and removed while the app runs.
  const buildDirectory = useCallback(() => buildBrokerDirectory({
    signedIn: getSignedInBrokers(),
    adapters: listAdaptersRef.current(),
  }), []);
  // A signed-in list that arrives after the flow started fills in the broker list.
  const signedInBrokers = useSyncExternalStore(subscribeSignedInBrokers, getSignedInBrokers, getSignedInBrokers);
  useEffect(() => {
    setFlow((current) => current?.step.kind === "broker" ? { ...current, directory: buildDirectory() } : current);
  }, [buildDirectory, setFlow, signedInBrokers]);

  const start = useCallback(() => {
    endAttemptRef.current?.("cancelled");
    if (listAdaptersRef.current().some((adapter) => adapter.id === SIGNED_IN_BROKER_TYPE)) void refreshSignedInBrokers();
    flowSequence += 1;
    setFlow(() => ({ id: flowSequence, directory: buildDirectory(), step: { kind: "broker" }, cursor: 0 }));
    setMessage(null);
  }, [buildDirectory, setFlow, setMessage]);

  const leave = useCallback(() => {
    // Esc, Back and the mouse's back button wait, as the disabled Cancel does.
    if (committingRef.current) return;
    endAttemptRef.current?.("cancelled");
    setFlow(() => null);
    // A field the form asked for is no longer asked for.
    setMessage(null);
  }, [setFlow, setMessage]);

  /** The pane on the new profile and its portfolio, as Add Broker always ended; or the reason its first sync failed. */
  const syncNewProfile = useCallback(async (flowId: number, instanceId: string, label: string) => {
    const land = () => {
      if (flowRef.current?.id !== flowId) return;
      setFlow(() => null);
      onProfileAdded(instanceId);
    };
    try {
      setBusy(t("Syncing…"));
      await syncBrokerInstance(instanceId);
      land();
      const state = getState();
      const portfolio = state.config.portfolios.find((entry) => entry.brokerInstanceId === instanceId);
      if (portfolio) showCollectionInPortfolioPane(state, dispatch, portfolio.id);
      notify({ body: t("Connected! Positions will sync automatically."), type: "success" });
    } catch (error) {
      // The profile stays: its detail and the footer say why it did not sync.
      land();
      setMessage({ tone: "error", text: errorText(error, tf("Failed to sync {label}.", { label })) });
    } finally {
      setBusy(null);
    }
  }, [dispatch, getState, notify, onProfileAdded, setBusy, setFlow, setMessage, syncBrokerInstance]);

  const connectDevice = useCallback(async () => {
    const current = flowRef.current;
    if (!current || current.step.kind !== "device" || committingRef.current) return;
    const { adapter, draft } = current.step;
    const label = draft.label.trim();
    if (!label) {
      setMessage({ tone: "error", text: t("Profile label is required.") });
      return;
    }
    const validationError = validateBrokerProfileValues(adapter, draft.values);
    if (validationError) {
      setMessage({ tone: "error", text: validationError });
      return;
    }
    committingRef.current = true;
    setMessage(null);
    try {
      setBusy(t("Connecting broker…"));
      let instanceId: string;
      try {
        const config = buildBrokerProfileConfig(adapter, draft.values);
        const proposed = { id: "new-profile", brokerType: adapter.id, label, enabled: true, config };
        if (adapter.getTradingCapabilities?.(proposed).enabled && !await confirmDialog(dialog, {
          title: "Enable trading?", body: "Orders can commit real money. Start with a simulation account. Every order needs review and confirmation; LIVE orders also need a typed confirmation. You can turn trading off in Brokers at any time.",
          confirmLabel: "Enable trading", confirmVariant: "danger",
        })) { setBusy(null); return; }
        const instance = await createBrokerInstance(adapter.id, label, config);
        instanceId = instance.id;
      } catch (error) {
        setBusy(null);
        setMessage({ tone: "error", text: errorText(error, t("Failed to save broker profile.")) });
        return;
      }
      await syncNewProfile(current.id, instanceId, label);
    } finally {
      committingRef.current = false;
    }
  }, [createBrokerInstance, dialog, setBusy, setMessage, syncNewProfile]);

  /** Shows one connect attempt in the pane until it ends, then says how. */
  const showAttempt = useCallback((flowId: number, write: boolean) => new Promise<BrokerSignInOutcome>((resolve) => {
    if (flowRef.current?.id !== flowId || flowRef.current.step.kind !== "sign-in") {
      resolve("cancelled");
      return;
    }
    const end = (outcome: BrokerSignInOutcome) => {
      if (endAttemptRef.current !== end) return;
      endAttemptRef.current = null;
      resolve(outcome);
    };
    endAttemptRef.current = end;
    attemptSequence += 1;
    const attempt = { id: attemptSequence, write };
    setFlow((current) => current?.id === flowId && current.step.kind === "sign-in"
      ? { ...current, step: { ...current.step, attempt } }
      : current);
  }), [setFlow]);

  const signIn = useCallback(async (flowId: number, entry: BrokerDirectoryEntry, broker: SignedInBroker) => {
    const onStep = () => flowRef.current?.id === flowId && flowRef.current.step.kind === "sign-in";
    let committing = false;
    try {
      let connected: { instance: BrokerInstanceConfig } | null;
      try {
        connected = await connectSignedInBrokerProfile(broker, {
          getConfig: () => getState().config,
          createBrokerInstance,
          // The first sync runs below, with its progress in the pane.
          syncBrokerInstance: async () => {},
          // Gloom's sign-in over the pane when needed, again after a session Gloom refused.
          requestSignIn: async (target) => {
            const signedIn = await runBrokerSignIn(target, undefined, {
              isSignedIn: () => apiClient.isSignedIn(),
              signInToGloom: async () => onStep() && await promptGloomSignIn(dialog),
              connectBroker: (_broker, write) => showAttempt(flowId, write),
            });
            // Connected in this flow: its profile is made next.
            if (signedIn && onStep()) {
              committing = true;
              committingRef.current = true;
            }
            return signedIn;
          },
        });
      } catch (error) {
        setMessage({ tone: "error", text: errorText(error, tf("{broker} was not connected.", { broker: broker.name })) });
        if (onStep()) setStep(flowId, { kind: "broker" });
        return;
      }
      if (!connected) {
        // Backed out of Gloom's sign-in: back to the choice made. A cancelled
        // connect step closed the flow already.
        const current = flowRef.current;
        if (!onStep() || !current) return;
        const choosesMethod = entry.methods.length > 1;
        const cursor = choosesMethod
          ? entry.methods.findIndex((method) => method.kind === "signed-in")
          : current.directory.findIndex((candidate) => candidate.key === entry.key);
        setStep(flowId, choosesMethod ? { kind: "method", entry } : { kind: "broker" }, Math.max(0, cursor));
        return;
      }
      await syncNewProfile(flowId, connected.instance.id, connected.instance.label);
    } finally {
      if (committing) committingRef.current = false;
    }
  }, [createBrokerInstance, dialog, getState, setMessage, setStep, showAttempt, syncNewProfile]);

  const chooseMethod = useCallback((entry: BrokerDirectoryEntry, method: BrokerMethod) => {
    const current = flowRef.current;
    if (!current) return;
    setMessage(null);
    if (method.kind === "device") {
      // The profile is named after the broker until the user names it.
      const draft = { ...createBrokerProfileDraft(method.adapter), label: entry.name };
      setStep(current.id, { kind: "device", entry, adapter: method.adapter, draft, activeKey: "label" });
      return;
    }
    setStep(current.id, { kind: "sign-in", entry, broker: method.broker, attempt: null });
    void signIn(current.id, entry, method.broker);
  }, [setMessage, setStep, signIn]);

  const chooseBroker = useCallback((entry: BrokerDirectoryEntry) => {
    const current = flowRef.current;
    if (!current) return;
    if (entry.methods.length > 1) {
      setStep(current.id, { kind: "method", entry });
      return;
    }
    const method = entry.methods[0];
    if (method) chooseMethod(entry, method);
  }, [chooseMethod, setStep]);

  const setCursor = useCallback((cursor: number) => {
    setFlow((current) => current && current.cursor !== cursor ? { ...current, cursor } : current);
  }, [setFlow]);

  const updateDraft = useCallback((update: (step: Extract<BrokerAddStep, { kind: "device" }>) => Partial<Extract<BrokerAddStep, { kind: "device" }>>) => {
    setFlow((current) => current?.step.kind === "device"
      ? { ...current, step: { ...current.step, ...update(current.step) } }
      : current);
  }, [setFlow]);

  /** Ends the attempt on show; a later outcome from an attempt already ended does nothing. */
  const endAttempt = useCallback((outcome: "connected" | "signed-out") => {
    endAttemptRef.current?.(outcome);
  }, []);

  const title = !flow
    ? ""
    : flow.step.kind === "broker"
      ? t("Add Broker Account")
      : flow.step.kind === "method"
        ? flow.step.entry.name
        : flow.step.kind === "device"
          ? tf("Connect {broker}", { broker: flow.step.entry.name })
          : tf("Connect {broker}", { broker: flow.step.broker.name });

  return {
    flow,
    title,
    /** A text field has the keyboard: global shortcuts wait. */
    capturesInput: flow?.step.kind === "device",
    start,
    leave,
    chooseBroker,
    chooseMethod,
    setCursor,
    updateDraft,
    connectDevice,
    endAttempt,
  };
}

export type BrokerAddFlow = ReturnType<typeof useBrokerAddFlow>;

/** The add flow's step, in the pane's detail. */
export function BrokerAddFlowContent({
  addFlow,
  busy,
  focused,
  width,
  height,
  scope,
}: {
  addFlow: BrokerAddFlow;
  busy: string | null;
  focused: boolean;
  /** Columns inside the detail's inset. */
  width: number;
  /** Rows under the stack's title. */
  height: number;
  /** The device form's shortcut scope. */
  scope: string;
}) {
  const { flow } = addFlow;
  if (!flow) return <Box flexGrow={1} />;
  const { step } = flow;

  if (step.kind === "broker") {
    return (
      <ChoiceList
        focused={focused}
        label={addFlow.title}
        cursor={flow.cursor}
        items={flow.directory.map((entry) => ({ id: entry.key, label: entry.name, detail: brokerMethodSummary(entry) }))}
        emptyMessage="No connectable brokers are installed."
        onCursorChange={addFlow.setCursor}
        onChoose={(index) => {
          const entry = flow.directory[index];
          if (entry) addFlow.chooseBroker(entry);
        }}
      />
    );
  }

  if (step.kind === "method") {
    return (
      <ChoiceList
        focused={focused}
        label={addFlow.title}
        cursor={flow.cursor}
        items={step.entry.methods.map((method) => ({ id: method.kind, label: brokerMethodLabel(step.entry, method) }))}
        onCursorChange={addFlow.setCursor}
        onChoose={(index) => {
          const method = step.entry.methods[index];
          if (method) addFlow.chooseMethod(step.entry, method);
        }}
      />
    );
  }

  if (step.kind === "device") {
    return (
      <DeviceProfileForm
        step={step}
        busy={busy}
        focused={focused}
        width={width}
        scope={scope}
        addFlow={addFlow}
      />
    );
  }

  const cancel = (
    <Box flexDirection="row" justifyContent="center">
      <Button label={t("Cancel")} shortcut="Esc" variant="secondary" disabled={busy !== null} onPress={addFlow.leave} />
    </Box>
  );
  if (!step.attempt) {
    // Gloom's own sign-in is up over the pane.
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="center">
          <Text fg={colors.textDim}>{t("Contacting Gloom...")}</Text>
        </Box>
        <Box height={1} />
        {cancel}
      </Box>
    );
  }
  return (
    <ConnectAttempt
      key={step.attempt.id}
      broker={step.broker}
      write={step.attempt.write}
      focused={focused}
      width={width}
      height={height}
      onOutcome={addFlow.endAttempt}
      cancel={cancel}
    />
  );
}

/** The broker list or the method list: Up and Down move, Enter or a click chooses. */
function ChoiceList({
  focused,
  label,
  cursor,
  items,
  emptyMessage,
  onCursorChange,
  onChoose,
}: {
  focused: boolean;
  label: string;
  cursor: number;
  items: ListViewItem[];
  emptyMessage?: string;
  onCursorChange: (index: number) => void;
  onChoose: (index: number) => void;
}) {
  const selectedIndex = Math.min(Math.max(0, cursor), Math.max(0, items.length - 1));
  useShortcut((event: KeyEventLike) => {
    const move = listCursorMove(event, 10);
    if (move) {
      event.preventDefault();
      event.stopPropagation();
      onCursorChange(move(items, selectedIndex));
      return;
    }
    if (isPlainKey(event, "enter", "return") && items.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      onChoose(selectedIndex);
    }
  }, { enabled: focused });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <ListView
        items={items}
        selectedIndex={selectedIndex}
        onSelect={onCursorChange}
        onActivate={(_item, index) => onChoose(index)}
        emptyMessage={emptyMessage}
        scrollable
        flexGrow={1}
        remoteLabel={label}
      />
    </Box>
  );
}

/** A device broker's fields in the pane's profile form, with Connect and Cancel. */
function DeviceProfileForm({
  step,
  busy,
  focused,
  width,
  scope,
  addFlow,
}: {
  step: Extract<BrokerAddStep, { kind: "device" }>;
  busy: string | null;
  focused: boolean;
  width: number;
  scope: string;
  addFlow: BrokerAddFlow;
}) {
  const { adapter, draft, activeKey } = step;
  const fields = getVisibleBrokerConfigFields(adapter, draft.values);
  const keys = useMemo<BrokerEditKey[]>(() => ["label", ...fields.map((field) => field.key)], [fields]);
  const selectKeys = useMemo<ReadonlySet<BrokerEditKey>>(
    () => new Set(fields.filter((field) => field.type === "select").map((field) => field.key)),
    [fields],
  );
  const { updateDraft, connectDevice, leave } = addFlow;
  const setActiveKey = useCallback((key: BrokerEditKey) => updateDraft(() => ({ activeKey: key })), [updateDraft]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  // Tab and j/k walk the fields and go round, as in the edit form.
  const { nodeRef: rowRef } = useFieldRing({
    ids: keys,
    activeId: activeKey,
    onActivate: setActiveKey,
    enabled: focused,
    scope,
    wrap: true,
    scrollRef,
  });

  // A field a changed select hid gives the focus back to the label.
  useEffect(() => {
    if (!keys.includes(activeKey)) updateDraft(() => ({ activeKey: "label" }));
  }, [activeKey, keys, updateDraft]);

  const cycleSelect = useCallback((key: BrokerEditKey, direction: -1 | 1) => {
    const options = fields.find((field) => field.key === key)?.options ?? [];
    if (options.length === 0) return;
    updateDraft((current) => {
      const index = options.findIndex((option) => option.value === current.draft.values[key]);
      const next = options[index < 0 ? 0 : (index + direction + options.length) % options.length];
      return next ? { draft: { ...current.draft, values: { ...current.draft.values, [key]: next.value } } } : {};
    });
  }, [fields, updateDraft]);

  useBrokerManagerKeyboard({
    activeEditKey: activeKey,
    editing: true,
    focused,
    scope,
    selectKeys,
    onCancelEdit: leave,
    onCycleSelect: cycleSelect,
    saveEdit: connectDevice,
  });

  return (
    <ScrollBox ref={scrollRef} flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1} gap={1}>
        <BrokerProfileForm
          adapter={adapter}
          draft={draft}
          fields={fields}
          previous={null}
          activeKey={activeKey}
          busy={busy}
          width={profileFieldWidth(width)}
          scope={scope}
          paneFocused={focused}
          submitLabel={t("Connect")}
          rowRef={rowRef}
          onActiveKeyChange={setActiveKey}
          onLabelChange={(label) => updateDraft((current) => ({ draft: { ...current.draft, label } }))}
          onValueChange={(key, value) => updateDraft((current) => ({
            draft: { ...current.draft, values: { ...current.draft.values, [key]: value } },
          }))}
          onSubmit={() => { void connectDevice(); }}
          onCancel={leave}
        />
      </Box>
    </ScrollBox>
  );
}

/**
 * One attempt at connecting a signed-in broker: the link, code and status the
 * connect dialog shows, in the pane. Enter skips the beat "Connected" stays up
 * for, and `r` asks for a new code.
 */
function ConnectAttempt({
  broker,
  write,
  focused,
  width,
  height,
  onOutcome,
  cancel,
}: {
  broker: SignedInBroker;
  write: boolean;
  focused: boolean;
  width: number;
  height: number;
  onOutcome: (outcome: "connected" | "signed-out") => void;
  cancel: ReactNode;
}) {
  const { snapshot, restart, finish } = useBrokerSignInAttempt(broker, write, onOutcome);
  const connected = snapshot.phase === "connected";
  useShortcut((event: KeyEventLike) => {
    if (!connected || !isPlainKey(event, "enter", "return")) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  }, { enabled: focused });
  usePaneRefreshKey(restart, { focused, enabled: !connected });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* A row under the header, then the spacer and Cancel take the last two rows. */}
      <Box height={1} />
      <BrokerConnectView broker={broker} snapshot={snapshot} height={Math.max(4, height - 3)} width={width} browserKey={focused} />
      <Box height={1} />
      {cancel}
    </Box>
  );
}
