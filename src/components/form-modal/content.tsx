import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { apiClient } from "../../api-client";
import type { SignedInBroker } from "../../brokers/signed-in/client";
import { runBrokerSignIn, type BrokerSignInOutcome } from "../../brokers/signed-in/sign-in";
import { promptGloomSignIn } from "../../brokers/signed-in/sign-in-dialog";
import { extractBrokerWorkflowValues } from "../command-bar/workflow/broker";
import { useAlertWorkflowQuoteSync } from "../command-bar/workflow/alert";
import {
  coerceFieldString,
  coerceFieldValues,
  getVisibleWorkflowFields,
  getWorkflowSubmitLabel,
  isWorkflowTextField,
} from "../command-bar/workflow/fields";
import {
  submitCommandBarWorkflow,
  validateRequiredWorkflowFields,
  type WorkflowSuccessDisposition,
} from "../command-bar/workflow/submit";
import { buildTickerListingPicker } from "../command-bar/workflow/ticker-listing-picker";
import type {
  CommandBarFieldValue,
  CommandBarWorkflowField,
} from "../command-bar/workflow/types";
import { isPlainTab, isWorkflowSubmitShortcut } from "../command-bar/keyboard-handlers";
import { MultiSelectFieldDialog, TuiSelectFieldDialog } from "../pane-settings-dialog/field-dialogs";
import { t } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useViewport, type KeyEventLike } from "../../react/input";
import { useThemeColors } from "../../theme/theme-context";
import { Box, ScrollBox, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../ui";
import { useDialog, useDialogKeyboard, type AlertContext, type PromptContext } from "../../ui/dialog";
import { useDialogIsTopmost } from "../../ui/dialog-context";
import { wrapTextLines } from "../../utils/text-wrap";
import type { PaneSettingField } from "../../types/plugin";
import { Button } from "../ui/button";
import { ChoiceDialog } from "../ui/choice-dialog";
import { DialogFrame } from "../ui/frame";
import { Spinner } from "../ui/loading";
import { openSelectField, type SelectFieldHandle } from "../ui/select-field";
import { brokerConnectStep } from "./broker-step";
import { createFormCollectionActions, type FormModalDeps } from "./deps";
import { FormFieldRow } from "./field-row";
import {
  applyFormValue,
  focusAfterField,
  initialFormFocus,
  isLastVisibleField,
  layoutFormRows,
  moveFormFocus,
  type FormFocus,
  type FormRoute,
  type FormStep,
} from "./model";

/** Handed to the form by its host: the app at the moment it is asked, and a way to close it. */
export interface FormModalRuntime {
  getDeps(): FormModalDeps;
  /** The host's handle on the open form, so the command bar opening over it can close it. */
  bindDismiss(dismiss: (() => void) | null): void;
}

/** Terminal rows the dialog spends around the body: border, padding, title and its spacer, spacer and buttons. */
const TERMINAL_CHROME_ROWS = 2 + 2 + 2 + 2;
/** Border and padding the terminal dialog host draws around the content. */
export const TERMINAL_DIALOG_INSET = 6;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t("Could not complete that action.");
}

function isCommit(event: KeyEventLike): boolean {
  return event.name === "return" || event.name === "enter";
}

function isSpace(event: KeyEventLike): boolean {
  return event.name === "space" || event.sequence === " ";
}

function consume(event: KeyEventLike): void {
  event.preventDefault();
  event.stopPropagation();
}

/** A remote value checked against the field, the way a person could have set it. */
function remoteFieldValue(field: CommandBarWorkflowField, input: unknown): CommandBarFieldValue {
  const raw = input && typeof input === "object" && "value" in input ? (input as { value: unknown }).value : input;
  switch (field.type) {
    case "toggle":
      return raw === true || raw === "true";
    case "select": {
      const value = String(raw ?? "");
      if (!field.options.some((option) => option.value === value)) {
        throw new Error(`"${value}" is not an option for ${field.label}.`);
      }
      return value;
    }
    case "multi-select":
    case "ordered-multi-select": {
      const values = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      const unknown = values.find((value) => !field.options.some((option) => option.value === value));
      if (unknown) throw new Error(`"${unknown}" is not an option for ${field.label}.`);
      return values;
    }
    default:
      return String(raw ?? "");
  }
}

export function FormModalContent({
  dismiss,
  initialRoute,
  runtime,
  width,
}: AlertContext & {
  initialRoute: FormRoute;
  runtime: FormModalRuntime;
  /** Dialog width in cells, the frame included. */
  width: number;
}) {
  useAppLanguage();
  const colors = useThemeColors();
  const dialog = useDialog();
  const isTopmost = useDialogIsTopmost();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const viewport = useViewport();
  const rowIdPrefix = useId();
  const [route, setRouteState] = useState<FormRoute>(() => ({ ...initialRoute, pending: false, error: null }));
  const [onSubmitStop, setOnSubmitStop] = useState(() => initialFormFocus(initialRoute).onSubmit);
  const [textareaRevisions, setTextareaRevisions] = useState<Record<string, number>>({});
  const [step, setStep] = useState<FormStep | null>(null);
  // Keys can arrive faster than renders (a held key, a paste), so handlers read these.
  const routeRef = useRef(route);
  const onSubmitStopRef = useRef(onSubmitStop);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const selectRefs = useRef(new Map<string, SelectFieldHandle>());
  // The broker connect step being shown, and how many have been.
  const endStepRef = useRef<((outcome: BrokerSignInOutcome) => void) | null>(null);
  const stepAttemptsRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Closing the form cancels the step: no profile is created.
      endStepRef.current?.("cancelled");
    };
  }, []);

  useEffect(() => {
    runtime.bindDismiss(dismiss);
    return () => runtime.bindDismiss(null);
  }, [dismiss, runtime]);

  const updateRoute = useCallback((update: (current: FormRoute) => FormRoute) => {
    const next = update(routeRef.current);
    if (next === routeRef.current) return;
    routeRef.current = next;
    setRouteState(next);
  }, []);

  const setFocus = useCallback((focus: FormFocus) => {
    onSubmitStopRef.current = focus.onSubmit;
    setOnSubmitStop(focus.onSubmit);
    if (focus.fieldId !== null) {
      updateRoute((current) => current.activeFieldId === focus.fieldId ? current : { ...current, activeFieldId: focus.fieldId });
    }
  }, [updateRoute]);

  const focusField = useCallback((fieldId: string) => {
    setFocus({ fieldId, onSubmit: false });
  }, [setFocus]);

  const setValue = useCallback((fieldId: string, value: CommandBarFieldValue) => {
    updateRoute((current) => applyFormValue(current, fieldId, value));
  }, [updateRoute]);

  /** Shows one attempt at connecting the broker in place of the fields, until it ends. */
  const connectBrokerInForm = useCallback((broker: SignedInBroker, write: boolean) => (
    new Promise<BrokerSignInOutcome>((resolve) => {
      if (!mountedRef.current) {
        resolve("cancelled");
        return;
      }
      const end = (outcome: BrokerSignInOutcome) => {
        if (endStepRef.current !== end) return;
        endStepRef.current = null;
        if (mountedRef.current) setStep(null);
        resolve(outcome);
      };
      endStepRef.current = end;
      stepAttemptsRef.current += 1;
      setStep(brokerConnectStep(broker, write, stepAttemptsRef.current, end));
    })
  ), []);

  /**
   * Signs a broker in from the form: Gloom's sign-in stacked over it when
   * needed, then the connect step inside it, again after a session Gloom
   * refused. False when the user backed out.
   */
  const signInBroker = useCallback((broker: SignedInBroker) => runBrokerSignIn(broker, undefined, {
    isSignedIn: () => apiClient.isSignedIn(),
    signInToGloom: async () => mountedRef.current && await promptGloomSignIn(dialog),
    connectBroker: connectBrokerInForm,
  }), [connectBrokerInForm, dialog]);

  // Effects that follow what is typed run here, with the values, and each
  // acts only in the form it belongs to, going by its workflow id.
  useAlertWorkflowQuoteSync({
    dataProvider: runtime.getDeps().dataProvider,
    route,
    updateRoute,
  });

  const submit = useCallback(async (routeToSubmit?: FormRoute): Promise<void> => {
    if (pendingRef.current) return;
    const current = routeToSubmit ?? routeRef.current;
    const visibleFields = getVisibleWorkflowFields(current.fields, current.values);
    const missing = validateRequiredWorkflowFields({
      fields: visibleFields,
      values: current.values,
      getFieldStringValue: (_field, value) => coerceFieldString(value),
    });
    if (missing) {
      // Straight to the empty field, which may be scrolled out of view.
      onSubmitStopRef.current = false;
      setOnSubmitStop(false);
      updateRoute((latest) => ({ ...latest, activeFieldId: missing.fieldId, error: missing.message }));
      return;
    }

    pendingRef.current = true;
    updateRoute((latest) => ({ ...latest, pending: true, error: null }));
    const deps = runtime.getDeps();
    let notified = false;
    const notify = (body: string, options?: { type?: "info" | "success" | "error" }) => {
      notified = true;
      deps.pluginRegistry.notify({ body, ...options });
    };

    let disposition: WorkflowSuccessDisposition;
    try {
      disposition = await submitCommandBarWorkflow({
        activeLayoutIndex: deps.getState().config.activeLayoutIndex,
        collectionWorkflowActions: createFormCollectionActions(deps, notify, signInBroker),
        dispatch: deps.dispatch,
        extractBrokerWorkflowValues,
        getFieldStringValue: (_field, value) => coerceFieldString(value),
        notify,
        pluginRegistry: deps.pluginRegistry,
        route: current,
        visibleFields,
      });
    } catch (error) {
      pendingRef.current = false;
      if (!mountedRef.current) {
        // Closed while it ran: the inline error has nowhere to go.
        deps.pluginRegistry.notify({ body: errorMessage(error), type: "error" });
        return;
      }
      const listingPicker = buildTickerListingPicker(current, error, (fieldId) => coerceFieldString(current.values[fieldId]));
      if (listingPicker) {
        updateRoute((latest) => ({ ...latest, pending: false, error: null }));
        const fieldId = listingPicker.fieldId;
        const choice = await dialog.prompt<string>({
          closeOnClickOutside: true,
          content: (context: PromptContext<string>) => (
            <ChoiceDialog
              {...context}
              title={listingPicker.title}
              choices={listingPicker.options.map((option) => ({ id: option.id, label: option.label }))}
            />
          ),
        });
        // Resubmitted only once the picker is gone, so a second ambiguous
        // ticker opens its picker over the form, not over this one.
        if (!choice || !mountedRef.current) return;
        let next = routeRef.current;
        updateRoute((latest) => {
          next = applyFormValue(latest, fieldId, choice);
          return next;
        });
        void submit(next);
        return;
      }
      updateRoute((latest) => ({ ...latest, pending: false, error: errorMessage(error) }));
      return;
    }

    pendingRef.current = false;
    if (disposition === "stay") {
      // Backed out of Gloom's sign-in: the form is as it was. A cancelled
      // connect step closed the form, which has nothing left to show.
      if (mountedRef.current) updateRoute((latest) => ({ ...latest, pending: false }));
      return;
    }
    if (mountedRef.current) {
      dismiss();
    } else if (!notified) {
      deps.pluginRegistry.notify({ body: t("Done."), type: "success" });
    }
  }, [dialog, dismiss, runtime, signInBroker, updateRoute]);

  const moveOn = useCallback((fieldId: string) => {
    setFocus(focusAfterField(routeRef.current, fieldId));
  }, [setFocus]);

  const submitOrMoveOn = useCallback((fieldId: string) => {
    if (isLastVisibleField(routeRef.current, fieldId)) void submit();
    else moveOn(fieldId);
  }, [moveOn, submit]);

  /** Enter on a select or a multi-select: its picker, stacked over the form in the terminal. */
  const openField = useCallback(async (field: CommandBarWorkflowField) => {
    if (pendingRef.current) return;
    const current = routeRef.current;
    if (field.type === "toggle") {
      setValue(field.id, current.values[field.id] !== true);
      return;
    }
    if (field.type === "select" && desktop) {
      openSelectField(selectRefs.current.get(field.id));
      return;
    }
    let applied = false;
    const options = "options" in field
      ? field.options.map((option) => ({
        value: option.value,
        label: t(option.label),
        description: option.description ? t(option.description) : undefined,
      }))
      : [];
    if (field.type === "select") {
      await dialog.alert({
        closeOnClickOutside: true,
        content: (context: AlertContext) => (
          <TuiSelectFieldDialog
            {...context}
            field={{ key: field.id, label: t(field.label), type: "select", options } as Extract<PaneSettingField, { type: "select" }>}
            currentValue={coerceFieldString(current.values[field.id])}
            onApply={async (value) => {
              applied = true;
              setValue(field.id, value);
            }}
          />
        ),
      });
    } else if (field.type === "multi-select" || field.type === "ordered-multi-select") {
      await dialog.alert({
        closeOnClickOutside: true,
        content: (context: AlertContext) => (
          <MultiSelectFieldDialog
            {...context}
            field={{ key: field.id, label: t(field.label), type: field.type, options } as Extract<PaneSettingField, { type: "multi-select" | "ordered-multi-select" }>}
            currentValue={coerceFieldValues(current.values[field.id])}
            onApply={async (values) => {
              applied = true;
              setValue(field.id, values);
            }}
          />
        ),
      });
    }
    if (applied && mountedRef.current) moveOn(field.id);
  }, [desktop, dialog, moveOn, setValue]);

  const modalWidth = Math.min(width, Math.max(1, viewport.width - 2));
  const contentWidth = Math.max(10, modalWidth - TERMINAL_DIALOG_INSET);
  const layout = layoutFormRows(route, contentWidth);
  const errorLines = route.error ? wrapTextLines(route.error, contentWidth).length : 0;
  const statusRows = errorLines + (route.pending && route.pendingLabel ? 1 : 0);
  const subtitleRows = route.subtitle ? wrapTextLines(t(route.subtitle), contentWidth).length : 0;
  const availableRows = viewport.height - 2 - TERMINAL_CHROME_ROWS - subtitleRows - (statusRows > 0 ? statusRows + 1 : 0);
  const bodyRows = Math.max(1, Math.min(layout.total, availableRows));

  const scrollIntoView = useCallback((fieldId: string) => {
    if (desktop) {
      const element = (globalThis as { document?: { getElementById(id: string): { scrollIntoView?(options: { block: "nearest" }): void } | null } })
        .document?.getElementById(`${rowIdPrefix}${fieldId}`);
      element?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    const scrollBox = scrollRef.current;
    const row = layoutFormRows(routeRef.current, contentWidth).rows.find((entry) => entry.fieldId === fieldId);
    if (!scrollBox || !row) return;
    const viewportRows = Math.max(1, scrollBox.viewport?.height ?? bodyRows);
    if (row.top < scrollBox.scrollTop) scrollBox.scrollTo(row.top);
    else if (row.top + row.height > scrollBox.scrollTop + viewportRows) scrollBox.scrollTo(row.top + row.height - viewportRows);
  }, [bodyRows, contentWidth, desktop, rowIdPrefix]);

  // After layout, so a field that dependsOn just revealed is measured.
  useEffect(() => {
    const fieldId = route.activeFieldId;
    if (!fieldId || onSubmitStop) return;
    const frame = setTimeout(() => scrollIntoView(fieldId), 0);
    return () => clearTimeout(frame);
  }, [onSubmitStop, route.activeFieldId, scrollIntoView]);

  useDialogKeyboard((event) => {
    // Esc belongs to the dialog host, which closes the form.
    if (event.name === "escape") return;
    // A desktop field acts on its own keys first (Enter moves on or submits)
    // and has already moved the focus this handler would read.
    if (event.defaultPrevented) return;
    const current = routeRef.current;
    if (current.pending) {
      consume(event);
      return;
    }
    const visibleFields = getVisibleWorkflowFields(current.fields, current.values);
    const onButton = onSubmitStopRef.current || visibleFields.length === 0;
    const activeField = onButton ? undefined : visibleFields.find((field) => field.id === current.activeFieldId) ?? visibleFields[0];
    const inTextarea = activeField?.type === "textarea";

    if (isWorkflowSubmitShortcut(event)) {
      consume(event);
      void submit();
      return;
    }
    if (isPlainTab(event)) {
      consume(event);
      setFocus(moveFormFocus(current, { fieldId: activeField?.id ?? null, onSubmit: onButton }, event.shift ? -1 : 1, true));
      return;
    }
    if (!inTextarea && !event.ctrl && !event.meta && !event.alt && (event.name === "up" || event.name === "down")) {
      consume(event);
      setFocus(moveFormFocus(current, { fieldId: activeField?.id ?? null, onSubmit: onButton }, event.name === "up" ? -1 : 1, false));
      return;
    }
    if (!desktop && (event.name === "pageup" || event.name === "pagedown")) {
      consume(event);
      const scrollBox = scrollRef.current;
      if (scrollBox) scrollBox.scrollTo(Math.max(0, scrollBox.scrollTop + (event.name === "pageup" ? -bodyRows : bodyRows)));
      return;
    }
    // A text field keeps every other key; Enter there goes through its own onSubmit.
    if (isWorkflowTextField(activeField)) return;

    event.stopPropagation();
    if (!isCommit(event) && !isSpace(event)) return;
    event.preventDefault();
    if (onButton) {
      void submit();
      return;
    }
    if (activeField) void openField(activeField);
  }, { allowEditable: true, enabled: step === null });

  if (step) {
    const stepSubtitleRows = step.subtitle ? wrapTextLines(step.subtitle, contentWidth).length : 0;
    const stepBody = (
      <Fragment key={step.id}>
        {step.render({
          bodyRows: Math.max(1, viewport.height - 2 - TERMINAL_CHROME_ROWS - stepSubtitleRows),
          contentWidth,
        })}
      </Fragment>
    );
    const cancel = (
      <Box flexDirection="row" justifyContent="flex-end">
        <Button label={t("Cancel")} variant="secondary" onPress={dismiss} />
      </Box>
    );
    if (desktop) {
      return (
        <Box width={width} maxWidth="calc(100vw - 72px)" flexDirection="column">
          <DialogFrame title={step.title} subtitle={step.subtitle} onClose={dismiss}>
            {stepBody}
            <Box style={{ marginTop: 14 }}>{cancel}</Box>
          </DialogFrame>
        </Box>
      );
    }
    return (
      <DialogFrame title={step.title} subtitle={step.subtitle}>
        <Box flexDirection="column" width={contentWidth}>
          {stepBody}
          <Box height={1} />
          {cancel}
        </Box>
      </DialogFrame>
    );
  }

  const visibleFields = getVisibleWorkflowFields(route.fields, route.values);
  const inputsFocusable = !route.pending && isTopmost;
  const fieldRows = visibleFields.map((field, index) => {
    const active = !onSubmitStop && field.id === route.activeFieldId;
    return (
      <FormFieldRow
        key={field.id}
        field={field}
        value={route.values[field.id]}
        active={active}
        inputFocused={active && inputsFocusable}
        pending={route.pending}
        desktop={desktop}
        isLast={index === visibleFields.length - 1}
        rowId={`${rowIdPrefix}${field.id}`}
        textareaRevision={textareaRevisions[field.id] ?? 0}
        onFocus={() => focusField(field.id)}
        onOpen={() => { void openField(field); }}
        onChange={(value) => setValue(field.id, value)}
        onSubmitField={() => submitOrMoveOn(field.id)}
        onPicked={() => moveOn(field.id)}
        onSelectRef={(handle) => {
          if (handle) selectRefs.current.set(field.id, handle);
          else selectRefs.current.delete(field.id);
        }}
        remote={{
          setValue: (input) => {
            setValue(field.id, remoteFieldValue(field, input));
            if (field.type === "textarea") {
              setTextareaRevisions((revisions) => ({ ...revisions, [field.id]: (revisions[field.id] ?? 0) + 1 }));
            }
          },
          submit: () => { void submit(); },
        }}
      />
    );
  });

  const descriptionLines = (route.description ?? []).map((line, index) => (
    <Text key={`description:${index}`} fg={colors.textDim} wrapText>{t(line)}</Text>
  ));
  const hasDescription = descriptionLines.length > 0;

  const status = (
    <>
      {route.error && <Text fg={colors.negative} wrapText>{t(route.error)}</Text>}
      {route.pending && route.pendingLabel && <Spinner label={route.pendingLabel} />}
    </>
  );

  const buttons = (
    <Box flexDirection="row" gap={1} justifyContent="flex-end">
      <Button label={t("Cancel")} variant="secondary" onPress={dismiss} />
      <Button
        label={t(getWorkflowSubmitLabel(route))}
        variant="primary"
        active={onSubmitStop}
        disabled={route.pending}
        onPress={() => { void submit(); }}
      />
    </Box>
  );

  if (desktop) {
    return (
      <Box width={width} maxWidth="calc(100vw - 72px)" flexDirection="column">
        <DialogFrame title={route.title} subtitle={route.subtitle ? t(route.subtitle) : undefined} onClose={dismiss}>
          <ScrollBox
            ref={scrollRef}
            scrollY
            style={{ maxHeight: "calc(100vh - 220px)", overflowX: "hidden", paddingRight: 4 }}
          >
            <Box flexDirection="column">
              {descriptionLines}
              {hasDescription && <Box style={{ height: 10 }} />}
              {fieldRows}
            </Box>
          </ScrollBox>
          {(route.error || (route.pending && route.pendingLabel)) && (
            <Box flexDirection="column" style={{ marginTop: 10 }}>{status}</Box>
          )}
          <Box style={{ marginTop: 14 }}>{buttons}</Box>
        </DialogFrame>
      </Box>
    );
  }

  return (
    <DialogFrame title={route.title} subtitle={route.subtitle ? t(route.subtitle) : undefined}>
      <Box flexDirection="column" width={contentWidth}>
        <ScrollBox ref={scrollRef} height={bodyRows} scrollY>
          {descriptionLines}
          {hasDescription && <Box height={1} />}
          {fieldRows}
        </ScrollBox>
        {statusRows > 0 && (
          <>
            <Box height={1} />
            {status}
          </>
        )}
        <Box height={1} />
        {buttons}
      </Box>
    </DialogFrame>
  );
}
