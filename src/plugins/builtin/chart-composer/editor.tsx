import { Box, Text, useNativeRenderer, useUiCapabilities } from "../../../ui";
import { EmptyState, DialogFrame, ListView, TextField } from "../../../components/ui";
import type { PromptContext } from "../../../ui/dialog";
import { colors } from "../../../theme/colors";
import type { ChartSpec } from "../../../time-series/types";
import { useSeriesEditorController } from "./editor/controller";
import {
  DesktopSeriesEditorActions,
  DesktopSeriesEditorFields,
} from "./editor/desktop-view";
import {
  OpenTuiSeriesEditorActions,
  OpenTuiSeriesEditorFields,
} from "./editor/opentui-view";
import type { SeriesEditorFocus } from "./editor/model";

export interface SeriesEditorDialogProps extends PromptContext<ChartSpec | null> {
  initialSpec: ChartSpec;
}

export function SeriesEditorDialog({ dialogId, resolve, initialSpec }: SeriesEditorDialogProps) {
  const isDesktop = useUiCapabilities().nativePaneChrome === true;
  const nativeRenderer = useNativeRenderer();
  const c = useSeriesEditorController({
    dialogId,
    resolve,
    initialSpec,
    isDesktop,
  });
  const availableTuiWidth = nativeRenderer.terminalWidth > 0
    ? nativeRenderer.terminalWidth - 8
    : 76;
  const tuiContentWidth = Math.max(1, Math.min(76, availableTuiWidth));
  const contentWidth = isDesktop ? "660px" : tuiContentWidth;
  const fieldLabel = (field: SeriesEditorFocus, label: string) => (
    c.keyboardFocus === field ? `› ${label}` : label
  );
  // The keys with no button of their own; the buttons show theirs.
  const seriesKeys = c.selected ? ["E source", "P panel", "L log scale"] : [];
  // A narrow terminal drops the navigation keys first: nothing else shows the action keys.
  const navigationKeys = ["Tab field", "←→ change", "↑↓ series"];
  while (navigationKeys.length > 0 && [...navigationKeys, ...seriesKeys].join(" · ").length > tuiContentWidth) {
    navigationKeys.pop();
  }

  return (
    <DialogFrame
      title="Chart Series"
      onClose={() => resolve(null)}
      footer={[...navigationKeys, ...seriesKeys].join(" · ")}
      // The desktop's fields take the pointer and arrows like any form.
      desktopFooter={c.selected
        ? { keys: [{ key: "E", label: "source" }, { key: "P", label: "panel" }, { key: "L", label: "log scale" }] }
        : null}
    >
      <Box
        flexDirection="column"
        width={contentWidth}
        overflow="hidden"
        gap={1}
        style={isDesktop ? { gap: 10 } : undefined}
      >
        <TextField
          label={isDesktop ? "Add a series" : fieldLabel("add", "Add a series")}
          value={c.quickAddQuery}
          placeholder={`Search ${c.defaultInstrument.symbol} metrics or type “MSFT revenue”`}
          hint={isDesktop ? "Search by ticker or company and metric. Exact FRED IDs also work." : undefined}
          focused={c.quickAddActive}
          width={isDesktop ? undefined : tuiContentWidth}
          inputRef={c.quickAddRef}
          onMouseDown={() => c.beginQuickAdd()}
          onKeyDown={(event) => {
            // The terminal's dialog keys see arrows first; a desktop field keeps
            // them unless the suggestion highlight takes them here.
            if (event.defaultPrevented || !isDesktop || !c.quickAddActive || c.quickAddItems.length === 0) return;
            const direction = event.name === "up" ? -1 : event.name === "down" ? 1 : 0;
            if (!direction || event.shift) return;
            event.preventDefault();
            event.stopPropagation();
            c.moveQuickAddSelection(direction);
          }}
          onChange={(value) => {
            c.setQuickAddQuery(value);
            if (value.trim()) c.activateQuickAdd();
          }}
          onSubmit={c.submitQuickAdd}
          onBlur={c.deactivateQuickAdd}
        />

        {(c.quickAddActive || c.quickAddError) && c.quickAddQuery.trim() && (
          c.quickAddItems.length > 0 ? (
            <Box width={contentWidth} overflow="hidden">
              <ListView
                items={c.quickAddItems}
                selectedIndex={c.quickAddSelection}
                height={Math.min(isDesktop ? 5 : 6, c.quickAddItems.length)}
                surface="framed"
                scrollable={c.quickAddItems.length > (isDesktop ? 5 : 6)}
                rowGap={isDesktop ? 0 : undefined}
                selectOnHover
                onSelect={c.setQuickAddSelection}
                onActivate={(_, index) => { c.beginQuickAdd(); c.addCatalogSuggestion(c.quickAddSuggestions[index]); }}
              />
            </Box>
          ) : !c.quickAddError ? (
            <Text fg={colors.textMuted}>
              {c.quickAddLoading ? "Searching instruments…" : "No matching security or metric."}
            </Text>
          ) : null
        )}
        {c.quickAddQuery.trim() && c.quickAddError && (
          <EmptyState title={c.quickAddError} status="error" retry={{ onRetry: () => { c.beginQuickAdd(); return c.retryQuickAdd(); } }} />
        )}

        {c.items.length > 0 ? (
          <Box
            width={contentWidth}
            overflow="hidden"
          >
            <ListView
              items={c.items}
              selectedIndex={c.selectedIndex}
              height={isDesktop
                ? Math.min(5, c.items.length)
                : Math.min(7, Math.max(1, c.items.length))}
              surface={isDesktop ? "plain" : "framed"}
              selectedBgColor={!isDesktop && c.keyboardFocus === "series"
                ? colors.borderFocused
                : undefined}
              scrollable={c.items.length > (isDesktop ? 5 : 7)}
              rowGap={isDesktop ? 0 : undefined}
              onSelect={(index) => { if (!isDesktop) c.focusKeyboardTarget("series"); c.setSelectedIndex(index); }}
              onActivate={(_, index) => c.setSelectedIndex(index)}
            />
          </Box>
        ) : (
          <Box height={2} justifyContent="center" alignItems="center">
            <Text fg={colors.textMuted}>No series yet. Add one to start the chart.</Text>
          </Box>
        )}

        {c.selected && (
          <Box flexDirection="column" width="100%" overflow="hidden" gap={1}>
            <TextField
              label={isDesktop
                ? "Exact source (advanced)"
                : fieldLabel("source", "Exact source (advanced)")}
              value={c.expression}
              placeholder="AAPL:revenue or FRED:CPIAUCSL"
              hint={isDesktop
                ? "Changes this series in place; use an exact symbol, field, or FRED ID."
                : undefined}
              focused={c.editingExpression}
              width={isDesktop ? undefined : tuiContentWidth}
              inputRef={c.expressionRef}
              onMouseDown={c.beginExpressionEdit}
              onKeyDown={(event) => {
                if (event.defaultPrevented) return;
                if (event.name === "escape") {
                  event.stopPropagation();
                  event.preventDefault();
                  resolve(null);
                } else if (event.name === "enter" || event.name === "return") {
                  event.stopPropagation();
                  event.preventDefault();
                  if (c.commitExpression()) c.moveKeyboardFocus(1);
                }
                // Tab is left to the dialog: the terminal's ring commits and moves,
                // and the desktop walks its controls, committing as the field blurs.
              }}
              onChange={(value) => {
                c.setExpression(value);
                // Tab reaches the field on the desktop without a click, so typing
                // is what marks it as being edited and committed on blur.
                if (isDesktop && !c.editingExpression) {
                  c.updateKeyboardFocus("source");
                  c.setEditingExpression(true);
                }
              }}
              onSubmit={() => { c.commitExpression(); }}
              onBlur={() => {
                if (!c.editingExpression) return;
                const committed = c.commitExpression();
                if (!committed && !isDesktop) {
                  c.updateKeyboardFocus("source");
                  c.setEditingExpression(true);
                  queueMicrotask(() => c.expressionRef.current?.focus?.());
                }
              }}
            />

            {isDesktop ? (
              <DesktopSeriesEditorFields fields={c.fields} />
            ) : (
              <OpenTuiSeriesEditorFields
                fields={c.fields}
                keyboardFocus={c.keyboardFocus}
                dialogId={dialogId}
                onFocus={c.focusKeyboardTarget}
              />
            )}
          </Box>
        )}

        {c.error && <Text fg={colors.negative} wrapText>{c.error}</Text>}

        {isDesktop ? (
          <DesktopSeriesEditorActions actions={c.actions} />
        ) : (
          <OpenTuiSeriesEditorActions actions={c.actions} />
        )}
      </Box>
    </DialogFrame>
  );
}
