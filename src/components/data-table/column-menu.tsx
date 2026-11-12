import { useMemo, useRef } from "react";
import { t, tf } from "../../i18n";
import type { ContextMenuItem } from "../../types/context-menu";
import { useOptionalDialog, type PromptContext } from "../../ui/dialog";
import { logFailure } from "../../utils/log-failure";
import { ChoiceDialog } from "../ui/choice-dialog";
import type { DataTableColumn } from "../ui";

const NO_ITEMS: readonly ContextMenuItem[] = [];

function columnName(column: DataTableColumn): string {
  return column.label.trim() || column.title || column.id;
}

/**
 * The pane menu's column entries while the table is focused: "Move Column…"
 * does a header drag from the keyboard (a column, then the one it should
 * follow), and "Reset Columns" puts the pane's own order back once the reader
 * has changed it.
 */
export function useDataTableColumnMenuItems({
  enabled,
  columns,
  anchoredColumns,
  onColumnMove,
  customized,
  reset,
}: {
  enabled: boolean;
  columns: readonly DataTableColumn[];
  anchoredColumns: number;
  onColumnMove?: (columnId: string, toIndex: number) => void;
  customized: boolean;
  reset: () => void;
}): readonly ContextMenuItem[] {
  const dialog = useOptionalDialog();
  const latest = useRef({ columns, anchoredColumns, onColumnMove });
  latest.current = { columns, anchoredColumns, onColumnMove };
  const movable = !!onColumnMove && columns.length - anchoredColumns >= 2;

  return useMemo(() => {
    if (!enabled || !movable) return NO_ITEMS;
    const move = async () => {
      if (!dialog) return;
      const current = latest.current;
      const columnId = await dialog.prompt<string>({
        closeOnClickOutside: true,
        content: (ctx: PromptContext<string>) => (
          <ChoiceDialog
            {...ctx}
            title={t("Move Column")}
            choices={current.columns.slice(current.anchoredColumns).map((column) => ({ id: column.id, label: columnName(column) }))}
          />
        ),
      });
      const from = current.columns.findIndex((column) => column.id === columnId);
      if (!columnId || from < 0) return;
      // After the column it should follow: the one it follows now is chosen to begin with.
      const others = current.columns.filter((column) => column.id !== columnId);
      const start = Math.max(0, current.anchoredColumns - 1);
      const target = await dialog.prompt<string>({
        closeOnClickOutside: true,
        content: (ctx: PromptContext<string>) => (
          <ChoiceDialog
            {...ctx}
            title={tf("Move {column}", { column: columnName(current.columns[from]!) })}
            selectedChoiceId={String(from)}
            choices={[
              ...current.anchoredColumns === 0 ? [{ id: "0", label: t("First") }] : [],
              ...others.slice(start).map((column, index) => ({
                id: String(start + index + 1),
                label: tf("After {column}", { column: columnName(column) }),
              })),
            ]}
          />
        ),
      });
      if (target) latest.current.onColumnMove?.(columnId, Number(target));
    };
    return [
      ...dialog ? [{
        id: "move-column",
        label: "Move Column…",
        onSelect: () => move().catch(logFailure("data-table", "Move Column failed")),
      }] : [],
      ...customized ? [{ id: "reset-columns", label: "Reset Columns", onSelect: reset }] : [],
    ];
  }, [customized, dialog, enabled, movable, reset]);
}
