import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient } from "../../../api-client";
import { getWallSummary } from "../../../api-client/wall-summary";
import { usePlanAccess } from "../../../api-client/plan-access";
import { exposeWallTeaser, recordWallViewed } from "../../../api-client/research-activity";
import { Badge, DataTableView, KeyValueRow, SectionHeading } from "../../../components";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { usePaneVisible } from "../../../state/app/activity";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { wrapTextLines } from "../../../utils/text-wrap";
import { listingIdentity } from "./ticker-request";
import { WALL_TEASERS } from "./wall-teaser-catalog";
import { trackWallView } from "./wall-view-lifecycle";

export interface WallTeaserProps {
  placement: string;
  width: number;
  height: number;
  title?: string;
  message?: string;
  symbol?: string | null;
  exchange?: string;
  children: ReactNode;
}

const SUMMARY_LABELS: Record<string, string> = {
  risk_count: "Risk factors",
  filed_at: "Filed",
  proxy_count: "Proxy statements",
  call_count: "Calls available",
  last_call_at: "Last call",
  filing_count_90d: "8-K filings in 90 days",
  last_filed_at: "Last filed",
  open_roles: "Open roles",
  as_of: "As of",
};

type Summary = { kind: "counts"; items: { label: string; value: number | string }[] };
type Teaser = { kind: "summary"; summary: Summary } | { kind: "sample" } | { kind: "none" };

/** No layout reservation or focus changes: the original wall remains usable while asking. */
export function WallTeaser({ children, placement, width, height, title = "", message = "", symbol, exchange }: WallTeaserProps) {
  useAppLanguage();
  const visible = usePaneVisible();
  const access = usePlanAccess();
  const userId = apiClient.getCurrentUser()?.id;
  const native = useUiCapabilities().nativePaneChrome === true;
  const sample = WALL_TEASERS[placement];
  const listing = sample?.summary ? listingIdentity(symbol, exchange) : null;
  const key = `${userId ?? "guest"}:${placement}:${listing?.symbol ?? ""}:${listing?.exchange ?? ""}`;
  const [resolved, setResolved] = useState<{ key: string; arm: string | null; teaser: Teaser } | null>(null);
  // Includes padding, the original action row and a two-row sample. Wrapped
  // wall copy must never push its buttons out of a short terminal pane.
  const copyRows = wrapTextLines(t(title), Math.max(1, width - 2)).length
    + wrapTextLines(t(message), Math.max(1, width - 2)).length;
  const fits = width >= 34 && height >= copyRows + 10;
  const trackedView = useRef<ReturnType<typeof trackWallView> | null>(null);

  useEffect(() => {
    if (!visible || access.hasProAccess) return;
    const view = trackWallView({
      identity: userId ?? "guest",
      placement,
      exposure: exposeWallTeaser(),
      currentIdentity: () => apiClient.getCurrentUser()?.id ?? "guest",
      record: recordWallViewed,
    });
    trackedView.current = view;
    return () => {
      if (trackedView.current === view) trackedView.current = null;
      view.release();
    };
  }, [visible, access.hasProAccess, userId, placement]);

  useEffect(() => {
    if (!visible || access.hasProAccess) return;
    let cancelled = false;
    void (async () => {
      const arm = await (trackedView.current?.exposure ?? exposeWallTeaser());
      if (cancelled) return;
      let teaser: Teaser = { kind: "none" };
      if (arm === "teaser" && fits && sample) {
        const summary = listing
          ? await getWallSummary(placement, listing.symbol, listing.exchange)
          : null;
        teaser = summary?.items.length ? { kind: "summary", summary } : { kind: "sample" };
      }
      if (cancelled) return;
      setResolved({ key, arm, teaser });
    })();
    return () => { cancelled = true; };
  }, [visible, access.hasProAccess, key, fits, placement, listing?.symbol, listing?.exchange, sample]);

  const current = resolved?.key === key ? resolved : null;
  const teaser = fits && current?.arm === "teaser" ? current.teaser : { kind: "none" as const };
  useEffect(() => {
    if (!visible || !current || access.hasProAccess) return;
    trackedView.current?.report(current.arm === "teaser" ? teaser.kind : undefined);
  }, [visible, current, access.hasProAccess, placement, teaser.kind]);

  return <>
    {children}
    {teaser.kind !== "none" && <Box
      flexDirection="column" paddingX={1} paddingBottom={1} flexShrink={0}
      data-gloom-ui="wall-teaser" data-teaser-kind={teaser.kind}
    >
      {teaser.kind === "summary" ? teaser.summary.items.map((item) => (
        <KeyValueRow key={item.label} label={t(SUMMARY_LABELS[item.label] ?? item.label)}
          value={String(item.value)} width={width - 2} labelWidth={Math.min(25, width - 14)} />
      )) : <FrozenWallSample placement={placement} width={width - 2} native={native} />}
    </Box>}
  </>;
}

function FrozenWallSample({ placement, width, native }: { placement: string; width: number; native: boolean }) {
  const colors = useThemeColors();
  const sample = WALL_TEASERS[placement]!;
  const columns = sample.columns.map((label, index) => ({
    id: String(index), label: t(label), width: Math.max(9, Math.floor((width - 2) / 3)), align: "left" as const,
  }));
  return <>
    <Box flexDirection="row" marginBottom={1}><Badge label={t("Sample")} /></Box>
    {sample.layout === "prose" ? sample.rows.map(([heading, meta, detail]) => (
      <Box key={heading} flexDirection="column">
        <SectionHeading title={t(heading)} />
        <Box style={native ? { filter: "blur(3px)", opacity: 0.6, pointerEvents: "none", userSelect: "none" } : undefined}>
          <Text fg={colors.textMuted} dim wrapText>{[t(meta), detail].filter(Boolean).join(" · ")}</Text>
        </Box>
      </Box>
    )) :
    <Box height={sample.rows.length + 1} style={native ? { pointerEvents: "none", userSelect: "none" } : undefined}>
      <DataTableView
        columns={columns} items={[...sample.rows]} rootWidth={width} rootHeight={sample.rows.length + 1}
        focused={false} keyboardNavigation={false} selection={{ kind: "none" }} sortable={false}
        sortColumnId={null} sortDirection="asc" getItemKey={(_row, index) => String(index)}
        isNavigable={() => false} emptyStateTitle="" showHorizontalScrollbar={false}
        renderCell={(row, column) => {
          const value = row[Number(column.id)] ?? "";
          // Unknown market values are blank shapes, never invented prices or
          // trades. DOM masking uses CSS; terminal masking uses shade cells.
          const masked = Number(column.id) > 0;
          return {
            text: value,
            color: colors.textMuted,
            content: native && masked
              ? <Box style={value
                ? { filter: "blur(3px)", opacity: 0.6 }
                : { background: colors.textMuted, opacity: 0.25, filter: "blur(3px)", width: "65%", height: "0.65em", marginTop: "0.2em" }}>
                {value && <Text fg={colors.textMuted}>{value}</Text>}
              </Box>
              : undefined,
            ...(!native && masked ? { text: value || "░░░░░░", attributes: 2 } : {}),
          };
        }}
      />
    </Box>}
  </>;
}
