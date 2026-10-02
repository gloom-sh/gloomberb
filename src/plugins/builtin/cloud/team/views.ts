import { apiClient, type TeamView, type TeamViewEvent } from "../../../../api-client";
import type { PluginCapability } from "../../../../capabilities";
import type { GloomPluginContext, PaneTemplateDef } from "../../../../types/plugin";
import {
  CUSTOM_VIEW_PANE_ID,
  customViewInstanceSettings,
  parseViewSpec,
  setViewRefResolver,
  type ViewSpec,
} from "../../custom-view";
import { teamPrefix } from "./model";
import { teamStore } from "./store";

const CLOUD_VIEWS_CAPABILITY_ID = "cloud.views";

type Listener = () => void

/**
 * Every team's published views, kept current from the server and the
 * view.updated frames, each registered as a pane template under its team so
 * it shows in the command bar as `MD· Movers`. A `ref` view spec resolves
 * through here, which is how a teammate's later revision reaches an open
 * pane without republishing.
 */
class TeamViewsStore {
  private views = new Map<string, TeamView>();
  private readonly listeners = new Set<Listener>();
  private readonly templateDisposers = new Map<string, () => void>();
  private ctx: Pick<GloomPluginContext, "registerPaneTemplate"> | null = null;
  private disposers: Array<() => void> = [];

  attach(ctx: Pick<GloomPluginContext, "registerPaneTemplate">): void {
    this.ctx = ctx;
  }

  list(teamId?: string): TeamView[] {
    const all = [...this.views.values()];
    return (teamId ? all.filter((view) => view.teamId === teamId) : all).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(viewId: string): TeamView | null {
    return this.views.get(viewId) ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    setViewRefResolver(async (source) => {
      const cached = this.views.get(source.viewId);
      const view = cached ?? (await apiClient.getTeamView(source.viewId).catch(() => null));
      if (!view) return null;
      if (!cached) this.upsert(view);
      return parseViewSpec(view.spec);
    });
    this.disposers.push(
      teamStore.subscribe(() => {
        void this.refresh();
      }),
      apiClient.subscribeCloudEvent("view.updated", (data) => {
        const event = data as TeamViewEvent;
        if ("view" in event) this.upsert(event.view);
      }),
      apiClient.subscribeCloudEvent("view.deleted", (data) => {
        const event = data as TeamViewEvent;
        if ("viewId" in event) this.remove(event.viewId);
      }),
    );
    void this.refresh();
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const dispose of this.templateDisposers.values()) dispose();
    this.templateDisposers.clear();
    this.views.clear();
    setViewRefResolver(null);
  }

  private lastTeamKey = "";

  async refresh(): Promise<void> {
    const teams = teamStore.getSnapshot().teams;
    const teamKey = teams.map((team) => team.id).join(",");
    if (teamKey === this.lastTeamKey && this.views.size > 0) return;
    this.lastTeamKey = teamKey;
    if (!apiClient.isVerified() || teams.length === 0) {
      for (const id of [...this.views.keys()]) this.remove(id);
      return;
    }
    const lists = await Promise.all(teams.map((team) => apiClient.listTeamViews(team.id).catch(() => [] as TeamView[])));
    const next = new Map(lists.flat().map((view) => [view.id, view]));
    for (const id of [...this.views.keys()]) {
      if (!next.has(id)) this.remove(id);
    }
    for (const view of next.values()) this.upsert(view);
  }

  upsert(view: TeamView): void {
    this.views.set(view.id, view);
    this.registerTemplate(view);
    this.emit();
  }

  remove(viewId: string): void {
    if (!this.views.delete(viewId)) return;
    this.templateDisposers.get(viewId)?.();
    this.templateDisposers.delete(viewId);
    this.emit();
  }

  private registerTemplate(view: TeamView): void {
    if (!this.ctx) return;
    const team = teamStore.getTeam(view.teamId);
    const label = `${team ? `${teamPrefix(team)} ` : ""}${view.name}`;
    const spec: ViewSpec = {
      version: 1,
      source: { kind: "ref", viewId: view.id, teamId: view.teamId },
      projection: { columns: [], filters: [] },
      presentation: { title: view.name },
    };
    const template: PaneTemplateDef = {
      id: `team-view:${view.id}`,
      paneId: CUSTOM_VIEW_PANE_ID,
      label,
      description: `${team?.name ?? "Team"} view, r${view.revision} by ${view.author.username ? `@${view.author.username}` : view.author.displayName}.`,
      keywords: ["view", "team", view.name, team?.name ?? "", team?.shortName ?? ""].filter(Boolean),
      createInstance: () => ({
        placement: "floating",
        title: label,
        settings: customViewInstanceSettings(spec),
      }),
    };
    this.templateDisposers.get(view.id)?.();
    this.templateDisposers.set(view.id, this.ctx.registerPaneTemplate(template));
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const teamViewsStore = new TeamViewsStore();

/** What other plugins may ask about team views: list, get, resolve a ref, follow changes. */
export function createCloudViewsCapability(): PluginCapability {
  return {
    id: CLOUD_VIEWS_CAPABILITY_ID,
    kind: "plugin-service",
    name: "Team views",
    operations: {
      list: {
        kind: "read",
        rendererSafe: true,
        handler: (input: { teamId?: string } = {}) => teamViewsStore.list(input.teamId),
      },
      get: {
        kind: "read",
        rendererSafe: true,
        handler: async (input: { viewId: string }) => teamViewsStore.get(input.viewId) ?? apiClient.getTeamView(input.viewId),
      },
      resolve: {
        kind: "read",
        rendererSafe: true,
        handler: async (input: { viewId: string }) => {
          const view = teamViewsStore.get(input.viewId) ?? (await apiClient.getTeamView(input.viewId));
          return view ? parseViewSpec(view.spec) : null;
        },
      },
      subscribe: {
        kind: "stream",
        rendererSafe: true,
        subscribe: (_input, emit) => {
          const publish = () => emit(teamViewsStore.list());
          publish();
          return teamViewsStore.subscribe(publish);
        },
      },
    },
  };
}
