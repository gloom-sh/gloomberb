import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { buildBrokerDirectory } from "../../brokers/directory";
import {
  getSignedInBrokers,
  refreshSignedInBrokers,
  subscribeSignedInBrokers,
} from "../../brokers/signed-in/catalog";
import { SIGNED_IN_BROKER_TYPE } from "../../brokers/signed-in/profile";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import { t } from "../../i18n";
import type { PluginRegistry } from "../../plugins/registry";
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

/** Pane settings width, in cells. */
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
  const signedInBrokers = useSyncExternalStore(subscribeSignedInBrokers, getSignedInBrokers, getSignedInBrokers);
  const brokerDirectory = useMemo(
    () => buildBrokerDirectory({ signedIn: signedInBrokers, adapters: pluginRegistry.brokers.values() }),
    [pluginRegistry.brokers, signedInBrokers],
  );
  const brokerDirectoryRef = useRef(brokerDirectory);
  brokerDirectoryRef.current = brokerDirectory;
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

  // The bar opening over a form would take its keys; the form gives way.
  const barWasOpenRef = useRef(commandBarOpen);
  useEffect(() => {
    const opened = commandBarOpen && !barWasOpenRef.current;
    barWasOpenRef.current = commandBarOpen;
    if (opened) openRef.current?.dismiss?.();
  }, [commandBarOpen]);

  useEffect(() => subscribeFormModalRequests((request) => {
    if (openRef.current) return false;
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
      const result = resolveFormRequest(request, depsRef.current, brokerDirectoryRef.current);
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
        content: (context: AlertContext) => render(context, runtime),
      }).finally(() => {
        if (openRef.current === handle) openRef.current = null;
      });
    });
    return true;
  }), [dialog, dispatch, pluginRegistry, stateRef]);

  return null;
}

function resolveFormRequest(
  request: Exclude<FormModalRequest, { kind: "confirm" }>,
  deps: FormModalDeps,
  brokerDirectory: ReturnType<typeof buildBrokerDirectory>,
): FormRouteResult {
  const state = deps.getState();
  switch (request.kind) {
    case "builtin": {
      const listsBrokers = request.actionId === "add-broker-account" || request.actionId === "new-portfolio";
      if (listsBrokers && deps.pluginRegistry.brokers.has(SIGNED_IN_BROKER_TYPE)) void refreshSignedInBrokers();
      return buildBuiltInFormRoute(request.actionId, state, brokerDirectory);
    }
    case "plugin-command": {
      const command = deps.pluginRegistry.commands.get(request.commandId);
      return command ? buildPluginCommandFormRoute(command, state, request.values) : { kind: "none" };
    }
    case "pane-template":
      return buildPaneTemplateFormRoute(deps.pluginRegistry, request.templateId, request.arg, state);
    case "add-to-portfolio":
      return buildAddToPortfolioFormRoute(request.ticker, request.portfolioId, state);
    case "route":
      return { kind: "route", route: request.route };
  }
}
