import { useId, useRef } from "react";
import { t } from "../../i18n";
import { useOptionalDialog, type PromptContext } from "../../ui/dialog";
import { usePaneMenuItems } from "../layout/pane/footer";
import { ChoiceDialog } from "../ui/choice-dialog";
import type { DataTableColumn } from "../ui";

/**
 * A sortable table's header clicks, for the keyboard: "Sort by…" in the pane
 * menu picks a column the way a header click does (the current column flips
 * direction), and "Reverse Sort" flips the current one.
 */
export function useDataTableSortMenu({
  enabled,
  columns,
  sortColumnId,
  sortDirection,
  onHeaderClick,
  onSortChange,
}: {
  enabled: boolean;
  columns: DataTableColumn[];
  sortColumnId: string | null;
  sortDirection: "asc" | "desc";
  onHeaderClick: (columnId: string) => void;
  /** Sets a direction outright, for a header click that cycles through "unsorted". */
  onSortChange?: (columnId: string, direction: "asc" | "desc") => void;
}) {
  const dialog = useOptionalDialog();
  const registrationId = `data-table-sort:${useId()}`;
  const latest = useRef({ columns, sortColumnId, sortDirection, onHeaderClick, onSortChange });
  latest.current = { columns, sortColumnId, sortDirection, onHeaderClick, onSortChange };
  const reverse = () => {
    const current = latest.current;
    if (!current.sortColumnId) return;
    if (current.onSortChange) current.onSortChange(current.sortColumnId, current.sortDirection === "asc" ? "desc" : "asc");
    else current.onHeaderClick(current.sortColumnId);
  };
  const sortableColumns = columns.filter((column) => column.label.trim().length > 0);

  usePaneMenuItems(registrationId, () => {
    if (!enabled || !dialog || sortableColumns.length === 0) return null;
    const chooseColumn = async () => {
      const current = latest.current;
      const arrow = current.sortDirection === "asc" ? "▲" : "▼";
      const columnId = await dialog.prompt<string>({
        closeOnClickOutside: true,
        content: (ctx: PromptContext<string>) => (
          <ChoiceDialog
            {...ctx}
            title={t("Sort by")}
            selectedChoiceId={current.sortColumnId ?? undefined}
            choices={current.columns
              .filter((column) => column.label.trim().length > 0)
              .map((column) => ({
                id: column.id,
                label: column.label,
                detail: column.id === current.sortColumnId ? arrow : undefined,
              }))}
          />
        ),
      });
      if (!columnId) return;
      // The current column flips, as its header does; another one sorts the way its header click would.
      if (columnId === latest.current.sortColumnId) reverse();
      else latest.current.onHeaderClick(columnId);
    };
    return [
      { id: "sort-by", label: "Sort by…", onSelect: () => { void chooseColumn(); } },
      ...(sortColumnId
        ? [{ id: "sort-reverse", label: "Reverse Sort", onSelect: reverse }]
        : []),
    ];
  }, [dialog, enabled, sortColumnId, sortableColumns.length]);
}
