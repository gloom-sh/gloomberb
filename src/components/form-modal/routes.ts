import type { BrokerDirectoryEntry } from "../../brokers/directory";
import { tf } from "../../i18n";
import { buildAddToPortfolioWorkflow } from "../../plugins/builtin/portfolio-list/command-bar";
import type { PluginRegistry } from "../../plugins/registry";
import {
  getFocusedCollectionId,
  getFocusedTickerSymbol,
  type AppState,
} from "../../state/app/context";
import type { CommandDef, PaneTemplateCreateOptions } from "../../types/plugin";
import type { TickerRecord } from "../../types/ticker";
import { buildPaneTemplateWorkflowRoute } from "../command-bar/pane-templates/workflow-route";
import { buildBrokerWorkflowRoute } from "../command-bar/workflow/broker";
import { buildBuiltInWorkflowRoute } from "../command-bar/workflow/builtin";
import { getFirstVisibleFieldId, normalizeWizardFields } from "../command-bar/workflow/fields";
import type { FormRoute } from "./model";

/** What to fill in, once the host resolved what the caller asked for. */
export type FormRouteResult =
  | { kind: "route"; route: FormRoute }
  | { kind: "notice"; message: string }
  | { kind: "none" };

function focusedTicker(state: AppState): TickerRecord | null {
  const symbol = getFocusedTickerSymbol(state);
  return symbol ? state.tickers.get(symbol) ?? null : null;
}

export function buildBuiltInFormRoute(
  actionId: string,
  state: AppState,
  brokerDirectory: BrokerDirectoryEntry[],
): FormRouteResult {
  return buildBuiltInWorkflowRoute({
    actionId,
    activeCollectionId: getFocusedCollectionId(state),
    activeTicker: focusedTicker(state),
    buildBrokerWorkflow: (title, subtitle, submitLabel) => buildBrokerWorkflowRoute({
      directory: brokerDirectory,
      submitLabel,
      subtitle,
      title,
    }),
    config: state.config,
  });
}

/**
 * A plugin command's wizard as one form. Without values from a typed
 * argument, the command's own argument parser fills what it can from the
 * focused ticker, as a launch from a pane always has.
 */
export function buildPluginCommandFormRoute(
  command: CommandDef,
  state: AppState,
  values?: Record<string, string>,
): FormRouteResult {
  if (!command.wizard || command.wizard.length === 0) return { kind: "none" };
  let defaults: Record<string, string> | undefined = values;
  if (!defaults) {
    try {
      defaults = command.shortcutArg?.parse?.("", { activeTicker: getFocusedTickerSymbol(state) });
    } catch {
      defaults = undefined;
    }
  }
  const normalized = normalizeWizardFields(command.wizard);
  const initialValues = { ...normalized.initialValues, ...(defaults ?? {}) };
  return {
    kind: "route",
    route: {
      kind: "workflow",
      workflowId: `plugin-command:${command.id}`,
      title: command.label,
      subtitle: command.description,
      description: normalized.description,
      fields: normalized.fields,
      values: initialValues,
      activeFieldId: getFirstVisibleFieldId(normalized.fields, initialValues),
      submitLabel: command.label,
      pendingLabel: normalized.pendingLabel,
      successLabel: normalized.successLabel,
      pending: false,
      error: null,
      successBehavior: "close",
      payload: { kind: "plugin-command", actionId: command.id },
    },
  };
}

export function buildAddToPortfolioFormRoute(
  ticker: TickerRecord,
  portfolioId: string | null | undefined,
  state: AppState,
): FormRouteResult {
  const workflow = buildAddToPortfolioWorkflow(state.config, {
    preferredPortfolioId: portfolioId,
    ticker,
    defaultAvgCost: state.financials.get(ticker.metadata.ticker)?.quote?.price ?? null,
  });
  if (!workflow) return { kind: "notice", message: "Create a manual portfolio first." };
  return {
    kind: "route",
    route: {
      kind: "workflow",
      workflowId: "builtin:add-portfolio",
      title: tf("Add {symbol} to Portfolio", { symbol: ticker.metadata.ticker }),
      fields: workflow.fields,
      values: workflow.values,
      activeFieldId: getFirstVisibleFieldId(workflow.fields, workflow.values),
      submitLabel: "Add to Portfolio",
      pendingLabel: workflow.pendingLabel,
      pending: false,
      error: null,
      successBehavior: "close",
      payload: { kind: "builtin", actionId: "add-portfolio" },
    },
  };
}

export function buildPaneTemplateFormRoute(
  pluginRegistry: PluginRegistry,
  templateId: string,
  arg: string | undefined,
  state: AppState,
  createOptions?: PaneTemplateCreateOptions,
): FormRouteResult {
  const template = pluginRegistry.paneTemplates.get(templateId);
  if (!template) return { kind: "none" };
  const route = buildPaneTemplateWorkflowRoute({
    activeTicker: getFocusedTickerSymbol(state),
    arg,
    template,
  });
  return {
    kind: "route",
    route: createOptions ? { ...route, payloadMeta: { ...route.payloadMeta, createOptions } } : route,
  };
}
