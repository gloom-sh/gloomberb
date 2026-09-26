import type { GloomPlugin, PaneTemplateCreateOptions } from "../../../types/plugin";
import { CUSTOM_VIEW_PANE_ID, CUSTOM_VIEW_SPEC_SETTING, CustomViewPane } from "./pane";
import { parseViewSpec, serializeViewSpec, type ViewSpec } from "./view-spec";

export { CUSTOM_VIEW_PANE_ID } from "./pane";
export { setViewRefResolver } from "./loader";
export * from "./view-spec";

export const CUSTOM_VIEW_TEMPLATE_ID = "custom-view-pane";

/** The pane instance settings for a spec, the one place that shape is decided. */
export function customViewInstanceSettings(spec: ViewSpec): Record<string, string> {
  return { [CUSTOM_VIEW_SPEC_SETTING]: serializeViewSpec(spec) };
}

export function customViewCreateOptions(spec: ViewSpec, name?: string): PaneTemplateCreateOptions {
  const title = name?.trim() || spec.presentation.title;
  return { values: { spec: serializeViewSpec(spec), ...(title ? { title } : {}) } };
}

/**
 * Custom views: declarative tables built by ASKG or the local agent through
 * view.create and view.update, rendered by one built-in pane, and publishable
 * to a team where they become pane templates for every member.
 */
export const customViewPlugin: GloomPlugin = {
  id: "custom-view",
  name: "Custom Views",
  version: "1.0.0",
  description: "Tables built from any data function: columns, a filter, a sort. Made by the agent, shared with a team.",
  toggleable: false,

  panes: [{
    id: CUSTOM_VIEW_PANE_ID,
    name: "View",
    icon: "V",
    component: CustomViewPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 100, height: 28 },
    tableExport: true,
    settings: {
      fields: [{
        key: CUSTOM_VIEW_SPEC_SETTING,
        label: "View spec (JSON)",
        type: "text",
        description: "Source, columns, filters, sort. Ask Gloom to write it.",
      }],
    },
  }],

  paneTemplates: [{
    id: CUSTOM_VIEW_TEMPLATE_ID,
    paneId: CUSTOM_VIEW_PANE_ID,
    label: "Custom View",
    description: "A table from any data function with your columns, filter, and sort.",
    keywords: ["view", "custom", "table", "query", "screen", "columns", "filter"],
    shortcut: { prefix: "VIEW", argPlaceholder: "spec JSON or empty", argKind: "text" },
    createInstance: (_context, options) => {
      const raw = options?.values?.spec ?? options?.arg ?? "";
      const spec = raw ? parseViewSpec(raw) : null;
      return {
        placement: "floating",
        ...(options?.values?.title ? { title: options.values.title } : spec?.presentation.title ? { title: spec.presentation.title } : {}),
        ...(spec ? { settings: customViewInstanceSettings(spec) } : {}),
      };
    },
  }],
};
