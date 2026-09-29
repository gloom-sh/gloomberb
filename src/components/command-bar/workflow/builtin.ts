import type { AppState } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";
import {
  buildSetPortfolioPositionWorkflow,
} from "../../../plugins/builtin/portfolio-list/command-bar";
import type { CommandBarFieldOption, CommandBarWorkflowField, CommandBarWorkflowRoute } from "./types";
import { buildCommandBarWorkflowRoute } from "./route-builder";
import { teamPrefix } from "../../../plugins/builtin/cloud/team/model";
import { teamStore } from "../../../plugins/builtin/cloud/team/store";

/**
 * Where a new collection lives: me, or one of my teams. Only asked when there
 * is a team; the default follows the FOCUS lens.
 */
function ownerField(): { field: CommandBarWorkflowField; value: string } | null {
  const snapshot = teamStore.getSnapshot();
  if (snapshot.teams.length === 0) return null;
  const options: CommandBarFieldOption[] = [
    { label: "Me", value: "user", description: "Only you see it" },
    ...snapshot.teams.map((team) => ({
      label: `${teamPrefix(team)} ${team.name}`,
      value: `team:${team.id}`,
      description: "Every member sees and edits it",
    })),
  ];
  const defaultTeamId = teamStore.getDefaultTeamId();
  return {
    field: { id: "owner", label: "Owner", type: "select", options, required: true },
    value: defaultTeamId ? `team:${defaultTeamId}` : "user",
  };
}

export function parseOwnerValue(value: unknown): { kind: "user" } | { kind: "team"; teamId: string } {
  return typeof value === "string" && value.startsWith("team:")
    ? { kind: "team", teamId: value.slice("team:".length) }
    : { kind: "user" };
}

type BrokerWorkflowBuilder = (
  title: string,
  subtitle: string | undefined,
  submitLabel: string,
) => CommandBarWorkflowRoute;

export type BuiltInWorkflowRouteResult =
  | { kind: "route"; route: CommandBarWorkflowRoute }
  | { kind: "notice"; message: string }
  | { kind: "none" };

export function buildBuiltInWorkflowRoute(options: {
  actionId: string;
  activeCollectionId: string | null;
  activeTicker: TickerRecord | null;
  buildBrokerWorkflow: BrokerWorkflowBuilder;
  config: AppState["config"];
}): BuiltInWorkflowRouteResult {
  const {
    actionId,
    activeCollectionId,
    activeTicker,
    buildBrokerWorkflow,
    config,
  } = options;

  switch (actionId) {
    case "new-watchlist": {
      const owner = ownerField();
      return {
        kind: "route",
        route: buildCommandBarWorkflowRoute({
          workflowId: "builtin:new-watchlist",
          title: "New Watchlist",
          fields: [
            ...(owner ? [owner.field] : []),
            {
              id: "name",
              label: "Watchlist Name",
              type: "text",
              placeholder: "My Watchlist",
              required: true,
            },
          ],
          values: { name: "", ...(owner ? { owner: owner.value } : {}) },
          submitLabel: "Create Watchlist",
          pendingLabel: "Creating watchlist…",
          payload: { kind: "builtin", actionId },
        }),
      };
    }

    case "new-layout":
    case "rename-layout":
      return {
        kind: "route",
        route: buildCommandBarWorkflowRoute({
          workflowId: `builtin:${actionId}`,
          title: actionId === "new-layout" ? "New Layout" : "Rename Layout",
          fields: [{
            id: "name",
            label: "Layout Name",
            type: "text",
            placeholder: actionId === "new-layout"
              ? "Trading, Research, Overview"
              : config.layouts[config.activeLayoutIndex]?.name || "Layout name",
            required: true,
          }],
          values: { name: "" },
          submitLabel: actionId === "new-layout" ? "Create Layout" : "Rename Layout",
          pendingLabel: actionId === "new-layout" ? "Creating layout…" : "Renaming layout…",
          payload: { kind: "builtin", actionId },
        }),
      };

    case "new-portfolio": {
      const route = buildBrokerWorkflow(
        "New Portfolio",
        "Choose a source for the new portfolio.",
        "Create Portfolio",
      );
      // A paper portfolio can belong to a team; broker portfolios never do.
      const owner = ownerField();
      if (owner && route.kind === "workflow") {
        const nameIndex = route.fields.findIndex((field) => field.id === "name");
        const field: CommandBarWorkflowField = { ...owner.field, dependsOn: [{ key: "source", value: "manual" }] };
        route.fields.splice(nameIndex >= 0 ? nameIndex : route.fields.length, 0, field);
        route.values.owner = owner.value;
      }
      return { kind: "route", route };
    }

    case "set-portfolio-position": {
      const workflow = buildSetPortfolioPositionWorkflow(config, {
        activeCollectionId,
        activeTicker,
      });
      if (!workflow) {
        return { kind: "notice", message: "Create a manual portfolio first." };
      }
      return {
        kind: "route",
        route: buildCommandBarWorkflowRoute({
          workflowId: "builtin:set-portfolio-position",
          title: "Set Portfolio Position",
          fields: workflow.fields,
          values: workflow.values,
          submitLabel: "Save Position",
          pendingLabel: workflow.pendingLabel,
          payload: { kind: "builtin", actionId },
        }),
      };
    }

    default:
      return { kind: "none" };
  }
}
