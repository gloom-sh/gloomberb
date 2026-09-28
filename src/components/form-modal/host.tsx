import { useEffect, useRef, type ReactNode } from "react";
import { buildBrokerDirectory } from "../../brokers/directory";
import { getSignedInBrokers, refreshSignedInBrokers } from "../../brokers/signed-in/catalog";
import { SIGNED_IN_BROKER_TYPE } from "../../brokers/signed-in/profile";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import { t } from "../../i18n";
import type { PluginRegistry } from "../../plugins/registry";
import { RemoteUiScope } from "../../remote/semantic-tree";
import { useAppDispatch, useAppSelector, useAppStateRef } from "../../state/app/context";
import type { DataProvider } from "../../types/data-provider";
import { useDialog, type AlertContext } from "../../ui/dialog";
import { CONFIRM_MODAL_WIDTH, ConfirmModalContent } from "./confirm";
import { FormModalContent, type FormModalRuntime } from "./content";
import type { FormModalDeps } from "./deps";
import type { FormRoute } from "./model";
import { subscribeFormModalRequests, type FormModalRequest } from "./request";
import {
  buildAddToPortfolioFormRoute,
  buildBuiltInFormRoute,
  buildPaneTemplateFormRoute,
  buildPluginCommandFormRoute,
  type FormRouteResult,
} from "./routes";

/**
 * Pane settings width, in cells. The broker connect step that Add Broker and
 * New Portfolio advance to fits in it too (its QR code, the link, the note
 * wrapped), since a dialog keeps the width it opened with.
 */
const FORM_MODAL_WIDTH = 68;
/** A prompt or a JSON body needs room to read. */
const FORM_MODAL_TEXTAREA_WIDTH = 88;

export function formModalWidth(route: FormRoute): number {
  return route.fields.some((field) => field.type === "textarea") ? FORM_MODAL_TEXTAREA_WIDTH : FORM_MODAL_WIDTH;
}

interface FormModalHostProps {
  dataProvider: DataProvider;
  pluginRegistry: PluginRegistry;
  tickerRepository: AppTickerRepositoryPort;
}

/**
 * Opens every form (a built-in workflow, a plugin command's wizard, a pane
 * template's settings) and every confirm as one centered modal. Mounted by the
 * main window's shell for the life of the app; `openFormModal` and
 * `openConfirmModal` reach it. Renders nothing.
 */
export function FormModalHost({ dataProvider, pluginRegistry, tickerRepository }: FormModalHostProps) {
  const dialog = useDialog();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const depsRef = useRef<FormModalDeps>(null as unknown as FormModalDeps);
  depsRef.current = {
    dataProvider,
    dispatch,
    getState: () => stateRef.current,
    pluginRegistry,
    tickerRepository,
  };
  // Set from the moment a form is asked for until its dialog closes.
  const openRef = useRef<{ dismiss: (() => void) | null } | null>(null);
  // One form asked for while another is open, such as the pane template a
  // plugin command creates from its own form's submit: it opens next.
  const queuedRef = useRef<FormModalRequest | null>(null);

  // The bar opening over a form would take its keys; the form gives way, and
  // one waiting behind it is dropped rather than closing the bar again.
  const barWasOpenRef = useRef(commandBarOpen);
  useEffect(() => {
    const opened = commandBarOpen && !barWasOpenRef.current;
    barWasOpenRef.current = commandBarOpen;
    if (!opened) return;
    queuedRef.current = null;
    openRef.current?.dismiss?.();
  }, [commandBarOpen]);

  useEffect(() => subscribeFormModalRequests(function open(request): boolean {
    if (openRef.current) {
      if (queuedRef.current) return false;
      queuedRef.current = request;
      return true;
    }
    let width: number;
    let closeOnClickOutside: boolean;
    let render: (context: AlertContext, runtime: FormModalRuntime) => ReactNode;
    if (request.kind === "confirm") {
      width = CONFIRM_MODAL_WIDTH;
      // Nothing typed to lose.
      closeOnClickOutside = true;
      render = (context, runtime) => (
        <ConfirmModalContent {...context} confirm={request.confirm} runtime={runtime} width={width} />
      );
    } else {
      const result = resolveFormRequest(request, depsRef.current);
      if (result.kind === "notice") {
        pluginRegistry.notify({ body: t(result.message), type: "info" });
        return true;
      }
      if (result.kind === "none") return false;
      const route = result.route;
      width = formModalWidth(route);
      // A stray click must not throw away what was typed.
      closeOnClickOutside = false;
      render = (context, runtime) => (
        <FormModalContent {...context} initialRoute={route} runtime={runtime} width={width} />
      );
    }

    const handle: { dismiss: (() => void) | null } = { dismiss: null };
    openRef.current = handle;
    if (stateRef.current.commandBarOpen) dispatch({ type: "SET_COMMAND_BAR", open: false });
    const runtime: FormModalRuntime = {
      getDeps: () => depsRef.current,
      bindDismiss: (dismiss) => { handle.dismiss = dismiss; },
    };
    // After the caller returns: a launch can come from inside a render effect,
    // and the terminal host commits a dialog synchronously.
    queueMicrotask(() => {
      void dialog.alert({
        closeOnClickOutside,
        style: { width },
        // Its buttons are the ones remote control presses first while it is open.
        content: (context: AlertContext) => <RemoteUiScope scope="form">{render(context, runtime)}</RemoteUiScope>,
      }).finally(() => {
        if (openRef.current !== handle) return;
        openRef.current = null;
        const next = queuedRef.current;
        queuedRef.current = null;
        if (next) open(next);
      });
    });
    return true;
  }), [dialog, dispatch, pluginRegistry, stateRef]);

  return null;
}

function resolveFormRequest(
  request: Exclude<FormModalRequest, { kind: "confirm" }>,
  deps: FormModalDeps,
): FormRouteResult {
  const state = deps.getState();
  switch (request.kind) {
    case "builtin": {
      const listsBrokers = request.actionId === "add-broker-account" || request.actionId === "new-portfolio";
      if (listsBrokers && deps.pluginRegistry.brokers.has(SIGNED_IN_BROKER_TYPE)) void refreshSignedInBrokers();
      // The host outlives plugins: the brokers installed, updated or removed
      // since it mounted are the ones to list, so the list is built now.
      const brokerDirectory = buildBrokerDirectory({
        signedIn: getSignedInBrokers(),
        adapters: deps.pluginRegistry.brokers.values(),
      });
      return buildBuiltInFormRoute(request.actionId, state, brokerDirectory);
    }
    case "plugin-command": {
      const command = deps.pluginRegistry.commands.get(request.commandId);
      return command ? buildPluginCommandFormRoute(command, state, request.values) : { kind: "none" };
    }
    case "pane-template":
      return buildPaneTemplateFormRoute(deps.pluginRegistry, request.templateId, request.arg, state, request.options);
    case "add-to-portfolio":
      return buildAddToPortfolioFormRoute(request.ticker, request.portfolioId, state);
    case "route":
      return { kind: "route", route: request.route };
  }
}
