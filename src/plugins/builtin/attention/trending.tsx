import { useCallback } from "react";
import { usePlanAccess } from "../../../api-client/plan-access";
import { isAccessDenied } from "../../../api-client/errors";
import { ActionRow, DataTableView, EmptyState, KeyValueRow, PaneStatusBody, SectionHeading, usePaneStatusFooter } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { SignInWall } from "../cloud/auth-actions";
import { cachedAttention, loadAttention } from "./client";
import { date, emptyAttention, number, signed } from "./model";
import { useThemeColors } from "../../../theme/theme-context";
import { listingCell, missingCell } from "../shared/research-cells";
function useTrending(symbol?: string) {
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const key = `${session.requestKey}:${access.hasProAccess ? "pro" : "preview"}`;
  const loader = useCallback((force: boolean) => loadAttention("today", key, symbol, force), [key, symbol]);
  const resource = useAsyncResource(access.signedIn ? loader : null, { initialData: () => cachedAttention("today", key, symbol), clearOnError: isAccessDenied });
  useAutoRefresh(resource.updatedAt, resource.load);
  return { resource, session, access };
}
/** Optional profile context. A failure here never hides or blocks the description. */
export function TrendingSummary({ symbol, onOpen }: { symbol: string; onOpen?: () => void }) {
  const { resource, access } = useTrending(symbol);
  const data = resource.data?.payload;
  const row = data?.rows[0];
  if (!access.signedIn || !data) return null;
  return <Box flexDirection="column">
    <SectionHeading title="Gloom Trending" />
    {row ? <>
      <KeyValueRow label="Research rank" value={`#${row.rank}`} detail={`Today · ${number(row.researchUnits)} research hours`} />
      <KeyValueRow label="Latest-hour Z" value={signed(row.zScore)} detail={data.asOf ? date(data.asOf) : undefined} />
    </> : <EmptyState title={data.status === "ready" ? data.entitlement === "preview" ? "Outside the current preview." : "No published research hours today." : emptyAttention(data)} />}
    {onOpen ? <ActionRow label="Open research attention" onPress={onOpen} /> : null}
  </Box>;
}
export function TrendingPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const { resource, session, access } = useTrending();
  const data = resource.data?.payload;
  const { createPaneFromTemplate } = usePluginAppActions();
  const [selectedIndex, setSelectedIndex] = usePluginPaneState("trending:selected", 0);
  const open = () => createPaneFromTemplate("attention-pane", { values: { window: "today" } });
  usePaneRefreshKey(() => void resource.reload(), { focused });
  usePaneStatusFooter({ registrationId: "attention:trending", loading: resource.loading, error: data ? resource.error : null, stale: data?.stale || resource.data?.stale,
    info: data?.asOf ? [{ id: "asof", parts: [{ text: `published ${date(data.asOf)}`, tone: "muted" }] }] : [],
    hints: [{ id: "attention", key: "a", label: "ttention", onPress: open }] });
  if (!access.signedIn || !data && isCloudSessionRequired(resource.error)) return <SignInWall placement="attention-trending-signin" action="view research attention" needsVerification={session.needsVerification} />;
  return <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} empty={!!data && !data.rows.length} emptyTitle={emptyAttention(data)} subject="research attention">
    {data ? <DataTableView columns={[{ id: "symbol", label: "Ticker", width: 16, flexGrow: 1, align: "left" }, { id: "research", label: "Research hrs", width: 12, align: "right" }, { id: "z", label: "1H Z", width: 8, align: "right" }]}
      items={data.rows.slice(0, 5)} emptyStateTitle="No published research hours." rootWidth={width} rootHeight={height} focused={focused} getItemKey={(row) => row.symbol} selection={{ kind: "index", selectedIndex, onChange: setSelectedIndex }}
      sortColumnId={null} sortDirection="desc" onActivate={(row) => createPaneFromTemplate("attention-pane", { arg: row.symbol, values: { window: "today" } })}
      selectedTextOverridesCellColor renderCell={(row, column, _index, state) => column.id === "symbol" ? listingCell(row.symbol, colors, state.selected)
        : column.id === "research" ? { text: number(row.researchUnits), value: row.researchUnits, color: colors.textBright }
        : row.zScore == null ? missingCell(colors) : { text: signed(row.zScore), value: row.zScore, color: row.zScore >= 2 ? colors.warning : colors.text, keepColorWhenSelected: row.zScore >= 2 }} /> : <EmptyState title="Sign in to view research attention." />}
  </PaneStatusBody>;
}
