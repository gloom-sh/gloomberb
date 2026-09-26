import type { Dispatch } from "react";
import type { AppAction } from "../../../state/app/context";
import type { PluginRegistry } from "../../../plugins/registry";
import type {
  CommandBarFieldValue,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";
import {
  coerceFieldBoolean,
  coerceFieldString,
  coerceFieldValues,
} from "../helpers";
import { resolveBrokerWorkflowSelection, type WorkflowStringValues } from "./broker";
import { parseOwnerValue } from "./builtin";
import type { PaneSettingField, PaneTemplateCreateOptions } from "../../../types/plugin";
import type {
  CommandBarCollectionWorkflowActions,
  CommandBarNotifyFn,
} from "./collection-actions";

export type WorkflowSuccessDisposition = "back" | "close" | "stay";

export function validateRequiredWorkflowFields(options: {
  fields: readonly CommandBarWorkflowField[];
  values: Record<string, CommandBarFieldValue>;
  getFieldStringValue: (
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ) => string;
}): string | null {
  for (const field of options.fields) {
    if (!field.required) continue;
    if (field.type === "toggle") continue;
    const value = options.values[field.id];
    if (field.type === "multi-select" || field.type === "ordered-multi-select") {
      if (coerceFieldValues(value).length === 0) {
        return `${field.label} is required.`;
      }
      continue;
    }
    if (!options.getFieldStringValue(field, value).trim()) {
      return `${field.label} is required.`;
    }
  }
  return null;
}

function collectWorkflowStringValues(options: {
  fields: readonly CommandBarWorkflowField[];
  values: Record<string, CommandBarFieldValue>;
  getFieldStringValue: (
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ) => string;
}): WorkflowStringValues {
  const values: WorkflowStringValues = {};
  for (const field of options.fields) {
    if (field.type === "toggle") {
      values[field.id] = coerceFieldBoolean(options.values[field.id]) ? "true" : "false";
    } else if (field.type === "multi-select" || field.type === "ordered-multi-select") {
      values[field.id] = coerceFieldValues(options.values[field.id]).join(",");
    } else {
      values[field.id] = options.getFieldStringValue(field, options.values[field.id]);
    }
  }
  return values;
}

export async function submitCommandBarWorkflow(options: {
  route: CommandBarWorkflowRoute;
  visibleFields: readonly CommandBarWorkflowField[];
  activeLayoutIndex: number;
  dispatch: Dispatch<AppAction>;
  pluginRegistry: PluginRegistry;
  collectionWorkflowActions: Pick<
    CommandBarCollectionWorkflowActions,
    | "addTickerMembershipFromWorkflow"
    | "connectBrokerProfile"
    | "connectSignedInBroker"
    | "createManualPortfolio"
    | "createWatchlist"
    | "setPortfolioPositionFromWorkflow"
  >;
  extractBrokerWorkflowValues: (
    values: Record<string, CommandBarFieldValue>,
    selectorKey: "brokerType" | "source",
    selectedBrokerId: string,
  ) => WorkflowStringValues;
  getFieldStringValue: (
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ) => string;
  notify: CommandBarNotifyFn;
}): Promise<WorkflowSuccessDisposition> {
  const {
    activeLayoutIndex,
    collectionWorkflowActions,
    dispatch,
    extractBrokerWorkflowValues,
    getFieldStringValue,
    notify,
    pluginRegistry,
    route,
    visibleFields,
  } = options;

  const connectBrokerFromWorkflow = async (selectorKey: "brokerType" | "source") => {
    const selection = resolveBrokerWorkflowSelection(route, selectorKey);
    if (!selection) throw new Error("Broker is required.");
    if (selection.method.kind === "signed-in") {
      // The connect dialog cannot open over the command bar, so the workflow
      // closes now and the outcome, a refusal included, arrives as a toast.
      void collectionWorkflowActions.connectSignedInBroker(selection.method.broker).catch((error: unknown) => {
        notify(error instanceof Error ? error.message : String(error), { type: "error" });
      });
      return;
    }
    const brokerId = selection.method.adapter.id;
    const values = extractBrokerWorkflowValues(route.values, selectorKey, brokerId);
    await collectionWorkflowActions.connectBrokerProfile(brokerId, values);
  };

  switch (route.payload.kind) {
    case "builtin": {
      switch (route.payload.actionId) {
        case "new-watchlist":
          await collectionWorkflowActions.createWatchlist(
            coerceFieldString(route.values.name),
            parseOwnerValue(route.values.owner),
          );
          break;
        case "new-layout": {
          const name = coerceFieldString(route.values.name).trim();
          if (!name) throw new Error("Layout name is required.");
          dispatch({ type: "NEW_LAYOUT", name });
          notify(`Created layout "${name}".`, { type: "success" });
          break;
        }
        case "rename-layout": {
          const name = coerceFieldString(route.values.name).trim();
          if (!name) throw new Error("Layout name is required.");
          dispatch({ type: "RENAME_LAYOUT", index: activeLayoutIndex, name });
          notify(`Renamed layout to "${name}".`, { type: "success" });
          break;
        }
        case "new-portfolio": {
          const source = coerceFieldString(route.values.source);
          if (source === "manual") {
            await collectionWorkflowActions.createManualPortfolio(
              coerceFieldString(route.values.name),
              parseOwnerValue(route.values.owner),
            );
          } else {
            await connectBrokerFromWorkflow("source");
          }
          break;
        }
        case "add-broker-account":
          await connectBrokerFromWorkflow("brokerType");
          break;
        case "add-portfolio": {
          const shares = coerceFieldString(route.values.shares).trim();
          if (!shares) {
            await collectionWorkflowActions.addTickerMembershipFromWorkflow(route.values);
          } else {
            await collectionWorkflowActions.setPortfolioPositionFromWorkflow(route.values);
          }
          break;
        }
        case "set-portfolio-position":
          await collectionWorkflowActions.setPortfolioPositionFromWorkflow(route.values);
          break;
        default:
          break;
      }
      break;
    }
    case "plugin-command": {
      const command = pluginRegistry.commands.get(route.payload.actionId);
      if (!command) throw new Error("Command not found.");
      const values = collectWorkflowStringValues({
        fields: visibleFields,
        getFieldStringValue,
        values: route.values,
      });
      await command.execute(values);
      if (route.successLabel) {
        notify(route.successLabel, { type: "success" });
      }
      break;
    }
    case "pane-template": {
      const template = pluginRegistry.paneTemplates.get(route.payload.actionId);
      if (!template) throw new Error("Pane template not found.");
      const argPlaceholder = String(route.payloadMeta?.argPlaceholder ?? "");
      const values = collectWorkflowStringValues({
        fields: visibleFields,
        getFieldStringValue,
        values: route.values,
      });
      const createOptions: PaneTemplateCreateOptions = {
        values,
        arg: argPlaceholder ? values[argPlaceholder] : undefined,
      };
      await pluginRegistry.createPaneFromTemplateAsyncFn(template.id, createOptions);
      if (route.successLabel) {
        notify(route.successLabel, { type: "success" });
      }
      break;
    }
    case "pane-setting": {
      const field = route.payloadMeta?.field as PaneSettingField | undefined;
      const paneId = route.payloadMeta?.paneId as string | undefined;
      if (!field || !paneId) throw new Error("Setting context is missing.");
      let nextValue: unknown;
      switch (field.type) {
        case "text":
          nextValue = coerceFieldString(route.values[field.key]);
          break;
        default:
          nextValue = coerceFieldString(route.values[field.key]);
      }
      await pluginRegistry.applyPaneSettingValueFn(paneId, field, nextValue);
      break;
    }
    default:
      break;
  }

  return route.successBehavior ?? "close";
}
