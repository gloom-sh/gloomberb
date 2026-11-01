import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Button,
  DataTableStackView,
  EmptyState,
  PaneStatusBody,
  StatGrid,
  delayedFooterSegment,
  usePaneFooter,
  usePaneTabs,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
  type PaneHint,
  type StatItem,
} from "../../../../components";
import { statGridWithin } from "../../../../components/ui/stat-grid";
import { useAsyncResource, usePaneSettingValue, usePluginAppActions } from "../../../../public/react";
import { usePaneStateValue } from "../../../../state/app/context";
import { usePaneTickerIdentity } from "../../../../state/hooks/pane-ticker";
import { useInlineTickers } from "../../../../state/hooks/inline-tickers";
import { collectUniqueTickerSymbols } from "../../../../tickers/tokenizer";
import { priceColor } from "../../../../theme/colors";
import { useThemeColors } from "../../../../theme/theme-context";
import type { PaneProps } from "../../../../types/plugin";
import { Box, ScrollBox, useRendererHost } from "../../../../ui";
import { CLOUD_PLAN_KEY } from "../../shared/cloud-upgrade";
import { useOpenDescription } from "../../shared/open-description";
import { renderBuildoutCell } from "../cells";
import { BuildoutDetail } from "../detail";
import { BUILDOUT_COMPANY_PANE_ID } from "./id";
import { metricNumber, moneyText, text, tickerSearchText, tickerSymbol } from "../format";
import type { BuildoutColumn, BuildoutRow, BuildoutUpdate } from "../model/types";
import { NOT_IN_SCREENSHOTS } from "../model";
import { rowKey } from "../table-model";
import { CompanyFlow, CompanyFlowList, FLOW_MIN_WIDTH } from "./flow";
import {
  fetchCompanyProfile,
  fetchCompanySignals,
  totalPowerMw,
  type BuildoutCompanyProfile,
  type BuildoutCompanySite,
  type BuildoutHiringSegment,
  type BuildoutRelation,
} from "./model";

const UPGRADE_URL = "https://thebuildout.ai/pricing";

export type CompanyTab = "flow" | "sites" | "hiring" | "signals";
const TABS: Array<{ label: string; value: CompanyTab }> = [
  { label: "Flow", value: "flow" },
  { label: "Sites", value: "sites" },
  { label: "Hiring", value: "hiring" },
  { label: "Signals", value: "signals" },
];
const isCompanyTab = (value: unknown): value is CompanyTab => TABS.some((tab) => tab.value === value);

type SiteColumn = DataTableColumn & { id: "site" | "type" | "role" | "mw" | "place" };
const SITE_COLUMNS: SiteColumn[] = [
  { id: "site", label: "Site", width: 24, align: "left", flexGrow: 1 },
  { id: "type", label: "Type", width: 12, align: "left" },
  { id: "role", label: "Role", width: 8, align: "left" },
  { id: "mw", label: "MW", width: 6, align: "right" },
  { id: "place", label: "Place", width: 18, align: "left" },
];

type HiringColumn = DataTableColumn & { id: "place" | "roles" | "change" | "family" | "site" };
const HIRING_COLUMNS: HiringColumn[] = [
  { id: "place", label: "Place", width: 18, align: "left", flexGrow: 1 },
  { id: "roles", label: "Roles", width: 6, align: "right" },
  { id: "change", label: "Chg", width: 5, align: "right" },
  { id: "family", label: "Roles in", width: 18, align: "left" },
  { id: "site", label: "Site", width: 22, align: "left", flexGrow: 1 },
];

/** A company's signals: what happened first, then who else it names. */
const SIGNAL_COLUMNS: BuildoutColumn[] = [
  { id: "time", label: "Time", width: 4, align: "left" },
  { id: "headline", label: "Title", width: 40, align: "left", flexGrow: 4 },
  { id: "companies", label: "Also", width: 16, align: "left" },
];

/** Columns that fit `width`, the flexible ones first to give way after the fixed tail. */
function fitColumns<C extends DataTableColumn>(columns: readonly C[], width: number, dropOrder: readonly string[]): C[] {
  let kept = [...columns];
  for (const id of dropOrder) {
    const total = kept.reduce((sum, column) => sum + column.width + 1, 0);
    if (total <= width) break;
    kept = kept.filter((column) => column.id !== id);
  }
  return kept;
}

function headerItems(profile: BuildoutCompanyProfile): StatItem[] {
  const count = (role: BuildoutRelation["role"]) => profile.relations.filter((relation) => relation.role === role).length;
  const power = count("power");
  const mw = totalPowerMw(profile);
  const owned = profile.sites.filter((site) => site.role === "owner").length;
  const change = metricNumber(profile.return1y);
  return [
    { id: "company", label: "Company", value: profile.name, detail: profile.marketCap ? moneyText(profile.marketCap) : undefined },
    { id: "return", label: "1Y", value: text(profile.return1y), ...(change == null ? {} : { color: priceColor(change) }) },
    ...(mw
      ? [{ id: "power", label: "Power", value: `${mw.toLocaleString("en-US")} MW`, detail: `${power} ${power === 1 ? "deal" : "deals"}` }]
      : power ? [{ id: "power", label: "Power deals", value: String(power) }] : []),
    { id: "suppliers", label: "Suppliers", value: String(count("supplier")) },
    { id: "customers", label: "Customers", value: String(count("customer")) },
    { id: "sites", label: "Sites", value: String(profile.sites.length), detail: profile.sites.length && owned < profile.sites.length ? `${owned} owned` : undefined },
  ];
}

function siteCell(site: BuildoutCompanySite, column: SiteColumn, dim: string, bright: string): DataTableCell {
  switch (column.id) {
    case "site": return { text: site.name, color: bright };
    case "type": return { text: text(site.type), color: dim };
    case "role": return { text: site.role === "owner" ? "Owner" : "Partner", color: dim };
    case "mw": return { text: site.mw == null ? "-" : site.mw.toLocaleString("en-US"), ...(site.mw == null ? {} : { value: site.mw }), color: dim };
    case "place": return { text: text(site.place), color: dim };
  }
}

function hiringCell(segment: BuildoutHiringSegment, column: HiringColumn, dim: string, bright: string): DataTableCell {
  switch (column.id) {
    case "place": return { text: segment.place, color: bright };
    case "roles": return { text: segment.roles == null ? "-" : String(segment.roles), color: bright };
    case "change": return { text: segment.change == null ? "-" : `${segment.change > 0 ? "+" : ""}${segment.change}`, color: segment.change ? priceColor(segment.change) : dim };
    case "family": return { text: text(segment.roleFamily), color: dim };
    case "site": return { text: text(segment.site), color: dim };
  }
}

/**
 * One company from TheBuildout: its power and hosting deals, suppliers and
 * customers as a flow, its sites, where it hires, and the signals that name
 * it. It follows the company selected in TheBuildout, or any list it is
 * linked to.
 */
export function BuildoutCompanyPane({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const openDescription = useOpenDescription();
  const { symbol } = usePaneTickerIdentity();
  const [settingTab] = usePaneSettingValue<unknown>("tab", undefined);
  const [tab, setTab] = usePaneStateValue<CompanyTab>("tab", isCompanyTab(settingTab) ? settingTab : "flow");
  const [siteIndex, setSiteIndex] = useState(0);
  const [hiringIndex, setHiringIndex] = useState(0);
  const [signalIndex, setSignalIndex] = useState(0);
  const [openSignal, setOpenSignal] = useState<BuildoutUpdate | null>(null);

  const loader = useMemo(() => (symbol ? () => fetchCompanyProfile(symbol) : null), [symbol]);
  const profile = useAsyncResource(loader, { keepPreviousData: true });
  // The last company stays while the next loads; one the dataset does not have says so.
  const company = profile.data;
  const missing = !!symbol && !company && !profile.loading && !profile.error;
  const signalsLoader = useMemo(
    () => (company?.id && tab === "signals" ? () => fetchCompanySignals(company.id) : null),
    [company?.id, tab],
  );
  const signals = useAsyncResource(signalsLoader);

  const openRelation = useCallback((relation: BuildoutRelation) => {
    if (relation.ticker) openDescription(relation.ticker);
  }, [openDescription]);
  const upgrade = useCallback(() => { void rendererHost.openExternal(UPGRADE_URL); }, [rendererHost]);

  // Every signal names this company, so its row lists only the others.
  const focusTicker = tickerSymbol(company?.ticker ?? symbol);
  const signalRows = useMemo<BuildoutRow[]>(() => (signals.data ?? []).map((item) => ({
    kind: "intel",
    item: { ...item, companies: (item.companies ?? []).filter((entry) => tickerSymbol(entry.ticker) !== focusTicker) },
  })), [focusTicker, signals.data]);
  const tickerTexts = useMemo(() => {
    if (!openSignal) return [];
    const texts = [openSignal.headline, openSignal.content ?? "", openSignal.context ?? ""];
    return [tickerSearchText([...collectUniqueTickerSymbols(texts)])];
  }, [openSignal]);
  const { catalog, openTicker } = useInlineTickers(tickerTexts, { badgeQuotes: true });

  const { strip, rows: tabRows } = usePaneTabs({
    tabs: TABS,
    activeValue: tab,
    onSelect: (value) => setTab(value as CompanyTab),
    focused: focused && !openSignal,
    compact: true,
    variant: "bare",
  });

  const free = company?.access === "free";
  const footerHints = useMemo<PaneHint[]>(() => {
    const hints: PaneHint[] = [];
    if (free) hints.push({ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade", onPress: upgrade });
    return hints;
  }, [free, upgrade]);
  usePaneFooter(BUILDOUT_COMPANY_PANE_ID, () => {
    const info: PaneFooterSegment[] = [];
    if (profile.loading && company) info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (profile.error && company) info.push({ id: "error", parts: [{ text: "refresh failed", tone: "warning" }] });
    if (free && tab === "signals") info.push(delayedFooterSegment({ id: "access", detail: "72h delayed", delay: "72h", onPress: upgrade }));
    return { info, hints: footerHints };
  }, [company, footerHints, free, profile.error, profile.loading, tab, upgrade]);

  const frame = (content: ReactNode) => (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {strip && <Box height={1}>{strip}</Box>}
      {content}
    </Box>
  );
  if (!symbol) {
    return frame(<EmptyState title="No company selected." message="Link this pane to TheBuildout or a list, or open TBOC with a ticker." />);
  }
  if (!company) {
    if (missing) return frame(<EmptyState title={`${symbol} is not in TheBuildout.`} />);
    if (profile.error) return frame(<PaneStatusBody error={String(profile.error)} subject="TheBuildout" retry={String(profile.error) === NOT_IN_SCREENSHOTS ? undefined : { onRetry: () => void profile.load(true) }} />);
    return frame(<PaneStatusBody loading subject="TheBuildout" />);
  }

  const header = statGridWithin(headerItems(company), width, 2);
  const bodyHeight = Math.max(1, height - tabRows - header.lines);
  const dim = colors.textDim;
  const bright = colors.text;

  let body: ReactNode;
  if (tab === "flow") {
    body = company.relations.length === 0
      ? <EmptyState title="No relationships in TheBuildout yet." />
      : width >= FLOW_MIN_WIDTH
        ? <CompanyFlow profile={company} width={width} height={bodyHeight} focused={focused} onOpen={openRelation} />
        : (
          <ScrollBox width={width} height={bodyHeight} scrollY focusable={false}>
            <CompanyFlowList profile={company} width={width} onOpen={openRelation} />
          </ScrollBox>
        );
  } else if (tab === "sites") {
    const columns = fitColumns(SITE_COLUMNS, width - 1, ["place", "type", "mw"]);
    body = (
      <DataTableStackView<BuildoutCompanySite, SiteColumn>
        focused={focused}
        detailOpen={false}
        onBack={() => {}}
        detailContent={null}
        rootWidth={width}
        rootHeight={bodyHeight}
        columns={columns}
        sortColumnId={null}
        sortDirection="asc"
        items={company.sites}
        selection={{ kind: "index", selectedIndex: siteIndex, onChange: setSiteIndex }}
        getItemKey={(site) => site.id}
        renderCell={(site, column) => siteCell(site, column, dim, bright)}
        emptyStateTitle="No sites in TheBuildout yet."
      />
    );
  } else if (tab === "hiring") {
    const columns = fitColumns(HIRING_COLUMNS, width - 1, ["site", "family", "change"]);
    body = company.hiring.segments.length ? (
      <DataTableStackView<BuildoutHiringSegment, HiringColumn>
        focused={focused}
        detailOpen={false}
        onBack={() => {}}
        detailContent={null}
        rootWidth={width}
        rootHeight={bodyHeight}
        columns={columns}
        sortColumnId={null}
        sortDirection="asc"
        emptyStateTitle="No hiring by site."
        items={company.hiring.segments}
        selection={{ kind: "index", selectedIndex: hiringIndex, onChange: setHiringIndex }}
        getItemKey={(segment) => segment.id}
        renderCell={(segment, column) => hiringCell(segment, column, dim, bright)}
      />
    ) : (
      <EmptyState
        title={company.hiring.hasData && free ? "Hiring by site is in Pro." : `No hiring by site for ${company.name} yet.`}
        message={company.hiring.hasData && free ? "Pro shows the roles a company is hiring for, place by place, and the site they match." : company.ticker ? "HIRE shows the company's open roles from its own postings." : undefined}
        actions={company.hiring.hasData && free
          ? <Button label="Upgrade" onPress={upgrade} />
          : company.ticker ? <Button label={`HIRE ${company.ticker}`} onPress={() => createPaneFromTemplate("hiring-pane", { symbol: company.ticker })} /> : undefined}
      />
    );
  } else {
    body = (
      <DataTableStackView<BuildoutRow, BuildoutColumn>
        focused={focused}
        detailOpen={!!openSignal}
        onBack={() => setOpenSignal(null)}
        detailTitle={openSignal?.headline}
        detailContent={(
          <BuildoutDetail
            row={openSignal ? { kind: "intel", item: openSignal } : null}
            width={width}
            height={bodyHeight}
            catalog={catalog}
            openTicker={openTicker}
          />
        )}
        rootWidth={width}
        rootHeight={bodyHeight}
        columns={fitColumns(SIGNAL_COLUMNS, width - 1, ["companies"])}
        sortColumnId={null}
        sortDirection="asc"
        items={signalRows}
        selection={{ kind: "index", selectedIndex: signalIndex, onChange: setSignalIndex }}
        onActivate={(row) => { if (row.kind === "intel") setOpenSignal(row.item); }}
        getItemKey={rowKey}
        renderCell={(row, column, _index, rowState) => renderBuildoutCell(row, column, rowState, { favoriteBusyKey: null, toggleFavorite: () => {} })}
        selectedTextOverridesCellColor
        emptyStateTitle={signals.loading ? "Loading..." : signals.error ? "Signals could not load." : `No signals name ${company.name} yet.`}
      />
    );
  }

  return frame(<>
    <StatGrid items={header.items} width={width} maxLines={2} />
    {body}
  </>);
}
