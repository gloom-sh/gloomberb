import { useId, useRef } from "react";
import { t } from "../../i18n";
import { useShortcut } from "../../react/input";
import type { ContextMenuItem } from "../../types/context-menu";
import { useOptionalDialog, type AlertContext, type PromptContext } from "../../ui/dialog";
import { usePaneMenuItems } from "../layout/pane/footer";
import { ChoiceDialog } from "./choice-dialog";
import { MultiSelectDialogContent } from "./multi-select/dialog";
import type { QueryBarFilter, QueryBarSearch, QueryBarView } from "./query-bar";

interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

/**
 * The keyboard side of a QueryBar, for every pane that has one: `/` focuses the
 * search, and each filter, the view and "clear" are entries in the pane menu,
 * so no chip, toggle or view strip needs a mouse.
 */
export function useQueryBarKeys({
  search,
  filters,
  view,
  narrowingCount,
  resetAll,
  focusSearch,
}: {
  search?: QueryBarSearch;
  filters: QueryBarFilter[];
  view?: QueryBarView<any>;
  narrowingCount: number;
  resetAll: () => void;
  focusSearch: () => void;
}) {
  const dialog = useOptionalDialog();
  const registrationId = `query-bar:${useId()}`;
  const latest = useRef({ filters, view, resetAll, focusSearch });
  latest.current = { filters, view, resetAll, focusSearch };

  // A pane that binds "/" itself keeps it; this covers every other search.
  useShortcut((event) => {
    if (event.defaultPrevented || event.name !== "/" || event.ctrl || event.meta || event.alt) return;
    event.preventDefault();
    event.stopPropagation();
    latest.current.focusSearch();
  }, { phase: "after", enabled: !!search && search.focused && !search.active });

  const choose = async (title: string, options: readonly ChoiceOption[], current: string, apply: (value: string) => void) => {
    if (!dialog) return;
    const value = await dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (ctx: PromptContext<string>) => (
        <ChoiceDialog
          {...ctx}
          title={title}
          selectedChoiceId={current}
          choices={options.map((option) => ({
            id: option.value,
            label: option.label,
            description: option.description,
            disabled: option.disabled,
          }))}
        />
      ),
    });
    if (value && value !== current) apply(value);
  };

  const signature = [
    search ? `search:${search.focused}` : "",
    ...filters.map((filter) => {
      if (filter.kind === "toggle") return `${filter.id}:${filter.value}`;
      if (filter.kind === "multi") return `${filter.id}:${filter.values.join(",")}`;
      return `${filter.id}:${String(filter.value)}`;
    }),
    view ? `view:${String(view.value)}` : "",
    narrowingCount,
  ].join("|");

  usePaneMenuItems(registrationId, () => {
    const items: ContextMenuItem[] = [];
    if (search) {
      items.push({ id: "search", label: t("Search"), accelerator: "/", onSelect: () => latest.current.focusSearch() });
    }
    for (const filter of filters) {
      const id = `filter:${filter.id}`;
      const find = () => latest.current.filters.find((entry) => entry.id === filter.id);
      if (filter.kind === "toggle") {
        items.push({
          id,
          label: t(filter.label),
          checked: filter.value,
          onSelect: () => {
            const current = find();
            if (current?.kind === "toggle") current.onChange(!current.value);
          },
        });
      } else if (filter.kind === "text") {
        items.push({
          id,
          label: `${t(filter.label)}…`,
          onSelect: () => {
            const current = find();
            // The field focuses itself once active; focusing it mid-keypress
            // would hand it the Enter that chose this item.
            if (current?.kind === "text") current.onActiveChange(true);
          },
        });
      } else if (filter.kind === "multi") {
        items.push({
          id,
          label: `${t(filter.label)}…`,
          onSelect: () => {
            const current = find();
            if (!dialog || current?.kind !== "multi") return;
            void dialog.alert({
              closeOnClickOutside: true,
              content: (ctx: AlertContext) => (
                <MultiSelectDialogContent
                  {...ctx}
                  title={t(current.title ?? current.label)}
                  options={[...current.options]}
                  selectedValues={current.values}
                  emptyLabel={current.emptyLabel}
                  onChange={(values) => {
                    const latestFilter = find();
                    if (latestFilter?.kind === "multi") latestFilter.onChange(values);
                  }}
                />
              ),
            });
          },
        });
      } else {
        const currentLabel = filter.options.find((option) => option.value === filter.value)?.label ?? String(filter.value);
        items.push({
          id,
          label: `${t(filter.label)}: ${t(currentLabel)}…`,
          onSelect: () => {
            const current = find();
            if (!current || current.kind === "toggle" || current.kind === "text" || current.kind === "multi") return;
            void choose(t(current.title ?? current.label), current.options, String(current.value), (value) => current.onChange(value));
          },
        });
      }
    }
    if (view) {
      const currentLabel = view.options.find((option) => option.value === view.value)?.label ?? String(view.value);
      items.push({
        id: "view",
        label: `${t("View")}: ${t(currentLabel)}…`,
        onSelect: () => {
          const current = latest.current.view;
          if (current) void choose(t("View"), current.options, String(current.value), (value) => current.onChange(value));
        },
      });
    }
    if (narrowingCount > 0) {
      items.push({ id: "clear-filters", label: t("Clear Filters"), onSelect: () => latest.current.resetAll() });
    }
    return items;
  }, [dialog, signature]);
}
