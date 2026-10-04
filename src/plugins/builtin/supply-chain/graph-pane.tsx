import { useCallback, useMemo, useRef, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import { DEFAULT_GRAPH_OPTIONS, type GraphOptions, type GraphPath, type GraphPayload } from "../../../api-client/supply-chain-graph";
import type { SupplyEntity } from "../../../api-client/supply-chain";
import { ActionRow, Badge, Button, ButtonActionScope, DataTableView, DetailScrollBody, EmptyState, KeyValueRow, Notice, NumberField, PageStackView, PaneStatusBody, QueryBar, StatGrid, TextField, usePaneNoticeFooter, usePaneStatusFooter, type DataTableColumn, type PaneHint, type QueryBarFilter, type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { RatioBar } from "../../../components/ui/ratio-bar";
import { useAsyncResource, useAutoRefresh, useInputCapture, usePaneInstance, usePaneSettingValue, usePluginAppActions, usePluginPaneState, useShortcut } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, ScrollBox, Text, TextAttributes, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedGraph, graphOptions, loadGraph, validateGraph } from "./graph-client";
import { entityKey, entityLabel, exposureLabel, pathLabel } from "./graph-model";
import { SupplyGraph } from "./graph";
import { DisclosureQuote } from "./disclosure-quote";
import { ROLE_COLORS, roleLabel, shareParts } from "./model";
import { scrollByLines } from "../../../state/pane-scroll-registry";
import { isPlainKey } from "../../../utils/keyboard";
import { displayWidth } from "../../../utils/format";
import { useRemoteUiNode } from "../../../remote/semantic-tree";

const PATH_COLUMNS: DataTableColumn[] = [{ id: "route", label: "Route", width: 40, align: "left" }, { id: "relationships", label: "Relationships", width: 22, align: "left" }, { id: "hops", label: "Hops", width: 6, align: "right" }, { id: "score", label: "Score", width: 9, align: "right" }, { id: "confidence", label: "Confidence", width: 12, align: "right" }, { id: "exposure", label: "Estimated exposure", width: 35, align: "left" }];
const SOURCE_LABELS = { xbrl: "Structured filing", filing_text: "Filing text", call: "Earnings call", news: "News", web: "Website", import: "Imported record" };
const TIER_LABELS = { structured: "Structured", primary: "Primary", secondary: "Secondary", imported: "Imported" };

function GraphInputs({ options, focused, width, onSave, onCancel }: { options: GraphOptions; focused: boolean; width: number; onSave: (options: GraphOptions) => void; onCancel: () => void }) {
  const [fields, setFields] = useState({ minPct: String(options.minPct), minConfidence: String(options.minConfidence), limit: String(options.limit), asOf: options.asOf ?? "" });
  const keys = ["minPct", "minConfidence", "limit", "asOf"] as const;
  const [active, setActive] = useState<(typeof keys)[number]>("minPct"), [error, setError] = useState<string | null>(null);
  useInputCapture(focused);
  const submit = () => {
    try { onSave(graphOptions({ ...options, roles: options.roles.join(","), sources: options.sources.join(","), tiers: options.tiers.join(","), ...fields })); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useShortcut(event => {
    if (event.name === "tab") { event.preventDefault(); event.stopPropagation(); setActive(old => keys[(keys.indexOf(old) + (event.shift ? -1 : 1) + keys.length) % keys.length]!); }
    else if (event.name === "escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }, { enabled: focused, phase: "before", allowEditable: true, scope: "supply-graph-inputs" });
  const labels = { minPct: "Minimum disclosed percentage (0–100)", minConfidence: "Minimum confidence (0–1)", limit: "Maximum paths / companies per section (1–50)", asOf: "Filing cutoff (YYYY-MM-DD, blank for latest)" };
  return <ScrollBox scrollY flexGrow={1} flexBasis={0} minHeight={0}><Box flexDirection="column" gap={1} paddingX={1}>
    {keys.map(key => {
      const props = { label: labels[key], value: fields[key], width: Math.min(width - 2, 47), focused: focused && active === key,
        onMouseDown: () => setActive(key), onChange: (value: string) => setFields(old => ({ ...old, [key]: value })), onSubmit: submit };
      return key === "asOf" ? <TextField key={key} {...props} /> : <NumberField key={key} {...props} allowDecimal={key !== "limit"} />;
    })}
    {error ? <Notice tone="warning">{error}</Notice> : null}
    <Box flexDirection="row" gap={2}><Button label="Apply filters" variant="primary" onPress={submit} /><Button label="Cancel" variant="secondary" onPress={onCancel} /></Box>
  </Box></ScrollBox>;
}
function PathEvidence({ data, path, width, focused, onRecenter }: { data: GraphPayload; path: GraphPath; width: number; focused: boolean; onRecenter: (entity: SupplyEntity) => void }) {
  const colors = useThemeColors(), host = useRendererHost();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  useShortcut(event => {
    const delta = isPlainKey(event, "j", "down") ? 1 : isPlainKey(event, "k", "up") ? -1 : 0;
    if (focused && delta && scrollRef.current) { event.preventDefault(); event.stopPropagation(); scrollByLines(scrollRef.current, delta); }
  });
  const figures: StatItem[] = [
    { id: "score", label: "Path score", value: path.score.toFixed(4) },
    { id: "confidence", label: "Confidence", value: `${Math.round(path.confidence * 100)}%` },
    { id: "exposure", label: "Estimated exposure", value: exposureLabel(path, data), detail: path.exposure?.period, wide: true },
  ];
  const company = (entity: SupplyEntity) => desktop && entity.ticker ? <Badge label={entity.ticker} tone="accent" />
    : <Text fg={entity.aggregate || entity.anonymous ? colors.textDim : colors.textBright} attributes={TextAttributes.BOLD}>{entityLabel(entity)}</Text>;
  return <DetailScrollBody ref={scrollRef} resetScrollKey={path.id}><ButtonActionScope>
    <StatGrid items={figures} width={Math.max(1, width - 2)} />
    {path.linkIds.map((id, index) => {
      const link = data.links.find(item => item.id === id)!;
      const from = data.nodes.find(node => node.id === path.nodeIds[index])!, to = data.nodes.find(node => node.id === path.nodeIds[index + 1])!;
      return <Box key={id} flexDirection="column" paddingTop={1}>
        <Box flexDirection="row" height={1} gap={1} overflow="hidden">
          <Text fg={colors.textDim}>{`${index + 1}H`}</Text>
          {company(from)}<Text fg={colors.textMuted}>→</Text>{company(to)}
        </Box>
        {link.evidence.map(evidence => {
          const share = shareParts({ ...evidence, reportingEntity: evidence.reporter }, undefined, { includeReporter: true });
          return <Box key={evidence.id} flexDirection="column" paddingBottom={1}>
            <KeyValueRow label="Disclosure" value={`${evidence.reporter.name} · ${roleLabel(evidence.role)}`} color={ROLE_COLORS[evidence.role]} labelWidth={20} />
            <KeyValueRow label="Evidence" value={`${TIER_LABELS[evidence.tier]} · ${SOURCE_LABELS[evidence.sourceKind]}`} detail={`${Math.round(evidence.confidence * 100)}% confidence`} labelWidth={20} />
            <KeyValueRow label="Period" value={evidence.period} detail={`filed ${evidence.filedDate ?? "--"}`} labelWidth={20} />
            {share ? <>
              <Box flexDirection="row" gap={1}>
                <KeyValueRow label="Disclosed share" value={share.value} color={ROLE_COLORS[evidence.role]} labelWidth={20} />
                <RatioBar ratio={evidence.pctOfRevenue! / 100} width={8} color={ROLE_COLORS[evidence.role]} track />
              </Box>
              <KeyValueRow label="Share basis" value={share.basis} labelWidth={20} />
            </> : null}
            {evidence.nativeAmount != null ? <KeyValueRow label="Disclosed value" value={`${evidence.nativeAmount.toLocaleString()} ${evidence.nativeCurrency ?? ""}`} labelWidth={20} /> : null}
            <DisclosureQuote role={evidence.role} quote={evidence.quote} />
            <Box flexDirection="row"><Button variant="plain" compact flush label={`Open ${evidence.form ?? "source"} filing`} onPress={() => void host.openExternal(evidence.filingUrl)} /></Box>
          </Box>;
        })}
        <ActionRow label={`Recenter on ${entityLabel(to)}`} onPress={() => onRecenter(to)} />
      </Box>;
    })}
  </ButtonActionScope></DetailScrollBody>;
}
export function SupplyGraphPane({ symbol, tab, width, height, focused }: { symbol: string; tab: "graph" | "path"; width: number; height: number; focused: boolean }) {
  const colors = useThemeColors(), desktop = !!useUiCapabilities().nativePaneChrome;
  const instance = usePaneInstance(), session = useResearchCloudSession(), access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const initialOptions = useMemo(() => { try { return graphOptions(instance?.settings ?? {}); } catch { return DEFAULT_GRAPH_OPTIONS; } }, []);
  const [options, setOptions] = usePluginPaneState<GraphOptions>("supply:graph-options", initialOptions);
  const [focus, setFocus] = usePluginPaneState(`supply:graph-focus:${symbol}`, symbol);
  const [target, setTarget] = usePluginPaneState(`supply:graph-target:${symbol}`, String(instance?.settings?.to ?? ""));
  const [targetDraft, setTargetDraft] = useState(target), [targetActive, setTargetActive] = useState(false);
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`supply:graph-selected:${symbol}`, null);
  const [selectedPathId, setSelectedPath] = usePluginPaneState<string | null>(`supply:path-selected:${symbol}`, null);
  const [openId, setOpen] = usePluginPaneState<string | null>(`supply:path-evidence:${symbol}`, null);
  const [collapsed, setCollapsed] = usePluginPaneState<string[]>(`supply:collapsed:${symbol}`, []);
  const [visibleLinks, setVisibleLinks] = useState<string[]>([]);
  const [inputsOpen, setInputsOpen] = useState(false);
  const [snapshotSetting] = usePaneSettingValue<GraphPayload | null>("graphSnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateGraph(snapshotSetting) : null; } catch { return null; } }, [snapshotSetting]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadGraph(focus, target, options, accessKey, force), [focus, target, options, accessKey, snapshot]);
  const resource = useAsyncResource(tab === "path" && !target ? null : loader, { initialData: () => cachedGraph(focus, target, options, accessKey), clearOnError: isAccessDenied });
  const data = resource.data?.payload ?? null;
  const [sort, setSort] = usePluginPaneState("supply:path-sort", { column: "score", direction: "desc" as "asc" | "desc" });
  const paths = useMemo(() => data ? data.paths.length ? data.paths : [...data.upstream, ...data.downstream, ...data.related].map(row => options.ranking === "shortest" ? row.shortestPath : row.bestPath) : [], [data, options.ranking]);
  const sortedPaths = useMemo(() => [...paths].sort((a, b) => {
    const value = (path: GraphPath): number | string => sort.column === "route" && data ? pathLabel(path, data) : sort.column === "relationships" && data ? path.linkIds.map(id => data.links.find(link => link.id === id)?.relationship ?? "").sort().join(" ") : sort.column === "hops" ? path.hops : sort.column === "confidence" ? path.confidence : sort.column === "exposure" ? path.exposure?.pct ?? -1 : path.score;
    const aValue = value(a), bValue = value(b);
    return (typeof aValue === "string" && typeof bValue === "string" ? aValue.localeCompare(bValue) : Number(aValue) - Number(bValue)) * (sort.direction === "asc" ? 1 : -1);
  }), [paths, data, sort]);
  const initialPath = paths[Math.max(0, Number(instance?.settings?.route ?? 1) - 1)] ?? paths[0] ?? null;
  const selectedPath = paths.find(path => path.id === selectedPathId) ?? paths.find(path => path.nodeIds.at(-1) === selectedId) ?? (target ? initialPath : null) ?? null;
  const selected = (tab === "path" ? null : data?.nodes.find(node => node.id === selectedId)) ?? (selectedPath ? data?.nodes.find(node => node.id === selectedPath.nodeIds.at(-1)) : null) ?? null;
  const openPath = paths.find(path => path.id === openId) ?? (instance?.settings?.evidence && openId !== "closed" ? initialPath : null) ?? null;
  const openUpgrade = useCloudUpgradeAction("splc"), { createPaneFromTemplate } = usePluginAppActions();
  const recenter = (entity: SupplyEntity) => { setFocus(entityKey(entity)); setTarget(""); setTargetDraft(""); setSelected(null); setSelectedPath(null); setOpen(null); setCollapsed([]); };
  const applyTarget = (value: string) => { setTarget(value.trim()); setTargetDraft(value.trim()); setSelected(null); setSelectedPath(null); setOpen(null); setTargetActive(false); };
  const selectNode = (id: string) => { setSelected(id); setSelectedPath(null); };
  const details = () => { if (selectedPath) setOpen(selectedPath.id); };
  const hints: PaneHint[] = inputsOpen ? [] : [
    ...(!openPath ? [{ id: "inputs", key: "i", label: "nputs", onPress: () => setInputsOpen(true) }] : []),
    ...(selectedPath && !openPath ? [{ id: "evidence", key: "e", label: "vidence", onPress: details }] : []),
    ...(tab === "graph" && !openPath && selected && selected.id !== data?.entity?.id ? [{ id: "target", key: "p", label: "aths to target", onPress: () => applyTarget(entityKey(selected)) },
      { id: "collapse", key: "c", label: collapsed.includes(selected.id) ? "expand" : "ollapse", onPress: () => setCollapsed(old => old.includes(selected.id) ? old.filter(id => id !== selected.id) : [...old, selected.id]) }] : []),
    ...(!openPath && selected?.ticker ? [
      { id: "description", key: "d", label: "es", onPress: () => createPaneFromTemplate("new-ticker-detail-pane", { symbol: entityKey(selected) }) },
      { id: "financials", key: "f", label: "a", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol: entityKey(selected) }) },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: entityKey(selected) }) },
    ] : []),
    ...(!openPath && (focus !== symbol || target) ? [{ id: "home", key: "z", label: "reset focus", onPress: () => { setFocus(symbol); applyTarget(""); setCollapsed([]); setSelected(null); } }] : []),
    ...(data?.access === "preview" ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", onPress: openUpgrade }] : []),
  ];
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused: focused && !inputsOpen && !targetActive });
  usePaneStatusFooter({ registrationId: "supply-graph", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale, hints,
    info: data?.asOf ? [{ id: "as-of", parts: [{ text: `as of ${data.asOf}`, tone: "muted" }] }] : [] });
  usePaneNoticeFooter({ registrationId: "supply-graph:notices", focused, notices: [...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ...(data && !data.search.complete ? [`Search limited: ${data.search.reasons.join(", ").replaceAll("_", " ")}. Narrow filters or reduce depth to inspect more routes.`] : []),
    ...(data?.access === "preview" ? [`Pro preview: depth ${data.options.depth}. Upgrade for four hops and the full graph.`] : [])] });
  useRemoteUiNode({ role: "chart-data", label: "Rendered supply chain graph", getMetadata: () => ({ kind: "supply-chain", version: 1, complete: !!data, ready: !!data, plottedValueCount: tab === "graph" ? visibleLinks.length : paths.length, payload: data, tab, evidenceOpen: !!openPath, evidenceId: openPath?.id ?? null, rowIds: tab === "graph" ? visibleLinks : paths.map(path => path.id) }) });
  const filters: QueryBarFilter[] = [
    { id: "target", kind: "text", label: "To", value: targetDraft, placeholder: "Ticker or id:123", onChange: setTargetDraft, onSubmit: applyTarget, focused, active: targetActive, onActiveChange: setTargetActive, width: 16 },
    { id: "depth", label: "Hops", value: String(options.depth), options: [1, 2, 3, 4].map(value => ({ value: String(value), label: String(value) })), onChange: value => setOptions(old => ({ ...old, depth: Number(value) })) },
    { id: "direction", label: "Direction", value: options.direction, options: [{ value: "both", label: "Both" }, { value: "upstream", label: "Upstream" }, { value: "downstream", label: "Downstream" }], onChange: value => setOptions(old => ({ ...old, direction: value })) },
    { id: "roles", kind: "multi", label: "Roles", values: options.roles, options: ["supplier", "customer", "partner", "competitor", "investee"].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })), onChange: values => setOptions(old => ({ ...old, roles: values as GraphOptions["roles"] })) },
    { id: "tiers", kind: "multi", label: "Tier", values: options.tiers, options: Object.entries(TIER_LABELS).map(([value, label]) => ({ value, label })), onChange: values => setOptions(old => ({ ...old, tiers: values as GraphOptions["tiers"] })) },
    { id: "sources", kind: "multi", label: "Evidence", values: options.sources, options: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })), onChange: values => setOptions(old => ({ ...old, sources: values as GraphOptions["sources"] })) },
  ];
  const query = <QueryBar width={width} filters={filters} view={{ value: options.ranking, options: [{ value: "score", label: "Top score" }, { value: "shortest", label: "Shortest" }], onChange: value => setOptions(old => ({ ...old, ranking: value })) }} />;
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="supply-chain-signin" action="explore supply chain paths" needsVerification={session.needsVerification} />;
  const detailOpen = inputsOpen || !!openPath;
  return <PageStackView focused={focused && !targetActive} detailOpen={detailOpen} onBack={() => { setOpen("closed"); setInputsOpen(false); }} detailTitle={inputsOpen ? "Graph filters" : openPath && data ? pathLabel(openPath, data) : undefined}
    detailContent={inputsOpen ? <GraphInputs options={options} focused={focused} width={width} onSave={value => { setOptions(value); setInputsOpen(false); }} onCancel={() => setInputsOpen(false)} /> : openPath && data ? <PathEvidence data={data} path={openPath} width={width} focused={focused} onRecenter={recenter} /> : null}
    rootContent={<Box width={width} height={height} flexDirection="column">{query}
      {tab === "path" && !target ? <EmptyState title="Choose a target company." hint="Enter a ticker or entity ID in To." /> : <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} empty={!!data && !data.links.length} emptyTitle={target ? "No disclosed route within these filters." : "No disclosed relationships within these filters."} subject="supply chain graph">
        {data ? tab === "graph" ? <SupplyGraph data={data} width={width} height={Math.max(4, height - 1 - (data.access === "preview" ? 1 : 0))} focused={focused && !targetActive && !detailOpen} selectedId={selectedId} selectedPath={selectedPath} collapsed={collapsed} onSelect={selectNode} onRecenter={recenter} onVisible={setVisibleLinks} />
          : <DataTableView<GraphPath> columns={PATH_COLUMNS} items={sortedPaths} sortColumnId={sort.column} sortDirection={sort.direction} onHeaderClick={column => setSort(old => ({ column, direction: old.column === column && old.direction === "desc" ? "asc" : "desc" }))} emptyStateTitle="No disclosed route within these filters." getItemKey={path => path.id} focused={focused && !targetActive && !detailOpen} rootWidth={width} rootHeight={height - 1 - (data.access === "preview" ? 1 : 0)}
            selection={{ kind: "id", selectedId: selectedPath?.id ?? paths[0]?.id ?? null, getId: path => path.id, onChange: id => setSelectedPath(id) }} onActivate={path => setOpen(path.id)}
            renderCell={(path, column, _index, state) => {
              const ink = state.selected ? colors.selectedText : colors.textBright;
              if (column.id === "route") {
                const text = pathLabel(path, data);
                const route = path.nodeIds.map(id => data.nodes.find(node => node.id === id)).filter((node): node is SupplyEntity => !!node);
                const cells = route.reduce((total, node) => total + displayWidth(entityLabel(node)) + (node.ticker ? 2 : 0), 0) + Math.max(0, route.length - 1) * 3;
                return { text, content: desktop && route.length === path.nodeIds.length && cells <= column.width ? <Box flexDirection="row" height={1} gap={1} overflow="hidden">
                  {route.flatMap((node, index) => [
                    index ? <Text key={`arrow:${index}`} fg={state.selected ? colors.selectedText : colors.textMuted}>→</Text> : null,
                    node.ticker ? <Badge key={node.id} label={node.ticker} tone="accent" color={state.selected ? colors.selectedText : undefined} />
                      : <Text key={node.id} fg={state.selected ? colors.selectedText : node.aggregate || node.anonymous ? colors.textDim : ink}>{node.name}</Text>,
                  ])}
                </Box> : undefined };
              }
              if (column.id === "relationships") {
                const relationships = [...new Set(path.linkIds.map(id => data.links.find(link => link.id === id)!.relationship))];
                const label = (relationship: typeof relationships[number]) => relationship === "commerce" ? "Trade" : roleLabel(relationship);
                return { text: relationships.map(label).join(" / "), content: <Box flexDirection="row" height={1} gap={1} overflow="hidden">
                  {relationships.map(relationship => {
                    const color = relationship === "commerce" ? colors.textMuted : ROLE_COLORS[relationship];
                    return <Box key={relationship} flexDirection="row" gap={1} flexShrink={0}>
                      {desktop ? <Box width={1} height={1} alignItems="center" justifyContent="center"><Box style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: color }} /></Box>
                        : <Text fg={color}>●</Text>}
                      <Text fg={state.selected ? colors.selectedText : color}>{label(relationship)}</Text>
                    </Box>;
                  })}
                </Box> };
              }
              return { text: column.id === "hops" ? String(path.hops) : column.id === "score" ? path.score.toFixed(4) : column.id === "confidence" ? `${Math.round(path.confidence * 100)}%` : exposureLabel(path, data) };
            }} showHorizontalScrollbar selectedTextOverridesCellColor resetScrollKey={`${focus}:${target}:${JSON.stringify(options)}`} /> : null}
      </PaneStatusBody>}
      {data?.access === "preview" ? <UpgradeLabel text="Upgrade for four hops and every relationship" onPress={openUpgrade} role="supply-upgrade" /> : null}
    </Box>} />;
}
