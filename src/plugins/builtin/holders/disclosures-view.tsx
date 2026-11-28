import { useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import type { OwnershipDisclosure } from "../../../api-client/ownership-disclosures";
import { DataTableView, PaneStatusBody, usePaneFooter } from "../../../components";
import { handleRefreshKey, loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { MISSING_VALUE } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { logFailure } from "../../../utils/log-failure";
import { useRendererHost } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { disclosureColumns, disclosureEmpty, disclosureWarnings } from "./disclosures";

const keyOf = (row: OwnershipDisclosure) => row.id ?? JSON.stringify([row.url, row.owner, row.role, row.date, row.position, row.securities, row.pledged]);

export function OwnershipDisclosureView({listing, focused, width, onCycle}: {
  listing: string; focused: boolean; width: number; onCycle: () => void;
}) {
  const host = useRendererHost();
  const session = useResearchCloudSession();
  const load = useCallback(() => apiClient.getOwnershipDisclosures(listing, 1000), [listing, session.requestKey]);
  const {data, error, loading, reload} = useAsyncResource(load, {
    clearOnError: error => error instanceof Error && isCloudSessionRequired(error.message),
  });
  const payload = data?.listing === listing ? data : null;
  const rows = payload?.rows ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const current = rows.find(row => keyOf(row) === selected) ?? rows[0];
  const open = (row: OwnershipDisclosure) => {
    void host.openExternal(row.url).catch(logFailure("holders.disclosures", "Open ownership source failed"));
  };
  const warnings = payload ? disclosureWarnings(payload).join(" ") : "";
  const empty = payload && !rows.length;
  const truncated = payload && rows.length < payload.total ? `Showing ${rows.length} of ${payload.total}` : "";
  usePaneFooter("holder-disclosures", () => ({
    info: [
      {id: "source", parts: [{text: [payload?.publisher, truncated, warnings].filter(Boolean).join(" · "), tone: "muted" as const}]},
      ...loadingErrorFooterInfo(loading, payload ? error : null),
    ],
    hints: current ? [{id: "source", key: "o", label: "pen source", onPress: () => open(current)}] : [],
  }), [payload, truncated, warnings, current, host, loading, error]);
  const columns = disclosureColumns(rows).map(([id,label,width]) => ({id,label,width,align: (["securities", "involved", "change", "pledged", "percent", "direct", "deemed"].includes(id) ? "right" : "left") as "right" | "left"}));
  if (isCloudSessionRequired(error)) {
    return <SignInWall placement="holders-disclosures-signin" action="view ownership disclosures" needsVerification={session.needsVerification} />;
  }
  return <PaneStatusBody loading={loading && !payload} error={payload ? null : error} subject="ownership disclosures" empty={!!empty} emptyTitle={warnings || (empty ? disclosureEmpty(payload) : undefined)}>
    <DataTableView focused={focused} rootWidth={width} items={rows} columns={columns} sortColumnId={null} sortDirection="desc"
      selection={{kind: "id", selectedId: current ? keyOf(current) : null, getId: keyOf, onChange: setSelected}}
      getItemKey={keyOf} resetScrollKey={listing} onActivate={open} freezeFirstColumn showHorizontalScrollbar
      onRootKeyDown={event => {
        if (handleRefreshKey(event, reload, {stopPropagation: true})) return true;
        if (isPlainKey(event, "s")) { onCycle(); return true; }
        if (isPlainKey(event, "o") && current) { open(current); return true; }
        return false;
      }}
      rowNote={row => row.reason ?? null}
      renderCell={(row, column) => {
        const value = row[column.id];
        return {text: typeof value === "number"
          ? value.toLocaleString("en-US", row.filing ? { maximumFractionDigits: 20 } : undefined)
          : value ?? MISSING_VALUE};
      }}
      emptyStateTitle="No ownership disclosures." />
  </PaneStatusBody>;
}
