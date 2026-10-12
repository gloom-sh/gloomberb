import { Box } from "../../../ui";
import { NestedPaneTabs, usePaneTabs } from "../../../components";
import type {
  PaneDef,
  PaneTemplateDef,
  PaneTemplateContext,
  PaneTemplateCreateOptions,
  PaneProps,
  PaneTemplateInstanceConfig,
  TickerResearchTabProps,
} from "../../../types/plugin";
import { usePaneSettingValue } from "../../../public/react";
import type { PluginModule } from "../plugin-module";
import { withCommandTab, commandTabParams, useCommandTab } from "../shared/command-tab";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { withPluginStateNamespace } from "../../runtime/context";
import { SecView, secHeadless } from "../sec";
import { ETF_FILING_FORMS, ETF_FORMS_SETTING } from "../sec/forms";
import { createSecHeadless, fundFilingsEmpty } from "../sec/headless";
import { mayBeUsEquityOrFundTicker, mayBeUsEquityTicker } from "../../../utils/sec";
import { RiskFactorsPane } from "../risk-factors/pane";
import { riskFactorsHeadless } from "../risk-factors/headless";
import { FilingEventsPane } from "../filing-events/pane";
import { catalystsHeadless, litigationHeadless } from "../catalysts/headless";
import { CatalystsPane, LitigationPane } from "../catalysts/pane";
import { MNA_PANE_ID } from "../mna/model";
import { MnaWorkspacePane } from "../mna/pane";
import { mnaHeadless } from "../mna/headless";
import { distressHeadless } from "../mna/distress/headless";
import { DistressBoard } from "../mna/distress/pane";
import { CorporateActionsView } from "../research/corporate-actions-pane";
import { eventsHeadless } from "../research/events-headless";
import { CommentLettersPane } from "../comment-letters/pane";
import { COMMENT_LETTERS_PANE_ID } from "../comment-letters/types";

const FILINGS_WORKSPACE_PANE_ID = "filings-workspace";
const EVENTS_WORKSPACE_PANE_ID = "events-workspace";

type FilingsTab = "sec" | "etf" | "eight-k" | "risks" | "comments";
type EventsTab = "corporate-actions" | "catalysts" | "litigation" | "mna" | "distress";

const FILINGS_TABS = [
  { label: "SEC", value: "sec" },
  { label: "ETF", value: "etf" },
  { label: "8-K", value: "eight-k" },
  { label: "Risks", value: "risks" },
  { label: "Letters", value: "comments" },
] as const;

const EVENTS_TABS = [
  { label: "Events", value: "corporate-actions" },
  { label: "Catalysts", value: "catalysts" },
  { label: "Legal", value: "litigation" },
  { label: "M&A", value: "mna" },
  { label: "Distress", value: "distress" },
] as const;

const CommentLettersView = withPluginStateNamespace("comment-letters", CommentLettersPane);

function FilingsWorkspace(props: PaneProps & { queryBarWidth?: number; initialTab?: FilingsTab }) {
  const [hideTabs] = usePaneSettingValue("hideTabs", false);
  const [lockedTabId] = usePaneSettingValue("lockedTabId", "");
  const [lockedWorkspaceTab] = usePaneSettingValue("lockedWorkspaceTab", "");
  const lockedTab = lockedTabId === FILINGS_WORKSPACE_PANE_ID && FILINGS_TABS.some((entry) => entry.value === lockedWorkspaceTab)
    ? lockedWorkspaceTab as FilingsTab
    : null;
  const [tab, setTab] = useCommandTab<FilingsTab>(FILINGS_WORKSPACE_PANE_ID, "filings:tab", FILINGS_TABS.map((entry) => entry.value), "sec");
  const activeTab = lockedTab ?? props.initialTab ?? tab;
  const { strip, rows } = usePaneTabs(!hideTabs ? { tabs: [...FILINGS_TABS], activeValue: activeTab, onSelect: (value) => setTab(value as FilingsTab), focused: props.focused, dense: true, queryBarWidth: props.queryBarWidth } : null);
  const child = { ...props, height: Math.max(1, props.height - rows) };

  return (
    <Box width={props.width} height={props.height} flexDirection="column">
      {strip ? <Box height={rows} flexShrink={0}>{strip}</Box> : null}
      <NestedPaneTabs>
        {activeTab === "sec" || activeTab === "etf" ? <SecView {...child} fundFilings={activeTab === "etf"} />
          : activeTab === "eight-k" ? <FilingEventsPane {...child} />
          : activeTab === "risks" ? <RiskFactorsPane {...child} nested />
          : <CommentLettersView {...child} />}
      </NestedPaneTabs>
    </Box>
  );
}

export function EventsWorkspacePane(props: PaneProps & { queryBarWidth?: number; initialTab?: EventsTab }) {
  const [hideTabs] = usePaneSettingValue("hideTabs", false);
  const [lockedTabId] = usePaneSettingValue("lockedTabId", "");
  const [lockedWorkspaceTab] = usePaneSettingValue("lockedWorkspaceTab", "");
  const lockedTab = lockedTabId === EVENTS_WORKSPACE_PANE_ID && EVENTS_TABS.some((entry) => entry.value === lockedWorkspaceTab)
    ? lockedWorkspaceTab as EventsTab
    : null;
  const [tab, setTab] = useCommandTab<EventsTab>(EVENTS_WORKSPACE_PANE_ID, "events:tab", EVENTS_TABS.map((entry) => entry.value), "corporate-actions");
  const activeTab = lockedTab ?? props.initialTab ?? tab;
  const { strip, rows } = usePaneTabs(!hideTabs ? { tabs: [...EVENTS_TABS], activeValue: activeTab, onSelect: (value) => setTab(value as EventsTab), focused: props.focused, dense: true, queryBarWidth: props.queryBarWidth } : null);
  const child = { ...props, height: Math.max(1, props.height - rows) };

  return (
    <Box width={props.width} height={props.height} flexDirection="column">
      {strip ? <Box height={rows} flexShrink={0}>{strip}</Box> : null}
      <NestedPaneTabs>
        {activeTab === "corporate-actions" ? <CorporateActionsView {...child} />
          : activeTab === "catalysts" ? <CatalystsPane {...child} queryBarWidth={props.width} />
          : activeTab === "litigation" ? <LitigationPane {...child} queryBarWidth={props.width} />
          : activeTab === "mna" ? <MnaWorkspacePane {...child} view="deals" />
          : <DistressBoard {...child} />}
      </NestedPaneTabs>
    </Box>
  );
}

function hidden(template: PaneTemplateDef): PaneTemplateDef {
  return template.shortcut
    ? { ...template, shortcut: { ...template.shortcut, showInBrowse: false } }
    : template;
}

function hideAndRoute(template: PaneTemplateDef, tab: string): PaneTemplateDef {
  return hidden(withCommandTab(template, tab));
}

function preserveLegacyTickerInstanceId(template: PaneTemplateDef, legacyPaneId: string): PaneTemplateDef {
  const create = template.createInstance;
  return {
    ...template,
    createInstance: (context, options) => {
      const created = create?.(context, options);
      const rewrite = (instance: PaneTemplateInstanceConfig | null) => {
        if (!instance?.instanceId) return instance;
        const sourcePrefix = [FILINGS_WORKSPACE_PANE_ID, EVENTS_WORKSPACE_PANE_ID]
          .find((paneId) => instance.instanceId?.startsWith(`${paneId}:`));
        if (!sourcePrefix) return instance;
        return { ...instance, instanceId: `${legacyPaneId}:${instance.instanceId.slice(sourcePrefix.length + 1)}` };
      };
      return created instanceof Promise ? created.then(rewrite) : rewrite(created ?? null);
    },
  };
}

function FilingsResearchTab(props: TickerResearchTabProps) {
  const pane: PaneProps = {
    paneId: FILINGS_WORKSPACE_PANE_ID,
    paneType: FILINGS_WORKSPACE_PANE_ID,
    width: props.width,
    height: props.height,
    focused: props.focused,
  };
  return <NestedPaneTabs><FilingsWorkspace {...pane} queryBarWidth={props.width} /></NestedPaneTabs>;
}

function EventsResearchTab(props: TickerResearchTabProps) {
  const pane: PaneProps = {
    paneId: EVENTS_WORKSPACE_PANE_ID,
    paneType: EVENTS_WORKSPACE_PANE_ID,
    width: props.width,
    height: props.height,
    focused: props.focused,
  };
  return <NestedPaneTabs><EventsWorkspacePane {...pane} queryBarWidth={props.width} /></NestedPaneTabs>;
}

function createEventsWorkspaceInstance(
  context: PaneTemplateContext,
  options?: PaneTemplateCreateOptions,
): PaneTemplateInstanceConfig {
  const ticker = (options?.symbol ?? options?.arg ?? context.activeTicker ?? "").trim().toUpperCase();
  return {
    instanceId: ticker ? `corporate-actions:${encodeURIComponent(ticker).replace(/%/g, "~")}` : `${EVENTS_WORKSPACE_PANE_ID}:market`,
    placement: "floating",
    binding: ticker ? { kind: "fixed", symbol: ticker } : { kind: "none" },
    ...(ticker ? { title: `Events ${ticker}` } : {}),
    params: commandTabParams(ticker ? "corporate-actions" : "catalysts"),
  };
}

const secTemplate = createTickerSurfacePaneTemplate({
  id: "sec-pane",
  paneId: FILINGS_WORKSPACE_PANE_ID,
  label: "SEC Filings",
  description: "Recent SEC filings for the selected ticker.",
  keywords: ["sec", "filings", "10-k", "10-q", "8-k"],
  shortcut: "SEC",
  shortcutAliases: ["CF"],
  canCreate: (_context, options) => !options?.ticker || mayBeUsEquityTicker(options.ticker),
});

const etfTemplate = createTickerSurfacePaneTemplate({
  id: "sec-etf-pane",
  paneId: FILINGS_WORKSPACE_PANE_ID,
  label: "ETF Filings",
  description: "A US-listed fund's SEC filings: registration statements, prospectus updates, shareholder reports, N-CEN and N-PORT.",
  keywords: ["etf", "fund", "n-1a", "485bpos", "497", "n-csr", "n-cen", "n-port", "prospectus"],
  shortcut: "ETF",
  viewKey: "ETF",
  canCreate: (_context, options) => !options?.ticker || mayBeUsEquityOrFundTicker(options.ticker),
  settings: () => ({ forms: ETF_FORMS_SETTING }),
});

const riskTemplate = createTickerSurfacePaneTemplate({
  id: "risk-factors-pane",
  paneId: FILINGS_WORKSPACE_PANE_ID,
  label: "Risk Factors",
  description: "The company's 10-K risk factors, and what was added, dropped, or rewritten since the prior year.",
  keywords: ["risk", "risks", "risk factors", "10-k", "annual report", "item 1a"],
  shortcut: "RISK",
});

const eightKTemplate = createTickerSurfacePaneTemplate({
  id: "filing-events-pane",
  paneId: FILINGS_WORKSPACE_PANE_ID,
  label: "8-K Filings",
  description: "The company's 8-K filings, classified by item and read: agreements, executive changes, auditor changes, restructurings, and what each said.",
  keywords: ["8-k", "8k", "current report", "events", "material", "filings", "executive change"],
  shortcut: "EK",
});

const commentLettersTemplate: PaneTemplateDef = {
  id: "comment-letters-pane",
  paneId: FILINGS_WORKSPACE_PANE_ID,
  label: "SEC Comment Letters",
  description: "SEC staff comment letters and company responses (CORRESP, UPLOAD): search their text, or a ticker for one company's letters.",
  keywords: ["comment", "letters", "corresp", "upload", "sec", "edgar", "correspondence", "staff", "response"],
  shortcut: { prefix: "CLTR", argPlaceholder: "words or ticker", argKind: "text", argOptional: true },
  createInstance: (_context, options) => {
    const query = (options?.arg ?? options?.symbol ?? options?.values?.query ?? "").trim();
    const encoded = encodeURIComponent(query).replace(/%/g, "~");
    return {
      instanceId: query ? `${COMMENT_LETTERS_PANE_ID}:${encoded}` : `${COMMENT_LETTERS_PANE_ID}:latest`,
      title: query ? `Filings ${query}` : undefined,
      placement: "floating",
      binding: { kind: "none" },
      settings: { query },
    };
  },
};

const corporateActionsTemplate = createTickerSurfacePaneTemplate({
  id: "corporate-actions-pane",
  paneId: EVENTS_WORKSPACE_PANE_ID,
  label: "Corporate Actions",
  description: "Dividends, splits, reported earnings, and analyst estimates.",
  keywords: ["events", "corporate", "actions", "dividend", "split", "earnings", "estimate", "revenue", "evt"],
  shortcut: "EVT",
  publicShare: true,
});

const eventsWorkspaceTemplate: PaneTemplateDef = {
  id: "events-workspace-pane",
  paneId: EVENTS_WORKSPACE_PANE_ID,
  label: "Events & Special Situations",
  description: "Issuer corporate actions, catalysts, legal dockets, M&A deals, and distress signals.",
  keywords: ["events", "catalysts", "legal", "litigation", "m&a", "deals", "distress", "corporate actions"],
  shortcut: { prefix: "EVNT", argPlaceholder: "ticker", argKind: "ticker", argOptional: true, openWithoutArg: true },
  createInstance: createEventsWorkspaceInstance,
};

export const filingsWorkspaceModule: PluginModule = {
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: FILINGS_WORKSPACE_PANE_ID,
      name: "Filings",
      order: 36,
      component: FilingsResearchTab,
      instruments: ["equity"],
      isVisible: ({ ticker }) => mayBeUsEquityTicker(ticker),
    });
  },
  panes: [{
    id: FILINGS_WORKSPACE_PANE_ID,
    name: "Filings",
    icon: "F",
    component: FilingsWorkspace,
    defaultPosition: "right",
    tickerFollower: true,
    defaultMode: "floating",
    defaultFloatingSize: { width: 110, height: 32 },
    tableExport: true,
  } satisfies PaneDef],
  paneTemplates: [
    {
      ...preserveLegacyTickerInstanceId(createTickerSurfacePaneTemplate({
        id: "filings-workspace-pane",
        paneId: FILINGS_WORKSPACE_PANE_ID,
        label: "Filings",
        description: "Issuer SEC filings, 8-Ks, ETF filings, risk factors, and comment letters.",
        keywords: ["filings", "sec", "8-k", "risk", "comment letters"],
        shortcut: "FIL",
      }), "sec"),
      headless: secHeadless,
    },
    { ...hideAndRoute(preserveLegacyTickerInstanceId(secTemplate, "sec"), "sec"), headless: secHeadless },
    { ...hideAndRoute(preserveLegacyTickerInstanceId(etfTemplate, "sec"), "etf"), headless: createSecHeadless(undefined, {
      forms: ETF_FILING_FORMS,
      title: "Fund Filings",
      argumentDescription: "US-listed fund ticker.",
      empty: fundFilingsEmpty,
    }) },
    { ...hideAndRoute(preserveLegacyTickerInstanceId(riskTemplate, "risk-factors"), "risks"), headless: riskFactorsHeadless },
    hideAndRoute(preserveLegacyTickerInstanceId(eightKTemplate, "filing-events"), "eight-k"),
    hideAndRoute(commentLettersTemplate, "comments"),
  ],
};

export const eventsWorkspaceModule: PluginModule = {
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: EVENTS_WORKSPACE_PANE_ID,
      name: "Events",
      order: 34,
      component: EventsResearchTab,
      instruments: ["equity", "fund"],
    });
  },
  panes: [{
    id: EVENTS_WORKSPACE_PANE_ID,
    name: "Events & Special Situations",
    icon: "E",
    component: EventsWorkspacePane,
    defaultPosition: "right",
    tickerFollower: true,
    defaultMode: "floating",
    defaultFloatingSize: { width: 120, height: 32 },
    tableExport: true,
  } satisfies PaneDef],
  paneTemplates: [
    eventsWorkspaceTemplate,
    { ...hideAndRoute(preserveLegacyTickerInstanceId(corporateActionsTemplate, "corporate-actions"), "corporate-actions"), headless: eventsHeadless },
    {
      ...hideAndRoute({
        id: "catalysts-pane",
        paneId: EVENTS_WORKSPACE_PANE_ID,
        label: "Catalysts",
        description: "Pro regulatory, clinical, legal and trade-policy calendar with source evidence and revision history.",
        keywords: ["catalysts", "calendar", "FDA", "clinical", "regulatory", "deadlines", "antitrust", "sanctions"],
        shortcut: { prefix: "CATL", argKind: "ticker", argPlaceholder: "ticker", argOptional: true, openWithoutArg: true },
        createInstance: (_context, options) => {
          const symbol = (options?.symbol ?? options?.arg ?? "").trim().toUpperCase();
          const event = options?.values?.event;
          const open = event && /^[a-zA-Z0-9:_-]{1,160}$/.test(event) ? event : undefined;
          return {
            title: symbol ? `Events ${symbol}` : "Events & Special Situations",
            placement: "floating",
            ...(symbol ? { binding: { kind: "fixed" as const, symbol } } : {}),
            settings: { symbol, ...(open ? { open } : {}) },
          };
        },
      }, "catalysts"),
      headless: catalystsHeadless,
    },
    { ...hideAndRoute(preserveLegacyTickerInstanceId(createTickerSurfacePaneTemplate({
      id: "litigation-pane",
      paneId: EVENTS_WORKSPACE_PANE_ID,
      label: "Litigation",
      description: "Pro company litigation, enforcement and antitrust dockets with dated source evidence.",
      keywords: ["litigation", "legal", "docket", "court", "enforcement", "antitrust"],
      shortcut: "LITI",
    }), "litigation"), "litigation"), headless: litigationHeadless },
    {
      ...hideAndRoute({
        id: "mna-pane",
        paneId: EVENTS_WORKSPACE_PANE_ID,
        label: "M&A",
        description: "Pending, rumored and closed mergers and acquisitions, with live arbitrage spreads on listed targets.",
        keywords: ["m&a", "mna", "merger", "mergers", "acquisition", "acquisitions", "takeover", "tender offer", "deal", "arbitrage", "spread"],
        shortcut: { prefix: "MA", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
        createInstance: (_context, options) => {
          const symbol = (options?.symbol ?? options?.arg)?.trim().toUpperCase();
          return symbol
            ? { instanceId: `${MNA_PANE_ID}:${symbol}`, title: `Events ${symbol}`, binding: { kind: "fixed", symbol }, placement: "floating", settings: { ticker: symbol } }
            : { placement: "floating" };
        },
      }, "mna"),
      headless: mnaHeadless,
    },
    {
      ...hideAndRoute({
        id: "distress-pane",
        paneId: EVENTS_WORKSPACE_PANE_ID,
        label: "Distress",
        description: "Dated public records about companies in difficulty: US 8-K bankruptcy, obligation and listing filings, SEC going-concern disclosures, Taiwan listing designations, and French and UK insolvency notices.",
        keywords: ["distress", "distressed", "bankruptcy", "chapter 11", "receivership", "going concern", "substantial doubt", "insolvency", "liquidation", "administration", "delisting", "delisted", "suspended", "special situations"],
        shortcut: { prefix: "DIST" },
        createInstance: () => ({ placement: "floating" }),
      }, "distress"),
      headless: distressHeadless,
    },
  ],
};
