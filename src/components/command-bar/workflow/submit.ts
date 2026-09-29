import type { Dispatch } from "react";
import { t, tf } from "../../../i18n";
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
import { recordPluginCommandOpen } from "../commands/plugin/items";
import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import type {
  CommandBarCollectionWorkflowActions,
  CommandBarNotifyFn,
} from "./collection-actions";

/**
 * What the form does after a submit. "stay" keeps it as it was: the user
 * backed out of a step the submit opened, such as a broker sign-in.
 */
export type WorkflowSuccessDisposition = "back" | "close" | "stay";

/** The first required field left empty, and what to tell the user about it. */
export function validateRequiredWorkflowFields(options: {
  fields: readonly CommandBarWorkflowField[];
  values: Record<string, CommandBarFieldValue>;
  getFieldStringValue: (
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ) => string;
}): { fieldId: string; message: string } | null {
  for (const field of options.fields) {
    if (!field.required) continue;
    if (field.type === "toggle") continue;
    const value = options.values[field.id];
    const empty = field.type === "multi-select" || field.type === "ordered-multi-select"
      ? coerceFieldValues(value).length === 0
      : !options.getFieldStringValue(field, value).trim();
    if (empty) return { fieldId: field.id, message: tf("{label} is required.", { label: t(field.label) }) };
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

  /** False when the user backed out of signing the broker in. */
  const connectBrokerFromWorkflow = async (): Promise<boolean> => {
    const selection = resolveBrokerWorkflowSelection(route);
    if (!selection) throw new Error("Broker is required.");
    if (selection.method.kind === "signed-in") {
      return await collectionWorkflowActions.connectSignedInBroker(selection.method.broker);
    }
    const brokerId = selection.method.adapter.id;
    const values = extractBrokerWorkflowValues(route.values, brokerId);
    await collectionWorkflowActions.connectBrokerProfile(brokerId, values);
    return true;
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
          } else if (!await connectBrokerFromWorkflow()) {
            return "stay";
          }
          break;
        }
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
      recordPluginCommandOpen(pluginRegistry, command);
      if (route.successLabel) {
        notify(route.successLabel, { type: "success" });
      }
      break;
    }
    case "pane-template": {
      const template = pluginRegistry.paneTemplates.get(route.payload.actionId);
      if (!template) throw new Error("Pane template not found.");
      const argPlaceholder = String(route.payloadMeta?.argPlaceholder ?? "");
      // What a plugin passed to `createPaneFromTemplate` along with the form.
      const baseOptions = route.payloadMeta?.createOptions as PaneTemplateCreateOptions | undefined;
      const values = collectWorkflowStringValues({
        fields: visibleFields,
        getFieldStringValue,
        values: route.values,
      });
      const createOptions: PaneTemplateCreateOptions = {
        ...baseOptions,
        values,
        arg: argPlaceholder ? values[argPlaceholder] : baseOptions?.arg,
      };
      await pluginRegistry.createPaneFromTemplateAsyncFn(template.id, createOptions);
      if (route.successLabel) {
        notify(route.successLabel, { type: "success" });
      }
      break;
    }
    default:
      break;
  }

  return route.successBehavior ?? "close";
}
