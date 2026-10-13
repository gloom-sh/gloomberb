import type {
  PaneTemplateContext,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
  PaneTemplateInstanceConfig,
} from "../../../types/plugin";
import { commandTabParams } from "../shared/command-tab";
import type { FixedIncomeSection } from "./model";
import { FIXED_INCOME_PANE_ID } from "./model";

function fixedIncomeInstance(
  context: PaneTemplateContext,
  instance: PaneTemplateInstanceConfig,
): PaneTemplateInstanceConfig {
  const symbol = instance.binding?.kind === "fixed" ? instance.binding.symbol.trim().toUpperCase() : "";
  const encoded = encodeURIComponent(symbol).replace(/%/g, "~");
  const instanceId = symbol ? `${FIXED_INCOME_PANE_ID}:${encoded}` : FIXED_INCOME_PANE_ID;
  const existing = context.layout.instances.find((candidate) => (
    candidate.paneId === FIXED_INCOME_PANE_ID && candidate.instanceId === instanceId
  ));
  return {
    ...instance,
    instanceId: existing?.instanceId ?? instanceId,
    title: symbol ? `Fixed Income ${symbol}` : "Fixed Income",
  };
}

/** Route a legacy function into its tab in the shared workspace. */
export function fixedIncomeShortcut(
  template: PaneTemplateDef,
  section: FixedIncomeSection,
  view: string,
): PaneTemplateDef {
  const create = template.createInstance;
  return {
    ...template,
    paneId: FIXED_INCOME_PANE_ID,
    shortcut: template.shortcut ? { ...template.shortcut, showInBrowse: false } : undefined,
    createInstance: (context: PaneTemplateContext, options?: PaneTemplateCreateOptions) => {
      const created = create ? create(context, options) : {};
      const route = (instance: PaneTemplateInstanceConfig | null) => {
        if (!instance) return null;
        const routed = fixedIncomeInstance(context, instance);
        return {
          ...routed,
          params: commandTabParams(section, { ...routed.params, view }),
        };
      };
      return created instanceof Promise ? created.then(route) : route(created);
    },
  };
}
