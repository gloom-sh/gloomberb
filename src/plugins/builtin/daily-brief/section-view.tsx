import { useEffect, useMemo, useRef } from "react";
import { unavailableText, type DataTableCell, type DataTableColumn } from "../../../components";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { usePaneAppConfig } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import { TextAttributes } from "../../../ui";
import type { SortPreference } from "../../../utils/sort-values";
import { loadViewSource, type LoadedView } from "../custom-view/loader";
import { applyViewProjection, formatViewValue, type ViewColumn, type ViewRow } from "../custom-view/view-spec";
import { capBriefView, type BriefViewSection } from "./sections";
import { BriefTable, type BriefTableRow } from "./tables";

export type BriefViewLine = BriefTableRow & {
  kind: "view";
  sectionId: string;
  symbol: string | null;
  url: string | null;
  articleId: string | null;
  values: ViewRow;
};

type ViewColumnView = DataTableColumn & { transform?: ViewColumn["transform"] };

function rowSymbol(row: ViewRow): string | null {
  for (const key of ["symbol", "ticker"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function rowUrl(row: ViewRow): string | null {
  const value = row.url;
  return typeof value === "string" && value.includes("://") ? value : null;
}

function rowArticleId(row: ViewRow): string | null {
  const value = row.id;
  return typeof value === "string" && value.trim() ? value : null;
}

function columnsFor(section: BriefViewSection, loaded: LoadedView | null): ViewColumnView[] {
  const known = new Map((loaded?.columns ?? []).map((column) => [column.key, column]));
  const picked: ViewColumn[] = section.spec.projection.columns.length > 0
    ? section.spec.projection.columns
    : (loaded?.columns ?? []).map((column) => ({ key: column.key }));
  const columns = picked.map((column) => {
    const source = known.get(column.key);
    const align = column.align ?? source?.align ?? "left";
    return {
      id: column.key,
      label: column.label ?? source?.header ?? column.key,
      align: align === "right" ? "right" as const : "left" as const,
      width: column.width ?? 14,
      transform: column.transform,
    };
  });
  if (columns.length === 0) return [{ id: "value", label: "Value", align: "left", width: 16, flexGrow: 1 }];
  return columns.map((column, index) => (
    index === columns.length - 1 ? { ...column, flexGrow: 1, width: Math.max(column.width ?? 12, 12) } : column
  ));
}

function linesFor(section: BriefViewSection, rows: readonly ViewRow[], error: string | null, loading: boolean): BriefViewLine[] {
  if (rows.length > 0) {
    return rows.map((row, index) => ({
      kind: "view" as const,
      id: `${section.id}:${rowArticleId(row) ?? index}`,
      sectionId: section.id,
      symbol: rowSymbol(row),
      url: rowUrl(row),
      articleId: rowArticleId(row),
      values: row,
    }));
  }
  if (loading && !error) return [];
  return [{
    kind: "view",
    id: `${section.id}:empty`,
    placeholder: true,
    sectionId: section.id,
    symbol: null,
    url: null,
    articleId: null,
    values: { value: error ? unavailableText("Rows") : "No rows." },
  }];
}

export function BriefViewBlock({
  section,
  width,
  focused,
  selectedId,
  reloadToken,
  sort,
  onSelect,
  onActivate,
  onHeaderClick,
  onLines,
}: {
  section: BriefViewSection;
  width: number;
  focused: boolean;
  selectedId: string | null;
  reloadToken: number;
  sort: SortPreference<string>;
  onSelect: (id: string) => void;
  onActivate: (line: BriefViewLine) => void;
  onHeaderClick: (columnId: string) => void;
  onLines: (id: string, lines: BriefViewLine[], error: string | null) => void;
}) {
  const colors = useThemeColors();
  const config = usePaneAppConfig();
  const spec = useMemo(() => capBriefView(section.spec), [section.spec]);
  const loader = useMemo(() => async () => {
    const controller = new AbortController();
    return loadViewSource(spec, config, controller.signal);
  }, [config, spec]);
  const resource = useAsyncResource(loader);
  useAutoRefresh(resource.updatedAt, resource.reload);
  const reloadRef = useRef(resource.reload);
  reloadRef.current = resource.reload;
  const seenToken = useRef(reloadToken);
  useEffect(() => {
    if (seenToken.current === reloadToken) return;
    seenToken.current = reloadToken;
    void reloadRef.current();
  }, [reloadToken]);
  const projected = useMemo(
    () => (resource.data
      ? applyViewProjection(
        resource.data.rows,
        spec.projection,
        sort.columnId ? { by: sort.columnId, direction: sort.direction } : undefined,
      )
      : []),
    [resource.data, sort.columnId, sort.direction, spec.projection],
  );
  const columns = useMemo(() => columnsFor(section, resource.data), [resource.data, section]);
  const lines = useMemo(
    () => linesFor(section, projected, resource.error, resource.loading),
    [projected, resource.error, resource.loading, section],
  );
  const signature = `${resource.error ?? ""}|${lines.map((line) => line.id).join(",")}`;
  const reported = useRef("");
  useEffect(() => {
    if (reported.current === signature) return;
    reported.current = signature;
    onLines(section.id, lines, resource.error);
  }, [lines, onLines, resource.error, section.id, signature]);
  useEffect(() => () => {
    reported.current = "";
    onLines(section.id, [], null);
  }, [onLines, section.id]);

  const textColumn = columns[0]?.id ?? "value";
  const renderCell = (row: BriefViewLine, column: DataTableColumn): DataTableCell => {
    if (row.placeholder) {
      return column.id === textColumn
        ? { text: String(row.values.value ?? ""), color: colors.textDim }
        : { text: "" };
    }
    const viewColumn = column as ViewColumnView;
    const value = row.values[column.id];
    const text = formatViewValue(value, viewColumn.transform);
    const symbolColumn = column.id === "symbol" || column.id === "ticker";
    return {
      text,
      color: symbolColumn ? colors.textBright : colors.text,
      ...(symbolColumn ? { attributes: TextAttributes.BOLD } : {}),
    };
  };

  return (
    <BriefTable
      label={section.title}
      count={lines.filter((line) => !line.placeholder).length}
      width={width}
      columns={columns}
      items={lines}
      focused={focused}
      selectedId={selectedId}
      onSelect={onSelect}
      onActivate={onActivate}
      renderCell={renderCell}
      sortColumnId={sort.columnId ?? spec.projection.sort?.by ?? null}
      sortDirection={sort.columnId ? sort.direction : spec.projection.sort?.direction ?? "asc"}
      onHeaderClick={onHeaderClick}
    />
  );
}
