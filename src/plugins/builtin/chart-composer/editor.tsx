import { Box, Text, useNativeRenderer, useUiHost } from "../../../ui";
import { DialogFrame, ListView, TextField } from "../../../components/ui";
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
  const isDesktop = useUiHost().kind === "desktop-web";
  const nativeRenderer = useNativeRenderer();
  const controller = useSeriesEditorController({
    dialogId,
    resolve,
    initialSpec,
    isDesktop,
  });
  const {
    actions,
    activateQuickAdd,
    addCatalogSuggestion,
    beginExpressionEdit,
    beginQuickAdd,
    commitExpression,
    deactivateQuickAdd,
    defaultInstrument,
    editingExpression,
    error,
    expression,
    expressionRef,
    fields,
    focusKeyboardTarget,
    items,
    keyboardFocus,
    moveKeyboardFocus,
    quickAddActive,
    quickAddItems,
    quickAddLoading,
    quickAddQuery,
    quickAddRef,
    quickAddSelection,
    quickAddSuggestions,
    selected,
    selectedIndex,
    setEditingExpression,
    setExpression,
    setQuickAddQuery,
    setQuickAddSelection,
    setSelectedIndex,
    submitQuickAdd,
    updateKeyboardFocus,
  } = controller;
  const availableTuiWidth = nativeRenderer.terminalWidth > 0
    ? nativeRenderer.terminalWidth - 8
    : 76;
  const tuiContentWidth = Math.max(1, Math.min(76, availableTuiWidth));
  const contentWidth = isDesktop ? "660px" : tuiContentWidth;
  const fieldLabel = (field: SeriesEditorFocus, label: string) => (
    keyboardFocus === field ? `› ${label}` : label
  );

  return (
    <DialogFrame
      title="Chart Series"
      footer={isDesktop
        ? undefined
        : "Tab/Shift+Tab field · ←→ change · ↑↓ series"}
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
          value={quickAddQuery}
          placeholder={`Search ${defaultInstrument.symbol} metrics or type “MSFT revenue”`}
          hint={isDesktop ? "Search by ticker or company and metric. Exact FRED IDs also work." : undefined}
          focused={quickAddActive}
          width={isDesktop ? undefined : tuiContentWidth}
          inputRef={quickAddRef}
          onMouseDown={() => beginQuickAdd()}
          onChange={(value) => {
            setQuickAddQuery(value);
            if (value.trim()) activateQuickAdd();
          }}
          onSubmit={submitQuickAdd}
          onBlur={deactivateQuickAdd}
        />

        {quickAddActive && quickAddQuery.trim() && (
          quickAddItems.length > 0 ? (
            <Box width={contentWidth} overflow="hidden" onMouseDown={() => beginQuickAdd()}>
              <ListView
                items={quickAddItems}
                selectedIndex={quickAddSelection}
                height={Math.min(isDesktop ? 5 : 6, quickAddItems.length)}
                surface="framed"
                scrollable={quickAddItems.length > (isDesktop ? 5 : 6)}
                rowGap={isDesktop ? 0 : undefined}
                selectOnHover
                onSelect={setQuickAddSelection}
                onActivate={(_, index) => addCatalogSuggestion(quickAddSuggestions[index])}
              />
            </Box>
          ) : (
            <Text fg={colors.textMuted}>
              {quickAddLoading ? "Searching instruments…" : "No matching security or metric."}
            </Text>
          )
        )}

        {items.length > 0 ? (
          <Box
            width={contentWidth}
            overflow="hidden"
            onMouseDown={() => {
              if (!isDesktop) focusKeyboardTarget("series");
            }}
          >
            <ListView
              items={items}
              selectedIndex={selectedIndex}
              height={isDesktop
                ? Math.min(5, items.length)
                : Math.min(7, Math.max(1, items.length))}
              surface={isDesktop ? "plain" : "framed"}
              selectedBgColor={!isDesktop && keyboardFocus === "series"
                ? colors.borderFocused
                : undefined}
              scrollable={items.length > (isDesktop ? 5 : 7)}
              rowGap={isDesktop ? 0 : undefined}
              onSelect={setSelectedIndex}
              onActivate={(_, index) => setSelectedIndex(index)}
            />
          </Box>
        ) : (
          <Box height={2} justifyContent="center" alignItems="center">
            <Text fg={colors.textMuted}>No series yet. Add one to start the chart.</Text>
          </Box>
        )}

        {selected && (
          <Box flexDirection="column" width="100%" overflow="hidden" gap={1}>
            <TextField
              label={isDesktop
                ? "Exact source (advanced)"
                : fieldLabel("source", "Exact source (advanced)")}
              value={expression}
              placeholder="AAPL:revenue or FRED:CPIAUCSL"
              hint={isDesktop
                ? "Changes this series in place; use an exact symbol, field, or FRED ID."
                : undefined}
              focused={editingExpression}
              width={isDesktop ? undefined : tuiContentWidth}
              inputRef={expressionRef}
              onMouseDown={beginExpressionEdit}
              onKeyDown={(event) => {
                if (event.defaultPrevented) return;
                if (event.name === "escape") {
                  event.stopPropagation();
                  event.preventDefault();
                  resolve(null);
                } else if (event.name === "enter" || event.name === "return") {
                  event.stopPropagation();
                  event.preventDefault();
                  if (commitExpression()) moveKeyboardFocus(1);
                } else if (event.name === "tab") {
                  event.stopPropagation();
                  event.preventDefault();
                  if (commitExpression()) moveKeyboardFocus(event.shift ? -1 : 1);
                }
              }}
              onChange={setExpression}
              onSubmit={() => { commitExpression(); }}
              onBlur={() => {
                if (!editingExpression) return;
                const committed = commitExpression();
                if (!committed && !isDesktop) {
                  updateKeyboardFocus("source");
                  setEditingExpression(true);
                  queueMicrotask(() => expressionRef.current?.focus?.());
                }
              }}
            />

            {isDesktop ? (
              <DesktopSeriesEditorFields fields={fields} />
            ) : (
              <OpenTuiSeriesEditorFields
                fields={fields}
                keyboardFocus={keyboardFocus}
                dialogId={dialogId}
                onFocus={focusKeyboardTarget}
              />
            )}
          </Box>
        )}

        {error && <Text fg={colors.negative} wrapText>{error}</Text>}

        {isDesktop ? (
          <DesktopSeriesEditorActions actions={actions} />
        ) : (
          <OpenTuiSeriesEditorActions actions={actions} />
        )}
      </Box>
    </DialogFrame>
  );
}
