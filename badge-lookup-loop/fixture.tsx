// Before/after pictures of the row-message cases: each case renders one pane in the DOM renderer with the
// same invented data and failures its tests use. Built against main and against the branch, the same file.
//   ?case=alerts|orders|team|team-invite|buildout|settings|ibkr&theme=white|paper
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { DomHostProviders } from "../../src/renderers/dom/dom-host-providers";
import { createWebUiHost, webRendererHost } from "../../src/renderers/electrobun/view/ui-host";
import { applyTheme, colors } from "../../src/theme/colors";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../src/theme/font-scale";
import { Box } from "../../src/ui";
import { useDialog } from "../../src/ui/dialog";
import { useToastHost, ToastViewport } from "../../src/ui/toast";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../src/state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../src/test-support/pane";
import { createConfigBackedTestPluginRuntime, createTestPluginRuntime } from "../../src/test-support/plugin-runtime";
import type { PluginRuntimeAccess } from "../../src/plugins/runtime";
import type { AppNotificationRequest, PaneSettingActionField, PaneSettingField } from "../../src/types/plugin";
import type { PluginRegistry } from "../../src/plugins/registry";
import { AlertsPane } from "../../src/plugins/builtin/alerts/pane";
import { serializeAlerts } from "../../src/plugins/builtin/alerts/alert-engine";
import type { AlertRule } from "../../src/plugins/builtin/alerts/types";
import { BrokerOrdersView } from "../../src/plugins/builtin/broker-trading/orders";
import { createDemoBroker } from "../../src/plugins/builtin/broker-trading/test-fixture";
import { TeamPane } from "../../src/plugins/builtin/cloud/team/pane";
import { requestTeamPaneView } from "../../src/team/pane-request";
import { teamStore } from "../../src/team/store";
import { createTestTeam } from "../../src/team/test-fixture";
import { apiClient, setCloudApiFetchTransport } from "../../src/api-client";
import { BuildoutPane } from "../../src/plugins/builtin/buildout/pane";
import { setHttpFetchTransport } from "../../src/utils/http-transport";
import { PaneSettingsDialogContent } from "../../src/components/pane-settings-dialog";

declare global { interface Window { __shot: { ready: boolean; toasts: string[] } } }
window.__shot = { ready: false, toasts: [] };

const params = new URLSearchParams(location.search);
const scenario = params.get("case") ?? "alerts";
applyTheme(params.get("theme") ?? "white");
document.body.style.background = colors.bg;
document.body.style.margin = "0";

const cols = Math.floor(window.innerWidth / WEB_CELL_WIDTH);
const rows = Math.floor(window.innerHeight / WEB_CELL_HEIGHT);
const PANE = "shot:pane";

/** The app's notify, as the shell draws it: a toast. */
function useNotify(): (notification: AppNotificationRequest) => void {
  const toasts = useToastHost();
  return (notification) => {
    window.__shot.toasts.push(notification.body ?? "");
    const tone = notification.type === "error" ? "error" : notification.type === "success" ? "success" : "info";
    toasts[tone](notification.body ?? "", { title: notification.title, duration: 60_000 });
  };
}

function Frame({ state, dispatch, runtime, pluginId, children }: {
  state: AppState; dispatch?: (action: AppAction) => void; runtime: PluginRuntimeAccess; pluginId: string;
  children: (body: { width: number; height: number }) => ReactNode;
}) {
  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE} pluginId={pluginId} runtime={runtime} width={cols} height={rows} footerKeys>
      {children}
    </TestPaneFrame>
  );
}

function config(paneId: string) {
  const value = createTestPaneConfig("/synthetic/row-shots", { instanceId: PANE, paneId, binding: { kind: "none" } });
  return value;
}

// Alerts: three price alerts, one on a symbol no source quotes.
function AlertsCase() {
  const notify = useNotify();
  const checkedAt = Date.now() - 60_000;
  const rule = (id: string, symbol: string, condition: "above" | "below", targetPrice: number): AlertRule => ({ id, symbol, condition, targetPrice, createdAt: Date.now() - 3_600_000, status: "active" });
  const alerts: AlertRule[] = [
    { ...rule("a1", "AAPL", "above", 400), lastCheckedPrice: 343.1, lastCheckedAt: checkedAt },
    { ...rule("a2", "ZZQXW", "above", 10), lastCheckedAt: checkedAt, lastCheckError: "Not a ticker: ZZQXW." },
    { ...rule("a3", "MSFT", "below", 200), lastCheckedPrice: 512.4, lastCheckedAt: checkedAt },
  ];
  const initial = useMemo(() => {
    const base = config("alerts");
    const state = createInitialState({ ...base, pluginConfig: { ...base.pluginConfig, alerts: { alerts: serializeAlerts(alerts) } } });
    state.focusedPaneId = PANE;
    return state;
  }, []);
  const [state, dispatch] = useReducer(appReducer, initial);
  const holder = useMemo(() => ({ state }), []);
  holder.state = state;
  const runtime = useMemo(() => createConfigBackedTestPluginRuntime({
    getConfig: () => holder.state.config,
    setConfig: (next) => dispatch({ type: "SET_CONFIG", config: next }),
  }, { notify }), []);
  return <Frame state={state} dispatch={dispatch} runtime={runtime} pluginId="alerts">
    {(body) => <AlertsPane paneId={PANE} paneType="alerts" focused {...body} />}
  </Frame>;
}

// Orders: the demo broker, whose cancel the broker refuses.
function OrdersCase() {
  const notify = useNotify();
  const demo = useMemo(() => {
    const value = createDemoBroker();
    value.adapter.cancelOrder = async () => { throw Object.assign(new Error("Too late to cancel this order."), { refused: true }); };
    return value;
  }, []);
  const state = useMemo(() => {
    const base = config("broker-orders");
    base.brokerInstances = [demo.instance];
    const value = createInitialState(base); value.focusedPaneId = PANE;
    return value;
  }, [demo]);
  const runtime = useMemo(() => createTestPluginRuntime({ notify }), []);
  return <Frame state={state} runtime={runtime} pluginId="broker-trading">
    {(body) => <BrokerOrdersView {...body} focused broker={demo.adapter} instance={demo.instance} accounts={demo.accounts()} accountId={demo.draft.accountId}
      onAccountChange={() => {}} onModify={() => {}} />}
  </Frame>;
}

// Team: a desk of three, whose member removals and invitations the service refuses.
const macroDesk = createTestTeam({ role: "owner" });
const members = [
  { id: "m-1", role: "owner", joinedAt: "2026-09-01T00:00:00.000Z", user: { id: "u0", username: "ada", displayName: "Ada" } },
  { id: "m-2", role: "admin", joinedAt: "2026-09-02T00:00:00.000Z", user: { id: "u2", username: "alice", displayName: "Alice Byrne" } },
  { id: "m-3", role: "member", joinedAt: "2026-09-03T00:00:00.000Z", user: { id: "u3", username: "bob", displayName: "Bob" } },
];
function teamRespond(path: string, method: string): unknown {
  if (path === "/teams/org-1/members") return { team: macroDesk, members };
  if (path === "/teams/org-1/invitations" && method === "GET") {
    return { invitations: [{ id: "inv-1", status: "pending", role: "member", expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), createdAt: "2026-09-14T00:00:00.000Z", inviter: members[0]!.user, invitee: { id: "u9", username: "carol", displayName: "Carol" } }] };
  }
  if (path === "/teams/org-1/invite-links") return { links: [{ token: "a".repeat(32), url: "https://gloom.sh/teams/invite/aaaaaaaa", teamId: "org-1", createdBy: "u0", expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), maxUses: null, uses: 3, createdAt: "2026-09-14T00:00:00.000Z" }] };
  if (path === "/teams") return { teams: [macroDesk] };
  if (path === "/teams/invitations") return { invitations: [] };
  if (path === "/teams/notifications") return { notifications: [] };
  if (path === "/chat/channels") return [];
  if (path === "/chat/state") return { channels: [], onlineCount: 0, channelStates: [], notifications: [] };
  return {};
}
const FAILING = new Set(["DELETE /teams/org-1/members/m-3", "POST /teams/org-1/invitations"]);
function TeamCase({ section }: { section: "members" | "invites" }) {
  const notify = useNotify();
  const [ready] = useState(() => {
    setCloudApiFetchTransport(async (url, init) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      const down = FAILING.has(`${method} ${parsed.pathname}`);
      return new Response(JSON.stringify(down ? { error: method === "POST" ? "No Gloom user is called @dave." : "Service unavailable" } : teamRespond(parsed.pathname, method)), {
        status: down ? (method === "POST" ? 404 : 503) : 200, headers: { "content-type": "application/json" },
      });
    });
    apiClient.setSessionToken("row-shots-session");
    apiClient.restoreCachedUser({ id: "u0", username: "ada", emailVerified: true, plan: "pro" } as any);
    (teamStore as any).update({ teams: [macroDesk], invitations: [], loaded: true });
    return true;
  });
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const state = createInitialState(config("team"));
  state.paneState = paneState;
  state.focusedPaneId = PANE;
  const dispatch = (action: AppAction) => setPaneState(appReducer(state, action).paneState);
  const runtime = useMemo(() => createTestPluginRuntime({ notify }), []);
  useEffect(() => {
    if (section !== "members") setTimeout(() => requestTeamPaneView({ teamId: "org-1", section }), 300);
  }, []);
  return ready ? <Frame state={state} dispatch={dispatch} runtime={runtime} pluginId="gloomberb-cloud">
    {(body) => <TeamPane paneId="team" paneType="team" focused {...body} />}
  </Frame> : null;
}

// Buildout: one company, whose star the service does not take.
function BuildoutCase() {
  const notify = useNotify();
  useState(() => {
    (apiClient as any).isSignedIn = () => true;
    (apiClient as any).getSession = async () => ({ id: "fixture-user" });
    (apiClient as any).getBuildoutAccount = async () => ({ subscription: { active: true } });
    (apiClient as any).getBuildoutToken = async () => ({ token: "fixture-token", expiresAt: "2099-01-01T00:00:00Z" });
    setHttpFetchTransport(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" || init?.method === "DELETE") return new Response("Starring is paused for maintenance.", { status: 503 });
      return Response.json(path === "/companies" ? [
        { id: "c-1", name: "Northwind Datacenters", ticker: params.get("ticker") ?? undefined },
        { id: "c-2", name: "Helios Fabrication" },
        { id: "c-3", name: "Quarry Power Systems" },
      ] : []);
    });
    return true;
  });
  const initial = useMemo(() => { const value = createInitialState(config("buildout")); value.focusedPaneId = PANE; return value; }, []);
  const [state, dispatch] = useReducer(appReducer, initial);
  const runtime = useMemo(() => createTestPluginRuntime({ notify }), []);
  return <Frame state={state} dispatch={dispatch} runtime={runtime} pluginId="buildout">
    {(body) => <BuildoutPane paneId={PANE} paneType="buildout" focused {...body} />}
  </Frame>;
}

// Pane settings: the BYOK AI plugin's account rows, whose GitHub Copilot sign-in ends with an expired code.
// The action is the plugin's: on a host with setRowNote it says it on the row, on one without it closes and toasts.
interface RowNote { status: string; text?: string; tone: "warning" | "negative" }
let pendingCode: string | null = null;
function accountRows(): PaneSettingField[] {
  const say = (context: any, note: RowNote | null, toast?: AppNotificationRequest) => {
    if (context.setRowNote?.(note)) return;
    if (toast) context.notify(toast);
  };
  const claude: PaneSettingActionField = {
    key: "account:anthropic", label: "Claude account", type: "action", actionId: "ai.account.anthropic", actionLabel: "Disconnect",
    description: "Connected through Claude Pro.", action: () => {},
  };
  const copilot: PaneSettingActionField = {
    key: "account:github-copilot", label: "GitHub Copilot account", type: "action", actionId: "ai.account.github-copilot", actionLabel: "Connect",
    description: pendingCode ?? "GitHub Copilot can be connected here.",
    async action(context: any) {
      if (!context.setRowNote) context.close();
      say(context, { status: "Connecting…", text: "Finish signing in to GitHub Copilot in the browser page that opened.", tone: "warning" },
        { body: "Opening GitHub Copilot sign-in in your browser…", type: "info" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      pendingCode = "Enter code ABCD-EFGH at https://github.com/login/device. The sign-in page has been opened in your browser.";
      say(context, { status: "Waiting for sign-in", tone: "warning" },
        { title: "GitHub Copilot device sign-in", body: pendingCode, type: "info", persistent: true });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      pendingCode = null;
      const reason = "The device code expired before the sign-in finished. Connect again for a new code.";
      say(context, { status: "Sign-in failed", text: reason, tone: "negative" }, { body: reason, type: "error", persistent: true });
    },
  };
  return [
    { key: "providerId", label: "Provider", type: "select", options: [{ value: "", label: "Default (Claude)" }] } as PaneSettingField,
    claude,
    copilot,
  ];
}
function SettingsCase() {
  const notify = useNotify();
  const dialog = useDialog();
  const state = useMemo(() => createInitialState(config("local-agent-workspace")), []);
  const runtime = useMemo(() => createTestPluginRuntime({ notify }), []);
  useEffect(() => {
    const context = { paneId: PANE, settings: {} };
    const registry = {
      resolvePaneSettings: () => ({ paneId: PANE, pane: { title: "AI Agent", paneId: "local-agent-workspace" }, paneDef: { name: "AI Agent" }, settingsDef: { title: "AI Agent Settings", fields: accountRows() }, context }),
      openCommandBar: () => {},
      notify,
    } as unknown as PluginRegistry;
    void dialog.alert({
      closeOnClickOutside: true,
      content: (ctx: { dismiss: () => void }) => <PaneSettingsDialogContent {...ctx} paneId={PANE} pluginRegistry={registry} applyFieldValue={async () => {}} initialFieldKey="account:github-copilot" />,
    });
  }, []);
  return <Frame state={state} runtime={runtime} pluginId="byok-ai">
    {() => <Box flexGrow={1} />}
  </Frame>;
}

function Case() {
  switch (scenario) {
    case "orders": return <OrdersCase />;
    case "team": return <TeamCase section="members" />;
    case "team-invite": return <TeamCase section="invites" />;
    case "buildout": return <BuildoutCase />;
    case "settings": return <SettingsCase />;
    default: return <AlertsCase />;
  }
}

function Ready() {
  useEffect(() => { requestAnimationFrame(() => requestAnimationFrame(() => { window.__shot.ready = true; })); }, []);
  return null;
}

const root = document.getElementById("root")!;
root.tabIndex = -1;
createRoot(root).render(
  <DomHostProviders ui={createWebUiHost("darwin")} renderer={webRendererHost}>
    <Case />
    <ToastViewport />
    <Ready />
  </DomHostProviders>,
);
