import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { InputRenderable, ScrollBoxRenderable, TextareaRenderable } from "../../../ui";
import type { AppAction } from "../../../state/app/context";
import type { PluginRegistry } from "../../../plugins/registry";
import type { NativeSelectElement } from "../../ui/native-select";
import { extractBrokerWorkflowValues } from "./broker";
import { buildTickerListingPicker } from "./ticker-listing-picker";
import type {
  CommandBarCollectionWorkflowActions,
  CommandBarNotifyFn,
} from "./collection-actions";
import { getFirstVisibleFieldId, getVisibleWorkflowFields } from "../helpers";
import {
  submitCommandBarWorkflow,
  validateRequiredWorkflowFields,
} from "./submit";
import type {
  CommandBarFieldValue,
  CommandBarRoute,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";
import {
  focusWorkflowTextField,
  getCommandBarWorkflowInputRef,
  getWorkflowFieldStringValueFromRefs,
  moveWorkflowFocusAction,
  openWorkflowFieldPickerAction,
  setWorkflowNativeSelectElement,
  syncActiveWorkflowTextareaAction,
  updateRouteStack,
  type CommandBarWorkflowInputRefs,
} from "./route-actions";

interface CloseCommandBarOptions {
  revertThemePreview?: boolean;
}

interface UseCommandBarWorkflowRuntimeOptions {
  activeLayoutIndex: number;
  closeAll: (options?: CloseCommandBarOptions) => void;
  collectionWorkflowActions: CommandBarCollectionWorkflowActions;
  currentRoute: CommandBarRoute | null;
  dispatch: Dispatch<AppAction>;
  notify: CommandBarNotifyFn;
  pluginRegistry: PluginRegistry;
  pushRoute: (route: CommandBarRoute) => void;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
}

interface UseCommandBarWorkflowRuntimeResult {
  ensureRouteFieldFocus: (route: CommandBarWorkflowRoute) => void;
  focusWorkflowField: (fieldId: string) => void;
  getWorkflowFieldStringValue: (
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ) => string;
  getWorkflowInputRef: (fieldId: string) => RefObject<InputRenderable | TextareaRenderable | null>;
  moveWorkflowFocus: (delta: number) => void;
  openWorkflowFieldPicker: (route: CommandBarWorkflowRoute, field: CommandBarWorkflowField) => void;
  openWorkflowRoute: (route: CommandBarWorkflowRoute) => void;
  setWorkflowNativeSelectRef: (fieldId: string, element: NativeSelectElement | null) => void;
  submitWorkflowRoute: (route: CommandBarWorkflowRoute) => Promise<void>;
  syncActiveWorkflowTextarea: (route: CommandBarWorkflowRoute | null) => void;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
  workflowNativeSelectRefs: RefObject<Map<string, NativeSelectElement>>;
  workflowScrollRef: RefObject<ScrollBoxRenderable | null>;
}

export function useCommandBarWorkflowRuntime({
  activeLayoutIndex,
  closeAll,
  collectionWorkflowActions,
  currentRoute,
  dispatch,
  notify,
  pluginRegistry,
  pushRoute,
  setRouteStack,
  updateTopRoute,
}: UseCommandBarWorkflowRuntimeOptions): UseCommandBarWorkflowRuntimeResult {
  const workflowInputRefs = useRef<CommandBarWorkflowInputRefs>({});
  const workflowNativeSelectRefs = useRef(new Map<string, NativeSelectElement>());
  const workflowScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const ensureRouteFieldFocus = useCallback((route: CommandBarWorkflowRoute) => {
    focusWorkflowTextField(workflowInputRefs.current, route);
  }, []);

  const setWorkflowNativeSelectRef = useCallback((fieldId: string, element: NativeSelectElement | null) => {
    setWorkflowNativeSelectElement(workflowNativeSelectRefs.current, fieldId, element);
  }, []);

  const openWorkflowRoute = useCallback((route: CommandBarWorkflowRoute) => {
    pushRoute({
      ...route,
      activeFieldId: route.activeFieldId ?? getFirstVisibleFieldId(route.fields, route.values),
      error: null,
      pending: false,
    });
  }, [pushRoute]);

  const updateWorkflowValue = useCallback((fieldId: string, value: CommandBarFieldValue) => {
    updateRouteStack(setRouteStack, fieldId, value);
  }, [setRouteStack]);

  const syncActiveWorkflowTextarea = useCallback((route: CommandBarWorkflowRoute | null): void => {
    syncActiveWorkflowTextareaAction({
      inputRefs: workflowInputRefs.current,
      route,
      updateWorkflowValue,
    });
  }, [updateWorkflowValue]);

  const getWorkflowFieldStringValue = useCallback((
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ): string => getWorkflowFieldStringValueFromRefs(workflowInputRefs.current, field, value), []);

  const submitWorkflowRoute = useCallback(async (route: CommandBarWorkflowRoute) => {
    syncActiveWorkflowTextarea(route);
    const visibleFields = getVisibleWorkflowFields(route.fields, route.values);
    const validationError = validateRequiredWorkflowFields({
      fields: visibleFields,
      getFieldStringValue: getWorkflowFieldStringValue,
      values: route.values,
    });
    if (validationError) {
      updateTopRoute((current) => current.kind === "workflow"
        ? { ...current, error: validationError }
        : current);
      return;
    }

    updateTopRoute((current) => current.kind === "workflow"
      ? { ...current, pending: true, error: null }
      : current);

    try {
      const successDisposition = await submitCommandBarWorkflow({
        activeLayoutIndex,
        collectionWorkflowActions,
        dispatch,
        extractBrokerWorkflowValues,
        getFieldStringValue: getWorkflowFieldStringValue,
        notify,
        pluginRegistry,
        route,
        visibleFields,
      });

      if (successDisposition === "back") {
        setRouteStack((current) => current.slice(0, -1));
        return;
      }
      closeAll({ revertThemePreview: false });
    } catch (error) {
      const listingPicker = buildTickerListingPicker(route, error, (fieldId) => {
        const field = visibleFields.find((field) => field.id === fieldId);
        return field ? getWorkflowFieldStringValue(field, route.values[fieldId]) : "";
      });
      if (listingPicker) {
        setRouteStack((current) => {
          const top = current.at(-1);
          if (top?.kind !== "workflow" || top.payload !== route.payload || !top.pending) return current;
          return [...current.slice(0, -1), { ...top, pending: false, error: null }, listingPicker];
        });
        return;
      }
      updateTopRoute((current) => current.kind === "workflow"
        ? {
          ...current,
          pending: false,
          error: error instanceof Error ? error.message : "Could not complete that action.",
        }
        : current);
      return;
    }

    updateTopRoute((current) => current.kind === "workflow"
      ? { ...current, pending: false, error: null }
      : current);
  }, [
    activeLayoutIndex,
    closeAll,
    collectionWorkflowActions,
    dispatch,
    getWorkflowFieldStringValue,
    notify,
    pluginRegistry,
    setRouteStack,
    syncActiveWorkflowTextarea,
    updateTopRoute,
  ]);

  const moveWorkflowFocus = useCallback((delta: number) => {
    moveWorkflowFocusAction({
      delta,
      route: currentRoute?.kind === "workflow" ? currentRoute : null,
      syncActiveWorkflowTextarea,
      updateTopRoute,
    });
  }, [currentRoute, syncActiveWorkflowTextarea, updateTopRoute]);

  const openWorkflowFieldPicker = useCallback((route: CommandBarWorkflowRoute, field: CommandBarWorkflowField) => {
    openWorkflowFieldPickerAction({
      field,
      pushRoute,
      route,
      syncActiveWorkflowTextarea,
      updateWorkflowValue,
    });
  }, [pushRoute, syncActiveWorkflowTextarea, updateWorkflowValue]);

  const getWorkflowInputRef = useCallback((fieldId: string) => (
    getCommandBarWorkflowInputRef(workflowInputRefs.current, fieldId)
  ), []);

  const focusWorkflowField = useCallback((fieldId: string) => {
    updateTopRoute((route) => route.kind === "workflow"
      ? { ...route, activeFieldId: fieldId, error: null }
      : route);
  }, [updateTopRoute]);

  return {
    ensureRouteFieldFocus,
    focusWorkflowField,
    getWorkflowFieldStringValue,
    getWorkflowInputRef,
    moveWorkflowFocus,
    openWorkflowFieldPicker,
    openWorkflowRoute,
    setWorkflowNativeSelectRef,
    submitWorkflowRoute,
    syncActiveWorkflowTextarea,
    updateWorkflowValue,
    workflowNativeSelectRefs,
    workflowScrollRef,
  };
}
